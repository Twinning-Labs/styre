import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
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
import { type AgentCliPreflight, preflightAgentCli } from "../agent/preflight.ts";
import { resolveAgentRunner } from "../agent/resolve.ts";
import type { AgentRunner } from "../agent/runner.ts";
import { type AgentConfig, DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { stateDir } from "../config/paths.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { adoptActiveTickets } from "../daemon/adopt.ts";
import { currentManifest } from "../daemon/design-digests.ts";
import { stepRow } from "../daemon/design-graph.ts";
import { captureOtherActiveTickets, captureSnapshot } from "../daemon/design-inputs.ts";
import { newerSchemeIn, newerSchemeRecorded, newerSchemeRefusal } from "../daemon/design-walk.ts";
import { pauseTicket } from "../daemon/pause-ticket.ts";
import { makeProjectorPorts } from "../daemon/ports.ts";
import type { ProjectorPorts } from "../daemon/projector.ts";
import { recover } from "../daemon/recover.ts";
import {
  type ReviewResumePlan,
  applyReviewResume,
  planReviewResume,
} from "../daemon/review-resume.ts";
import { createRunEnd, driveToTerminal, formatRunSummary } from "../daemon/run-ticket.ts";
import type { PauseReason, RunOutcome } from "../daemon/run-ticket.ts";
import type { StepRegistry } from "../daemon/step-registry.ts";
import { resumeVerificationRetries } from "../daemon/verification-retry.ts";
import { openDb } from "../db/client.ts";
import { type DatabaseState, migrate, readDatabaseState } from "../db/migrate.ts";
import { CURRENT_VERSION } from "../db/migrations/index.ts";
import { readCopyOf } from "../db/read-copy.ts";
import {
  findCheckpointParkedStepKey,
  findCheckpointTicket,
  listCheckpointIdents,
  readCheckpointTargetRepo,
} from "../db/repos/checkpoint-read.ts";
import { getLatestForTicket, getLatestWorktreePath } from "../db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { getProject } from "../db/repos/project.ts";
import { requeueFailedForge } from "../db/repos/projection-outbox.ts";
import { getRun, insertRun, markResumed } from "../db/repos/run.ts";
import { listPending, markConsumed } from "../db/repos/signal.ts";
import { getInput } from "../db/repos/ticket-input.ts";
import { getTicket, setTicketStatus } from "../db/repos/ticket.ts";
import { getByKey as getStep, listByStatus } from "../db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../dispatch/handlers.ts";
import type { Profile } from "../dispatch/profile.ts";
import { recordUnusableComponents, resetProvision } from "../dispatch/provision.ts";
import type { ResumeContext } from "../dispatch/run-dispatch.ts";
import { branchHeadSha, reconcileWorktree } from "../dispatch/worktree.ts";
import type { ParkInfo } from "../engine/park-signal.ts";
import { stdoutSink } from "../telemetry/emit.ts";
import { RunInterrupted, isStopping } from "../util/process/door.ts";
import type { HandlerCtx } from "../util/process/signals.ts";
import { nowUtc } from "../util/time.ts";
import { checkpointPath } from "./checkpoint-name.ts";
import type { NonPrimaryComponent } from "./component-roles.ts";
import { EXIT, StyreError, agentCliError, usageError } from "./errors.ts";
import { exitCodeForOutcome } from "./outcome.ts";
import { formatMessage } from "./output.ts";
import {
  type UnusableComponent,
  resumePauseReason,
  toolchainDecision,
  toolchainNotice,
} from "./preflight.ts";
import { confirmPrBase } from "./resolve-pr-base.ts";
import { type RunLock, acquireRunLock, releaseRunLock } from "./run-lock.ts";

/** How `styre run` hands the stop handler (ENG-485 section 7) what it needs: the run once its
 *  database and ticket row exist, and the run lock while it is held. */
export interface StopWiring {
  setRun(r: HandlerCtx["run"]): void;
  holdLock(lock: RunLock | null): void;
}

/**
 * Handle the terminal result of a `styre run` after `runTicket`/`driveToTerminal` returns.
 * Mirrors the inline tail of `src/cli/run.ts` so the same code path is exercised in tests.
 *
 * - paused(budget) with a park: calls `dumpPark` (which closes db), sets `process.exitCode = 75`,
 *   returns.
 * - paused(needs_you | interrupted): closes db, sets `process.exitCode = 75` (resumable-later, but
 *   it writes no dump — it takes the plain `db.close()` path below; dumping a needs_you pause is
 *   ENG-385's job).
 * - abandoned: closes db, sets `process.exitCode = 1` (via `exitCodeForOutcome`), returns — this
 *   is an operational stop, not a bug, so it must not throw a stack trace.
 * - otherwise (pr-ready | done): closes db, sets `process.exitCode = 0`, returns.
 *
 * The human-readable resume-hint line (`Resume with: styre run --resume …`) is intentionally
 * left in `run.ts` because it requires `args.profile` which we don't want to thread here.
 */
export function finishRunResult(
  db: Database,
  dbPath: string,
  slug: string,
  ident: string,
  out: { outcome: RunOutcome; reason?: PauseReason; park?: ParkInfo },
): void {
  if (out.outcome === "paused" && out.reason === "budget" && out.park) {
    dumpPark(db, dbPath, slug, ident, out.park, "run: "); // closes db
    process.exitCode = exitCodeForOutcome("paused"); // 75
    return;
  }
  db.close();
  process.exitCode = exitCodeForOutcome(out.outcome); // 0 pr-ready/done · 75 paused · 1 abandoned
}

/** The durable dump dir for a paused run: ~/.local/state/styre/<project-stub>/<ticket-ident>/.
 *  Both names are checked first (operator rulings, 2026-10-10): every checkpoint path a fresh run,
 *  a resume and a pause build goes through here. */
export function parkDir(slug: string, ident: string): string {
  return checkpointPath(stateDir(), slug, ident);
}

/** The run_id in an existing paused copy's run.db, read through a private copy (operator ruling,
 *  2026-10-09): null when the file is absent or predates the run table (from before the upgrade).
 *  Throws when the file exists but cannot be read, so dumpPark says so instead of skipping its
 *  warning. */
export function priorRunIdAt(destPath: string): string | null {
  if (!existsSync(destPath)) return null;
  return readCopyOf(destPath, (db) => {
    const hasRun =
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run'").get() !== null;
    if (!hasRun) return null; // a copy from before the run table: no run identity was ever minted
    return (
      db.query<{ run_id: string }, []>("SELECT run_id FROM run ORDER BY id LIMIT 1").get()
        ?.run_id ?? null
    );
  });
}

/** Persist the paused run so `styre run --resume` can rehydrate it exactly:
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
  prefix: "run: " | "resume: ",
): string {
  const dir = parkDir(slug, ident);
  mkdirSync(dir, { recursive: true });
  const currentRunId = getRun(db)?.run_id ?? null; // read before we close db
  // The step the park left running: its key, its generation, and for a table step its inputs, scope
  // the carryover (spec §6.5). The run's own ticket, found by its ident (operator ruling, 2026-10-10):
  // on a reused --db other tickets share the database.
  const own = findCheckpointTicket(db, ident).ticket;
  const parked = own ? listByStatus(db, "running").find((s) => s.ticket_id === own.id) : undefined;
  const parkedGeneration = parked?.generation ?? null;
  const parkedRow = parked ? stepRow(parked.step_key) : undefined;
  const parkedManifest =
    parked && parkedRow ? currentManifest(db, parked.ticket_id, parkedRow) : null;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); // fold WAL into the main file before copy
  db.close();
  const destPath = join(dir, "run.db");
  // Skip the copy when resuming in-place: dbPath and destPath are the same file (re-park from
  // an existing dump — the DB is already at the correct location, no copy needed).
  if (dbPath !== destPath) {
    let prior: string | null = null;
    try {
      prior = priorRunIdAt(destPath);
    } catch (err) {
      // Said, not skipped: the copy about to be overwritten could not be read.
      process.stderr.write(
        `${prefix}could not read the paused run at ${destPath} before overwriting it: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (prior !== null && currentRunId !== null && prior !== currentRunId) {
      process.stderr.write(`overwriting paused run ${prior} with ${currentRunId} for ${ident}\n`);
    }
    copyFileSync(dbPath, destPath);
  }
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({
      dispatchId: park.dispatchId,
      cause: park.cause,
      resetAt: park.resetAt,
      transcript: park.transcript,
      stepKey: parked?.step_key ?? null,
      generation: parkedGeneration,
      manifest: parkedManifest,
    }),
  );
  return dir;
}

/** On resume, a fresh `worktreeRoot` is minted and the paused run's worktree is wiped (see the
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

/** The resumed run's own ticket, by its ident, the checkpoint folder's name (spec §4, operator
 *  ruling 2026-10-10): a checkpoint written by a run on a reused --db holds other tickets too, with
 *  lower ids. One without that ticket is refused (exit 65), never resumed as another ticket. */
function ownTicketId(db: Database, ident: string, dir: string): number {
  const { ticket, reason } = findCheckpointTicket(db, ident);
  if (!ticket) throw noOwnTicket(ident, dir, reason, listCheckpointIdents(db));
  return ticket.id;
}

/** Never suggests `--fresh`: on a filesystem that ignores case (macOS by default) `--resume eng-1`
 *  reaches the `ENG-1` folder, and a fresh run of the tracker's `ENG-1` would discard that paused
 *  run. It names the idents the checkpoint holds instead, so the operator can resume the right one. */
function noOwnTicket(ident: string, dir: string, reason: string, held: string[]): StyreError {
  const holds =
    held.length === 0
      ? "This checkpoint holds no ticket."
      : `This checkpoint holds: ${[...new Set(held)].join(", ")}.`;
  return new StyreError({
    code: EXIT.RESUME_REFUSED,
    headline: `resume refused: the checkpoint at ${dir} holds no run of ${ident} (${reason})`,
    recovery: `Nothing was changed. Ticket idents are case sensitive. ${holds} To resume, run styre run --resume with the ident exactly as the checkpoint holds it.`,
  });
}

export interface ResumeArgs {
  resume: string; // ticket ident
  acceptHead?: boolean;
  reviewAction?: string;
  reviewFindings?: string;
  reviewReason?: string;
  inspect?: boolean;
}

/** What the resumed run's registry is built from (spec §4.1): the profile after the toolchain
 *  narrowing, and the lists of what was narrowed away, so provision reports them (ENG-412, ENG-425). */
export interface ResumeRegistryWiring {
  profile: Profile;
  unusableComponents: UnusableComponent[];
  nonPrimaryComponents: NonPrimaryComponent[];
  inPlace: boolean;
  worktreeRoot: string;
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

/** `--inspect` on any checkpoint, whatever its version (operator rulings, 2026-10-09 and
 *  2026-10-10): read through a private copy, with the readers that work on every shape since v7
 *  (spec §7.7). It writes nothing to the database: no migration, no backup, no run row, and the
 *  original is never opened; so it also works where resume would refuse. */
export function inspectWithoutUpgrading(
  dbPath: string,
  ident: string,
  state: DatabaseState,
): string {
  let details: string;
  let newer = "";
  try {
    // A private copy (operator ruling, 2026-10-09): the checkpoint itself is never opened.
    details = readCopyOf(dbPath, (db) => {
      // When resume would refuse a run fingerprinted under a newer scheme, say so (Task 13).
      const found = state.kind === "current" ? newerSchemeIn(db) : null;
      if (found !== null)
        newer = `; resume would refuse it: this run was recorded by a newer Styre (fingerprint scheme ${found.scheme}); use that version`;
      // the run's own ticket, by its ident (spec §4, operator ruling 2026-10-10)
      const { ticket, reason } = findCheckpointTicket(db, ident);
      if (!ticket) return `  resume would refuse this checkpoint: ${reason}\n`;
      const targetRepo = readCheckpointTargetRepo(db, ticket.project_id);
      if (!targetRepo) return `  (no project recorded for ${ident})\n`;
      const recorded = headBaseline(db, ticket.id);
      const current = branchHeadSha(targetRepo, branchNameFor(ticket));
      const moved = recorded !== null && current !== null && recorded !== current;
      return (
        `  recorded base: ${recorded ?? "(none)"}\n  current head:  ${current ?? "(none)"}${moved ? "  [MOVED]" : ""}\n` +
        `  would re-dispatch step: ${findCheckpointParkedStepKey(db, ticket.id) ?? "(none)"}\n`
      );
    });
  } catch (err) {
    details = `  (the rest cannot be read on this shape: ${err instanceof Error ? err.message : String(err)})\n`;
  }
  const schema =
    state.kind === "upgrade"
      ? `resume will upgrade this checkpoint from v${state.version} to v${CURRENT_VERSION}, after writing a backup`
      : state.kind === "refuse"
        ? `resume would refuse this checkpoint: ${state.error.headline}`
        : state.kind === "empty"
          ? "the checkpoint holds no tables"
          : `v${state.version}, current${newer}`;
  return `resume --inspect ${ident}\n  schema: ${schema}\n${details}  (no changes made)\n`;
}

export async function resumeRun(
  args: ResumeArgs,
  profile: Profile,
  runtimeConfig: RuntimeConfig,
  deps?: {
    buildRegistry?: (
      resumeContext: ResumeContext | undefined,
      wiring: ResumeRegistryWiring,
    ) => StepRegistry;
    ports?: ProjectorPorts;
    preflight?: (config: AgentConfig) => AgentCliPreflight;
    /** The agent runner for the default registry (tests); the configured provider otherwise. */
    runner?: AgentRunner;
    /** The stop handler `styre run` installed (section 7.1). */
    stop?: StopWiring;
    probe?: (repoDir: string, command: string) => boolean;
  },
  /** ENG-435: components role-classification removed from `profile`, so a RESUMED run reports
   *  the narrowing in its PR the same way a fresh one does. `profile` arrives already narrowed
   *  (see `loadRunProfile`); without this the resume path would narrow SILENTLY, which is the
   *  one thing ENG-425's contract forbids — and it is the path ENG-425 originally missed.
   *  Last, with a default, so existing callers are untouched. */
  nonPrimaryComponents: NonPrimaryComponent[] = [],
): Promise<void> {
  // A stop that began before the resume (during an earlier await) leaves the checkpoint as it is.
  // From here to the handler's setRun below the code is synchronous, so none can begin between.
  if (isStopping()) throw new RunInterrupted();
  const dir = parkDir(profile.slug, args.resume);
  const dbPath = join(dir, "run.db");
  if (!existsSync(dbPath)) {
    throw usageError(
      `no paused run at ${dbPath}`,
      "Check the ticket ident, or start fresh: styre run <ticket>.",
    );
  }
  // Acquire the per-ticket run lock before any db is opened (fresh path parity, run.ts:253) —
  // two concurrent `--resume` of the same ticket would otherwise open the same live-location
  // run.db and corrupt it. Taken before migrate/openDb so a held lock has nothing to close.
  const lock = acquireRunLock(dir);
  if (lock === null) {
    process.stderr.write(
      `resume refused: another 'styre run ${args.resume}' is already in progress (${dir}/run.lock).\n  Wait for it to finish, or remove the stale lock if that process is gone.\n`,
    );
    process.exitCode = 65; // EXIT.RESUME_REFUSED — no db opened yet, nothing to close
    return;
  }
  deps?.stop?.holdLock(lock);
  try {
    // --inspect is diagnostics only, whatever the checkpoint's version (operator rulings,
    // 2026-10-09 and 2026-10-10): it reads a private copy and writes nothing to the database (no
    // migration, no backup, no open of the original, no insertRun or markResumed). The run lock,
    // a file beside the database, is released by the finally below.
    if (args.inspect) {
      let state: DatabaseState;
      try {
        state = readDatabaseState(dbPath);
      } catch (err) {
        process.stderr.write(
          `resume --inspect ${args.resume}\n  schema: cannot be read: ${err instanceof Error ? err.message : String(err)}\n  (no changes made)\n`,
        );
        return;
      }
      process.stderr.write(inspectWithoutUpgrading(dbPath, args.resume, state));
      return;
    }
    // Refused before anything is written (no migration, no backup, no run row): a checkpoint that
    // does not hold this ticket. A schema it cannot use is migrate's refusal, below.
    const before = readDatabaseState(dbPath);
    if (before.kind === "empty") throw noOwnTicket(args.resume, dir, "it holds no tables", []);
    if (before.kind !== "refuse") {
      const found = readCopyOf(dbPath, (db) => ({
        ...findCheckpointTicket(db, args.resume),
        held: listCheckpointIdents(db),
      }));
      if (!found.ticket) throw noOwnTicket(args.resume, dir, found.reason, found.held);
    }
    // A manifest recorded under a newer FINGERPRINT_SCHEME (operator ruling, 2026-10-10): this
    // Styre cannot compare it. Refuse before anything is written, like a HEAD that moved (65).
    const newerScheme = newerSchemeRecorded(dbPath);
    if (newerScheme !== null) {
      process.stderr.write(
        `resume refused: ${newerSchemeRefusal(args.resume, newerScheme.scheme)}`,
      );
      process.exitCode = 65; // EXIT.RESUME_REFUSED, inside the try whose finally releases the lock
      return;
    }
    migrate(dbPath, { log: (line) => process.stderr.write(`${line}\n`) });
    const db = openDb(dbPath);
    if (getRun(db) === null) {
      // Pre-upgrade park: no identity was ever minted — assign a fresh one for the resumed portion.
      insertRun(db, {
        runId: randomUUID(),
        startedAt: nowUtc(),
        provider: (runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG).provider,
      });
    }
    markResumed(db); // same logical run for a v2 park; resumed=1, attempt++
    const ticketId = ownTicketId(db, args.resume, dir);
    const ticket = getTicket(db, ticketId);
    if (!ticket) throw new Error("resume: ticket vanished");
    deps?.stop?.setRun({ db, dbPath, ticketId, ident: ticket.ident });
    // Closes the run's connection on a normal exit only: during a stop the handler reads it (R26).
    const closeDb = (): void => {
      if (isStopping()) return;
      deps?.stop?.setRun(null);
      db.close();
    };
    const project = getProject(db, ticket.project_id);
    if (!project) throw new Error("resume: project missing");
    // Same-container in-place derivation: no schema/dump change — the persisted worktree_path on
    // the latest dispatch IS the signal. In-place there is no separate worktree to wipe/re-mint,
    // and the deps installed by `provision` persist in the repo root across the park.
    const staleWorktreePath = getLatestWorktreePath(db, ticketId);
    const inPlace = staleWorktreePath === project.target_repo;
    const branch = branchNameFor(ticket);
    const parkedStep =
      listByStatus(db, "running").find((s) => s.ticket_id === ticketId) ??
      listByStatus(db, "failed").find((s) => s.ticket_id === ticketId) ??
      null;

    const recorded = headBaseline(db, ticketId);
    const current = branchHeadSha(project.target_repo, branch);
    const moved = recorded !== null && current !== null && recorded !== current;

    if (moved && !args.acceptHead) {
      process.stderr.write(
        `resume refused: branch HEAD moved since the run paused.\n  recorded base: ${recorded}\n  current head:  ${current}\n  would re-dispatch: ${parkedStep?.step_key ?? "(none)"}\n  Re-run with --accept-head to resume against the new HEAD (drops stale transcript),\n  or --inspect to review, or 'styre run ${ticket.ident} --fresh' to start fresh.\n`,
      );
      closeDb();
      process.exitCode = 65;
      return;
    }

    let reviewPlan: ReviewResumePlan;
    try {
      reviewPlan = planReviewResume(db, ticketId, current, moved, {
        action: args.reviewAction,
        findings: args.reviewFindings,
        reason: args.reviewReason,
      });
    } catch (error) {
      process.stderr.write(
        `resume refused: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      closeDb();
      process.exitCode = 65;
      return;
    }

    // Fail fast (no retry burn) if the configured agent CLI is missing or below its supported
    // version — resume dispatches the CLI too (resolveAgentRunner below), and a resume often runs
    // later / on another machine where the CLI may have changed since the park (ENG-326). Placed
    // after the --inspect and resume-refused early-returns so those stay tool-independent, and
    // before any repo mutation or dispatch. Injectable so fake-driven resume tests skip the live CLI.
    const cliPreflight = (deps?.preflight ?? preflightAgentCli)(
      runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG,
    );
    if (!cliPreflight.ok) {
      closeDb();
      throw agentCliError(cliPreflight);
    }
    if (cliPreflight.unauthHint) process.stderr.write(`resume: ${cliPreflight.unauthHint}\n`);

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
      const { assertInPlaceMarker, assertInPlaceIdentity } = await import(
        "../dispatch/in-place.ts"
      );
      assertInPlaceMarker(project.target_repo); // language-agnostic disposability re-check before checkout -B
      await assertInPlaceIdentity(project.target_repo, profile);
      if (isStopping()) throw new RunInterrupted();
    }

    // Confirm the PR base on the forge before the reconcile and the resume transaction below, so a
    // forge failure leaves the checkpoint exactly as it was paused (after the in-place block, which
    // re-applies profile.targetRepo for the forge ports).
    const ports: ProjectorPorts = deps?.ports ?? makeProjectorPorts(runtimeConfig, profile);
    try {
      await confirmPrBase(ports, profile);
    } catch (error) {
      closeDb();
      throw error;
    }
    if (isStopping()) throw new RunInterrupted();

    // Mint the resumed run's worktree root once (in-place reuses the repo root) so the stale-worktree
    // reconcile and the dispatch registry below share it — and reconcile knows the real new target.
    const worktreeRoot = inPlace ? project.target_repo : mkdtempSync(join(tmpdir(), "styre-wt-"));
    const targetWorktreePath = inPlace ? project.target_repo : join(worktreeRoot, ticket.ident);

    // --- Stale-worktree cleanup (Fix B → reconcileWorktree, ENG-381; pid-liveness, ENG-382) ---
    // The paused run left its worktree checked out; git refuses `worktree add -B <branch>`
    // while the branch is held. reconcileWorktree removes THIS ticket's own prior worktree and prunes
    // dangling refs, refusing a live/foreign holder it can't prove stale (never a blind force-remove).
    // `dir` (this ticket's checkpoint dir) lets it consult the run lock: a DIFFERENT live run owning
    // the ticket → refuse outright; a dead-owner styre worktree → free it. In-place: the repo root IS
    // the worktree, so there is nothing separate to reconcile.
    if (!inPlace && staleWorktreePath) {
      reconcileWorktree(project.target_repo, branch, staleWorktreePath, targetWorktreePath, dir);
    }

    // Worktree mode: the worktree above is gone (wiped/rebuilt fresh below) — any deps a succeeded
    // `provision` step installed are gone with it. Re-arm provision so it re-runs before the next
    // verify. In-place: the repo root is never wiped, so the deps persist — resetting here would
    // needlessly discard the reuse payoff (re-running provision for no reason).
    if (
      reviewPlan.kind !== "none" &&
      branchHeadSha(project.target_repo, branch) !== reviewPlan.head
    ) {
      process.stderr.write(
        "resume refused: branch HEAD changed while preparing review resume; inspect and retry\n",
      );
      closeDb();
      process.exitCode = 65;
      return;
    }
    let resumeContext: ResumeContext | undefined;
    db.transaction(() => {
      if (!inPlace) {
        resetProvisionForResume(db, ticketId);
      }

      // Consume any pending human_resume BEFORE driveToTerminal — else hasPendingHumanResume
      // (run-ticket.ts:113) fires on the first tick and instantly re-pauses. Budget/interrupted
      // checkpoints have no such signal and fall through untouched. (No reset-time gate — resetAt is
      // free text, see the plan header; a still-out-of-budget run simply re-pauses.)
      for (const s of listPending(db, ticketId).filter((s) => s.signal_type === "human_resume")) {
        markConsumed(db, s.id);
      }

      setTicketStatus(db, ticketId, "active");
      if (moved && args.acceptHead) {
        appendEvent(db, { ticketId, kind: "resumed", reason: `accept-head:${current}` });
        // carryover dropped: the operator changed the base, so the transcript is untrustworthy
      } else {
        if (parkedStep && existsSync(join(dir, "transcript.json"))) {
          const tj = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as {
            transcript: string;
            stepKey?: string | null;
            generation?: number | null;
            manifest?: Record<string, string> | null;
          };
          resumeContext = {
            stepKey: parkedStep.step_key,
            // A transcript written before ENG-477 records no step, generation or manifest: it
            // belongs to the parked step as it is now.
            writtenBy: tj.stepKey ?? null,
            transcript: tj.transcript,
            generation: tj.generation ?? parkedStep.generation,
            manifest: tj.manifest ?? null,
          };
        }
        appendEvent(db, { ticketId, kind: "resumed", reason: "resume" });
      }

      applyReviewResume(db, ticketId, runtimeConfig, reviewPlan);
      resumeVerificationRetries(db, ticketId);
      requeueFailedForge(db, ticketId, profile.defaultBranch, current);
    })();

    // Resets the interrupted 'running' step to pending. A recorded interruption is free: its attempt
    // was given back, in-place edits are undone, and the branch returns to where the step started
    // when that is safe (ENG-485 section 7.5). The old worktree is already gone (reconcile above),
    // and the new one is created only when the step runs, so a worktree branch can move here.
    recover(db, {
      inPlace,
      repoPath: project.target_repo,
      branch,
      acceptHead: args.acceptHead === true,
      warn: (line) => process.stderr.write(`${line}\n`),
    });
    // spec §4.1: the same toolchain narrowing as a fresh run, here: after --inspect, after the resume
    // transaction (a pause written before it would be consumed by it) and recover(), before the
    // snapshot. Never exit 69: where the fresh gate would refuse, pause for the operator instead.
    // A ticket the resume transaction already left waiting (a plan review gate stop applied again)
    // gets no second pause: one human_resume and one escalation are enough (operator ruling,
    // 2026-10-09). The tool gap is still recorded, as a note, and said as what it is.
    const toolchain = toolchainDecision(profile, deps?.probe);
    if (toolchain.kind === "refuse") {
      const reason = resumePauseReason(toolchain.blocking);
      if (getTicket(db, ticketId)?.status === "waiting") {
        appendEvent(db, {
          ticketId,
          kind: "note",
          reason: "toolchain-missing",
          payload: { event: "toolchain-missing", detail: reason },
        });
        process.stderr.write(`resume: paused: the run is already waiting for you, and ${reason}\n`);
      } else {
        pauseTicket(db, ticketId, reason);
        process.stderr.write(`resume: paused: ${reason}\n`);
      }
      // Ends like every other needs_you pause (driveToTerminal's finish): the events and the
      // summary on stdout, the notifier's sweep, the outbox drained. No step ran: zero ticks.
      const now = getTicket(db, ticketId);
      const paused = await createRunEnd(db, {
        ticketId,
        config: runtimeConfig,
        ports,
        emit: stdoutSink,
      }).finish({
        outcome: "paused",
        reason: "needs_you",
        iterations: 0,
        stage: now?.stage ?? ticket.stage,
        status: now?.status ?? ticket.status,
      });
      // A stop that began during the drain: as after driveToTerminal, nothing below may run.
      if (isStopping()) throw new RunInterrupted();
      process.stderr.write(`${formatRunSummary(db, ticketId, paused)}\n`);
      closeDb();
      process.exitCode = exitCodeForOutcome(paused.outcome); // 75, needs_you
      return;
    }
    const runProfile = toolchain.profile;
    if (toolchain.unusable.length > 0) {
      process.stderr.write(`resume: ${toolchainNotice(toolchain.unusable, runProfile)}\n`);
    }

    // spec §4: after recover() and the provision reset, before the first resolver pass, the profile
    // and config rows are rewritten from what the handlers will receive now. The ticket text and the
    // starting commit never are (E2).
    // One transaction (captureSnapshot's own nests in it as a savepoint): the prior list read, the
    // new snapshot rows, their `inputs-changed` note and the toolchain advisory commit together or
    // not at all. A crash between two commits would leave the new list recorded without its
    // advisory, and the next resume, seeing no change, would never record it.
    db.transaction(() => {
      const priorUnusable = getInput(db, ticketId, "run.unusableComponents");
      const snapshot = captureSnapshot(db, ticketId, {
        profile: runProfile,
        unusableComponents: toolchain.unusable,
        nonPrimaryComponents,
        config: runtimeConfig,
      });
      // ENG-412, never silent: provision records what the narrowing skipped, but it runs again
      // only where its step is not already done (worktree mode resets it above; in place it stays
      // done). When this host's list changed and provision will not run again, the runner records
      // it here, through provision's own writer, so the PR's advisory block names it all the same.
      const unusableChanged =
        priorUnusable === null || snapshot.changed.includes("run.unusableComponents");
      if (unusableChanged && getStep(db, ticketId, "provision")?.status === "succeeded") {
        recordUnusableComponents(db, ticketId, toolchain.unusable);
      }
    })();
    // Operator ruling, 2026-10-10 (spec §4): a checkpoint written by a run on a reused --db holds
    // that database's other active tickets, which this resume's loop drives with this registry. Each
    // gets the same snapshot, with the same note, after a `reused-database` note (the `resumed`
    // event above is this run's own ticket's; for the others the checkpoint is a reused database);
    // no starting commit and no toolchain advisory (that stays this run's own ticket's, above).
    // Waiting tickets are left alone.
    captureOtherActiveTickets(db, ticketId, {
      profile: runProfile,
      unusableComponents: toolchain.unusable,
      nonPrimaryComponents,
      config: runtimeConfig,
    });
    // spec §7.6: after every snapshot, before the first resolver pass; this ticket and every other
    // active one, as runTicket does on a reused --db.
    adoptActiveTickets(db, ticketId);

    const wiring: ResumeRegistryWiring = {
      profile: runProfile,
      unusableComponents: toolchain.unusable,
      nonPrimaryComponents,
      inPlace,
      worktreeRoot, // minted once above (in-place = repo root), shared with the reconcile
    };
    const registry: StepRegistry = deps?.buildRegistry
      ? deps.buildRegistry(resumeContext, wiring)
      : buildDispatchRegistry({
          runner: deps?.runner ?? resolveAgentRunner(runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG),
          agentConfig: runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG,
          ...wiring,
          resumeContext,
        });

    const result = await driveToTerminal(db, registry, {
      ticketId,
      config: runtimeConfig,
      ports,
      profile: runProfile,
      emit: stdoutSink,
      // ENG-485 section 7.5: where the ticket branch stands when each step starts.
      readHead: () => branchHeadSha(project.target_repo, branch),
    });
    // A step that finished during a stop is not recorded (section 7.5): nothing below may run.
    if (isStopping()) throw new RunInterrupted();
    process.stderr.write(`${formatRunSummary(db, ticketId, result)}\n`);

    if (result.outcome === "paused" && result.reason === "budget" && result.park) {
      deps?.stop?.setRun(null); // a normal exit: dumpPark closes the db
      dumpPark(db, dbPath, profile.slug, ticket.ident, result.park, "resume: "); // re-dump (closes db)
      process.stderr.write(
        `${formatMessage("run", `Paused again — out of budget: ${result.park.cause}. Checkpoint: ${dir}`)}\n`,
      );
      process.exitCode = exitCodeForOutcome("paused"); // 75
      return;
    }
    closeDb();
    process.exitCode = exitCodeForOutcome(result.outcome); // 0 pr-ready/done · 75 paused · 1 abandoned
  } finally {
    // During a stop the handler releases the lock, last (R7); the run code leaves it alone.
    if (!isStopping()) {
      deps?.stop?.holdLock(null);
      releaseRunLock(lock);
    }
  }
}
