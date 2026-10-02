import { Database } from "bun:sqlite";
// ENG-485 section 7.3 step 6 and section 7.5: the signal handler records an interruption in one
// transaction through its own connection, and on --resume recover() matches it, so the interruption
// is free: the attempt is given back, edits are undone in place, the branch goes back to where the
// step started when that is safe. Anything unmatched takes the crash path. recover() kills nothing.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { branchNameFor } from "../../src/agent/branch.ts";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { reapEffort } from "../../src/cli/clean.ts";
import { parkDir } from "../../src/cli/park.ts";
import { runImpl } from "../../src/cli/run.ts";
import { recover } from "../../src/daemon/recover.ts";
import { openDb } from "../../src/db/client.ts";
import {
  completeDispatch,
  getLatestWorktreePath,
  insertDispatch,
} from "../../src/db/repos/dispatch.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { getProject } from "../../src/db/repos/project.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { branchHeadSha, commitWorktree } from "../../src/dispatch/worktree.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import * as door from "../../src/util/process/door.ts";
import {
  findInterruption,
  recordInterruption,
  undoBeforeDiscard,
} from "../../src/util/process/interruption.ts";
import { nowUtc } from "../../src/util/time.ts";
import { git, makeGitProject, makeTicketDb } from "../helpers/lifecycle.ts";
import { cleanupParkedRun, resumeParkedTicket, runParkedTicket } from "../helpers/run-harness.ts";

let state: string;
const savedState = process.env.XDG_STATE_HOME;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "styre-interruption-"));
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  door.__resetForTests();
  if (savedState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  else process.env.XDG_STATE_HOME = savedState;
  rmSync(state, { recursive: true, force: true });
});

const quiet = { warn: () => {} };
const dispatchRow = (db: Database, id: number) =>
  db.query("SELECT outcome, branch_head_sha, partial FROM dispatch WHERE id = ?").get(id);

// ---- recording -----------------------------------------------------------------------------------

test("the handler's write gives back the attempt, stores the attempt after the decrement, and closes the dispatch", () => {
  const t = makeTicketDb(); // a running step at attempt 2, with an open dispatch row
  const row = recordInterruption(t.path, {
    ticketId: t.ticketId,
    signal: "SIGINT",
    step: {
      stepId: t.stepId,
      startedAt: t.startedAt,
      ident: "ENG-1",
      headAtStart: null,
      headAtStop: null,
    },
    agent: {
      ident: "ENG-1",
      stepId: t.stepId,
      worktree: "/w",
      untrackedBefore: ["old.txt"],
      dispatchRowId: t.dispatchRowId,
    },
  });
  expect(row?.kind).toBe("note");
  expect(row?.reason).toBe("interrupted");
  const db = new Database(t.path);
  const step = steps.getById(db, t.stepId);
  if (!step) throw new Error("step missing");
  expect(step.attempt).toBe(1);
  expect(step.status).toBe("running"); // recover() owns the reset, on resume
  expect(JSON.parse(row?.payload_json as string)).toMatchObject({ attempt: 1 });
  expect(findInterruption(db, step)).toMatchObject({
    event: "interrupted",
    stepId: t.stepId,
    attempt: 1,
    startedAt: t.startedAt,
    worktree: "/w",
    untrackedBefore: ["old.txt"],
    dispatchRowId: t.dispatchRowId,
    signal: "SIGINT",
  });
  expect(dispatchRow(db, t.dispatchRowId)).toMatchObject({ outcome: "interrupted", partial: 1 });
  // The earlier attempt's row is not the open one, and is left alone.
  expect(dispatchRow(db, t.earlierDispatchRowId)).toMatchObject({
    outcome: "dispatch-failed",
    partial: 0,
  });
  db.close();
});

test("with no step in flight only the event is written: no attempt and no dispatch change", () => {
  const t = makeTicketDb();
  const row = recordInterruption(t.path, {
    ticketId: t.ticketId,
    signal: "SIGTERM",
    step: null,
    agent: null,
  });
  expect(row?.kind).toBe("note");
  expect(JSON.parse(row?.payload_json as string)).toEqual({
    event: "interrupted",
    signal: "SIGTERM",
  });
  const db = new Database(t.path);
  expect(steps.getById(db, t.stepId)?.attempt).toBe(2);
  expect(dispatchRow(db, t.dispatchRowId)).toMatchObject({ outcome: null });
  expect(findInterruption(db, steps.getById(db, t.stepId) as steps.WorkflowStepRow)).toBeNull();
  db.close();
});

test("an already completed dispatch row named by the launch is not rewritten", () => {
  const g = makeGitProject(); // the dispatch row is complete, at B
  recordInterruption(g.dbPath, {
    ticketId: g.ticketId,
    signal: "SIGINT",
    step: {
      stepId: g.stepId,
      startedAt: g.startedAt,
      ident: "ENG-1",
      headAtStart: g.A,
      headAtStop: g.B,
    },
    agent: {
      ident: "ENG-1",
      stepId: g.stepId,
      worktree: g.repo,
      untrackedBefore: [],
      dispatchRowId: g.dispatchRowId,
    },
  });
  const db = new Database(g.dbPath);
  expect(dispatchRow(db, g.dispatchRowId)).toEqual({
    outcome: "succeeded",
    branch_head_sha: g.B,
    partial: 0,
  });
  db.close();
});

test("a missing run database records nothing and creates nothing", () => {
  const path = join(state, "absent", "run.db");
  expect(
    recordInterruption(path, { ticketId: 1, signal: "SIGINT", step: null, agent: null }),
  ).toBeNull();
  expect(existsSync(path)).toBe(false);
});

// ---- matching ------------------------------------------------------------------------------------

test("recover treats a matched step as an interruption: no markFailed, even for a suite step", () => {
  const t = makeTicketDb({ stepKey: "verify:integration" });
  recordInterruption(t.path, {
    ticketId: t.ticketId,
    signal: "SIGTERM",
    step: {
      stepId: t.stepId,
      startedAt: t.startedAt,
      ident: "ENG-1",
      headAtStart: null,
      headAtStop: null,
    },
    agent: null,
  });
  const db = new Database(t.path);
  const out = recover(db);
  expect(out).toEqual({ reset: 1, interrupted: 1, warned: 0 });
  const s = steps.getById(db, t.stepId);
  expect(s?.status).toBe("pending");
  expect(s?.error_json).toBeNull();
  expect(s?.attempt).toBe(1);
  db.close();
});

test("an unmatched running step takes today's crash path", () => {
  const t = makeTicketDb({ stepKey: "verify:integration" });
  const db = new Database(t.path);
  expect(recover(db)).toEqual({ reset: 1, interrupted: 0, warned: 0 });
  const s = steps.getById(db, t.stepId);
  expect(s?.status).toBe("pending");
  expect(JSON.parse(s?.error_json as string).message).toContain(
    "verification execution interrupted",
  );
  expect(s?.attempt).toBe(2); // a crash keeps the attempt it consumed
  db.close();
});

test("an old note from an earlier run of the step does not match a later attempt that a budget pause left running", () => {
  const t = makeTicketDb({ stepKey: "verify:integration" });
  recordInterruption(t.path, {
    ticketId: t.ticketId,
    signal: "SIGINT",
    step: {
      stepId: t.stepId,
      startedAt: t.startedAt,
      ident: "ENG-1",
      headAtStart: null,
      headAtStop: null,
    },
    agent: null,
  }); // attempt 2 -> 1, note at attempt 1
  const db = openDb(t.path);
  recover(db); // resume: pending at attempt 1
  Bun.sleepSync(3);
  steps.markRunning(db, t.stepId, {}); // the redo: attempt 2, a new started_at
  steps.decrementAttempt(db, t.stepId); // a budget pause gives it back and leaves it running
  const now = steps.getById(db, t.stepId);
  expect(now?.attempt).toBe(1); // the same attempt number as the old note...
  expect(now?.started_at).not.toBe(t.startedAt); // ...but a different start
  expect(findInterruption(db, now as steps.WorkflowStepRow)).toBeNull();
  expect(recover(db).interrupted).toBe(0);
  expect(JSON.parse(steps.getById(db, t.stepId)?.error_json as string).message).toContain(
    "verification execution interrupted",
  );
  db.close();
});

test("a note whose attempt differs from the step's does not match, even at the same start", () => {
  const t = makeTicketDb({ stepKey: "verify:integration" });
  const db = openDb(t.path);
  // The attempt BEFORE the decrement, as a handler that stored it too early would write it.
  appendEvent(db, {
    ticketId: t.ticketId,
    kind: "note",
    reason: "interrupted",
    payload: {
      event: "interrupted",
      stepId: t.stepId,
      attempt: 3,
      startedAt: t.startedAt,
      signal: "SIGINT",
      worktree: null,
      untrackedBefore: null,
      dispatchRowId: null,
      headAtStart: null,
      headAtStop: null,
    },
  });
  expect(findInterruption(db, steps.getById(db, t.stepId) as steps.WorkflowStepRow)).toBeNull();
  expect(recover(db).interrupted).toBe(0);
  db.close();
});

// ---- returning the branch ----------------------------------------------------------------------

const interruptAtB = (g: ReturnType<typeof makeGitProject>) =>
  recordInterruption(g.dbPath, {
    ticketId: g.ticketId,
    signal: "SIGINT",
    step: {
      stepId: g.stepId,
      startedAt: g.startedAt,
      ident: "ENG-1",
      headAtStart: g.A,
      headAtStop: g.B,
    },
    agent: null,
  });

test("a checks commit interrupted before its rollback is reset on resume, and its dispatch marked reverted (M1)", () => {
  const g = makeGitProject(); // repo with branch at commit A; a step in flight that committed B
  interruptAtB(g);
  const db = new Database(g.dbPath);
  recover(db, { inPlace: true, repoPath: g.repo, branch: g.branch, acceptHead: false, ...quiet });
  expect(g.head()).toBe(g.A);
  expect(git(g.repo, ["rev-parse", "HEAD"])).toBe(g.A); // the checkout itself, not only the ref
  expect(existsSync(join(g.repo, "b.txt"))).toBe(false);
  expect(dispatchRow(db, g.dispatchRowId)).toMatchObject({
    outcome: "reverted",
    branch_head_sha: g.A,
  });
  // N2: the same step's earlier attempt started before this one and is not touched.
  expect(dispatchRow(db, g.earlierDispatchRowId)).toMatchObject({
    outcome: "dispatch-failed",
    branch_head_sha: null,
  });
  db.close();
});

test("--accept-head keeps the operator's commit and resets nothing (N1)", () => {
  const g = makeGitProject();
  interruptAtB(g);
  const C = g.commitAsOperator();
  recover(new Database(g.dbPath), {
    inPlace: true,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: true,
    ...quiet,
  });
  expect(g.head()).toBe(C);
});

test("--accept-head alone stops the reset, even when nobody moved the branch", () => {
  const g = makeGitProject();
  interruptAtB(g);
  const lines: string[] = [];
  const db = new Database(g.dbPath);
  recover(db, {
    inPlace: true,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: true,
    warn: (l) => lines.push(l),
  });
  expect(g.head()).toBe(g.B);
  expect(dispatchRow(db, g.dispatchRowId)).toMatchObject({
    outcome: "succeeded",
    branch_head_sha: g.B,
  });
  expect(lines.join("\n")).toContain("remain");
  db.close();
});

test("a moved head (not by the step) is never reset, even without --accept-head", () => {
  const g = makeGitProject();
  interruptAtB(g);
  const C = g.commitAsOperator();
  const lines: string[] = [];
  recover(new Database(g.dbPath), {
    inPlace: true,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    warn: (l) => lines.push(l),
  });
  expect(g.head()).toBe(C);
  expect(lines.join("\n")).toContain("remain");
});

test("no reset without a starting head (N3), or when the step did not move the branch", () => {
  for (const heads of [
    { headAtStart: null, headAtStop: "B" },
    { headAtStart: "A", headAtStop: "A" },
  ]) {
    const g = makeGitProject();
    const resolve = (v: string | null) => (v === "A" ? g.A : v === "B" ? g.B : null);
    recordInterruption(g.dbPath, {
      ticketId: g.ticketId,
      signal: "SIGINT",
      step: {
        stepId: g.stepId,
        startedAt: g.startedAt,
        ident: "ENG-1",
        headAtStart: resolve(heads.headAtStart),
        headAtStop: resolve(heads.headAtStop),
      },
      agent: null,
    });
    const out = recover(new Database(g.dbPath), {
      inPlace: true,
      repoPath: g.repo,
      branch: g.branch,
      acceptHead: false,
      ...quiet,
    });
    expect(out.interrupted).toBe(1);
    expect(g.head()).toBe(g.B);
  }
});

test("in place, a checkout that is not on the ticket branch is never reset", () => {
  const g = makeGitProject();
  interruptAtB(g);
  git(g.repo, ["checkout", "main"]);
  const lines: string[] = [];
  recover(new Database(g.dbPath), {
    inPlace: true,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    warn: (l) => lines.push(l),
  });
  expect(g.head()).toBe(g.B);
  expect(git(g.repo, ["rev-parse", "main"])).toBe(g.I);
  expect(lines.join("\n")).toContain("remain");
});

test("worktree mode moves the branch ref with branch -f and leaves the main checkout alone", () => {
  const g = makeGitProject({ mode: "worktree" }); // checkout on main, branch b not checked out
  interruptAtB(g);
  writeFileSync(join(g.repo, "README.md"), "operator edit\n"); // an edit in the main checkout
  const db = new Database(g.dbPath);
  const out = recover(db, {
    inPlace: false,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    ...quiet,
  });
  expect(out.interrupted).toBe(1);
  expect(g.head()).toBe(g.A);
  expect(git(g.repo, ["rev-parse", "HEAD"])).toBe(g.I); // main did not move
  expect(git(g.repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
  expect(readFileSync(join(g.repo, "README.md"), "utf8")).toBe("operator edit\n");
  expect(dispatchRow(db, g.dispatchRowId)).toMatchObject({
    outcome: "reverted",
    branch_head_sha: g.A,
  });
  db.close();
});

test("a branch checked out in another worktree is reported and skipped; the resume does not fail (N4)", () => {
  const g = makeGitProject({ mode: "worktree" });
  interruptAtB(g);
  const other = `${g.repo}-other`;
  git(g.repo, ["worktree", "add", other, g.branch]);
  try {
    const lines: string[] = [];
    const db = new Database(g.dbPath);
    const out = recover(db, {
      inPlace: false,
      repoPath: g.repo,
      branch: g.branch,
      acceptHead: false,
      warn: (l) => lines.push(l),
    });
    expect(out.interrupted).toBe(1);
    expect(g.head()).toBe(g.B);
    expect(lines.join("\n")).toContain("could not return b");
    expect(steps.getById(db, g.stepId)?.status).toBe("pending");
    expect(dispatchRow(db, g.dispatchRowId)).toMatchObject({ outcome: "succeeded" });
    db.close();
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

// ---- undoing edits -------------------------------------------------------------------------------

test("worktree mode undoes nothing: the recorded folder is left as it is", () => {
  const g = makeGitProject({ mode: "worktree" });
  const wt = `${g.repo}-wt`;
  git(g.repo, ["worktree", "add", "--detach", wt, g.B]);
  writeFileSync(join(wt, "agent-new.txt"), "new\n");
  writeFileSync(join(wt, "a.txt"), "changed\n");
  recordInterruption(g.dbPath, {
    ticketId: g.ticketId,
    signal: "SIGINT",
    step: {
      stepId: g.stepId,
      startedAt: g.startedAt,
      ident: "ENG-1",
      headAtStart: g.A,
      headAtStop: g.A,
    },
    agent: { ident: "ENG-1", stepId: g.stepId, worktree: wt, untrackedBefore: [] },
  });
  recover(new Database(g.dbPath), {
    inPlace: false,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    ...quiet,
  });
  expect(existsSync(join(wt, "agent-new.txt"))).toBe(true);
  expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("changed\n");
});

test("in place, a recorded folder that no longer exists is skipped with a message", () => {
  const t = makeTicketDb();
  const gone = join(state, "gone");
  recordInterruption(t.path, {
    ticketId: t.ticketId,
    signal: "SIGINT",
    step: {
      stepId: t.stepId,
      startedAt: t.startedAt,
      ident: "ENG-1",
      headAtStart: null,
      headAtStop: null,
    },
    agent: { ident: "ENG-1", stepId: t.stepId, worktree: gone, untrackedBefore: [] },
  });
  const lines: string[] = [];
  const db = new Database(t.path);
  const out = recover(db, {
    inPlace: true,
    repoPath: gone,
    branch: "b",
    acceptHead: false,
    warn: (l) => lines.push(l),
  });
  expect(out.interrupted).toBe(1);
  expect(lines.join("\n")).toContain(
    `skipped undoing the interrupted step's edits: ${gone} no longer exists`,
  );
  expect(steps.getById(db, t.stepId)?.status).toBe("pending");
  db.close();
});

// ---- through real steps --------------------------------------------------------------------------

/** Run one effectful step for real: it edits the checkout and commits B through the runner's commit,
 *  then a stop begins and the step unwinds. Returns what the handler would record. */
async function interruptRealStep(g: ReturnType<typeof makeGitProject>, checkout: string) {
  const db = openDb(g.dbPath);
  // Start over from the fixture's attempt: the step is pending at attempt 1 with the branch at A.
  steps.resetToPending(db, g.stepId);
  steps.decrementAttempt(db, g.stepId);
  git(g.repo, ["update-ref", `refs/heads/${g.branch}`, g.A]);
  if (checkout === g.repo) git(g.repo, ["reset", "--hard", g.A]);
  else git(checkout, ["reset", "--hard", g.A]);
  writeFileSync(join(checkout, "old.txt"), "an untracked file that was there before\n");
  const untrackedBefore = ["old.txt"];
  let agent: door.LaunchContext | null = null;
  let dispatchRowId = -1;
  const run = runStep(db, {
    ticketId: g.ticketId,
    stepKey: "implement:dispatch",
    stepType: "dispatch",
    effectful: true,
    ident: "ENG-1",
    readHead: () => branchHeadSha(g.repo, g.branch),
    execute: async (row) => {
      // The agent's dispatch row opens with the attempt, as run-dispatch opens it.
      const opened = insertDispatch(db, {
        ticketId: g.ticketId,
        dispatchId: "d-3",
        seq: 3,
        stepId: row.id,
        startedAt: nowUtc(),
        worktreePath: checkout,
      });
      dispatchRowId = opened.id;
      agent = {
        ident: "ENG-1",
        stepId: row.id,
        worktree: checkout,
        untrackedBefore,
        dispatchRowId: opened.id,
      };
      writeFileSync(join(checkout, "authored.test.txt"), "test\n");
      commitWorktree(checkout, "checks", ["authored.test.txt"]); // moves the branch: headAtStop
      // The test run edits the checkout, then the stop lands before the rollback.
      writeFileSync(join(checkout, "agent-new.txt"), "new\n");
      writeFileSync(join(checkout, "a.txt"), "changed by the agent\n");
      door.beginStopping();
      throw new Error("the launch was stopped");
    },
  });
  await expect(run).rejects.toBeInstanceOf(door.RunInterrupted);
  const before = steps.getById(db, g.stepId);
  db.close();
  const inFlight = door.inFlightStep();
  expect(inFlight?.headAtStart).toBe(g.A);
  expect(inFlight?.headAtStop).not.toBe(g.A);
  recordInterruption(g.dbPath, { ticketId: g.ticketId, signal: "SIGINT", step: inFlight, agent });
  door.__resetForTests(); // the resume is a new process
  return {
    attemptDuring: before?.attempt as number,
    committed: inFlight?.headAtStop as string,
    dispatchRowId,
  };
}

test("a real step interrupted in place: edits undone, branch back at its start, attempt given back", async () => {
  const g = makeGitProject();
  const { attemptDuring, committed, dispatchRowId } = await interruptRealStep(g, g.repo);
  expect(attemptDuring).toBe(2); // markRunning counted the interrupted attempt
  const db = openDb(g.dbPath);
  const out = recover(db, {
    inPlace: true,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    ...quiet,
  });
  expect(out.interrupted).toBe(1);
  const s = steps.getById(db, g.stepId);
  expect(s?.status).toBe("pending");
  expect(s?.attempt).toBe(1); // its value before the interrupted attempt
  expect(g.head()).toBe(g.A);
  expect(existsSync(join(g.repo, "agent-new.txt"))).toBe(false);
  expect(existsSync(join(g.repo, "authored.test.txt"))).toBe(false);
  expect(readFileSync(join(g.repo, "a.txt"), "utf8")).toBe("a\n");
  expect(existsSync(join(g.repo, "old.txt"))).toBe(true); // there before the dispatch: spared
  expect(git(g.repo, ["status", "--porcelain"])).toBe("?? old.txt");
  // The attempt's own dispatch row: closed as interrupted by the handler, then reverted (N2).
  expect(dispatchRow(db, dispatchRowId)).toEqual({
    outcome: "reverted",
    branch_head_sha: g.A,
    partial: 1,
  });
  // The fixture's rows started before this attempt did: they are not this attempt's, and stay.
  expect(dispatchRow(db, g.dispatchRowId)).toMatchObject({
    outcome: "succeeded",
    branch_head_sha: g.B,
  });
  expect(committed).not.toBe(g.A);
  db.close();
});

test("a real step interrupted in worktree mode: the branch ref goes back after the worktree is gone", async () => {
  const g = makeGitProject({ mode: "worktree" });
  const wt = `${g.repo}-wt`;
  git(g.repo, ["worktree", "add", wt, g.branch]);
  await interruptRealStep(g, wt);
  // resumeRun removes the old worktree before recover() runs (park.ts reconcileWorktree).
  git(g.repo, ["worktree", "remove", "--force", wt]);
  const db = openDb(g.dbPath);
  const out = recover(db, {
    inPlace: false,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    ...quiet,
  });
  expect(out.interrupted).toBe(1);
  expect(steps.getById(db, g.stepId)).toMatchObject({
    status: "pending",
    attempt: 1,
    error_json: null,
  });
  expect(g.head()).toBe(g.A);
  expect(git(g.repo, ["rev-parse", "HEAD"])).toBe(g.I); // the main checkout never moved
  db.close();
});

// ---- older checkpoints ---------------------------------------------------------------------------

test("an older checkpoint's journaled pid produces a warning and no stop (N12)", async () => {
  const sleeper = Bun.spawn(["sleep", "30"]);
  try {
    for (const pid of [process.pid, sleeper.pid]) {
      const t = makeTicketDb({ pid });
      const lines: string[] = [];
      const db = new Database(t.path);
      const out = recover(db, {
        inPlace: false,
        repoPath: "/x",
        branch: "b",
        acceptHead: false,
        warn: (l) => lines.push(l),
      });
      expect(out.warned).toBe(1);
      expect(lines[0]).toContain(String(pid));
      expect(lines[0]).toContain("cannot be confirmed");
      expect(steps.getById(db, t.stepId)?.status).toBe("pending");
      db.close();
    }
    await Bun.sleep(100); // a signal, had one been sent, would have landed by now
    expect(sleeper.exitCode).toBeNull(); // still alive: recover() stopped nothing
    expect(sleeper.killed).toBe(false);
  } finally {
    sleeper.kill("SIGKILL");
  }
});

test("a step written by the new code (no pid) or with a dead pid gives no warning", () => {
  const dead = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
  for (const pid of [undefined, Number(dead)]) {
    const t = makeTicketDb(pid === undefined ? {} : { pid });
    const lines: string[] = [];
    const out = recover(new Database(t.path), {
      inPlace: false,
      repoPath: "/x",
      branch: "b",
      acceptHead: false,
      warn: (l) => lines.push(l),
    });
    expect(out.warned).toBe(0);
    expect(lines).toEqual([]);
  }
});

// ---- --fresh and clean ---------------------------------------------------------------------------

/** An in-place checkpoint whose step was interrupted after the agent left a new file and an edit. */
function interruptedInPlace(opts?: { dbPath?: string; inPlace?: boolean }) {
  const g = makeGitProject();
  const inPlace = opts?.inPlace ?? true;
  if (!inPlace) {
    const db = openDb(g.dbPath);
    db.query("UPDATE dispatch SET worktree_path = ?").run(`${g.repo}-wt`);
    db.close();
  }
  writeFileSync(join(g.repo, "old.txt"), "before\n");
  writeFileSync(join(g.repo, "agent-new.txt"), "new\n");
  writeFileSync(join(g.repo, "a.txt"), "changed\n");
  recordInterruption(g.dbPath, {
    ticketId: g.ticketId,
    signal: "SIGINT",
    step: {
      stepId: g.stepId,
      startedAt: g.startedAt,
      ident: "ENG-1",
      headAtStart: g.A,
      headAtStop: g.B,
    },
    agent: { ident: "ENG-1", stepId: g.stepId, worktree: g.repo, untrackedBefore: ["old.txt"] },
  });
  return g;
}

test("undoBeforeDiscard undoes an in-place interruption's edits and leaves the branch alone", () => {
  const g = interruptedInPlace();
  const lines: string[] = [];
  undoBeforeDiscard(g.dbPath, (l) => lines.push(l));
  expect(existsSync(join(g.repo, "agent-new.txt"))).toBe(false);
  expect(readFileSync(join(g.repo, "a.txt"), "utf8")).toBe("a\n");
  expect(existsSync(join(g.repo, "old.txt"))).toBe(true);
  expect(g.head()).toBe(g.B); // discarding is not resuming: no branch reset
  expect(lines).toEqual([]);
  // The checkpoint was only read.
  const db = new Database(g.dbPath);
  expect(steps.getById(db, g.stepId)?.status).toBe("running");
  db.close();
});

test("undoBeforeDiscard does nothing in worktree mode, or for a step that was not interrupted", () => {
  const g = interruptedInPlace({ inPlace: false });
  undoBeforeDiscard(g.dbPath, () => {});
  expect(existsSync(join(g.repo, "agent-new.txt"))).toBe(true);
  const plain = makeGitProject();
  writeFileSync(join(plain.repo, "agent-new.txt"), "new\n");
  undoBeforeDiscard(plain.dbPath, () => {});
  expect(existsSync(join(plain.repo, "agent-new.txt"))).toBe(true);
});

test("undoBeforeDiscard warns about an older checkpoint's live pid and stops nothing", () => {
  const t = makeTicketDb({ pid: process.pid });
  const lines: string[] = [];
  undoBeforeDiscard(t.path, (l) => lines.push(l));
  expect(lines.join("\n")).toContain(String(process.pid));
});

test("clean undoes an in-place interruption's edits before it removes the checkpoint", () => {
  const g = interruptedInPlace();
  // The checkpoint folder is the fixture's own: run.db with the -wal and -shm files Bun leaves.
  const dir = dirname(g.dbPath);
  const dbPath = g.dbPath;
  reapEffort(g.repo, { branch: g.branch, dir, ticketId: g.ticketId, dbPath });
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(join(g.repo, "agent-new.txt"))).toBe(false);
  expect(readFileSync(join(g.repo, "a.txt"), "utf8")).toBe("a\n");
  expect(existsSync(join(g.repo, "old.txt"))).toBe(true);
});

/** Drive `styre run <ident> --fresh` for real over an in-place checkpoint left by an interruption. */
async function freshOver(
  g: ReturnType<typeof makeGitProject>,
  before?: (checkpointDir: string) => void,
  args: { fresh?: boolean; db?: string } = { fresh: true },
) {
  const SLUG = "test-project";
  const IDENT = "ENG-1";
  const prev = { config: process.env.XDG_CONFIG_HOME, telemetry: process.env.STYRE_TELEMETRY };
  process.env.XDG_CONFIG_HOME = join(state, "config");
  process.env.STYRE_TELEMETRY = "0";
  const profilePath = join(state, "profile.json");
  writeFileSync(
    profilePath,
    JSON.stringify({
      slug: SLUG,
      targetRepo: g.repo,
      defaultBranch: "main",
      checksSystem: "none",
      components: [],
    }),
  );
  const checkpointDir = parkDir(SLUG, IDENT);
  mkdirSync(checkpointDir, { recursive: true });
  for (const f of ["run.db", "run.db-wal", "run.db-shm"]) {
    const from = join(dirname(g.dbPath), f);
    if (existsSync(from)) writeFileSync(join(checkpointDir, f), readFileSync(from));
  }
  before?.(checkpointDir);
  // runImpl sets the process exit status (75 on a park): never let it leak into the test runner.
  const previousExitCode = process.exitCode;
  try {
    await runImpl(
      { args: { ticket: IDENT, profile: profilePath, ...args } },
      {
        ports: {
          issueTracker: fakeIssueTracker({
            ticket: {
              ident: IDENT,
              title: "t",
              description: "body",
              typeLabel: "Feature",
              externalId: "u",
              url: null,
            },
          }),
          forge: fakeForge(),
        },
        runner: new FakeAgentRunner(() => ({
          completed: false,
          exitCode: 1,
          stdout: "",
          stderr: "You have reached your session limit · resets tomorrow",
          timedOut: false,
          costUsd: null,
          tokensIn: null,
          tokensOut: null,
          cause: "session-limit" as const,
          resetAt: "tomorrow",
        })),
        preflight: () => ({ ok: true, version: null }),
      },
    );
  } finally {
    process.exitCode = previousExitCode ?? 0;
    for (const [k, v] of [
      ["XDG_CONFIG_HOME", prev.config],
      ["STYRE_TELEMETRY", prev.telemetry],
    ] as const) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

test("--fresh undoes an in-place interruption's edits before it discards the checkpoint", async () => {
  const g = interruptedInPlace();
  await freshOver(g);
  expect(existsSync(join(g.repo, "agent-new.txt"))).toBe(false);
  expect(readFileSync(join(g.repo, "a.txt"), "utf8")).toBe("a\n");
  expect(existsSync(join(g.repo, "old.txt"))).toBe(true);
});

test("--fresh refused by a live run's lock undoes nothing", async () => {
  const g = interruptedInPlace();
  await expect(
    freshOver(g, (dir) => writeFileSync(join(dir, "run.lock"), String(process.ppid))),
  ).rejects.toThrow(/in progress/);
  expect(existsSync(join(g.repo, "agent-new.txt"))).toBe(true);
  expect(readFileSync(join(g.repo, "a.txt"), "utf8")).toBe("changed\n");
});

// ---- the resume wiring ---------------------------------------------------------------------------

/** A real worktree mode checkpoint (a parked dispatch step) turned into an interrupted one: the
 *  step committed B through the runner, then the stop landed before its rollback. */
async function parkedThenInterrupted() {
  const parked = await runParkedTicket();
  const dbPath = join(parked.dumpDir, "run.db");
  const db = openDb(dbPath);
  const step = steps.listByStatus(db, "running")[0];
  if (!step) throw new Error("no running step in the checkpoint");
  const ticket = getTicket(db, parked.ticketId);
  const project = ticket ? getProject(db, ticket.project_id) : null;
  if (!ticket || !project) throw new Error("checkpoint has no ticket");
  const repo = project.target_repo;
  const branch = branchNameFor(ticket);
  const A = git(repo, ["rev-parse", `refs/heads/${branch}`]);
  const tree = git(repo, ["rev-parse", `${A}^{tree}`]);
  const B = git(repo, ["commit-tree", tree, "-p", A, "-m", "authored tests"]);
  git(repo, ["update-ref", `refs/heads/${branch}`, B]);
  const row = insertDispatch(db, {
    ticketId: parked.ticketId,
    dispatchId: "ENG-1-checks",
    seq: 99,
    stepId: step.id,
    startedAt: nowUtc(),
    worktreePath: getLatestWorktreePath(db, parked.ticketId),
  });
  completeDispatch(db, row.id, { outcome: "succeeded", branchHeadSha: B, endedAt: nowUtc() });
  // markRunning counted this attempt; the handler gives it back.
  db.query("UPDATE workflow_step SET attempt = attempt + 1 WHERE id = ?").run(step.id);
  db.close();
  recordInterruption(dbPath, {
    ticketId: parked.ticketId,
    signal: "SIGINT",
    step: {
      stepId: step.id,
      startedAt: step.started_at as string,
      ident: "ENG-1",
      headAtStart: A,
      headAtStop: B,
    },
    agent: null,
  });
  const rowAfterResume = () => {
    const after = new Database(dbPath, { readonly: true });
    try {
      return dispatchRow(after, row.id);
    } finally {
      after.close();
    }
  };
  return { parked, A, B, rowAfterResume };
}

test("styre run --resume passes the checkout to recover(): a matched interruption's branch goes back", async () => {
  const { parked, A, rowAfterResume } = await parkedThenInterrupted();
  try {
    await resumeParkedTicket(parked, { parkAgain: true });
    expect(rowAfterResume()).toMatchObject({ outcome: "reverted", branch_head_sha: A });
  } finally {
    cleanupParkedRun(parked);
  }
});

test("styre run --resume --accept-head passes the flag to recover(): nothing is reset", async () => {
  const { parked, B, rowAfterResume } = await parkedThenInterrupted();
  try {
    await resumeParkedTicket(parked, { parkAgain: true, acceptHead: true });
    expect(rowAfterResume()).toMatchObject({ outcome: "succeeded", branch_head_sha: B });
  } finally {
    cleanupParkedRun(parked);
  }
});

// ---- fix round 1: the recording and matching guards ----------------------------------------------

const inFlightOf = (t: { stepId: number; startedAt: string }) => ({
  stepId: t.stepId,
  startedAt: t.startedAt,
  ident: "ENG-1",
  headAtStart: null,
  headAtStop: null,
});

test("an in-flight step that is no longer running from the same start gets only the bare note", () => {
  const variants: Array<[string, (db: Database, t: ReturnType<typeof makeTicketDb>) => string]> = [
    [
      "succeeded",
      (db, t) => {
        steps.markSucceeded(db, t.stepId, null);
        return t.startedAt;
      },
    ],
    [
      "pending",
      (db, t) => {
        steps.resetToPending(db, t.stepId);
        return t.startedAt;
      },
    ],
    ["a different start", (_db, t) => `${t.startedAt.slice(0, -1)}9Z`],
  ];
  for (const [name, change] of variants) {
    const t = makeTicketDb();
    const db = openDb(t.path);
    const startedAt = change(db, t);
    const before = steps.getById(db, t.stepId);
    db.close();
    const row = recordInterruption(t.path, {
      ticketId: t.ticketId,
      signal: "SIGINT",
      step: { ...inFlightOf(t), startedAt },
      agent: {
        ident: "ENG-1",
        stepId: t.stepId,
        worktree: "/w",
        untrackedBefore: [],
        dispatchRowId: t.dispatchRowId,
      },
    });
    const after = new Database(t.path);
    expect([name, JSON.parse(row?.payload_json as string)]).toEqual([
      name,
      { event: "interrupted", signal: "SIGINT" },
    ]);
    expect([name, steps.getById(after, t.stepId)?.attempt]).toEqual([name, before?.attempt]);
    expect([name, dispatchRow(after, t.dispatchRowId)]).toEqual([
      name,
      { outcome: null, branch_head_sha: null, partial: 0 },
    ]);
    after.close();
  }
});

test("a launch context from another step is not recorded, and its dispatch row is left open", () => {
  const t = makeTicketDb();
  const row = recordInterruption(t.path, {
    ticketId: t.ticketId,
    signal: "SIGINT",
    step: inFlightOf(t),
    agent: {
      ident: "ENG-1",
      stepId: t.stepId + 1,
      worktree: "/w",
      untrackedBefore: ["x"],
      dispatchRowId: t.dispatchRowId,
    },
  });
  expect(JSON.parse(row?.payload_json as string)).toMatchObject({
    stepId: t.stepId,
    worktree: null,
    untrackedBefore: null,
    dispatchRowId: null,
  });
  const db = new Database(t.path);
  expect(dispatchRow(db, t.dispatchRowId)).toEqual({
    outcome: null,
    branch_head_sha: null,
    partial: 0,
  });
  expect(steps.getById(db, t.stepId)?.attempt).toBe(1); // the step itself was still recorded
  db.close();
});

test("the recording is one transaction: a failing append leaves the attempt and the dispatch as they were", () => {
  const t = makeTicketDb();
  // A ticket that does not exist breaks the note's foreign key, after the decrement has run.
  expect(() =>
    recordInterruption(t.path, {
      ticketId: t.ticketId + 999,
      signal: "SIGINT",
      step: inFlightOf(t),
      agent: {
        ident: "ENG-1",
        stepId: t.stepId,
        worktree: "/w",
        untrackedBefore: [],
        dispatchRowId: t.dispatchRowId,
      },
    }),
  ).toThrow();
  const db = new Database(t.path);
  expect(steps.getById(db, t.stepId)?.attempt).toBe(2);
  expect(dispatchRow(db, t.dispatchRowId)).toEqual({
    outcome: null,
    branch_head_sha: null,
    partial: 0,
  });
  db.close();
});

test("a note for another step, at the same attempt and start, does not match", () => {
  const t = makeTicketDb({ stepKey: "verify:integration" });
  const db = openDb(t.path);
  const step = steps.getById(db, t.stepId) as steps.WorkflowStepRow;
  appendEvent(db, {
    ticketId: t.ticketId,
    kind: "note",
    reason: "interrupted",
    payload: {
      event: "interrupted",
      stepId: t.stepId + 1,
      attempt: step.attempt,
      startedAt: t.startedAt,
      signal: "SIGINT",
      worktree: null,
      untrackedBefore: null,
      dispatchRowId: null,
      headAtStart: null,
      headAtStop: null,
    },
  });
  expect(findInterruption(db, step)).toBeNull();
  expect(recover(db).interrupted).toBe(0);
  db.close();
});

test("a step that did not move the branch is not reset and marks nothing reverted, even when the head still stands there", () => {
  const g = makeGitProject(); // the branch is at B
  recordInterruption(g.dbPath, {
    ticketId: g.ticketId,
    signal: "SIGINT",
    step: { ...inFlightOf(g), headAtStart: g.B, headAtStop: g.B },
    agent: null,
  });
  const db = new Database(g.dbPath);
  const out = recover(db, {
    inPlace: true,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    ...quiet,
  });
  expect(out.interrupted).toBe(1);
  expect(g.head()).toBe(g.B);
  expect(dispatchRow(db, g.dispatchRowId)).toMatchObject({
    outcome: "succeeded",
    branch_head_sha: g.B,
  });
  expect(dispatchRow(db, g.earlierDispatchRowId)).toMatchObject({ outcome: "dispatch-failed" });
  db.close();
});

// ---- fix round 1: R21 --------------------------------------------------------------------------

/** An in-place interruption where the agent left a new file and an edit, with the run's checkout
 *  then moved to main by the operator, who has their own edit and untracked file there. */
function operatorOnMain() {
  const g = interruptedInPlace();
  git(g.repo, ["stash", "push", "--include-untracked", "-m", "agent"]); // keep main clean to switch
  git(g.repo, ["checkout", "main"]);
  writeFileSync(join(g.repo, "README.md"), "operator edit\n");
  writeFileSync(join(g.repo, "operator-notes.txt"), "mine\n");
  return g;
}
const operatorUntouched = (g: ReturnType<typeof makeGitProject>) => {
  expect(readFileSync(join(g.repo, "README.md"), "utf8")).toBe("operator edit\n");
  expect(existsSync(join(g.repo, "operator-notes.txt"))).toBe(true);
  expect(git(g.repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
};

test("R21: in place, recover skips the undo and says so when the checkout is not on the ticket branch", () => {
  const g = operatorOnMain();
  const lines: string[] = [];
  const db = new Database(g.dbPath);
  const out = recover(db, {
    inPlace: true,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    warn: (l) => lines.push(l),
  });
  expect(out.interrupted).toBe(1);
  operatorUntouched(g);
  expect(lines.join("\n")).toContain("skipped undoing the interrupted step's edits");
  expect(lines.join("\n")).toContain("not on b");
  db.close();
});

test("R21: --fresh and clean skip the undo when the checkout is not on the ticket branch", () => {
  const g = operatorOnMain();
  const lines: string[] = [];
  undoBeforeDiscard(g.dbPath, (l) => lines.push(l));
  operatorUntouched(g);
  expect(lines.join("\n")).toContain("skipped undoing the interrupted step's edits");
  const err = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    reapEffort(g.repo, {
      branch: g.branch,
      dir: dirname(g.dbPath),
      ticketId: g.ticketId,
      dbPath: g.dbPath,
    });
  } finally {
    err.mockRestore();
  }
  operatorUntouched(g);
});

test("R21: a failing undo (a stale index.lock) warns and the resume goes on", () => {
  const g = interruptedInPlace();
  writeFileSync(join(g.repo, ".git", "index.lock"), "");
  const lines: string[] = [];
  const db = new Database(g.dbPath);
  const out = recover(db, {
    inPlace: true,
    repoPath: g.repo,
    branch: g.branch,
    acceptHead: false,
    warn: (l) => lines.push(l),
  });
  expect(out.interrupted).toBe(1);
  expect(steps.getById(db, g.stepId)?.status).toBe("pending");
  expect(lines.join("\n")).toContain("could not undo the interrupted step's edits");
  expect(lines.join("\n")).toContain("index.lock");
  db.close();
});

test("R21: a failing undo (a stale index.lock) warns and clean still removes the checkpoint", () => {
  const g = interruptedInPlace();
  writeFileSync(join(g.repo, ".git", "index.lock"), "");
  const lines: string[] = [];
  undoBeforeDiscard(g.dbPath, (l) => lines.push(l));
  expect(lines.join("\n")).toContain("could not undo the interrupted step's edits");
  const written: string[] = [];
  const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    reapEffort(g.repo, {
      branch: g.branch,
      dir: dirname(g.dbPath),
      ticketId: g.ticketId,
      dbPath: g.dbPath,
    });
  } finally {
    err.mockRestore();
  }
  expect(existsSync(dirname(g.dbPath))).toBe(false);
  expect(written.join("")).toContain("could not undo the interrupted step's edits");
});

test("R21: a failing undo (a stale index.lock) warns and --fresh still starts over", async () => {
  const g = interruptedInPlace();
  writeFileSync(join(g.repo, ".git", "index.lock"), "");
  const written: string[] = [];
  const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await freshOver(g);
  } finally {
    err.mockRestore();
  }
  expect(written.join("")).toContain("could not undo the interrupted step's edits");
  expect(existsSync(join(parkDir("test-project", "ENG-1"), "run.db"))).toBe(true);
});

test("R21: a fresh run on a reused --db reports an older checkpoint's live pid on stderr", async () => {
  const g = makeGitProject();
  const dbPath = join(state, "reused", "run.db");
  makeTicketDb({ path: dbPath, pid: process.pid, targetRepo: g.repo });
  const written: string[] = [];
  const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await freshOver(g, undefined, { db: dbPath });
  } finally {
    err.mockRestore();
  }
  expect(written.join("")).toContain(
    `pid ${process.pid} is alive but its identity cannot be confirmed`,
  );
});
