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
import { resolveAgentRunner } from "../agent/resolve.ts";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { stateDir } from "../config/paths.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { makeProjectorPorts } from "../daemon/ports.ts";
import type { ProjectorPorts } from "../daemon/projector.ts";
import { realRecoverDeps, recover } from "../daemon/recover.ts";
import { driveToTerminal, formatRunSummary } from "../daemon/run-ticket.ts";
import type { StepRegistry } from "../daemon/step-registry.ts";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { getLatestForTicket, getLatestWorktreePath } from "../db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { getProject } from "../db/repos/project.ts";
import { getTicket, setTicketStatus } from "../db/repos/ticket.ts";
import { listByStatus } from "../db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../dispatch/handlers.ts";
import type { Profile } from "../dispatch/profile.ts";
import { resetProvision } from "../dispatch/provision.ts";
import { branchHeadSha, removeWorktree } from "../dispatch/worktree.ts";
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
  const destPath = join(dir, "run.db");
  // Skip the copy when resuming in-place: dbPath and destPath are the same file (re-park from
  // an existing dump — the DB is already at the correct location, no copy needed).
  if (dbPath !== destPath) {
    copyFileSync(dbPath, destPath);
  }
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

/** On resume, a fresh `worktreeRoot` is minted and the parked worktree is wiped (see the
 *  stale-worktree cleanup above) — so any deps a succeeded `provision` step installed are gone.
 *  But the journaled step is still 'succeeded', so the resolver's `done("provision")` gate would
 *  skip re-running it, and post-resume verify would run against an un-provisioned tree. Reset the
 *  step to 'pending' (and zero its `attempt`, since a wiped worktree isn't a retry of the prior
 *  attempt) so the resolver's `!done("provision")` gate re-fires before the next verify.
 *
 *  This is the same reset the Task-9 manifest-touch hook needs (a loopback editing a dependency
 *  manifest also invalidates a succeeded provision) — the logic lives in `dispatch/provision.ts`
 *  as `resetProvision` and is re-exported here under its resume-specific name so callers/tests of
 *  this module are unaffected. */
export const resetProvisionForResume = resetProvision;

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

/** The HEAD-guard baseline: the most recent of {latest `accept-head:` resumed event, latest
 *  dispatch row with a non-null branch_head_sha}, compared by `created_at` recency.
 *
 *  Rationale: after `--accept-head` records `accept-head:shaA`, the resumed dispatch commits and
 *  advances the branch to shaB.  If the run parks again and the operator runs plain `--resume`,
 *  the guard must compare against shaB (the sha Styre itself committed), not the stale shaA.
 *  Whichever source is newer wins: a committed sha whose row is newer than the accept event means
 *  Styre moved the branch itself → use the committed sha; an accept event that is newer means the
 *  operator explicitly accepted a new HEAD → use the accepted sha. */
export function headBaseline(db: Database, ticketId: number): string | null {
  const accepted = listEvents(db, ticketId)
    .filter((e) => e.kind === "resumed" && (e.reason?.startsWith("accept-head:") ?? false))
    .at(-1);
  const dispatch = getLatestForTicket(db, ticketId);

  if (accepted?.reason && dispatch?.branch_head_sha) {
    // Both exist: pick the sha from whichever source has the later created_at.
    const acceptedNewer = accepted.created_at >= dispatch.created_at;
    return acceptedNewer ? accepted.reason.slice("accept-head:".length) : dispatch.branch_head_sha;
  }
  if (accepted?.reason) return accepted.reason.slice("accept-head:".length);
  return dispatch?.branch_head_sha ?? null;
}

export async function resumeRun(
  args: ResumeArgs,
  profile: Profile,
  runtimeConfig: RuntimeConfig,
  deps?: {
    buildRegistry?: (
      resumeContext: { stepKey: string; transcript: string } | undefined,
    ) => StepRegistry;
    ports?: ProjectorPorts;
  },
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
  // Same-container in-place derivation: no schema/dump change — the persisted worktree_path on
  // the latest dispatch IS the signal. In-place there is no separate worktree to wipe/re-mint,
  // and the deps installed by `provision` persist in the repo root across the park.
  const staleWorktreePath = getLatestWorktreePath(db, ticketId);
  const inPlace = staleWorktreePath === project.target_repo;
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

  // Defense-in-depth (whole-branch review I-2 / Task 3 F1): `assertInPlaceSafe` is NOT reusable on
  // resume (HEAD legitimately sits on the styre branch mid-run in the supported same-container
  // path, and the run's own in-progress commits legitimately dirty the tree), so resume drives
  // `ensureWorktree`'s `checkout -B` with no dirty-tree gate at all. Marker PRESENCE (language-
  // agnostic — unlike the python-only identity probe below) IS the resume gate: a reused park dir
  // whose `target_repo` path happens to collide with a foreign checkout would otherwise let resume
  // hijack it with zero disposability check for a non-python repo. The IDENTITY probe is also
  // reusable: in a foreign checkout the active env's `<pkg>` won't resolve under the repo root, so
  // it fails fast BEFORE the stale-worktree cleanup / dispatch below ever mutates the repo.
  if (inPlace) {
    profile.targetRepo = project.target_repo; // re-apply the discovered override — forge ports read profile.targetRepo
    const { assertInPlaceMarker, assertInPlaceIdentity } = await import("../dispatch/in-place.ts");
    assertInPlaceMarker(project.target_repo); // language-agnostic disposability re-check before checkout -B
    await assertInPlaceIdentity(project.target_repo, profile);
  }

  // --- Stale-worktree cleanup (Fix B) ---
  // The parked run left its worktree checked out. git will refuse `worktree add -B <branch>`
  // if the branch is already checked out in another worktree. Remove it best-effort.
  // In-place: there is no separate worktree — the repo root IS the worktree — so there is
  // nothing stale to remove (and `removeWorktree` already no-ops on worktreePath===repoPath;
  // skipping here also avoids the harmless-but-pointless `git worktree prune`).
  if (!inPlace) {
    if (staleWorktreePath) {
      try {
        removeWorktree(project.target_repo, staleWorktreePath);
      } catch {
        // Already gone / never registered — fine; cleanup must not abort the resume.
      }
      // Belt-and-suspenders: prune dangling worktree refs in git's internal tracking.
      Bun.spawnSync(["git", "worktree", "prune"], { cwd: project.target_repo });
    }
  }

  // Worktree mode: the worktree above is gone (wiped/rebuilt fresh below) — any deps a succeeded
  // `provision` step installed are gone with it. Re-arm provision so it re-runs before the next
  // verify. In-place: the repo root is never wiped, so the deps persist — resetting here would
  // needlessly discard the reuse payoff (re-running provision for no reason).
  if (!inPlace) {
    resetProvisionForResume(db, ticketId);
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

  const ports: ProjectorPorts = deps?.ports ?? makeProjectorPorts(runtimeConfig, profile);

  const registry: StepRegistry = deps?.buildRegistry
    ? deps.buildRegistry(resumeContext)
    : buildDispatchRegistry({
        runner: resolveAgentRunner(runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG),
        agentConfig: runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG,
        profile,
        inPlace,
        // worktreeRoot is unused in-place (any value is inert) — avoid minting a tmpdir for it.
        worktreeRoot: inPlace ? project.target_repo : mkdtempSync(join(tmpdir(), "styre-wt-")),
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
