import type { Database } from "bun:sqlite";
import type { RunResult } from "../daemon/run-ticket.ts";
import {
  listByTicket as listDispatches,
  listByTicketSince as listDispatchesSince,
} from "../db/repos/dispatch.ts";
import type { DispatchRow } from "../db/repos/dispatch.ts";
import {
  listByTicket as listEvents,
  listByTicketSince as listEventsSince,
} from "../db/repos/event-log.ts";
import type { EventLogRow } from "../db/repos/event-log.ts";
import { listByTicketSince as listSignalsSince } from "../db/repos/ground-truth-signal.ts";
import type { GroundTruthSignalRow } from "../db/repos/ground-truth-signal.ts";
import { getRun } from "../db/repos/run.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { nowUtc } from "../util/time.ts";
import type { TelemetrySink } from "./emit.ts";
import { SCHEMA_VERSION, type TelemetryEvent } from "./events.ts";

type RunCtx = { runId: string; provider: string; startedAt: string };

/** Read the single run row; a missing row is an invariant violation (D9) — the runner always
 *  inserts it at start and resume backfills it, so null here means a broken caller, not a "0". */
function runCtx(db: Database): RunCtx {
  const r = getRun(db);
  if (!r)
    throw new Error("telemetry: no run row — run identity is required (see ENG-349 design D9)");
  return { runId: r.run_id, provider: r.provider, startedAt: r.started_at };
}

/** Sum of reported (non-null) values; null iff none reported. `reported` is the coverage count. */
function aggregate(ns: Array<number | null>): { value: number | null; reported: number } {
  const present = ns.filter((n): n is number => n !== null);
  return {
    value: present.length === 0 ? null : present.reduce((a, n) => a + n, 0),
    reported: present.length,
  };
}

function toEvent(r: EventLogRow, ctx: RunCtx): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "event",
    run_id: ctx.runId,
    ticket_id: r.ticket_id,
    dispatch_id: r.dispatch_id,
    seq: r.seq,
    kind: r.kind,
    actor: r.actor,
    from_stage: r.from_stage,
    to_stage: r.to_stage,
    loop: r.loop,
    route_to: r.route_to,
    signature: r.signature,
    reason: r.reason,
    payload_json: r.payload_json,
    created_at: r.created_at,
  };
}

function toDispatch(r: DispatchRow, ctx: RunCtx): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "dispatch",
    run_id: ctx.runId,
    dispatch_id: r.dispatch_id,
    ticket_id: r.ticket_id,
    work_unit_id: r.work_unit_id,
    seq: r.seq,
    stage: r.stage,
    kind: r.kind,
    model: r.model,
    provider: ctx.provider,
    trigger: r.trigger,
    effort: r.effort,
    exit_code: r.exit_code,
    predecessor_dispatch_id: r.predecessor_dispatch_id,
    outcome: r.outcome,
    branch_head_sha: r.branch_head_sha,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_ms: r.duration_ms,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    cache_read: r.cache_read,
    cache_create: r.cache_create,
    cost_usd: r.cost_usd,
  };
}

function toSignal(r: GroundTruthSignalRow, ctx: RunCtx): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "signal",
    run_id: ctx.runId,
    id: r.id,
    ticket_id: r.ticket_id,
    work_unit_id: r.work_unit_id,
    signal_type: r.signal_type,
    result: r.result,
    command: r.command,
    branch_head_sha: r.branch_head_sha,
    measured_at: r.measured_at,
  };
}

/** Compute the per-ticket summary from the durable SoT (cost from the dispatch rows). */
export function buildSummary(db: Database, ticketId: number, result: RunResult): TelemetryEvent {
  const ctx = runCtx(db);
  const ticket = getTicket(db, ticketId);
  const events = listEvents(db, ticketId);
  const dispatches = listDispatches(db, ticketId);
  const cost = aggregate(dispatches.map((d) => d.cost_usd));
  const tin = aggregate(dispatches.map((d) => d.tokens_in));
  const tout = aggregate(dispatches.map((d) => d.tokens_out));
  const cr = aggregate(dispatches.map((d) => d.cache_read));
  const cc = aggregate(dispatches.map((d) => d.cache_create));
  const dispatch_outcomes: Record<string, number> = {};
  for (const d of dispatches) {
    if (d.outcome) dispatch_outcomes[d.outcome] = (dispatch_outcomes[d.outcome] ?? 0) + 1;
  }
  const escalations = events.filter((e) => e.kind === "escalated");
  return {
    schema_version: SCHEMA_VERSION,
    type: "summary",
    run_id: ctx.runId,
    ticket_id: ticketId,
    ident: ticket?.ident ?? "",
    provider: ctx.provider,
    started_at: ctx.startedAt,
    ended_at: nowUtc(),
    outcome: result.outcome,
    stage: result.stage,
    status: result.status,
    ticks: result.iterations,
    cost_usd: cost.value,
    tokens_in: tin.value,
    tokens_out: tout.value,
    cache_read: cr.value,
    cache_create: cc.value,
    usage_coverage: {
      dispatch_count: dispatches.length,
      cost_usd: cost.reported,
      tokens_in: tin.reported,
      tokens_out: tout.reported,
      cache_read: cr.reported,
      cache_create: cc.reported,
    },
    dispatch_count: dispatches.length,
    dispatch_outcomes,
    cycle_count: events.filter((e) => e.kind === "loopback").length,
    escalation_count: escalations.length,
    escalation_reasons: escalations.map((e) => e.reason).filter((r): r is string => r !== null),
  };
}

/** A stateful per-run emitter: flushNew streams rows journaled since the last call (dedup by
 *  natural key); emitSummary emits the terminal summary. */
export function createTelemetryEmitter(sink: TelemetrySink): {
  flushNew(db: Database, ticketId: number): void;
  emitSummary(db: Database, ticketId: number, result: RunResult): void;
  emitCiHandoff(
    db: Database,
    ticketId: number,
    h: {
      prRef: string | null;
      prUrl: string | null;
      sha: string | null;
      checksSystem: string;
      read: "passing" | "failing" | "pending" | "not-reported" | "skipped";
    },
  ): void;
} {
  // Monotonic watermarks instead of growing seen-sets: each tick scans only rows newer than the
  // last, so total work is ~O(rows) over a run rather than O(ticks × rows).
  let lastEventSeq = 0;
  let lastDispatchId = 0;
  let lastSignalId = 0;
  // Read the run row once (lazy) and cache it — run identity is constant for the run's lifetime.
  let ctx: RunCtx | null = null;
  const ensureCtx = (db: Database): RunCtx => {
    if (ctx === null) ctx = runCtx(db);
    return ctx;
  };
  return {
    flushNew(db, ticketId) {
      const c = ensureCtx(db);
      for (const r of listEventsSince(db, ticketId, lastEventSeq)) {
        sink(toEvent(r, c));
        lastEventSeq = r.seq;
      }
      // A dispatch is created and completed within one tick, so a row past the watermark is already
      // ended on the common path; advance the watermark regardless and emit only ended rows (an
      // abandoned/failed dispatch with no ended_at is correctly never emitted — and never re-scanned).
      for (const d of listDispatchesSince(db, ticketId, lastDispatchId)) {
        lastDispatchId = d.id;
        if (d.ended_at !== null) sink(toDispatch(d, c));
      }
      for (const s of listSignalsSince(db, ticketId, lastSignalId)) {
        sink(toSignal(s, c));
        lastSignalId = s.id;
      }
    },
    emitSummary(db, ticketId, result) {
      sink(buildSummary(db, ticketId, result));
    },
    // The ONE deliberate push-style emit (the other members are derived from SoT rows by flushNew).
    // Justified: the handoff is an external network fact captured at the terminal, not a SoT row —
    // it feeds no control flow (CL-INV-6 safe) and writes nothing to the DB (CL-INV-7 safe), so the
    // derived-from-row pattern buys nothing and would cost a row-write + a derive fn. Best-effort,
    // lossy, dup-on-resume — squarely inside the §5.3 telemetry contract.
    emitCiHandoff(db, ticketId, h) {
      const c = ensureCtx(db);
      const ticket = getTicket(db, ticketId);
      sink({
        schema_version: SCHEMA_VERSION,
        type: "ci_handoff",
        run_id: c.runId,
        ticket_id: ticketId,
        ident: ticket?.ident ?? "",
        pr_ref: h.prRef,
        pr_url: h.prUrl,
        branch_head_sha: h.sha,
        checks_system: h.checksSystem,
        read: h.read,
        measured_at: nowUtc(),
      });
    },
  };
}
