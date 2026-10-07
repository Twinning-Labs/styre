// ENG-485 Task 11: the stop handler wired into `styre run`, `styre run --resume` and `styre setup`;
// the error boundary while stopping (review round 4, m1); and the outbox drain (m2). Every handler
// here is installed with an injected re-raise and exit, so no test sends a real signal to the test
// process or ends it: `process.emit` calls the listeners only.
//
// The pseudo terminal test of Ctrl-C at a setup prompt lives in Task 15, with its pty helper (R4).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunResult } from "../../src/agent/runner.ts";
import { StyreError, usageError } from "../../src/cli/errors.ts";
import { assertNoLeakedLaunches } from "../../src/cli/exit-check.ts";
import { guard } from "../../src/cli/output.ts";
import { parkDir, resumeRun } from "../../src/cli/park.ts";
import { runCommandBody, runImpl } from "../../src/cli/run.ts";
import { runSetup, setupCommandBody, setupImpl } from "../../src/cli/setup.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { slugForCwd } from "../../src/config/discover.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import type { EventLogRow } from "../../src/db/repos/event-log.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import type { IssueTrackerPort } from "../../src/integrations/issue-tracker.ts";
import type { EnrichDeps } from "../../src/setup/enrich.ts";
import type { AnalyticsClient } from "../../src/telemetry/analytics/client.ts";
import { telemetryEnabled } from "../../src/telemetry/analytics/consent.ts";
import * as door from "../../src/util/process/door.ts";
import {
  __setCwdReadersForTests,
  checkLeftoversInBackground,
} from "../../src/util/process/leftovers.ts";
import { nowToken } from "../../src/util/process/proc-table.ts";
import {
  type HandlerDeps,
  __resetSignalsForTests,
  installStopHandlers,
} from "../../src/util/process/signals.ts";
import { makeOutboxDb } from "../helpers/lifecycle.ts";
import { cleanupParkedRun, runParkedTicket } from "../helpers/run-harness.ts";

const SIGS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
const counts = (): number[] => SIGS.map((s) => process.listenerCount(s));
const plusOne = (c: number[]): number[] => c.map((n) => n + 1);
const STOP_LINE =
  "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…\n";
const RESUME_LINE = "styre: run interrupted; resume with: styre run --resume ENG-1\n";

afterEach(() => {
  __setCwdReadersForTests(undefined);
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
});

// ---- shared fixtures ------------------------------------------------------------------------------

/** The handler's injected dependencies: everything it says and does is captured, and it never
 *  re-raises or exits for real. */
function handlerDeps() {
  const out = {
    lines: [] as string[],
    exited: [] as number[],
    reraised: [] as string[],
    emitted: [] as { row: EventLogRow; db: Database }[],
  };
  const d: Partial<HandlerDeps> = {
    stderr: (s) => {
      out.lines.push(s);
    },
    emit: (row, db) => {
      out.emitted.push({ row, db });
    },
    reraise: (sig) => {
      out.reraised.push(sig);
    },
    exit: (code) => {
      out.exited.push(code);
    },
    leftovers: () => [],
  };
  return { out, d };
}

/** An analytics client that records events. When gated, `shutdown` waits until `open()`: the
 *  handler calls it just before it releases the run lock, so a gated test can look at the run while
 *  the handler still holds the exit. */
function analytics(gated: boolean) {
  const events: string[] = [];
  let shutdowns = 0;
  let open: () => void = () => {};
  const gate = gated
    ? new Promise<void>((r) => {
        open = r;
      })
    : Promise.resolve();
  const client: AnalyticsClient = {
    capture: (_id, event) => {
      events.push(event);
    },
    shutdown: async () => {
      shutdowns++;
      await gate;
    },
  };
  return { events, client, shutdowns: () => shutdowns, open: () => open() };
}

const ENV_KEYS = [
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "STYRE_TELEMETRY",
  "DO_NOT_TRACK",
  "SLACK_BOT_TOKEN",
] as const;
/** Temporary state and config folders, telemetry on (so a stray cli_error would be captured). */
function isolate(state?: string) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const prevExit = process.exitCode;
  const stateRoot = state ?? mkdtempSync(join(tmpdir(), "styre-wiring-state-"));
  const configRoot = mkdtempSync(join(tmpdir(), "styre-wiring-config-"));
  process.env.XDG_STATE_HOME = stateRoot;
  process.env.XDG_CONFIG_HOME = configRoot;
  for (const k of ["STYRE_TELEMETRY", "DO_NOT_TRACK", "SLACK_BOT_TOKEN"]) {
    Reflect.deleteProperty(process.env, k);
  }
  process.exitCode = 0;
  return {
    stateRoot,
    configRoot,
    restore: () => {
      for (const k of ENV_KEYS) {
        const v = prev[k];
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
      process.exitCode = prevExit ?? 0;
      rmSync(configRoot, { recursive: true, force: true });
      if (state === undefined) rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-wiring-repo-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function writeProfile(path: string, slug: string, repo: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      slug,
      targetRepo: repo,
      defaultBranch: "main",
      checksSystem: "none",
      components: [],
    }),
  );
  return path;
}

const sessionLimit = (): AgentRunResult => ({
  completed: false,
  exitCode: 1,
  stdout: "partial work",
  stderr: "You have reached your session limit · resets tomorrow",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
  cause: "session-limit",
  resetAt: "tomorrow",
});
/** A fake agent that parks the run, after sending SIGINT to the listeners on its first call when
 *  `interrupt` is set: the stop lands while the step is in flight. */
function agent(interrupt: boolean): FakeAgentRunner {
  let n = 0;
  return new FakeAgentRunner(() => {
    if (interrupt && n++ === 0) process.emit("SIGINT", "SIGINT");
    return sessionLimit();
  });
}

const tracker = (): IssueTrackerPort =>
  fakeIssueTracker({
    ticket: {
      ident: "ENG-1",
      title: "Wiring ticket",
      description: "body",
      typeLabel: "Feature",
      externalId: "uuid-wiring",
      url: null,
    },
  });

/** Everything written to stdout and stderr while `fn` runs. */
async function captured(fn: () => Promise<void>): Promise<string> {
  const text: string[] = [];
  const err = process.stderr.write.bind(process.stderr);
  const out = process.stdout.write.bind(process.stdout);
  const grab = (s: unknown): boolean => {
    text.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = grab;
  (process.stdout as { write: unknown }).write = grab;
  try {
    await fn();
  } finally {
    (process.stderr as { write: unknown }).write = err;
    (process.stdout as { write: unknown }).write = out;
  }
  return text.join("");
}

async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await Bun.sleep(10);
}
/** True when `p` settles within `ms`. */
async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  const done = p.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The interruption notes in a run database, with their ticket and payload. */
function notes(dbPath: string): { ticket_id: number; stepId: number | undefined }[] {
  const c = new Database(dbPath);
  try {
    return c
      .query<{ ticket_id: number; payload_json: string | null }, []>(
        "SELECT ticket_id, payload_json FROM event_log WHERE kind = 'note' AND reason = 'interrupted'",
      )
      .all()
      .map((r) => ({
        ticket_id: r.ticket_id,
        stepId: (JSON.parse(r.payload_json ?? "{}") as { stepId?: number }).stepId,
      }));
  } finally {
    c.close();
  }
}
function idOf(dbPath: string, sql: string): number {
  const c = new Database(dbPath);
  try {
    const r = c.query<{ id: number }, []>(sql).get();
    if (!r) throw new Error(`no row for: ${sql}`);
    return r.id;
  } finally {
    c.close();
  }
}

/** Records every blocking call the door makes (git, probes), with the number of SIGINT listeners
 *  at that moment, then makes the call as the door would. */
function recordBlockingCalls(): { argv: string; listening: number }[] {
  const seen: { argv: string; listening: number }[] = [];
  door.__setBlockingForTests((argv, opts) => {
    seen.push({ argv: argv.join(" "), listening: process.listenerCount("SIGINT") });
    const o = opts as {
      cwd?: string;
      timeoutMs: number;
      env?: Record<string, string | undefined>;
      stdin?: Uint8Array;
    };
    const r = Bun.spawnSync(argv, {
      cwd: o.cwd,
      env: o.env ?? process.env,
      stdin: o.stdin,
      timeout: o.timeoutMs,
    });
    return {
      exitCode: r.exitCode,
      success: r.success,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
      timedOut: r.exitedDueToTimeout === true,
      signalCode: r.signalCode ?? null,
    };
  });
  return seen;
}

/** The run tests drive a whole run; the handler may wait in its own timers. */
const SLOW = 30_000;

/** Starts a leftover check that is still pending when the command's exit check waits for it, and
 *  sends SIGINT to the listeners during that wait (R27). */
function stopDuringExitCheckWait(): void {
  __setCwdReadersForTests({
    async: async () => {
      await Bun.sleep(200);
      process.emit("SIGINT", "SIGINT");
      return new Map();
    },
  });
  void checkLeftoversInBackground({ worktree: tmpdir(), since: nowToken(), report: () => {} });
}

const okPreflight = () => ({ ok: true as const, version: null });

// ---- the error boundary while stopping (m1) -------------------------------------------------------

describe("the error boundary while stopping (m1)", () => {
  test("guard says nothing and leaves the exit code alone, whatever the error's type", async () => {
    door.beginStopping();
    process.exitCode = 0;
    const text = await captured(async () => {
      await guard("run", async () => {
        throw new Error("attempt to write a readonly database");
      });
      await guard("run", async () => {
        throw usageError("a usage error raised while stopping");
      });
    });
    expect(text).not.toContain("internal error");
    expect(text).toBe("");
    expect(process.exitCode).toBe(0);
  });

  test("guard still renders an error when no stop is in progress (control)", async () => {
    const prev = process.exitCode;
    const text = await captured(() =>
      guard("run", async () => {
        throw new Error("boom");
      }),
    );
    expect(text).toContain("internal error");
    expect(process.exitCode).toBe(70);
    process.exitCode = prev ?? 0;
  });

  test("the exit check leaves a stop's launches to the handler: no leak line, no stop, no exit code", async () => {
    const h = door.launch({
      argv: ["sleep", "30"],
      cwd: tmpdir(),
      env: process.env,
      kind: "group",
      context: { ident: null, stepId: null, worktree: null },
    });
    door.beginStopping();
    process.exitCode = 0;
    const text = await captured(() => assertNoLeakedLaunches());
    expect(text).toBe("");
    expect(process.exitCode).toBe(0);
    expect(door.liveLaunches()).toContain(h);
    expect(h.proc.exitCode).toBeNull(); // not stopped by the check
  });
});

// ---- the outbox drain (m2) ------------------------------------------------------------------------

describe("the outbox drain (m2)", () => {
  test("sends nothing once stopping", async () => {
    const o = makeOutboxDb();
    try {
      door.beginStopping();
      const r = await drainOutbox(o.db, o.ports);
      expect(r.sent).toBe(0);
      expect(o.calls()).toBe(0);
      expect(o.pending()).toBe(3);
    } finally {
      o.db.close();
    }
  });

  test("checks the door before each row: a stop during the first send ends the drain after it", async () => {
    const o = makeOutboxDb({ onCall: (n) => n === 1 && door.beginStopping() });
    try {
      const r = await drainOutbox(o.db, o.ports);
      expect(o.calls()).toBe(1);
      expect(r.sent).toBe(1);
      expect(o.pending()).toBe(2);
    } finally {
      o.db.close();
    }
  });
});

// ---- styre run ------------------------------------------------------------------------------------

describe("styre run", () => {
  test(
    "the handlers are installed before the first launch, and removed when the run ends",
    async () => {
      const env = isolate();
      const repo = gitRepo();
      const cwd = process.cwd();
      const base = counts();
      try {
        // No --profile: the run finds its profile from the working folder's repository, so its very
        // first act is a git call.
        const slug = slugForCwd(repo);
        if (!slug) throw new Error("no slug for the test repository");
        writeProfile(join(env.configRoot, "styre", slug, "profile.json"), slug, repo);
        const seen = recordBlockingCalls();
        let atPreflight: number[] = [];
        const a = analytics(false);
        process.chdir(repo);
        await captured(() =>
          runCommandBody(
            { ticket: "ENG-1" },
            {
              ports: { issueTracker: tracker(), forge: fakeForge() },
              runner: agent(false),
              preflight: () => {
                atPreflight = counts();
                return okPreflight();
              },
              analyticsClient: a.client,
            },
          ),
        );
        process.chdir(cwd);
        expect(process.exitCode).toBe(75); // the run parked: it really ran to its end
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]?.argv).toContain("rev-parse");
        expect(seen.filter((s) => s.listening !== (base[0] ?? 0) + 1)).toEqual([]);
        expect(atPreflight).toEqual(plusOne(base));
        expect(counts()).toEqual(base);
        // Disposed: a second install in this process works.
        installStopHandlers({ command: "run", run: null }, handlerDeps().d).dispose();
      } finally {
        process.chdir(cwd);
        env.restore();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  test(
    "R27: a stop during the exit check's wait for leftover checks is handled by the handler",
    async () => {
      const env = isolate();
      const profile = writeProfile(
        join(env.configRoot, "p", "profile.json"),
        "test-project",
        tmpdir(),
      );
      const { out, d } = handlerDeps();
      const base = counts();
      try {
        // The run ends early (the agent CLI preflight fails) while a leftover check is still
        // pending; the exit check waits for it, and the signal lands during that wait.
        await captured(() =>
          runCommandBody(
            { ticket: "ENG-1", profile },
            {
              preflight: () => {
                stopDuringExitCheckWait();
                throw new Error("the agent CLI is missing");
              },
              analyticsClient: analytics(false).client,
              stopHandlerDeps: d,
            },
          ),
        );
        await waitFor(() => out.exited.length > 0, 3_000);
        expect(out.lines[0]).toBe(STOP_LINE);
        expect(out.exited).toEqual([130]);
        expect(counts()).toEqual(plusOne(base)); // kept: the stop owns them now
      } finally {
        env.restore();
      }
    },
    SLOW,
  );

  test(
    "the command removes the handlers once its exit check is done",
    async () => {
      const env = isolate();
      const base = counts();
      try {
        await captured(() =>
          runCommandBody(
            { ticket: "ENG-1", "review-action": "accept-risk" },
            { analyticsClient: analytics(false).client, stopHandlerDeps: handlerDeps().d },
          ),
        );
        expect(process.exitCode).toBe(64);
        expect(counts()).toEqual(base);
      } finally {
        env.restore();
      }
    },
    SLOW,
  );

  test(
    "a refusal before any work removes the handlers too",
    async () => {
      const base = counts();
      for (let i = 0; i < 2; i++) {
        await expect(
          runImpl(
            { args: { ticket: "ENG-1", "review-action": "accept-risk" } },
            { analyticsClient: analytics(false).client },
          ),
        ).rejects.toThrow(/review actions require --resume/);
        expect(counts()).toEqual(base);
      }
    },
    SLOW,
  );

  test(
    "a stop mid-step: recorded for this ticket, the run's db and lock left to the handler, the boundary silent",
    async () => {
      const env = isolate();
      const repo = gitRepo();
      const profile = writeProfile(join(env.configRoot, "p", "profile.json"), "test-project", repo);
      const { out, d } = handlerDeps();
      const a = analytics(true);
      const base = counts();
      try {
        expect(telemetryEnabled({ telemetry: true })).toBe(true);
        const checkpoint = parkDir("test-project", "ENG-1");
        let text = "";
        const run = captured(() =>
          runCommandBody(
            { ticket: "ENG-1", profile },
            {
              ports: { issueTracker: tracker(), forge: fakeForge() },
              runner: agent(true),
              preflight: okPreflight,
              analyticsClient: a.client,
              stopHandlerDeps: d,
            },
          ),
        ).then((t) => {
          text = t;
        });
        // The run code gives up while the handler waits in its analytics shutdown, just before it
        // releases the lock.
        expect(await settles(run, 5_000)).toBe(true);
        expect(a.shutdowns()).toBe(1); // the handler's; the run code left analytics to it
        expect(out.exited).toEqual([]);
        expect(existsSync(join(checkpoint, "run.lock"))).toBe(true);
        expect(out.emitted).toHaveLength(1);
        const runDb = out.emitted[0]?.db as Database;
        expect(() => runDb.query("SELECT 1").get()).not.toThrow(); // not closed by the run code
        expect(counts()).toEqual(plusOne(base)); // not disposed during the stop
        expect(text).not.toContain("internal error");
        expect(text).not.toContain("styre run:");
        expect(process.exitCode).toBe(0);
        expect(a.events).toContain("run_started");
        expect(a.events).not.toContain("cli_error");

        a.open();
        await waitFor(() => out.exited.length > 0);
        expect(out.exited).toEqual([130]);
        expect(out.reraised).toEqual(["SIGINT"]);
        expect(existsSync(join(checkpoint, "run.lock"))).toBe(false); // released by the handler
        expect(out.lines[0]).toBe(STOP_LINE);
        expect(out.lines).toContain(RESUME_LINE);
        const dbPath = join(checkpoint, "run.db");
        const ticketId = idOf(dbPath, "SELECT id FROM ticket WHERE ident = 'ENG-1'");
        const stepId = idOf(
          dbPath,
          "SELECT id FROM workflow_step WHERE step_key = 'design:dispatch'",
        );
        expect(notes(dbPath)).toEqual([{ ticket_id: ticketId, stepId }]);
        expect(out.emitted[0]?.row.ticket_id).toBe(ticketId);
        runDb.close();
      } finally {
        a.open();
        env.restore();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  test(
    "a stop after the last step, while the run waits for its leftover checks: the run code finishes nothing",
    async () => {
      const env = isolate();
      const repo = gitRepo();
      const profile = writeProfile(join(env.configRoot, "p", "profile.json"), "test-project", repo);
      const { out, d } = handlerDeps();
      const a = analytics(true);
      // The parked step starts a leftover check in the background; the run waits for it before it
      // finishes. The stop lands during that wait, after every step has ended, so the run's own
      // code returns normally (the drain sends nothing and returns) instead of failing on a write.
      __setCwdReadersForTests({
        async: async () => {
          await Bun.sleep(150);
          process.emit("SIGINT", "SIGINT");
          return new Map();
        },
      });
      try {
        const checkpoint = parkDir("test-project", "ENG-1");
        let text = "";
        const run = captured(() =>
          runCommandBody(
            { ticket: "ENG-1", profile },
            {
              ports: { issueTracker: tracker(), forge: fakeForge() },
              runner: agent(false),
              preflight: okPreflight,
              analyticsClient: a.client,
              stopHandlerDeps: d,
            },
          ),
        ).then((t) => {
          text = t;
        });
        expect(await settles(run, 5_000)).toBe(true);
        expect(out.emitted).toHaveLength(1); // the stop was recorded: the run was set
        expect(a.events).not.toContain("run_completed");
        expect(process.exitCode).toBe(0); // not 75: the run code did not finish the run
        expect(existsSync(join(checkpoint, "run.lock"))).toBe(true);
        const runDb = out.emitted[0]?.db as Database;
        expect(() => runDb.query("SELECT 1").get()).not.toThrow();
        expect(existsSync(join(checkpoint, "transcript.json"))).toBe(false); // no park dump
        expect(text).not.toContain("internal error");
        a.open();
        await waitFor(() => out.exited.length > 0);
        expect(out.exited).toEqual([130]);
        expect(existsSync(join(checkpoint, "run.lock"))).toBe(false);
        runDb.close();
      } finally {
        a.open();
        env.restore();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  test(
    "with a reused --db, the interruption names the ticket this run inserted",
    async () => {
      const env = isolate();
      const repo = gitRepo();
      const profile = writeProfile(join(env.configRoot, "p", "profile.json"), "test-project", repo);
      const dbPath = join(mkdtempSync(join(tmpdir(), "styre-wiring-db-")), "reused.db");
      // Earlier rows, so this run's ticket is neither the first ticket nor shares its project's id.
      migrate(dbPath);
      const c = openDb(dbPath);
      const other = insertProject(c, { slug: "other", targetRepo: "/tmp/other" });
      insertTicket(c, { projectId: other, ident: "OTHER-1" });
      insertTicket(c, { projectId: other, ident: "OTHER-2" });
      c.close();
      const { out, d } = handlerDeps();
      try {
        await captured(() =>
          runCommandBody(
            { ticket: "ENG-1", profile, db: dbPath },
            {
              ports: { issueTracker: tracker(), forge: fakeForge() },
              runner: agent(true),
              preflight: okPreflight,
              analyticsClient: analytics(false).client,
              stopHandlerDeps: d,
            },
          ),
        );
        await waitFor(() => out.exited.length > 0);
        expect(out.exited).toEqual([130]);
        const ticketId = idOf(dbPath, "SELECT id FROM ticket WHERE ident = 'ENG-1'");
        expect(ticketId).toBe(3);
        expect(notes(dbPath).map((n) => n.ticket_id)).toEqual([ticketId]);
        expect(out.lines).toContain(RESUME_LINE);
        out.emitted[0]?.db.close();
      } finally {
        env.restore();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  test(
    "a stop before the run database exists writes nothing: no checkpoint, no lock",
    async () => {
      const env = isolate();
      const repo = gitRepo();
      const profile = writeProfile(join(env.configRoot, "p", "profile.json"), "test-project", repo);
      const { out, d } = handlerDeps();
      const it = tracker();
      const fetch = it.fetchTicket.bind(it);
      it.fetchTicket = async (ref) => {
        process.emit("SIGINT", "SIGINT");
        return fetch(ref);
      };
      try {
        const text = await captured(() =>
          runCommandBody(
            { ticket: "ENG-1", profile },
            {
              ports: { issueTracker: it, forge: fakeForge() },
              runner: agent(false),
              preflight: okPreflight,
              analyticsClient: analytics(false).client,
              stopHandlerDeps: d,
            },
          ),
        );
        await waitFor(() => out.exited.length > 0);
        expect(out.exited).toEqual([130]);
        expect(existsSync(parkDir("test-project", "ENG-1"))).toBe(false);
        expect(text).not.toContain("internal error");
        expect(out.lines).not.toContain(RESUME_LINE); // nothing to resume
      } finally {
        env.restore();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});

// ---- styre run --resume ---------------------------------------------------------------------------

describe("styre run --resume", () => {
  async function parked() {
    const p = await runParkedTicket();
    const dbPath = join(p.dumpDir, "run.db");
    const c = new Database(dbPath);
    const repo = c
      .query<{ target_repo: string }, []>("SELECT target_repo FROM project LIMIT 1")
      .get()?.target_repo as string;
    const stepId = c
      .query<{ id: number }, []>("SELECT id FROM workflow_step WHERE status = 'running'")
      .get()?.id as number;
    c.close();
    return { p, dbPath, repo, stepId, state: join(p.dumpDir, "..", "..", "..") };
  }

  test(
    "a stop mid-step: recorded for the checkpoint's ticket, the lock released by the handler only",
    async () => {
      const k = await parked();
      const env = isolate(k.state);
      const profile = writeProfile(join(env.configRoot, "p", "profile.json"), k.p.slug, k.repo);
      const { out, d } = handlerDeps();
      const a = analytics(true);
      const base = counts();
      try {
        let text = "";
        const run = captured(() =>
          runCommandBody(
            { resume: "ENG-1", profile },
            {
              ports: { issueTracker: tracker(), forge: fakeForge() },
              runner: agent(true),
              preflight: okPreflight,
              analyticsClient: a.client,
              stopHandlerDeps: d,
            },
          ),
        ).then((t) => {
          text = t;
        });
        expect(await settles(run, 5_000)).toBe(true);
        expect(out.exited).toEqual([]);
        expect(existsSync(join(k.p.dumpDir, "run.lock"))).toBe(true);
        expect(out.emitted).toHaveLength(1);
        const runDb = out.emitted[0]?.db as Database;
        expect(() => runDb.query("SELECT 1").get()).not.toThrow();
        expect(counts()).toEqual(plusOne(base));
        expect(text).not.toContain("internal error");
        expect(a.events).not.toContain("cli_error");

        a.open();
        await waitFor(() => out.exited.length > 0);
        expect(out.exited).toEqual([130]);
        expect(existsSync(join(k.p.dumpDir, "run.lock"))).toBe(false);
        expect(out.lines).toContain(RESUME_LINE);
        expect(notes(k.dbPath)).toEqual([{ ticket_id: k.p.ticketId, stepId: k.stepId }]);
        runDb.close();
      } finally {
        a.open();
        env.restore();
        cleanupParkedRun(k.p);
      }
    },
    SLOW,
  );

  test(
    "a stop during the PR base check: the resume leaves its db open and its lock held for the handler",
    async () => {
      const k = await parked();
      const env = isolate(k.state);
      const profile = writeProfile(join(env.configRoot, "p", "profile.json"), k.p.slug, k.repo);
      const { out, d } = handlerDeps();
      const a = analytics(true);
      const forge = fakeForge();
      forge.branchExists = async () => {
        process.emit("SIGINT", "SIGINT");
        throw new Error("the forge did not answer");
      };
      try {
        let text = "";
        const run = captured(() =>
          runCommandBody(
            { resume: "ENG-1", profile },
            {
              ports: { issueTracker: tracker(), forge },
              runner: agent(false),
              preflight: okPreflight,
              analyticsClient: a.client,
              stopHandlerDeps: d,
            },
          ),
        ).then((t) => {
          text = t;
        });
        expect(await settles(run, 5_000)).toBe(true);
        expect(out.emitted).toHaveLength(1);
        const runDb = out.emitted[0]?.db as Database;
        expect(() => runDb.query("SELECT 1").get()).not.toThrow(); // the error path did not close it
        expect(existsSync(join(k.p.dumpDir, "run.lock"))).toBe(true);
        expect(text).not.toContain("internal error");
        expect(text).not.toContain("did not answer");
        expect(a.events).not.toContain("cli_error");
        a.open();
        await waitFor(() => out.exited.length > 0);
        expect(out.exited).toEqual([130]);
        expect(existsSync(join(k.p.dumpDir, "run.lock"))).toBe(false);
        // No step was in flight: the bare note, for the checkpoint's ticket.
        expect(notes(k.dbPath)).toEqual([{ ticket_id: k.p.ticketId, stepId: undefined }]);
        runDb.close();
      } finally {
        a.open();
        env.restore();
        cleanupParkedRun(k.p);
      }
    },
    SLOW,
  );

  test(
    "a stop after the resumed step, while the resume waits for its leftover checks: nothing is finished",
    async () => {
      const k = await parked();
      const env = isolate(k.state);
      const profile = writeProfile(join(env.configRoot, "p", "profile.json"), k.p.slug, k.repo);
      const { out, d } = handlerDeps();
      const a = analytics(true);
      __setCwdReadersForTests({
        async: async () => {
          await Bun.sleep(150);
          process.emit("SIGINT", "SIGINT");
          return new Map();
        },
      });
      try {
        let text = "";
        const run = captured(() =>
          runCommandBody(
            { resume: "ENG-1", profile },
            {
              ports: { issueTracker: tracker(), forge: fakeForge() },
              runner: agent(false),
              preflight: okPreflight,
              analyticsClient: a.client,
              stopHandlerDeps: d,
            },
          ),
        ).then((t) => {
          text = t;
        });
        expect(await settles(run, 5_000)).toBe(true);
        expect(out.emitted).toHaveLength(1);
        expect(process.exitCode).toBe(0); // not 75: the resume did not finish the run
        expect(text).not.toContain("Paused again");
        const runDb = out.emitted[0]?.db as Database;
        expect(() => runDb.query("SELECT 1").get()).not.toThrow(); // dumpPark did not close it
        expect(existsSync(join(k.p.dumpDir, "run.lock"))).toBe(true);
        expect(text).not.toContain("internal error");
        a.open();
        await waitFor(() => out.exited.length > 0);
        expect(out.exited).toEqual([130]);
        expect(existsSync(join(k.p.dumpDir, "run.lock"))).toBe(false);
        runDb.close();
      } finally {
        a.open();
        env.restore();
        cleanupParkedRun(k.p);
      }
    },
    SLOW,
  );

  test(
    "a resume that parks again ends with the handlers removed and the lock released",
    async () => {
      const k = await parked();
      const env = isolate(k.state);
      const profile = writeProfile(join(env.configRoot, "p", "profile.json"), k.p.slug, k.repo);
      const base = counts();
      try {
        await captured(() =>
          runCommandBody(
            { resume: "ENG-1", profile },
            {
              ports: { issueTracker: tracker(), forge: fakeForge() },
              runner: agent(false),
              preflight: okPreflight,
              analyticsClient: analytics(false).client,
            },
          ),
        );
        expect(process.exitCode).toBe(75);
        expect(counts()).toEqual(base);
        expect(existsSync(join(k.p.dumpDir, "run.lock"))).toBe(false);
        installStopHandlers({ command: "run", run: null }, handlerDeps().d).dispose();
      } finally {
        env.restore();
        cleanupParkedRun(k.p);
      }
    },
    SLOW,
  );

  test(
    "a stop that began before the resume touches nothing: no lock, no resumed mark",
    async () => {
      const k = await parked();
      const env = isolate(k.state);
      const runRow = () => {
        const c = new Database(k.dbPath);
        try {
          return c.query<{ resumed: number }, []>("SELECT resumed FROM run LIMIT 1").get()?.resumed;
        } finally {
          c.close();
        }
      };
      const resumedBefore = runRow();
      try {
        door.beginStopping();
        const profile = parseProfile({
          slug: k.p.slug,
          targetRepo: k.repo,
          defaultBranch: "main",
          checksSystem: "none",
        });
        await expect(
          resumeRun({ resume: "ENG-1" }, profile, DEFAULT_RUNTIME_CONFIG, {
            ports: { issueTracker: tracker(), forge: fakeForge() },
            preflight: okPreflight,
          }),
        ).rejects.toBeInstanceOf(door.RunInterrupted);
        expect(existsSync(join(k.p.dumpDir, "run.lock"))).toBe(false);
        expect(runRow()).toBe(resumedBefore);
      } finally {
        env.restore();
        cleanupParkedRun(k.p);
      }
    },
    SLOW,
  );
});

// ---- styre setup ----------------------------------------------------------------------------------

const NOOP_ENRICH = {
  topology: { detail: "" },
  data: { detail: "" },
  caching: { detail: "" },
  observability: { detail: "" },
  configSecrets: { detail: "" },
  documentation: { detail: "" },
  releasePackaging: { detail: "" },
};
function enrichDeps(onDispatch?: () => void): EnrichDeps {
  const runner = new FakeAgentRunner(() => {
    onDispatch?.();
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-setup-enrich\n${JSON.stringify(NOOP_ENRICH)}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  return { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: () => Promise.resolve() };
}
/** A ruby repository: setup asks for its missing commands, then for approval. */
function rubyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "styre-wiring-ruby-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo });
  run(["init", "-b", "main"]);
  run(["remote", "add", "origin", "git@github.com:acme/myapp.git"]);
  writeFileSync(join(repo, "Gemfile"), "source 'https://rubygems.org'\ngem 'rspec'\n");
  writeFileSync(join(repo, ".rspec"), "--format documentation\n");
  return repo;
}
/** Runs `fn` with stdin reading as a terminal (or not) and `globalThis.prompt` replaced. */
async function withPrompt<T>(
  tty: boolean,
  prompt: (q: string) => string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const origPrompt = globalThis.prompt;
  const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  (globalThis as Record<string, unknown>).prompt = prompt;
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    (globalThis as Record<string, unknown>).prompt = origPrompt;
    if (desc !== undefined) Object.defineProperty(process.stdin, "isTTY", desc);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
}

describe("styre setup", () => {
  test("the handlers are installed before the first launch, and removed when setup ends", async () => {
    const env = isolate();
    const repo = gitRepo();
    const base = counts();
    try {
      const seen = recordBlockingCalls();
      let atPreflight: number[] = [];
      await expect(
        setupImpl(
          { args: { repo } },
          {
            preflight: () => {
              atPreflight = counts();
              throw new Error("stop here");
            },
          },
        ),
      ).rejects.toThrow("stop here");
      expect(seen.length).toBeGreaterThan(0); // the slug's git call
      expect(seen.filter((s) => s.listening !== (base[0] ?? 0) + 1)).toEqual([]);
      expect(atPreflight).toEqual(plusOne(base));
      expect(counts()).toEqual(base);
      installStopHandlers({ command: "setup", run: null }, handlerDeps().d).dispose();
    } finally {
      env.restore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a stop during setup: the handler speaks and exits, the boundary says nothing", async () => {
    const env = isolate();
    const repo = gitRepo();
    const { out, d } = handlerDeps();
    const base = counts();
    try {
      const text = await captured(() =>
        setupCommandBody(
          { repo },
          {
            preflight: () => {
              process.emit("SIGINT", "SIGINT");
              throw new StyreError({ code: 78, headline: "an error after the stop began" });
            },
            stopHandlerDeps: d,
          },
        ),
      );
      expect(text).toBe("");
      expect(process.exitCode).toBe(0);
      // Setup keeps its handlers during the stop: a second Ctrl-C forces the stop instead of
      // taking the default action.
      expect(counts()).toEqual(plusOne(base));
      process.emit("SIGINT", "SIGINT");
      expect(out.lines).toContain("styre: forcing stop…\n");
      await waitFor(() => out.exited.length > 0);
      expect(out.exited).toEqual([130]);
      expect(out.lines[0]).toBe(STOP_LINE);
      expect(out.lines.some((l) => l.includes("resume"))).toBe(false); // setup has no run
    } finally {
      env.restore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("R27: a stop during setup's exit check wait for leftover checks is handled by the handler", async () => {
    const env = isolate();
    const repo = gitRepo();
    const { out, d } = handlerDeps();
    try {
      await captured(() =>
        setupCommandBody(
          { repo },
          {
            preflight: () => {
              stopDuringExitCheckWait();
              throw new Error("the agent CLI is missing");
            },
            stopHandlerDeps: d,
          },
        ),
      );
      await waitFor(() => out.exited.length > 0, 3_000);
      expect(out.lines[0]).toBe(STOP_LINE);
      expect(out.exited).toEqual([130]);
    } finally {
      env.restore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("setup removes the handlers once its exit check is done", async () => {
    const env = isolate();
    const repo = gitRepo();
    const base = counts();
    try {
      await captured(() =>
        setupCommandBody(
          { repo },
          {
            preflight: () => {
              throw new Error("the agent CLI is missing");
            },
            stopHandlerDeps: handlerDeps().d,
          },
        ),
      );
      expect(process.exitCode).toBe(70);
      expect(counts()).toEqual(base);
    } finally {
      env.restore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("both prompts run with the handlers removed, and the handlers come back after each", async () => {
    const repo = rubyRepo();
    const out = join(mkdtempSync(join(tmpdir(), "styre-wiring-out-")), "profile.json");
    const base = counts();
    const h = installStopHandlers({ command: "setup", run: null }, handlerDeps().d);
    const asked: { q: string; listening: number[] }[] = [];
    try {
      await captured(() =>
        withPrompt(
          true,
          (q) => {
            asked.push({ q, listening: counts() });
            return q.includes("Approve") ? "y" : "";
          },
          () => runSetup({ repo, out, deps: enrichDeps() }).then(() => {}),
        ),
      );
      expect(asked.some((a) => a.q.includes("Approve"))).toBe(true);
      expect(asked.some((a) => !a.q.includes("Approve"))).toBe(true); // a missing command
      expect(asked.filter((a) => a.listening.join() !== base.join())).toEqual([]);
      expect(counts()).toEqual(plusOne(base));
      expect(existsSync(out)).toBe(true); // control: setup wrote when nothing stopped it
    } finally {
      h.dispose();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a stop during the agent's enrichment: setup writes no profile and no environment file", async () => {
    const repo = rubyRepo();
    const out = join(mkdtempSync(join(tmpdir(), "styre-wiring-out-")), "profile.json");
    try {
      const result = withPrompt(
        false,
        () => null,
        () => runSetup({ repo, out, deps: enrichDeps(() => door.beginStopping()) }),
      );
      await expect(result).rejects.toBeInstanceOf(door.RunInterrupted);
      expect(existsSync(out)).toBe(false);
      expect(existsSync(`${out}.environment.json`)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a stop at the approval prompt: setup writes nothing", async () => {
    const repo = rubyRepo();
    const out = join(mkdtempSync(join(tmpdir(), "styre-wiring-out-")), "profile.json");
    try {
      await captured(async () => {
        const result = withPrompt(
          true,
          (q) => {
            if (!q.includes("Approve")) return "";
            door.beginStopping();
            return "y";
          },
          () => runSetup({ repo, out, deps: enrichDeps() }),
        );
        await expect(result).rejects.toBeInstanceOf(door.RunInterrupted);
      });
      expect(existsSync(out)).toBe(false);
      expect(existsSync(`${out}.environment.json`)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
