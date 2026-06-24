import type { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import { claudeAgentRunner } from "../agent/providers/claude.ts";
import { selectAgentRunner } from "../agent/registry.ts";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { stateDir } from "../config/paths.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { makeProjectorPorts } from "../daemon/ports.ts";
import { realRecoverDeps, recover } from "../daemon/recover.ts";
import { driveToTerminal, formatRunSummary } from "../daemon/run-ticket.ts";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { getProject } from "../db/repos/project.ts";
import { getTicket, setTicketStatus } from "../db/repos/ticket.ts";
import { listByStatus } from "../db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../dispatch/handlers.ts";
import type { Profile } from "../dispatch/profile.ts";
import { branchHeadSha } from "../dispatch/worktree.ts";
import type { ParkInfo } from "../engine/park-signal.ts";
import { stdoutSink } from "../telemetry/emit.ts";

/**
 * Handle the terminal result of a `styre run` after `runTicket`/`driveToTerminal` returns.
 * Mirrors the inline tail of `src/cli/run.ts` so the same code path is exercised in tests.
 *
 * - parked: calls `dumpPark` (which closes db), sets `process.exitCode = 75`, returns.
 * - blocked | no-progress: closes db, throws.
 * - otherwise (pr-ready): closes db, returns.
 *
 * The human-readable resume-hint line (`Resume with: styre run --resume …`) is intentionally
 * left in `run.ts` because it requires `args.profile` which we don't want to thread here.
 */
export function finishRunResult(
  db: Database,
  dbPath: string,
  slug: string,
  ident: string,
  out: { outcome: string; park?: ParkInfo },
): void {
  if (out.outcome === "parked" && out.park) {
    dumpPark(db, dbPath, slug, ident, out.park); // closes db
    process.exitCode = 75;
    return;
  }
  db.close();
  if (out.outcome === "blocked" || out.outcome === "no-progress") {
    throw new Error(`run: ticket ${ident} ended ${out.outcome}`);
  }
}

/** The durable dump dir for a parked run: ~/.local/state/styre/<project-stub>/<ticket-ident>/ */
export function parkDir(slug: string, ident: string): string {
  return join(stateDir(), slug, ident);
}

/** Persist the parked run so `styre run --resume` can rehydrate it exactly:
 *   - run.db: the SoT (checkpointed so the single file is self-contained), with the interrupted
 *     step left 'running' (recover() resets it on resume)
 *   - transcript.json: the dying dispatch's partial stdout, for advisory carryover
 *  The branch commits are already durable in the target repo's git. Returns the dump dir.
 *  NOTE: the caller must NOT have closed `db` yet — this checkpoints then the caller closes. */
export function dumpPark(
  db: Database,
  dbPath: string,
  slug: string,
  ident: string,
  park: ParkInfo,
): string {
  const dir = parkDir(slug, ident);
  mkdirSync(dir, { recursive: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); // fold WAL into the main file before copy
  db.close();
  copyFileSync(dbPath, join(dir, "run.db"));
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({
      dispatchId: park.dispatchId,
      cause: park.cause,
      resetAt: park.resetAt,
      transcript: park.transcript,
    }),
  );
  return dir;
}

/** The single ticket id in a per-run SoT. */
function onlyTicketId(db: Database): number {
  const row = db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get();
  if (!row) throw new Error("resume: the dump DB has no ticket");
  return row.id;
}

export interface ResumeArgs {
  resume: string; // ticket ident
  acceptHead?: boolean;
  inspect?: boolean;
}

/** The HEAD-guard baseline: the most recent operator-accepted head if any, else the last
 *  successful dispatch's branch head (the base the interrupted step started from). */
function headBaseline(db: Database, ticketId: number): string | null {
  const accepted = listEvents(db, ticketId)
    .filter((e) => e.kind === "resumed" && (e.reason?.startsWith("accept-head:") ?? false))
    .at(-1);
  if (accepted?.reason) return accepted.reason.slice("accept-head:".length);
  return getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
}

export async function resumeRun(
  args: ResumeArgs,
  profile: Profile,
  runtimeConfig: RuntimeConfig,
): Promise<void> {
  const dir = parkDir(profile.slug, args.resume);
  const dbPath = join(dir, "run.db");
  if (!existsSync(dbPath)) {
    throw new Error(`resume: no parked run at ${dbPath}`);
  }
  migrate(dbPath);
  const db = openDb(dbPath);
  const ticketId = onlyTicketId(db);
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("resume: ticket vanished");
  const project = getProject(db, ticket.project_id);
  if (!project) throw new Error("resume: project missing");
  const branch = branchNameFor(ticket);
  const parkedStep = listByStatus(db, "running").find((s) => s.ticket_id === ticketId) ?? null;

  const recorded = headBaseline(db, ticketId);
  const current = branchHeadSha(project.target_repo, branch);
  const moved = recorded !== null && current !== null && recorded !== current;

  if (args.inspect) {
    process.stderr.write(
      `resume --inspect ${ticket.ident}\n  recorded base: ${recorded ?? "(none)"}\n  current head:  ${current ?? "(none)"}${moved ? "  [MOVED]" : ""}\n  would re-dispatch step: ${parkedStep?.step_key ?? "(none)"}\n  (no changes made)\n`,
    );
    db.close();
    return;
  }

  if (moved && !args.acceptHead) {
    process.stderr.write(
      `resume refused: branch HEAD moved since the parked attempt.\n  recorded base: ${recorded}\n  current head:  ${current}\n  would re-dispatch: ${parkedStep?.step_key ?? "(none)"}\n  Re-run with --accept-head to resume against the new HEAD (drops stale transcript),\n  or --inspect to review, or 'styre run ${ticket.ident}' to start fresh.\n`,
    );
    db.close();
    process.exitCode = 65;
    return;
  }

  setTicketStatus(db, ticketId, "active");
  let resumeContext: { stepKey: string; transcript: string } | undefined;
  if (moved && args.acceptHead) {
    appendEvent(db, { ticketId, kind: "resumed", reason: `accept-head:${current}` });
    // carryover dropped: the operator changed the base, so the transcript is untrustworthy
  } else {
    if (parkedStep && existsSync(join(dir, "transcript.json"))) {
      const tj = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as {
        transcript: string;
      };
      resumeContext = { stepKey: parkedStep.step_key, transcript: tj.transcript };
    }
    appendEvent(db, { ticketId, kind: "resumed", reason: "resume" });
  }

  recover(db, realRecoverDeps()); // resets the interrupted 'running' step → pending

  const ports = makeProjectorPorts(runtimeConfig, profile);
  const runner = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
    resumeContext,
  });

  const result = await driveToTerminal(db, registry, {
    ticketId,
    config: runtimeConfig,
    ports,
    profile,
    emit: stdoutSink,
  });
  process.stderr.write(`${formatRunSummary(db, ticketId, result)}\n`);

  if (result.outcome === "parked" && result.park) {
    dumpPark(db, dbPath, profile.slug, ticket.ident, result.park); // re-dump (closes db)
    process.stderr.write(`Parked again: ${result.park.cause}. Dump: ${dir}\n`);
    process.exitCode = 75;
    return;
  }
  db.close();
  if (result.outcome === "blocked" || result.outcome === "no-progress") {
    throw new Error(`resume: ticket ${ticket.ident} ended ${result.outcome}`);
  }
}
