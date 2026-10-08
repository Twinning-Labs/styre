// ENG-485 Task 14 (spec section 7.5, "A test interrupts at every launch site, and between launches"):
// a real run is interrupted through the stop handler at each place a stop can land, then resumed
// through the real `resumeRun`. The run is driven by `driveToTerminal` (the loop `runTicket` runs)
// over a run database at the checkpoint's live location, with real step handlers and real launches.
// The handler is called as `styre run`'s installed listener calls it, with the run's own connection,
// and with its re-raise and exit stubbed. Every case runs in place, where the checkout itself is the
// working folder (R19: in worktree mode `ensureWorktree`'s `worktree add -B` undoes the branch
// return, a known limit owned by a separate task).
//
// After the resume, each case asserts:
//  - the step is redone;
//  - after recover() its attempt equals its value before the interrupted attempt;
//  - the dispatch row the stop caught is `interrupted` with `partial = 1`, where the case has one.
//    Only case 1 (the agent launch) does. Cases 2, 3 and 7 stop a command, which is not a
//    dispatch: no dispatch row is touched. Case 4 stops the step before it opens its dispatch row.
//    In cases 5 and 6 the authoring dispatch had already completed with its commit before the test
//    run the stop caught, so there is nothing to close; resume marks it `reverted` (5) or, with
//    --accept-head, leaves it as it was (6);
//  - the checkout is back to its state before the dispatch;
//  - run code wrote nothing to the run database during the stop: the database once the stop and
//    the run code have both ended equals the one just before the stop, row for row and column for
//    column, apart from the handler's own writes (one note row, the attempt it gave back, the
//    dispatch row it closed). This is stricter than comparing row counts: it also catches a step
//    status, a dispatch outcome or any other column changed in place.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { claudeAgentRunner } from "../../src/agent/providers/claude.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "../../src/agent/runner.ts";
import { parkDir, resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import type { StepRegistry } from "../../src/daemon/step-registry.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { classifyAcCheck, insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import {
  completeDispatch,
  getLatestWorktreePath,
  insertDispatch,
  nextSeq,
} from "../../src/db/repos/dispatch.ts";
import type { EventLogRow } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { insertPending, markSucceeded } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { type Profile, parseProfile } from "../../src/dispatch/profile.ts";
import { branchHeadSha } from "../../src/dispatch/worktree.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import * as door from "../../src/util/process/door.ts";
import { listProcesses } from "../../src/util/process/proc-table.ts";
import {
  type HandlerCtx,
  type HandlerDeps,
  __resetSignalsForTests,
  handleStopSignal,
} from "../../src/util/process/signals.ts";
import { nowUtc } from "../../src/util/time.ts";

const FX = join(import.meta.dir, "fixtures");
const SLUG = "test-project";
const IDENT = "ENG-1";
const BRANCH = "feat/ENG-1";
/** Every case drives a whole run, stops it and resumes it. */
const SLOW = 60_000;
/** The stand-in agent's tool command lives this many seconds at most, whatever happens. */
const STANDIN_LIFE = "47";
/** A command launch blocks this many seconds at most, whatever happens. */
const BLOCK_LIFE = 45;

// ---- cleanup: only what this file started ---------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  // Launches still live (a case that failed before its stop): this file started them.
  for (const h of door.liveLaunches()) {
    try {
      process.kill(h.record.kind === "group" ? -h.record.pid : h.record.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    h.proc.unref();
  }
  door.__resetForTests();
  __resetSignalsForTests();
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

// ---- small helpers --------------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env } });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trimEnd(); // a status line may start with a space
}

async function until(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** True when `p` settles within `ms`; the timer never outlives the call. */
async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The state of the checkout an in-place step works in: branch, HEAD, every change against HEAD
 *  (untracked files included), and the content of every untracked file. */
function checkoutState(repo: string) {
  const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const untracked = status
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3));
  return {
    branch: git(repo, ["symbolic-ref", "--quiet", "HEAD"]),
    head: git(repo, ["rev-parse", "HEAD"]),
    status,
    untracked: Object.fromEntries(untracked.map((p) => [p, readFileSync(join(repo, p), "utf8")])),
  };
}

type Rows = Record<string, Record<string, Record<string, unknown>>>;
/** Every row of every table of the run database, keyed by table and rowid, read through a
 *  connection of its own. SQLite's own tables are left out, except `sqlite_sequence`: a row run
 *  code inserted and deleted again during the stop still shows there, as a bumped sequence. */
function dbRows(dbPath: string): Rows {
  const c = new Database(dbPath, { readonly: true });
  try {
    const tables = c
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')",
      )
      .all()
      .map((t) => t.name);
    const out: Rows = {};
    for (const t of tables) {
      out[t] = {};
      for (const r of c
        .query<Record<string, unknown>, []>(`SELECT rowid AS __rowid, * FROM "${t}"`)
        .all()) {
        const { __rowid, ...rest } = r;
        (out[t] as Record<string, Record<string, unknown>>)[String(__rowid)] = rest;
      }
    }
    return out;
  } finally {
    c.close();
  }
}

/** What changed between two snapshots: rows added, removed, and each changed row's columns. */
function dbDiff(before: Rows, after: Rows) {
  const added: { table: string; row: Record<string, unknown> }[] = [];
  const removed: { table: string; rowid: string }[] = [];
  const changed: { table: string; rowid: string; columns: Record<string, [unknown, unknown]> }[] =
    [];
  for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[t] ?? {};
    const a = after[t] ?? {};
    for (const id of Object.keys(a)) {
      const rowB = b[id];
      const rowA = a[id] as Record<string, unknown>;
      if (!rowB) {
        added.push({ table: t, row: rowA });
        continue;
      }
      const columns: Record<string, [unknown, unknown]> = {};
      for (const k of Object.keys(rowA)) {
        if (JSON.stringify(rowA[k]) !== JSON.stringify(rowB[k])) columns[k] = [rowB[k], rowA[k]];
      }
      if (Object.keys(columns).length > 0) changed.push({ table: t, rowid: id, columns });
    }
    for (const id of Object.keys(b)) if (!a[id]) removed.push({ table: t, rowid: id });
  }
  return { added, removed, changed };
}

function stepRow(dbPath: string, key: string) {
  const c = new Database(dbPath, { readonly: true });
  try {
    return c
      .query<
        {
          id: number;
          status: string;
          attempt: number;
          started_at: string | null;
          error_json: string | null;
        },
        [string]
      >("SELECT id, status, attempt, started_at, error_json FROM workflow_step WHERE step_key = ?")
      .get(key);
  } finally {
    c.close();
  }
}

function dispatchRows(dbPath: string) {
  const c = new Database(dbPath, { readonly: true });
  try {
    return c
      .query<
        {
          id: number;
          step_id: number | null;
          outcome: string | null;
          partial: number;
          branch_head_sha: string | null;
        },
        []
      >("SELECT id, step_id, outcome, partial, branch_head_sha FROM dispatch ORDER BY id")
      .all();
  } finally {
    c.close();
  }
}

const ok = (stdout: string): AgentRunResult => ({
  completed: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});
const sessionLimit = (): AgentRunResult => ({
  completed: false,
  exitCode: 1,
  stdout: "",
  stderr: "You have reached your session limit · resets tomorrow",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
  cause: "session-limit",
  resetAt: "tomorrow",
});

// ---- the run ----------------------------------------------------------------------------------------

interface Run {
  repo: string;
  dbPath: string;
  ticketId: number;
  profile: Profile;
  /** Scripts and logs that live outside the checkout. */
  aux: string;
}

/** A disposable checkout already on the ticket branch, an untracked file that was there before any
 *  step, and a run database at the checkpoint's live location holding the ticket. `seed` adds the
 *  state the case starts from; `components` are the profile's. */
function setUp(
  components: (aux: string) => unknown[],
  seed: (db: Database, ids: { ticketId: number; repo: string; aux: string }) => void,
  repoFiles: Record<string, string> = {},
): Run {
  const state = mkdtempSync(join(tmpdir(), "styre-e2e-int-state-"));
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "styre-e2e-int-repo-")));
  const aux = realpathSync(mkdtempSync(join(tmpdir(), "styre-e2e-int-aux-")));
  cleanups.push(() => {
    if (prevState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    else process.env.XDG_STATE_HOME = prevState;
    for (const d of [state, repo, aux]) rmSync(d, { recursive: true, force: true });
  });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@s.dev"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "readme\n");
  for (const [p, text] of Object.entries(repoFiles)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["checkout", "-q", "-b", BRANCH]);
  // In place needs the disposability marker; kept out of `git status` so the checkout reads clean.
  writeFileSync(join(repo, ".styre-disposable"), "");
  writeFileSync(join(repo, ".git", "info", "exclude"), ".styre-disposable\n");
  writeFileSync(join(repo, "old.txt"), "an untracked file that was there before the run\n");

  const dbPath = join(parkDir(SLUG, IDENT), "run.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  migrate(dbPath);
  const db = openDb(dbPath);
  try {
    const projectId = insertProject(db, { slug: SLUG, targetRepo: repo, defaultBranch: "main" });
    const ticketId = insertTicket(db, { projectId, ident: IDENT });
    insertRun(db, { runId: "e2e-interrupt-run", startedAt: nowUtc(), provider: "claude" });
    seed(db, { ticketId, repo, aux });
    const profile = parseProfile({
      slug: SLUG,
      targetRepo: repo,
      defaultBranch: "main",
      checksSystem: "none",
      components: components(aux),
    });
    return { repo, dbPath, ticketId, profile, aux };
  } finally {
    db.close();
  }
}

const ports = () => ({
  issueTracker: fakeIssueTracker({
    ticket: {
      ident: IDENT,
      title: "Interrupted ticket",
      description: "body",
      typeLabel: "Feature",
      externalId: "uuid-e2e-interrupt",
      url: null,
    },
  }),
  forge: fakeForge(),
  checks: fakeChecks("passing"),
});

function registryFor(run: Run, runner: AgentRunner): StepRegistry {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: run.profile,
    worktreeRoot: run.repo,
    inPlace: true,
    timeoutMs: 60_000,
  });
}

/** The handler's injected dependencies: it never re-raises or exits for real. `onReraise` sees the
 *  moment the real process would end. */
function handlerDeps(onReraise: () => void = () => {}) {
  const out = { lines: [] as string[], reraised: [] as string[], exited: [] as number[] };
  const notes: EventLogRow[] = [];
  const d: HandlerDeps = {
    stderr: (s) => {
      out.lines.push(s);
    },
    emit: (row) => {
      notes.push(row);
    },
    reraise: (sig) => {
      onReraise();
      out.reraised.push(sig);
    },
    exit: (code) => {
      out.exited.push(code);
    },
    now: () => Date.now(),
    leftovers: () => [],
    noCore: () => {},
  };
  return { out, notes, d };
}

interface Interrupted {
  /** The run database just before the stop, and once the stop and the run code have both ended. */
  before: Rows;
  after: Rows;
  /** The checkout before the run started, and once the stop and the run code have both ended. */
  checkoutBefore: ReturnType<typeof checkoutState>;
  checkoutAtStop: ReturnType<typeof checkoutState>;
  /** The stopped step's row as the stop found it, from the snapshot just before the stop. */
  during: { id: number; status: string; attempt: number };
  out: ReturnType<typeof handlerDeps>["out"];
  /** The telemetry rows the handler wrote. */
  notes: EventLogRow[];
  runError: unknown;
}

/** Drive the run until `ready` says the stop should land, then run the stop handler on the run's
 *  own connection, as `styre run`'s installed listener does. `ready` resolves once the launch the
 *  case targets is live; `stopKey` names the step the stop catches. When `stopFromReadHead` is set
 *  the stop instead begins inside the step's own read of the branch head (a blocking git call):
 *  the door closes there and the handler runs as soon as the run code yields. */
async function interrupt(
  run: Run,
  runner: AgentRunner,
  stopKey: string,
  ready: () => Promise<void>,
  opts: { stopFromReadHead?: boolean; onReraise?: () => void } = {},
): Promise<Interrupted> {
  const checkoutBefore = checkoutState(run.repo);
  const db = openDb(run.dbPath);
  const ctx: HandlerCtx = {
    command: "run",
    run: { db, dbPath: run.dbPath, ticketId: run.ticketId, ident: IDENT },
  };
  const { out, notes, d } = handlerDeps(opts.onReraise);
  let before: Rows | null = null;
  let handler: Promise<void> | null = null;
  const startStop = () => {
    before = dbRows(run.dbPath);
    handler = handleStopSignal("SIGINT", ctx, d);
  };
  let readHead = () => branchHeadSha(run.repo, BRANCH);
  if (opts.stopFromReadHead) {
    const real = readHead;
    readHead = () => {
      const head = real();
      if (stepRow(run.dbPath, stopKey)?.status === "running" && before === null) {
        before = dbRows(run.dbPath);
        door.beginStopping();
        // A signal that arrives during a blocking call is handled once the call has returned and
        // the run code yields to the event loop.
        setTimeout(() => {
          handler = handleStopSignal("SIGINT", ctx, d);
        }, 0);
      }
      return head;
    };
  }
  const drive = driveToTerminal(db, registryFor(run, runner), {
    ticketId: run.ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: ports(),
    profile: run.profile,
    readHead,
  });
  let runError: unknown = null;
  const caught = drive.then(
    (r) => {
      runError = new Error(`the run ended without being stopped: ${JSON.stringify(r)}`);
    },
    (e: unknown) => {
      runError = e;
    },
  );
  try {
    if (!opts.stopFromReadHead) {
      await Promise.race([ready(), caught.then(() => Promise.reject(runError))]);
      startStop();
    }
    // A run that ends before the stop starts is a failure of the case, said at once.
    await until("the stop handler to start", () => {
      if (handler === null && runError !== null) throw runError;
      return handler !== null;
    });
    expect(await settles(handler as unknown as Promise<void>, 10_000)).toBe(true);
    expect(await settles(drive, 10_000)).toBe(true);
    await caught;
  } finally {
    // The process would have ended here; the next one opens the database afresh.
    db.close();
  }
  const after = dbRows(run.dbPath);
  const checkoutAtStop = checkoutState(run.repo);
  if (before === null) throw new Error("no snapshot before the stop");
  const found = Object.entries((before as Rows).workflow_step ?? {}).find(
    ([, r]) => r.step_key === stopKey,
  );
  if (!found) throw new Error(`no step ${stopKey} was running when the stop began`);
  const during = {
    id: Number(found[0]),
    status: String(found[1].status),
    attempt: Number(found[1].attempt),
  };
  door.__resetForTests();
  __resetSignalsForTests();
  return { before, after, checkoutBefore, checkoutAtStop, during, out, notes, runError };
}

/** Section 7.5 (R3): nothing but the handler wrote to the run database during the stop. The
 *  handler's writes are one note, the attempt given back on the stopped step, and the dispatch row
 *  it closed (when `dispatchRowId` is given). */
function expectOnlyHandlerWrites(i: Interrupted, stepId: number, dispatchRowId: number | null) {
  const diff = dbDiff(i.before, i.after);
  expect(diff.removed).toEqual([]);
  expect(diff.added.map((a) => [a.table, a.row.kind, a.row.reason])).toEqual([
    ["event_log", "note", "interrupted"],
  ]);
  // The same note went out as the interruption's telemetry event, naming the stopped step.
  expect(i.notes.map((n) => [n.seq, n.reason])).toEqual([
    [Number(diff.added[0]?.row.seq), "interrupted"],
  ]);
  expect(JSON.parse(i.notes[0]?.payload_json ?? "{}")).toMatchObject({ stepId });
  const expected: { table: string; rowid: string; columns: string[] }[] = [
    { table: "workflow_step", rowid: String(stepId), columns: ["attempt", "updated_at"] },
  ];
  if (dispatchRowId !== null) {
    expected.push({
      table: "dispatch",
      rowid: String(dispatchRowId),
      columns: ["duration_ms", "ended_at", "outcome", "partial"],
    });
  }
  expect(
    diff.changed
      .map((c) => ({ table: c.table, rowid: c.rowid, columns: Object.keys(c.columns).sort() }))
      .sort((a, b) => a.table.localeCompare(b.table)),
  ).toEqual(expected.sort((a, b) => a.table.localeCompare(b.table)));
  const attempt = diff.changed.find((c) => c.table === "workflow_step")?.columns.attempt;
  expect(attempt).toEqual([i.during.attempt, i.during.attempt - 1]);
}

/** What resume's recover() left, seen from inside resumeRun right after it: the registry is built
 *  after recover() and before the first step runs. */
interface AfterRecover {
  /** `error_json` is null unless recover() marked the step failed on its way to pending, as it does
   *  for a crash: an interruption must not be, or the redone dispatch gets it as a prior failure. */
  step: { status: string; attempt: number; error_json: string | null } | null;
  checkout: ReturnType<typeof checkoutState>;
}

/** Resume through the real `resumeRun`, in place, with `runner` for every redone dispatch. */
async function resume(
  run: Run,
  stopKey: string,
  runner: AgentRunner,
  opts: { acceptHead?: boolean } = {},
): Promise<{ afterRecover: AfterRecover | null; stderr: string }> {
  // resumeRun works in place only when the checkpoint's latest dispatch worked in the checkout.
  const c = new Database(run.dbPath, { readonly: true });
  try {
    expect(getLatestWorktreePath(c, run.ticketId)).toBe(run.repo);
  } finally {
    c.close();
  }
  let afterRecover: AfterRecover | null = null;
  const stderr: string[] = [];
  // stderr is the resume's human output; stdout carries its telemetry, which is not looked at here.
  const write = process.stderr.write.bind(process.stderr);
  const writeOut = process.stdout.write.bind(process.stdout);
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    stderr.push(String(s));
    return true;
  };
  (process.stdout as { write: unknown }).write = () => true;
  const previousExit = process.exitCode ?? 0;
  try {
    process.exitCode = 0;
    await resumeRun(
      { resume: IDENT, acceptHead: opts.acceptHead },
      run.profile,
      DEFAULT_RUNTIME_CONFIG,
      {
        buildRegistry: () => {
          const s = stepRow(run.dbPath, stopKey);
          afterRecover = {
            step: s ? { status: s.status, attempt: s.attempt, error_json: s.error_json } : null,
            checkout: checkoutState(run.repo),
          };
          return registryFor(run, runner);
        },
        ports: ports(),
        preflight: () => ({ ok: true, version: null }),
      },
    );
    return { afterRecover, stderr: stderr.join("") };
  } finally {
    (process.stderr as { write: unknown }).write = write;
    (process.stdout as { write: unknown }).write = writeOut;
    process.exitCode = previousExit;
  }
}

/** A runner that parks the run at its first dispatch, recording which steps it was asked for. */
function parkingRunner(): { runner: FakeAgentRunner; asked: string[] } {
  const asked: string[] = [];
  const runner = new FakeAgentRunner((input: AgentRunInput) => {
    asked.push(input.context?.stepId === undefined ? "?" : String(input.context.stepId));
    return sessionLimit();
  });
  return { runner, asked };
}

const appComponent = {
  name: "app",
  kind: "node",
  paths: ["**"],
  commands: { build: "true", test: "true" },
};

// ---- 1. the agent launch ------------------------------------------------------------------------

test(
  "1. a stop during the implement dispatch: the agent is stopped, its edits undone, the dispatch closed as interrupted, and the step redone",
  async () => {
    const run = setUp(
      () => [appComponent],
      (db, { ticketId }) => {
        db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
        insertWorkUnit(db, {
          ticketId,
          seq: 1,
          kind: "backend",
          behavioral: 0,
          verifyCheckTypes: [],
        });
      },
    );
    const prevSleep = process.env.STANDIN_SLEEP;
    process.env.STANDIN_SLEEP = STANDIN_LIFE;
    cleanups.push(() => {
      if (prevSleep === undefined) Reflect.deleteProperty(process.env, "STANDIN_SLEEP");
      else process.env.STANDIN_SLEEP = prevSleep;
    });
    const key = "implement:wu1:dispatch";
    let agentPid = 0;
    let toolPid = 0;
    const i = await interrupt(
      run,
      claudeAgentRunner(join(FX, "standin-agent.sh")),
      key,
      async () => {
        await until("the agent launch", () =>
          door.liveLaunches().some((h) => h.record.kind === "agent"),
        );
        agentPid = door.liveLaunches().find((h) => h.record.kind === "agent")?.record.pid ?? 0;
        await until("the agent's tool command", () =>
          listProcesses().some((p) => p.ppid === agentPid && p.state !== "zombie"),
        );
        toolPid = listProcesses().find((p) => p.ppid === agentPid)?.pid ?? 0;
        // The agent edits the checkout while it works.
        writeFileSync(join(run.repo, "agent-new.txt"), "written by the agent\n");
        writeFileSync(join(run.repo, "README.md"), "changed by the agent\n");
      },
    );
    expect(i.runError).toBeInstanceOf(door.RunInterrupted);
    expect(i.out.lines.join("")).toContain(
      `styre: stopped the agent (pid ${agentPid}) and 1 of its commands.`,
    );
    expect(i.out.reraised).toEqual(["SIGINT"]);
    // The agent's edits were in the checkout when it stopped.
    expect(i.checkoutAtStop.untracked["agent-new.txt"]).toBe("written by the agent\n");
    expect(i.checkoutAtStop.status).toContain(" M README.md");
    // Both the agent and its tool command are gone.
    const live = new Set(
      listProcesses()
        .filter((p) => p.state !== "zombie")
        .map((p) => p.pid),
    );
    expect(live.has(agentPid)).toBe(false);
    expect(live.has(toolPid)).toBe(false);

    const rows = dispatchRows(run.dbPath);
    expect(rows).toHaveLength(1);
    const row = rows[0] as (typeof rows)[number];
    expect(row).toMatchObject({ step_id: i.during.id, outcome: "interrupted", partial: 1 });
    expectOnlyHandlerWrites(i, i.during.id, row.id);
    // markRunning counted the interrupted attempt; the step did not exist before it.
    expect(i.during).toMatchObject({ status: "running", attempt: 1 });

    const { runner, asked } = parkingRunner();
    const r = await resume(run, key, runner);
    expect(r.afterRecover).toEqual({
      step: { status: "pending", attempt: 0, error_json: null }, // its value before the interrupted attempt; not failed
      checkout: i.checkoutBefore,
    });
    expect(asked).toEqual([String(i.during.id)]); // the step was redone
    expect(dispatchRows(run.dbPath).find((d) => d.id === row.id)).toMatchObject({
      outcome: "interrupted",
      partial: 1,
    });
  },
  SLOW,
);

// ---- command launches ---------------------------------------------------------------------------

/** A shell script outside the checkout. Each run is logged to `<aux>/<name>.log` as `run <cwd>`.
 *  Then it exits 1 when `failWhen` (a file in its working folder) exists; otherwise, while
 *  `<aux>/block` exists, it logs `blocking` and blocks for BLOCK_LIFE seconds at most. With
 *  `version`, a `--version` probe exits 0 at once, unlogged (the check capability probe). */
function blockingScript(
  aux: string,
  name: string,
  opts: { version?: boolean; failWhen?: string } = {},
): string {
  const path = join(aux, `${name}.sh`);
  const log = join(aux, `${name}.log`);
  writeFileSync(
    path,
    [
      opts.version ? '[ "$1" = "--version" ] && exit 0' : "",
      `echo "run $(pwd)" >> '${log}'`,
      opts.failWhen ? `[ -f '${opts.failWhen}' ] && exit 1` : "",
      `if [ -f '${join(aux, "block")}' ]; then echo blocking >> '${log}'; exec sleep ${BLOCK_LIFE}; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  writeFileSync(join(aux, "block"), "");
  return path;
}
const logLines = (aux: string, name: string): string[] => {
  try {
    return readFileSync(join(aux, `${name}.log`), "utf8")
      .trim()
      .split("\n");
  } catch {
    return [];
  }
};
/** Resolves once the script has logged `blocking` and its command group is a live launch. */
const blocked = (aux: string, name: string) => async () => {
  await until(`${name} to block`, () => logLines(aux, name).includes("blocking"));
  await until("the command launch", () =>
    door.liveLaunches().some((h) => h.record.kind === "group" && h.record.command.includes(name)),
  );
};

/** A completed dispatch of an earlier step that worked in the checkout, at its current head. The
 *  latest dispatch's folder is how resume tells an in-place run from a worktree one. */
function designDispatch(db: Database, ticketId: number, repo: string): void {
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
    startedAt: nowUtc(),
    worktreePath: repo,
  });
  completeDispatch(db, d.id, {
    outcome: "clean-success",
    branchHeadSha: git(repo, ["rev-parse", "HEAD"]),
    endedAt: nowUtc(),
  });
}

/** The ticket at `implement` with its one unit verified and a committed head recorded on a
 *  dispatch row that worked in the checkout, so the next steps are provision and then `next`. */
function verifiedUnit(db: Database, ticketId: number, repo: string): void {
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: [],
    status: "verified",
  });
  designDispatch(db, ticketId, repo);
}

/** The assertions every command case shares: the stop said what it stopped, no dispatch row
 *  was touched, the checkout is as it was, the step returns at its attempt before the stop, and
 *  the resumed run redoes it (its script runs again). */
async function expectCommandCaseResumes(
  run: Run,
  i: Interrupted,
  key: string,
  script: string,
): Promise<void> {
  expect(i.runError).toBeInstanceOf(door.RunInterrupted);
  expect(i.out.reraised).toEqual(["SIGINT"]);
  expect(i.during).toMatchObject({ status: "running", attempt: 1 });
  // No dispatch was in flight: the only rows are the seeded ones, untouched.
  expectOnlyHandlerWrites(i, i.during.id, null);
  const runsBefore = logLines(run.aux, script).filter((l) => l.startsWith("run")).length;
  rmSync(join(run.aux, "block"));
  const { runner } = parkingRunner();
  const r = await resume(run, key, runner);
  expect(r.afterRecover).toEqual({
    step: { status: "pending", attempt: 0, error_json: null }, // its value before the interrupted attempt; not failed
    checkout: i.checkoutBefore,
  });
  // Redone: the script ran again, and the step finished this time.
  expect(logLines(run.aux, script).filter((l) => l.startsWith("run")).length).toBeGreaterThan(
    runsBefore,
  );
  expect(stepRow(run.dbPath, key)?.status).toBe("succeeded");
}

test(
  "2. a stop during a suite (runBoundedCommand in verify:integration): the group is stopped, nothing recorded by run code, the step redone",
  async () => {
    const run = setUp(
      (aux) => [
        {
          name: "app",
          kind: "node",
          paths: ["**"],
          commands: { build: "true", test: `sh '${blockingScript(aux, "suite")}'` },
        },
      ],
      (db, { ticketId, repo }) => verifiedUnit(db, ticketId, repo),
    );
    const key = "verify:integration";
    const { runner } = parkingRunner();
    const i = await interrupt(run, runner, key, blocked(run.aux, "suite"));
    expect(i.checkoutAtStop).toEqual(i.checkoutBefore);
    await expectCommandCaseResumes(run, i, key, "suite");
  },
  SLOW,
);

test(
  "3. a stop during an acceptance check (runCommand in verify:checks-gate): the group is stopped, nothing recorded by run code, the step redone",
  async () => {
    const testFile = "checks/ENG-1_ac1_test.js";
    const run = setUp(
      (aux) => [
        // Listed first, so it owns the check's path (impactedComponents takes the first).
        {
          name: "checks",
          kind: "node",
          paths: ["checks/**"],
          testAction: {
            framework: "jest",
            launcher: `sh '${blockingScript(aux, "check", { version: true })}'`,
          },
        },
        { name: "app", kind: "node", paths: ["**"], commands: { build: "true", test: "true" } },
      ],
      (db, { ticketId, repo }) => {
        verifiedUnit(db, ticketId, repo);
        const ac = insertAc(db, { ticketId, seq: 1, text: "it works", source: "checklist" });
        const check = insertAcCheck(db, {
          ticketId,
          acId: ac.id,
          selector: testFile,
          testPath: testFile,
          redFirstResult: "red",
        });
        classifyAcCheck(db, { acCheckId: check.id, redClass: "assertion" });
        insertSignal(db, {
          ticketId,
          signalType: "ac-check-red-first",
          result: "fail",
          branchHeadSha: git(repo, ["rev-parse", "HEAD"]),
          detail: {
            rawOutput: "",
            exitCode: 1,
            framework: "jest",
            command: null,
            acCheckId: check.id,
          },
        });
      },
      { [testFile]: "test('ac1 works', () => { expect(1).toBe(1); });\n" },
    );
    const key = "verify:checks-gate";
    const { runner } = parkingRunner();
    const i = await interrupt(run, runner, key, blocked(run.aux, "check"));
    expect(i.checkoutAtStop).toEqual(i.checkoutBefore);
    await expectCommandCaseResumes(run, i, key, "check");
  },
  SLOW,
);

test(
  "7. a stop while a baseline worktree exists (m3): no styre-baseline worktree is left registered, the step redone",
  async () => {
    const worktrees = (repo: string) =>
      git(repo, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((l) => l.startsWith("worktree ") && l.includes("styre-baseline"));
    let base = "";
    const run = setUp(
      (aux) => [
        {
          name: "app",
          kind: "node",
          paths: ["**"],
          commands: {
            build: "true",
            // Fails at the delivered head, so verify:integration runs it again at the baseline,
            // where it blocks.
            test: `sh '${blockingScript(aux, "suite", { failWhen: "delivered.txt" })}'`,
          },
        },
      ],
      (db, { ticketId, repo }) => {
        base = git(repo, ["rev-parse", "HEAD"]);
        writeFileSync(join(repo, "delivered.txt"), "the change\n");
        git(repo, ["add", "delivered.txt"]);
        git(repo, ["commit", "-q", "-m", "delivered"]);
        verifiedUnit(db, ticketId, repo);
        // The baseline is where the first RED-first check ran: before the change.
        insertSignal(db, {
          ticketId,
          signalType: "ac-check-red-first",
          result: "fail",
          branchHeadSha: base,
          detail: { rawOutput: "", exitCode: 1 },
        });
      },
    );
    const key = "verify:integration";
    const { runner } = parkingRunner();
    const seen: { atStop: string[] | null; whileBlocked: string[] } = {
      atStop: null,
      whileBlocked: [],
    };
    const i = await interrupt(
      run,
      runner,
      key,
      async () => {
        await blocked(run.aux, "suite")();
        seen.whileBlocked = worktrees(run.repo);
        // If the removal under test fails, the folder outlives the repository: remove it anyway.
        for (const w of seen.whileBlocked) {
          const dir = w.slice("worktree ".length);
          cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        }
      },
      // What is registered at the moment the real process would end.
      {
        onReraise: () => {
          seen.atStop = worktrees(run.repo);
        },
      },
    );
    // The stop landed while the baseline worktree existed, and it was gone when the process would
    // have ended.
    expect(seen.whileBlocked).toHaveLength(1);
    expect(seen.atStop).toEqual([]);
    expect(i.checkoutAtStop).toEqual(i.checkoutBefore);
    await expectCommandCaseResumes(run, i, key, "suite");
    expect(worktrees(run.repo)).toEqual([]);
  },
  SLOW,
);

// ---- between launches ---------------------------------------------------------------------------

test(
  "4. a stop between launches (inside the step's blocking read of the branch head): the next launch is refused, nothing recorded by run code, the step redone",
  async () => {
    const run = setUp(
      () => [appComponent],
      (db, { ticketId, repo }) => {
        db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
        insertWorkUnit(db, {
          ticketId,
          seq: 1,
          kind: "backend",
          behavioral: 0,
          verifyCheckTypes: [],
        });
        // An earlier step's dispatch worked in the checkout: that is how resume knows the run is
        // in place.
        designDispatch(db, ticketId, repo);
      },
    );
    const key = "implement:wu1:dispatch";
    const first = parkingRunner();
    const i = await interrupt(run, first.runner, key, async () => {}, { stopFromReadHead: true });
    expect(i.runError).toBeInstanceOf(door.RunInterrupted);
    expect(i.out.reraised).toEqual(["SIGINT"]);
    expect(first.asked).toEqual([]); // the agent was never launched
    expect(i.during).toMatchObject({ status: "running", attempt: 1 });
    // The stop landed before the step's dispatch row was opened: there is none to close.
    expect(dispatchRows(run.dbPath).filter((d) => d.step_id === i.during.id)).toEqual([]);
    expectOnlyHandlerWrites(i, i.during.id, null);
    expect(i.checkoutAtStop).toEqual(i.checkoutBefore);

    const { runner, asked } = parkingRunner();
    const r = await resume(run, key, runner);
    expect(r.afterRecover).toEqual({
      step: { status: "pending", attempt: 0, error_json: null }, // its value before the interrupted attempt; not failed
      checkout: i.checkoutBefore,
    });
    expect(asked).toEqual([String(i.during.id)]); // the step was redone
  },
  SLOW,
);

// ---- the checks step: a commit, then a test run (M1, N1) ---------------------------------------

const AUTHORED = "checks/ENG-1_ac1_test.js";

/** The ticket at `design`, with its plan done and sized, about to author its acceptance checks: the
 *  checks step commits the authored test (through the runner's commit), then runs it, and the stop
 *  lands during that run. Returns the run, the head the step started at, and the interruption. */
async function interruptChecksTestRun() {
  let acId = 0;
  const run = setUp(
    (aux) => [
      {
        name: "checks",
        kind: "node",
        paths: ["checks/**"],
        testAction: {
          framework: "jest",
          launcher: `sh '${blockingScript(aux, "check", { version: true })}'`,
        },
      },
      { name: "app", kind: "node", paths: ["src/**"], commands: { build: "true", test: "true" } },
    ],
    (db, { ticketId }) => {
      db.query("UPDATE ticket SET stage = 'design', track = 'fast' WHERE id = ?").run(ticketId);
      const plan = insertPending(db, {
        ticketId,
        stepKey: "design:dispatch",
        stepType: "dispatch",
      });
      markSucceeded(db, plan.id, {});
      insertWorkUnit(db, {
        ticketId,
        seq: 1,
        kind: "backend",
        behavioral: 0,
        verifyCheckTypes: [],
      });
      acId = insertAc(db, { ticketId, seq: 1, text: "it works", source: "checklist" }).id;
    },
  );
  const headAtStart = git(run.repo, ["rev-parse", "HEAD"]);
  // The plan-blind author: writes the check it declares.
  const author = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "checks"), { recursive: true });
    writeFileSync(join(input.cwd, AUTHORED), "test('ac1 works', () => {});\n");
    return ok(
      `Authored.\n\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [{ ac_id: acId, test_file: AUTHORED, test_name: "ac1 works" }],
      })}\n\`\`\``,
    );
  });
  const key = "checks:dispatch";
  const i = await interrupt(run, author, key, blocked(run.aux, "check"));
  expect(i.runError).toBeInstanceOf(door.RunInterrupted);
  expect(i.out.reraised).toEqual(["SIGINT"]);
  expect(i.during).toMatchObject({ status: "running", attempt: 1 });
  // The step committed the authored test before the stop: the branch moved.
  const committed = git(run.repo, ["rev-parse", "HEAD"]);
  expect(committed).not.toBe(headAtStart);
  expect(git(run.repo, ["show", "--name-only", "--format=", committed])).toBe(AUTHORED);
  const rows = dispatchRows(run.dbPath);
  expect(rows).toHaveLength(1);
  const row = rows[0] as (typeof rows)[number];
  // The authoring dispatch had already completed with its commit; the stop has nothing to close.
  expect(row).toMatchObject({ outcome: "clean-success", branch_head_sha: committed, partial: 0 });
  expectOnlyHandlerWrites(i, i.during.id, null);
  rmSync(join(run.aux, "block"));
  return { run, i, key, headAtStart, committed, rowId: row.id };
}

test(
  "5. a stop during the checks step's test run, after its commit (M1): the branch returns to where the step started, the dispatch is marked reverted, the step redone",
  async () => {
    const { run, i, key, headAtStart, rowId } = await interruptChecksTestRun();
    const { runner, asked } = parkingRunner();
    const r = await resume(run, key, runner);
    expect(r.afterRecover).toEqual({
      step: { status: "pending", attempt: 0, error_json: null }, // its value before the interrupted attempt; not failed
      checkout: i.checkoutBefore, // HEAD back at headAtStart, the authored test gone
    });
    expect(i.checkoutBefore.head).toBe(headAtStart);
    expect(dispatchRows(run.dbPath).find((d) => d.id === rowId)).toMatchObject({
      outcome: "reverted",
      branch_head_sha: headAtStart,
    });
    expect(asked).toEqual([String(i.during.id)]); // the step was redone
  },
  SLOW,
);

test(
  "6. the same stop, then an operator commit and --accept-head (N1): the operator's commit is kept and nothing is reset",
  async () => {
    const { run, i, key, committed, rowId } = await interruptChecksTestRun();
    writeFileSync(join(run.repo, "operator.txt"), "the operator's own change\n");
    git(run.repo, ["add", "operator.txt"]);
    git(run.repo, ["commit", "-q", "-m", "operator"]);
    const operator = git(run.repo, ["rev-parse", "HEAD"]);
    const { runner, asked } = parkingRunner();
    const r = await resume(run, key, runner, { acceptHead: true });
    expect(r.afterRecover?.step).toEqual({ status: "pending", attempt: 0, error_json: null });
    expect(r.afterRecover?.checkout.head).toBe(operator);
    expect(git(run.repo, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(operator);
    expect(git(run.repo, ["rev-list", "--count", `${committed}..${operator}`])).toBe("1");
    expect(r.stderr).toContain(
      `styre: the interrupted step's commits remain under the current HEAD of ${BRANCH} (--accept-head was given); nothing was reset`,
    );
    expect(dispatchRows(run.dbPath).find((d) => d.id === rowId)).toMatchObject({
      outcome: "clean-success",
      branch_head_sha: committed,
    });
    expect(asked).toEqual([String(i.during.id)]); // the step was redone
  },
  SLOW,
);
