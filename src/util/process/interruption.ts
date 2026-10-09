// ENG-485 section 7.3 step 6 and section 7.5: recording an interruption, and matching it on resume.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { branchNameFor } from "../../agent/branch.ts";
import { completeDispatch, getLatestWorktreePath } from "../../db/repos/dispatch.ts";
import { type EventLogRow, appendEvent } from "../../db/repos/event-log.ts";
import { getProject } from "../../db/repos/project.ts";
import { getTicket } from "../../db/repos/ticket.ts";
import * as steps from "../../db/repos/workflow-step.ts";
import type { WorkflowStepRow } from "../../db/repos/workflow-step.ts";
import { undoAttempt } from "../../dispatch/worktree.ts";
import { nowUtc } from "../time.ts";
import { type InFlightStep, type LaunchContext, runBlocking } from "./door.ts";
import { listProcesses, probe } from "./proc-table.ts";

/** Bound for the local git calls below (section 5.1). */
const LOCAL_GIT_MS = 30_000;
/** `reset --hard` writes the whole tree, so it gets the longer bound. */
const TREE_GIT_MS = 120_000;
/** The handler's connection waits this long for a lock; recording takes milliseconds (section 7.4). */
const HANDLER_BUSY_MS = 1_000;

/** The payload of the `note` event with reason `interrupted` (no schema change, section 2.6). */
export interface InterruptionPayload {
  event: "interrupted";
  stepId: number;
  /** The step's attempt AFTER the decrement: the value recover() finds on the step (R6). */
  attempt: number;
  startedAt: string;
  signal: string;
  worktree: string | null;
  untrackedBefore: string[] | null;
  dispatchRowId: number | null;
  headAtStart: string | null;
  headAtStop: string | null;
}

/** Section 7.3 step 6: one synchronous transaction through the handler's OWN connection (the run's
 *  connection is read only by now). It acts only on the step in flight (R5): it gives back the
 *  attempt `markRunning` counted, stores the attempt after that decrement in the same transaction
 *  (R6), and closes the step's open dispatch row as `interrupted`. With no step in flight it writes
 *  only the event. Returns the note, which the handler emits as telemetry, or null when there is no
 *  run database to write to. */
export function recordInterruption(
  dbPath: string,
  a: { ticketId: number; signal: string; step: InFlightStep | null; agent: LaunchContext | null },
): EventLogRow | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`PRAGMA busy_timeout = ${HANDLER_BUSY_MS};`);
    return db.transaction((): EventLogRow => {
      const inFlight = a.step;
      const row = inFlight ? steps.getById(db, inFlight.stepId) : null;
      // Only the step that is still running from the very start the door saw. Anything else (the
      // step already ended, a later attempt) has no attempt of ours to give back.
      if (!inFlight || !row || row.status !== "running" || row.started_at !== inFlight.startedAt) {
        return appendEvent(db, {
          ticketId: a.ticketId,
          kind: "note",
          reason: "interrupted",
          payload: { event: "interrupted", signal: a.signal },
        });
      }
      steps.decrementAttempt(db, inFlight.stepId);
      const attempt = steps.getById(db, inFlight.stepId)?.attempt;
      if (attempt === undefined) throw new Error(`step ${inFlight.stepId} vanished`);
      // A launch context names this step's agent only when it belongs to this step.
      const agent =
        a.agent && (a.agent.stepId === null || a.agent.stepId === inFlight.stepId) ? a.agent : null;
      const payload: InterruptionPayload = {
        event: "interrupted",
        stepId: inFlight.stepId,
        attempt,
        startedAt: inFlight.startedAt,
        signal: a.signal,
        worktree: agent?.worktree ?? null,
        untrackedBefore: agent?.untrackedBefore ?? null,
        dispatchRowId: agent?.dispatchRowId ?? null,
        headAtStart: inFlight.headAtStart,
        headAtStop: inFlight.headAtStop,
      };
      if (payload.dispatchRowId !== null && dispatchIsOpen(db, payload.dispatchRowId)) {
        completeDispatch(db, payload.dispatchRowId, {
          outcome: "interrupted",
          endedAt: nowUtc(),
          partial: 1,
        });
      }
      return appendEvent(db, {
        ticketId: a.ticketId,
        kind: "note",
        reason: "interrupted",
        payload: { ...payload },
      });
    })();
  } finally {
    db.close();
  }
}

/** Only an open row is closed: a completed one already carries its outcome and branch head. */
function dispatchIsOpen(db: Database, id: number): boolean {
  const r = db
    .query<{ outcome: string | null }, [number]>("SELECT outcome FROM dispatch WHERE id = ?")
    .get(id);
  return r !== null && r.outcome === null;
}

/** Section 7.5 (N3): the note for this step whose step ID, attempt AND `started_at` all match the
 *  step as it stands. An older note, from an earlier attempt or an earlier start, never matches. */
export function findInterruption(db: Database, step: WorkflowStepRow): InterruptionPayload | null {
  const rows = db
    .query<{ payload_json: string | null }, [number]>(
      "SELECT payload_json FROM event_log WHERE ticket_id = ? AND kind = 'note' AND reason = 'interrupted' ORDER BY seq DESC",
    )
    .all(step.ticket_id);
  for (const r of rows) {
    if (r.payload_json === null) continue;
    let p: Partial<InterruptionPayload>;
    try {
      p = JSON.parse(r.payload_json) as Partial<InterruptionPayload>;
    } catch {
      continue;
    }
    if (
      p.event === "interrupted" &&
      p.stepId === step.id &&
      p.attempt === step.attempt &&
      typeof p.startedAt === "string" &&
      p.startedAt === step.started_at
    ) {
      return p as InterruptionPayload;
    }
  }
  return null;
}

/** Section 7.5 (R1). Worktree mode: nothing to undo, since resume rebuilt the worktree from the
 *  branch. In place: restore the checkout to its state before the dispatch, sparing the untracked
 *  files that were already there, but only while the checkout is still on the ticket branch (the
 *  same check as the reset: an operator who switched branches keeps their edits). A missing folder
 *  or a failing undo never fails the resume, `--fresh` or `clean` (R21). Returns a line to print,
 *  or null. */
export function undoInterruptedEdits(
  p: InterruptionPayload,
  mode: { inPlace: boolean; repoPath: string; branch: string },
): string | null {
  if (!mode.inPlace || p.untrackedBefore === null || p.worktree === null) return null;
  const skipped = (why: string) => `styre: skipped undoing the interrupted step's edits: ${why}`;
  if (!existsSync(p.worktree)) return skipped(`${p.worktree} no longer exists`);
  const on = gitOut(["symbolic-ref", "--quiet", "HEAD"], p.worktree);
  if (on !== `refs/heads/${mode.branch}`) {
    return skipped(`the checkout is on ${on ?? "a detached HEAD"}, not on ${mode.branch}`);
  }
  try {
    undoAttempt(p.worktree, new Set(p.untrackedBefore));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `styre: could not undo the interrupted step's edits in ${p.worktree} (${why}); they remain`;
  }
  return null;
}

function gitOut(args: string[], cwd: string): string | null {
  const r = runBlocking(["git", ...args], { cwd, timeoutMs: LOCAL_GIT_MS });
  return r.success ? r.stdout.trim() : null;
}

/** Section 7.5 (M1, N1, N2, N4). Returns the branch to where the step started only when all four
 *  conditions hold: the interruption matched (the caller found `p`); the step moved the branch
 *  (`headAtStart` exists and `headAtStop` differs); the branch still stands at `headAtStop`, so
 *  nobody else has moved it; and `--accept-head` was not given. Worktree mode moves the ref with
 *  `git branch -f`; in place, `git reset --hard` in the checkout, after the in-place undo. After a
 *  reset, the step's dispatches since its start are marked `reverted`. Returns a line to print, or
 *  null. Never throws for a refused git call: the resume goes on and says the commits remain. */
export function resetBranchAfterInterruption(
  db: Database,
  p: InterruptionPayload,
  ctx: { inPlace: boolean; repoPath: string; branch: string; acceptHead: boolean },
): string | null {
  if (p.headAtStart === null || p.headAtStop === null || p.headAtStart === p.headAtStop)
    return null;
  const remain = (why: string) =>
    `styre: the interrupted step's commits remain under the current HEAD of ${ctx.branch} (${why}); nothing was reset`;
  if (ctx.acceptHead) return remain("--accept-head was given");
  const current = gitOut(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${ctx.branch}`],
    ctx.repoPath,
  );
  if (current !== p.headAtStop) {
    return remain(`it is at ${current ?? "an unreadable commit"}, not where the step left it`);
  }
  let r: { success: boolean; stderr: string; timedOut: boolean };
  if (ctx.inPlace) {
    // `reset --hard` moves whatever the checkout has checked out: only ever the ticket branch.
    const on = gitOut(["symbolic-ref", "--quiet", "HEAD"], ctx.repoPath);
    if (on !== `refs/heads/${ctx.branch}`) {
      return remain(`the checkout is on ${on ?? "a detached HEAD"}, not on ${ctx.branch}`);
    }
    r = runBlocking(["git", "reset", "--hard", p.headAtStart], {
      cwd: ctx.repoPath,
      timeoutMs: TREE_GIT_MS,
    });
  } else {
    r = runBlocking(["git", "branch", "-f", ctx.branch, p.headAtStart], {
      cwd: ctx.repoPath,
      timeoutMs: LOCAL_GIT_MS,
    });
  }
  if (!r.success) {
    const why = r.timedOut ? "git timed out" : r.stderr.trim();
    return `styre: could not return ${ctx.branch} to ${p.headAtStart} (${why}); the interrupted step's commits remain`;
  }
  db.query(
    "UPDATE dispatch SET outcome = 'reverted', branch_head_sha = ? WHERE step_id = ? AND started_at >= ?",
  ).run(p.headAtStart, p.stepId, p.startedAt);
  return null;
}

/** Section 5.5: a `running` step with a pid can only come from a Styre before ENG-485. Its pid is
 *  reported when something still runs under it, and nothing is stopped: its identity cannot be
 *  confirmed. A negative pid was a process group. Returns the warning, or null. */
export function olderCheckpointWarning(step: WorkflowStepRow): string | null {
  const pid = step.pid;
  if (pid === null) return null;
  const alive = pid < 0 ? listProcesses().some((p) => p.pgid === -pid) : probe(pid).kind !== "gone";
  if (!alive) return null;
  return `styre: step '${step.step_key}' was left running by an older Styre; pid ${pid} is alive but its identity cannot be confirmed, so nothing was stopped`;
}

/** Section 7.5: `--fresh` and `clean` in in-place mode undo an interrupted step's edits before they
 *  discard the checkpoint; otherwise the next run would count the agent's new files as files that
 *  were already there. The mode is the checkpoint's own: in place when its latest dispatch worked
 *  in the project's repository (as resume derives it). The checkpoint is only read. Call it after
 *  the live lock check. */
export function undoBeforeDiscard(dbPath: string, warn: (line: string) => void): void {
  if (!existsSync(dbPath)) return;
  let db: Database;
  let running: WorkflowStepRow[];
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    warn(`styre: could not read ${dbPath} to undo an interrupted step's edits: ${String(err)}`);
    return;
  }
  try {
    try {
      running = steps.listByStatus(db, "running");
    } catch (err) {
      warn(`styre: could not read ${dbPath} to undo an interrupted step's edits: ${String(err)}`);
      return;
    }
    for (const step of running) {
      const older = olderCheckpointWarning(step);
      if (older) warn(older);
      const p = findInterruption(db, step);
      if (!p) continue;
      const ticket = getTicket(db, step.ticket_id);
      const project = ticket ? getProject(db, ticket.project_id) : null;
      if (!ticket || !project) continue;
      const inPlace = getLatestWorktreePath(db, step.ticket_id) === project.target_repo;
      const line = undoInterruptedEdits(p, {
        inPlace,
        repoPath: project.target_repo,
        branch: branchNameFor(ticket),
      });
      if (line) warn(line);
    }
  } finally {
    db.close();
  }
}
