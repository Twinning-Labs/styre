import type { Database } from "bun:sqlite";
import { outcomeSentence } from "../cli/outcome.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import { type EventLogRow, listByTicket } from "../db/repos/event-log.ts";
import { insertProject } from "../db/repos/project.ts";
import { getDeliveredPayload, listPending } from "../db/repos/signal.ts";
import { getTicket, insertTicket } from "../db/repos/ticket.ts";
import type { Profile } from "../dispatch/profile.ts";
import type { ParkInfo } from "../engine/park-signal.ts";
import { branchPrefixFor } from "../integrations/ticket-source.ts";
import { type TelemetrySink, noopSink } from "../telemetry/emit.ts";
import { createTelemetryEmitter } from "../telemetry/emitter.ts";
import { tick } from "./loop.ts";
import { createNotifier } from "./notify.ts";
import { type ProjectorPorts, drainOutbox } from "./projector.ts";
import type { StepRegistry } from "./step-registry.ts";

export type RunOutcome = "pr-ready" | "done" | "blocked" | "no-progress" | "parked" | "escalated";
export interface RunResult {
  outcome: RunOutcome;
  iterations: number;
  stage: string;
  status: string;
  park?: ParkInfo;
}

const DEFAULT_CAP = 200; // overall iteration budget for one ticket
const IDLE_CAP = 3; // consecutive zero-advance ticks → stalled

type CiRead = "passing" | "failing" | "pending" | "not-reported" | "skipped";

const CI_READ_TIMEOUT_MS = 8_000; // best-effort; never let the t+0 read block the terminal

/** Best-effort t+0 read of remote CI state. NEVER throws and NEVER blocks: any error, TIMEOUT,
 *  unsupported system, or missing sha → "not-reported"; checksSystem "none" → "skipped".
 *  The timeout is load-bearing: ChecksPort.status() (githubChecks) issues unbounded octokit
 *  paginate calls that HANG rather than throw on a slow/unreachable API — a bare try/catch would
 *  not save us, and a hang here would also block finish()'s outbox drain (the outbound PR/Linear
 *  projection), reintroducing the exact idle-burn this design deletes. */
async function readCiState(
  ports: ProjectorPorts,
  checksSystem: string,
  sha: string | null,
  timeoutMs: number = CI_READ_TIMEOUT_MS,
): Promise<CiRead> {
  if (checksSystem === "none") return "skipped";
  if (checksSystem !== "github" || !ports.checks || !sha) return "not-reported";
  const checks = ports.checks;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CiRead>((resolve) => {
    timer = setTimeout(() => resolve("not-reported"), timeoutMs);
  });
  try {
    return await Promise.race([checks.status({ ref: sha }), timeout]);
  } catch {
    return "not-reported";
  } finally {
    clearTimeout(timer);
  }
}

/** Drive ONE ticket through repeated ticks until a terminal state. `run` exits at PR-ready (the
 *  ticket parked at merge on human_merge_approval — the PR is open, awaiting the human merge gate
 *  which `run` never delivers). Emits a best-effort `ci_handoff` telemetry snapshot on the
 *  PR-ready path (checks are reported, never gated). */
export async function driveToTerminal(
  db: Database,
  registry: StepRegistry,
  opts: {
    ticketId: number;
    config: RuntimeConfig;
    ports: ProjectorPorts;
    profile: { checksSystem: string };
    cap?: number;
    emit?: TelemetrySink;
    ciReadTimeoutMs?: number;
  },
): Promise<RunResult> {
  const cap = opts.cap ?? DEFAULT_CAP;
  const ciReadTimeoutMs = opts.ciReadTimeoutMs ?? CI_READ_TIMEOUT_MS;
  const emitter = createTelemetryEmitter(opts.emit ?? noopSink);
  const notifier = createNotifier(opts.config);
  const finish = async (result: RunResult): Promise<RunResult> => {
    emitter.flushNew(db, opts.ticketId);
    emitter.emitSummary(db, opts.ticketId, result);
    notifier.sweepNew(db, opts.ticketId); // backstop: the per-tick sweep already caught these; re-sweep in case a terminal enqueued late events
    notifier.notifyTerminal(db, opts.ticketId, result.outcome);
    await drainOutbox(db, opts.ports); // BLOCKER-1 fix: flush the terminal + tail notify rows
    return result;
  };
  let idle = 0;
  let last = { stage: "", status: "" };
  for (let i = 1; i <= cap; i++) {
    const r = await tick(db, registry, {
      config: opts.config,
      ports: opts.ports,
    });
    emitter.flushNew(db, opts.ticketId);
    notifier.sweepNew(db, opts.ticketId);
    const t = getTicket(db, opts.ticketId);
    if (!t) throw new Error(`driveToTerminal: ticket ${opts.ticketId} not found`);
    last = { stage: t.stage, status: t.status };
    const pending = listPending(db, opts.ticketId);

    if (r.parked)
      return await finish({ outcome: "parked", iterations: i, ...last, park: r.parked });
    if (t.status === "done") return await finish({ outcome: "done", iterations: i, ...last });
    if (pending.some((s) => s.signal_type === "human_resume"))
      return await finish({ outcome: "blocked", iterations: i, ...last });
    if (t.stage === "merge" && pending.some((s) => s.signal_type === "human_merge_approval")) {
      const pr = getDeliveredPayload(db, opts.ticketId, "external_pr_result");
      const sha = getLatestForTicket(db, opts.ticketId)?.branch_head_sha ?? null;
      const read = await readCiState(opts.ports, opts.profile.checksSystem, sha, ciReadTimeoutMs);
      emitter.emitCiHandoff(db, opts.ticketId, {
        prRef: typeof pr?.ref === "string" ? pr.ref : null,
        prUrl: typeof pr?.url === "string" ? pr.url : null,
        sha,
        checksSystem: opts.profile.checksSystem,
        read,
      });
      return await finish({ outcome: "pr-ready", iterations: i, ...last });
    }
    // A resolver dead-end ('blocked': no actionable unit and not all verified) is terminal, not a
    // stall to grind on — surface it immediately rather than spinning to the iteration cap.
    if (r.blocked) return await finish({ outcome: "blocked", iterations: i, ...last });

    if (r.advanced === 0) {
      idle += 1;
      if (idle >= IDLE_CAP) return await finish({ outcome: "no-progress", iterations: i, ...last });
    } else {
      idle = 0;
    }
  }
  return await finish({ outcome: "no-progress", iterations: cap, ...last });
}

/** Ingest ONE ticket (read from the tracker) into the SoT, then drive it to a terminal. The single
 *  Linear read happens here, at trigger — never in the control loop. */
export async function runTicket(deps: {
  db: Database;
  profile: Profile;
  runtimeConfig: RuntimeConfig;
  ports: ProjectorPorts;
  registry: StepRegistry;
  ticketRef: string;
  emit?: TelemetrySink;
}): Promise<RunResult & { ticketId: number; summary: string }> {
  const ingested = await deps.ports.issueTracker.fetchTicket(deps.ticketRef);
  const projectId = insertProject(deps.db, {
    slug: deps.profile.slug,
    targetRepo: deps.profile.targetRepo,
    defaultBranch: deps.profile.defaultBranch,
  });
  const ticketId = insertTicket(deps.db, {
    projectId,
    ident: ingested.ident,
    title: ingested.title,
    description: ingested.description,
    typeLabel: ingested.typeLabel,
    branchPrefix: branchPrefixFor(ingested.typeLabel),
    externalId: ingested.externalId,
  });
  const result = await driveToTerminal(deps.db, deps.registry, {
    ticketId,
    config: deps.runtimeConfig,
    ports: deps.ports,
    profile: deps.profile,
    emit: deps.emit,
  });
  return { ...result, ticketId, summary: formatRunSummary(deps.db, ticketId, result) };
}

/** The first `|`-delimited segment of a loopback signature, with a count of the rest — e.g.
 *  `"a:1|b:2|c:3"` → `"a:1 (+2 more)"`. A single-segment signature passes through unchanged. */
function firstSignature(sig: string): string {
  const parts = sig.split("|");
  return parts.length > 1 ? `${parts[0]} (+${parts.length - 1} more)` : (parts[0] ?? sig);
}

/** One legible line per event_log row for the terminal timeline — in particular rendering a
 *  loopback's loop/route/signature instead of the bare word "loopback". */
function timelineLine(e: EventLogRow): string {
  switch (e.kind) {
    case "transition":
      return `transition ${e.from_stage ?? "?"}→${e.to_stage ?? "?"}`;
    case "loopback": {
      const route = e.route_to ? ` → ${e.route_to}` : "";
      const sig = e.signature ? `: ${firstSignature(e.signature)}` : "";
      return `loopback ${e.loop ?? "?"}${route}${sig}`;
    }
    case "escalated":
      return `escalated${e.reason ? ` — ${e.reason}` : ""}`;
    default:
      return `${e.kind}${e.reason ? ` — ${e.reason}` : ""}`;
  }
}

/** A plain-text run summary from the durable SoT: a human outcome sentence, the PR URL on any
 *  outcome that has one, the pending signal name when the ticket is waiting on a human, and a
 *  legible event timeline. Per-step cost/tokens (incl. cache) live on the `dispatch` rows and are
 *  summed into the machine telemetry summary (buildSummary); this human stderr summary
 *  intentionally stays text-only. */
export function formatRunSummary(db: Database, ticketId: number, result: RunResult): string {
  const events = listByTicket(db, ticketId);
  const pr = getDeliveredPayload(db, ticketId, "external_pr_result");
  const prUrl = typeof pr?.url === "string" ? pr.url : undefined;
  const pending = listPending(db, ticketId).map((s) => s.signal_type);
  const lines: string[] = [outcomeSentence(result.outcome)];
  if (prUrl) lines.push(`PR: ${prUrl}`);
  if (pending.length > 0 && result.outcome !== "pr-ready" && result.outcome !== "done") {
    lines.push(`Waiting on: ${pending.join(", ")}`);
  }
  lines.push(`Stage ${result.stage} · ${result.iterations} ticks · ${events.length} events`);
  for (const e of events) lines.push(`  #${e.seq} ${timelineLine(e)}`);
  return lines.join("\n");
}
