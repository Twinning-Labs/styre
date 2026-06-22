import type { Database } from "bun:sqlite";
import type { RunResult } from "../daemon/run-ticket.ts";
import { listByTicket as listDispatches } from "../db/repos/dispatch.ts";
import type { DispatchRow } from "../db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";
import type { EventLogRow } from "../db/repos/event-log.ts";
import { listByTicket as listSignals } from "../db/repos/ground-truth-signal.ts";
import type { GroundTruthSignalRow } from "../db/repos/ground-truth-signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import type { TelemetrySink } from "./emit.ts";
import { SCHEMA_VERSION, type TelemetryEvent } from "./events.ts";

function toEvent(r: EventLogRow): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "event",
    ticket_id: r.ticket_id,
    seq: r.seq,
    kind: r.kind,
    actor: r.actor,
    from_stage: r.from_stage,
    to_stage: r.to_stage,
    loop: r.loop,
    route_to: r.route_to,
    signature: r.signature,
    reason: r.reason,
    created_at: r.created_at,
  };
}

function toDispatch(r: DispatchRow): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "dispatch",
    dispatch_id: r.dispatch_id,
    ticket_id: r.ticket_id,
    work_unit_id: r.work_unit_id,
    seq: r.seq,
    stage: r.stage,
    kind: r.kind,
    model: r.model,
    outcome: r.outcome,
    branch_head_sha: r.branch_head_sha,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_ms: r.duration_ms,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    cost_usd: r.cost_usd,
  };
}

function toSignal(r: GroundTruthSignalRow): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "signal",
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
  const ticket = getTicket(db, ticketId);
  const events = listEvents(db, ticketId);
  const dispatches = listDispatches(db, ticketId);
  const sum = (ns: Array<number | null>) => ns.reduce((a: number, n) => a + (n ?? 0), 0);
  const dispatch_outcomes: Record<string, number> = {};
  for (const d of dispatches) {
    if (d.outcome) dispatch_outcomes[d.outcome] = (dispatch_outcomes[d.outcome] ?? 0) + 1;
  }
  const escalations = events.filter((e) => e.kind === "escalated");
  return {
    schema_version: SCHEMA_VERSION,
    type: "summary",
    ticket_id: ticketId,
    ident: ticket?.ident ?? "",
    outcome: result.outcome,
    stage: result.stage,
    status: result.status,
    ticks: result.iterations,
    cost_usd: sum(dispatches.map((d) => d.cost_usd)),
    tokens_in: sum(dispatches.map((d) => d.tokens_in)),
    tokens_out: sum(dispatches.map((d) => d.tokens_out)),
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
} {
  let lastEventSeq = 0;
  const seenDispatch = new Set<string>();
  const seenSignal = new Set<number>();
  return {
    flushNew(db, ticketId) {
      for (const r of listEvents(db, ticketId)) {
        if (r.seq > lastEventSeq) {
          sink(toEvent(r));
          lastEventSeq = r.seq;
        }
      }
      for (const d of listDispatches(db, ticketId)) {
        if (d.ended_at !== null && !seenDispatch.has(d.dispatch_id)) {
          sink(toDispatch(d));
          seenDispatch.add(d.dispatch_id);
        }
      }
      for (const s of listSignals(db, ticketId)) {
        if (!seenSignal.has(s.id)) {
          sink(toSignal(s));
          seenSignal.add(s.id);
        }
      }
    },
    emitSummary(db, ticketId, result) {
      sink(buildSummary(db, ticketId, result));
    },
  };
}
