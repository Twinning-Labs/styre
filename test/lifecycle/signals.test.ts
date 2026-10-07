// ENG-485 section 7.3/7.4: the stop signal handler. Most tests drive `handleStopSignal` with
// injected dependencies (stderr, telemetry, re-raise, exit, clock, leftover check) against real
// processes; the last ones run a child process with the real handlers installed.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import { listProcesses } from "../../src/util/process/proc-table.ts";
import {
  HANDLER_DEADLINE_MS,
  type HandlerCtx,
  type HandlerDeps,
  __resetSignalsForTests,
  handleStopSignal,
  installStopHandlers,
  suspendStopHandlers,
} from "../../src/util/process/signals.ts";
import { realStopDeps } from "../../src/util/process/stop.ts";
import { makeTicketDb } from "../helpers/lifecycle.ts";

const FX = join(import.meta.dir, "fixtures");
const OPENING_INT =
  "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…\n";

interface Out {
  err: string[];
  emitted: unknown[];
  reraised: string[];
  exited: number[];
}
function deps(): { out: Out; d: HandlerDeps } {
  const out: Out = { err: [], emitted: [], reraised: [], exited: [] };
  return {
    out,
    d: {
      stderr: (s) => {
        out.err.push(s);
      },
      emit: (r) => {
        out.emitted.push(r);
      },
      reraise: (s) => {
        out.reraised.push(s);
      },
      exit: (c) => {
        out.exited.push(c);
      },
      now: () => Date.now(),
      leftovers: () => [],
    },
  };
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "styre-signals-")));
function agent(argv: string[], context: Partial<door.LaunchContext> = {}, env = process.env) {
  return door.launch({
    argv,
    cwd: process.cwd(),
    env,
    kind: "agent",
    context: { ident: "ENG-1", stepId: null, worktree: null, ...context },
  });
}
const alive = (pid: number) => listProcesses().some((p) => p.pid === pid && p.state !== "zombie");
/** The pid of the one live child of `parent` (not a zombie). */
const childOf = (parent: number): number =>
  listProcesses().find((p) => p.ppid === parent && p.state !== "zombie")?.pid ?? 0;

/** Reads `stream` until `re` matches (or the stream ends), then lets go of it. */
async function readUntil(stream: ReadableStream<Uint8Array>, re: RegExp): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    while (!re.test(text)) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}
const ticketRun = () => {
  const t = makeTicketDb();
  const db = new Database(t.path);
  door.beginStep({ stepId: t.stepId, startedAt: t.startedAt, ident: "ENG-1", headAtStart: null });
  return { t, db, run: { db, dbPath: t.path, ticketId: t.ticketId, ident: "ENG-1" } };
};
const notes = (path: string): number => {
  const c = new Database(path, { readonly: true });
  try {
    return (
      c
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_log WHERE kind = 'note' AND reason = 'interrupted'",
        )
        .get()?.n ?? -1
    );
  } finally {
    c.close();
  }
};

afterEach(() => {
  // Even on failure: nothing a test started may outlive it. A launch still live here (a stop that
  // never settled, a survivor) would otherwise keep Bun's event loop, and so the test run, alive.
  for (const h of door.liveLaunches()) {
    try {
      // A group may outlive its leader; an agent is killed only while Bun has not seen it end.
      if (h.record.kind === "group") process.kill(-h.record.pid, "SIGKILL");
      else if (h.proc.exitCode === null && h.proc.signalCode === null) h.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    h.proc.unref();
  }
  Bun.spawnSync(["pkill", "-9", "-f", "sleep 30[7-9][0-9]"]);
  Bun.spawnSync(["pkill", "-9", "-f", "stubborn-cli.sh"]);
  Bun.spawnSync(["pkill", "-9", "-f", "signal-child.ts"]);
  door.__resetForTests();
  __resetSignalsForTests();
});

describe("order and messages", () => {
  test("Ctrl-C: signals go out before any write, the message order is exact, and the exit re-raises", async () => {
    const h = agent([join(FX, "standin-agent.sh")], {}, { ...process.env, STANDIN_SLEEP: "3071" });
    // The stand-in says `tool <pid>` once its tool command runs: only then is there a command to stop.
    expect(await readUntil(h.proc.stderr, /tool \d+\n/)).toMatch(/tool \d+\n/);
    const { out, d } = deps();
    let wroteBeforeSignal = false;
    const origKill = process.kill;
    let killed = false;
    (process as { kill: unknown }).kill = (...a: unknown[]) => {
      killed = true;
      return (origKill as (...x: unknown[]) => boolean).apply(process, a);
    };
    d.stderr = (s) => {
      if (!killed) wroteBeforeSignal = true;
      out.err.push(s);
    };
    try {
      await handleStopSignal("SIGINT", { command: "run", run: null }, d);
    } finally {
      (process as { kill: unknown }).kill = origKill;
    }
    expect(wroteBeforeSignal).toBe(false);
    expect(out.err).toEqual([
      OPENING_INT,
      `styre: stopped the agent (pid ${h.record.pid}) and 1 of its commands.\n`,
    ]);
    expect(out.reraised).toEqual(["SIGINT"]);
    expect(out.exited).toEqual([130]);
    expect(h.interrupted).toBe(true);
    expect(alive(h.record.pid)).toBe(false);
  });

  test("a signal other than SIGINT opens with the reason, and the fallback exit is 128 + n", async () => {
    const codes: Record<string, number> = { SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131, SIGINT: 130 };
    for (const sig of ["SIGTERM", "SIGHUP", "SIGQUIT", "SIGINT"] as const) {
      door.__resetForTests();
      __resetSignalsForTests();
      const { out, d } = deps();
      await handleStopSignal(sig, { command: "run", run: null }, d);
      expect(out.err[0]).toBe(
        sig === "SIGINT" ? OPENING_INT : `styre: received a stop request (${sig}) — cleaning up…\n`,
      );
      // The injected re-raise returns, as it does for a container's first process.
      expect(out.reraised).toEqual([sig]);
      expect(out.exited).toEqual([codes[sig] as number]);
    }
  });

  test("the door is closed: no launch and no blocking call after the signal", async () => {
    const { d } = deps();
    await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
    expect(door.isStopping()).toBe(true);
    expect(() => agent(["sleep", "3075"])).toThrow(door.RunInterrupted);
  });

  test("the commands count leaves out the agent, processes already gone, and zombies", async () => {
    // `sleep 0.1` ends at once and stays a zombie (the exec'd sleep never reaps it); `sleep 3072` is
    // the one live command. Only it was signalled besides the agent.
    const h = agent(["bash", "-c", "sleep 0.1 & sleep 3072 & exec sleep 3073"]);
    await Bun.sleep(400);
    const kids = listProcesses().filter((p) => p.ppid === h.record.pid);
    expect(kids.some((p) => p.state === "zombie")).toBe(true); // the case is really there
    const { out, d } = deps();
    await handleStopSignal("SIGINT", { command: "run", run: null }, d);
    expect(out.err).toContain(
      `styre: stopped the agent (pid ${h.record.pid}) and 1 of its commands.\n`,
    );
  });

  test("a survivor is named by its own command, with the exact line", async () => {
    const h = agent(["bash", "-c", "sleep 3076 & wait"]);
    await Bun.sleep(200);
    const child = childOf(h.record.pid);
    expect(child).toBeGreaterThan(0);
    // The child cannot be signalled, so it outlives the stop.
    door.__setStopDepsForTests({
      ...realStopDeps,
      kill: (t, s) => {
        if (t === child) return;
        realStopDeps.kill(t, s);
      },
    });
    const { out, d } = deps();
    const first = handleStopSignal("SIGINT", { command: "run", run: null }, d);
    await Bun.sleep(300);
    await handleStopSignal("SIGINT", { command: "run", run: null }, d); // force it
    await first;
    try {
      expect(out.err).toContain(
        `styre: could not stop sleep 3076 (pid ${child}); stop it with: kill -9 ${child}\n`,
      );
      // The survivor is not counted as stopped.
      expect(out.err).toContain(
        `styre: stopped the agent (pid ${h.record.pid}) and 0 of its commands.\n`,
      );
    } finally {
      try {
        process.kill(child, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 10_000);

  test("styre setup speaks and exits, but records nothing and prints no resume line", async () => {
    const t = makeTicketDb();
    const db = new Database(t.path);
    door.beginStep({ stepId: t.stepId, startedAt: t.startedAt, ident: "ENG-1", headAtStart: null });
    const { out, d } = deps();
    await handleStopSignal(
      "SIGINT",
      { command: "setup", run: { db, dbPath: t.path, ticketId: t.ticketId, ident: "ENG-1" } },
      d,
    );
    expect(out.err).toEqual([OPENING_INT]);
    expect(out.emitted).toEqual([]);
    expect(out.exited).toEqual([130]);
    const check = new Database(t.path, { readonly: true });
    expect(
      check.query("SELECT COUNT(*) AS n FROM event_log WHERE reason = 'interrupted'").get(),
    ).toEqual({ n: 0 });
    check.close();
    db.close();
  });
});

describe("recording", () => {
  test("the run connection becomes read only and the interruption is written through a second connection", async () => {
    const t = makeTicketDb();
    const db = new Database(t.path);
    door.beginStep({ stepId: t.stepId, startedAt: t.startedAt, ident: "ENG-1", headAtStart: null });
    const { out, d } = deps();
    await handleStopSignal(
      "SIGINT",
      { command: "run", run: { db, dbPath: t.path, ticketId: t.ticketId, ident: "ENG-1" } },
      d,
    );
    expect(() => db.query("UPDATE ticket SET title = 'x'").run()).toThrow(/readonly/);
    expect(out.emitted.length).toBe(1);
    expect(out.emitted[0]).toMatchObject({ kind: "note", reason: "interrupted" });
    expect(out.err.at(-1)).toBe("styre: run interrupted; resume with: styre run --resume ENG-1\n");
    const check = new Database(t.path, { readonly: true });
    expect(check.query("SELECT attempt FROM workflow_step WHERE id = ?").get(t.stepId)).toEqual({
      attempt: 1,
    });
    check.close();
    db.close();
  });

  test("the step in flight and the agent's context are read at the signal, not after the waits (R18)", async () => {
    const t = makeTicketDb();
    const db = new Database(t.path);
    door.beginStep({ stepId: t.stepId, startedAt: t.startedAt, ident: "ENG-1", headAtStart: null });
    const h = agent(["sleep", "3074"], {
      stepId: t.stepId,
      worktree: scratch,
      untrackedBefore: ["keep.txt"],
      dispatchRowId: t.dispatchRowId,
    });
    const { out, d } = deps();
    const p = handleStopSignal(
      "SIGTERM",
      { command: "run", run: { db, dbPath: t.path, ticketId: t.ticketId, ident: "ENG-1" } },
      d,
    );
    // While the handler waits, run code moves on: the step ends, the context changes.
    door.endStep();
    h.context.dispatchRowId = t.earlierDispatchRowId;
    h.context.untrackedBefore?.push("late.txt");
    h.context.worktree = "/elsewhere";
    await p;
    expect(out.emitted.length).toBe(1);
    const check = new Database(t.path, { readonly: true });
    const note = check
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM event_log WHERE reason = 'interrupted'",
      )
      .get();
    expect(JSON.parse(note?.payload_json ?? "{}")).toMatchObject({
      stepId: t.stepId,
      dispatchRowId: t.dispatchRowId,
      untrackedBefore: ["keep.txt"],
      worktree: scratch,
      signal: "SIGTERM",
    });
    expect(check.query("SELECT outcome FROM dispatch WHERE id = ?").get(t.dispatchRowId)).toEqual({
      outcome: "interrupted",
    });
    check.close();
    db.close();
  });

  test("a recording that fails is said, and the stop still exits", async () => {
    const t = makeTicketDb();
    const db = new Database(t.path);
    const { out, d } = deps();
    await handleStopSignal(
      "SIGTERM",
      // No such ticket: the event's foreign key fails inside the handler's transaction.
      { command: "run", run: { db, dbPath: t.path, ticketId: 999_999, ident: "ENG-1" } },
      d,
    );
    expect(out.err.some((l) => l.startsWith("styre: could not record the interruption: "))).toBe(
      true,
    );
    expect(out.emitted).toEqual([]);
    expect(out.exited).toEqual([143]);
    db.close();
  });
});

describe("the deadline and the exit", () => {
  test("the whole handler finishes inside the 6.5 s deadline even with slow leftovers and analytics", async () => {
    const { d } = deps();
    let budget = -1;
    let analyticsMs = -1;
    d.leftovers = (_stopped, ms) => {
      budget = ms;
      const e = Date.now() + 3000;
      while (Date.now() < e) {}
      return [];
    };
    agent(["sleep", "3077"], { worktree: scratch });
    const t0 = Date.now();
    await handleStopSignal(
      "SIGTERM",
      {
        command: "run",
        run: null,
        shutdownAnalytics: (ms) => {
          analyticsMs = ms;
          return Bun.sleep(Math.min(ms, 5000));
        },
      },
      d,
    );
    const took = Date.now() - t0;
    expect(took).toBeLessThan(HANDLER_DEADLINE_MS + 100);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(HANDLER_DEADLINE_MS - 1_000);
    expect(analyticsMs).toBeGreaterThan(0);
  }, 15_000);

  test("analytics that never ends is cut off at the deadline", async () => {
    const { out, d } = deps();
    const t0 = Date.now();
    // Start 6 s into the deadline, so the cut is quick to test.
    let n = 0;
    d.now = () => Date.now() + (n++ === 0 ? 0 : 6_000);
    await handleStopSignal(
      "SIGTERM",
      { command: "run", run: null, shutdownAnalytics: () => new Promise(() => {}) },
      d,
    );
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(out.exited).toEqual([143]);
  });

  test("with no time left, the leftover check and analytics are skipped, the skip is said, and the exit still happens", async () => {
    const { out, d } = deps();
    let leftoversCalled = false;
    let analyticsCalled = false;
    let lock = false;
    d.leftovers = () => {
      leftoversCalled = true;
      return [];
    };
    let n = 0;
    d.now = () => Date.now() + (n++ === 0 ? 0 : 6_400);
    agent(["sleep", "3078"], { worktree: scratch });
    await handleStopSignal(
      "SIGTERM",
      {
        command: "run",
        run: null,
        releaseLock: () => {
          lock = true;
        },
        shutdownAnalytics: async () => {
          analyticsCalled = true;
        },
      },
      d,
    );
    expect(leftoversCalled).toBe(false);
    expect(analyticsCalled).toBe(false);
    expect(out.err).toContain(
      "styre: skipped the check for processes the agent left running in the worktree (no time was left before the stop deadline)\n",
    );
    expect(lock).toBe(true);
    expect(out.reraised).toEqual(["SIGTERM"]);
    expect(out.exited).toEqual([143]);
  });

  test("leftover lines are printed as the check returns them", async () => {
    const { out, d } = deps();
    d.leftovers = () => ["styre: a leftover line\n"];
    agent(["sleep", "3079"], { worktree: scratch });
    await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
    expect(out.err).toContain("styre: a leftover line\n");
  });

  test("the run lock is released last: after analytics, just before the re-raise", async () => {
    const order: string[] = [];
    const { d } = deps();
    d.stderr = (s) => order.push(`say ${s.slice(0, 20)}`);
    d.reraise = (s) => order.push(`reraise ${s}`);
    d.exit = (c) => order.push(`exit ${c}`);
    await handleStopSignal(
      "SIGQUIT",
      {
        command: "run",
        run: null,
        releaseLock: () => order.push("lock"),
        shutdownAnalytics: async () => {
          order.push("analytics start");
          await Bun.sleep(50);
          order.push("analytics end");
        },
      },
      d,
    );
    expect(order.slice(-5)).toEqual([
      "analytics start",
      "analytics end",
      "lock",
      "reraise SIGQUIT",
      "exit 131",
    ]);
  });

  test("a failing analytics shutdown or lock release does not stop the exit", async () => {
    const { out, d } = deps();
    await handleStopSignal(
      "SIGTERM",
      {
        command: "run",
        run: null,
        releaseLock: () => {
          throw new Error("lock");
        },
        shutdownAnalytics: async () => {
          throw new Error("analytics");
        },
      },
      d,
    );
    expect(out.reraised).toEqual(["SIGTERM"]);
    expect(out.exited).toEqual([143]);
  });

  test("a second signal forces every stop at once, and the exit uses the FIRST signal", async () => {
    const h = agent(["bash", join(FX, "stubborn-cli.sh")]);
    await Bun.sleep(200);
    const { out, d } = deps();
    const t0 = Date.now();
    const first = handleStopSignal("SIGINT", { command: "run", run: null }, d);
    await Bun.sleep(300);
    await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
    await first;
    expect(Date.now() - t0).toBeLessThan(2_500); // not the 5 s grace period
    expect(out.err).toContain("styre: forcing stop…\n");
    expect(door.stopAbort.forced).toBe(true);
    expect(out.reraised).toEqual(["SIGINT"]);
    expect(out.exited).toEqual([130]);
    expect(alive(h.record.pid)).toBe(false);
  }, 10_000);
});

describe("fix round 1", () => {
  test("the run connection is already read only at the handler's first write (step 1 before step 3)", async () => {
    const { db, run } = ticketRun();
    const { out, d } = deps();
    let atFirstWrite: unknown = "no write";
    d.stderr = (s) => {
      if (out.err.length === 0) {
        try {
          db.query("UPDATE ticket SET title = 'x'").run();
          atFirstWrite = "written";
        } catch (err) {
          atFirstWrite = err;
        }
      }
      out.err.push(s);
    };
    await handleStopSignal("SIGINT", { command: "run", run }, d);
    expect(String(atFirstWrite)).toMatch(/readonly/);
    db.close();
  });

  test("an already closed run database: the agent is still stopped, nothing is recorded or emitted, and the exit happens", async () => {
    const { t, db, run } = ticketRun();
    db.close();
    const h = agent(["sleep", "3083"]);
    const { out, d } = deps();
    await handleStopSignal("SIGTERM", { command: "run", run }, d);
    expect(alive(h.record.pid)).toBe(false);
    expect(out.err).toContain(
      `styre: stopped the agent (pid ${h.record.pid}) and 0 of its commands.\n`,
    );
    expect(out.emitted).toEqual([]);
    expect(notes(t.path)).toBe(0);
    expect(out.err.some((l) => l.includes("resume with"))).toBe(false);
    expect(out.exited).toEqual([143]);
  });

  test("the run is read at the signal: setRun(null) during the stop does not lose the recording (R26)", async () => {
    const { t, db, run } = ticketRun();
    agent(["sleep", "3084"]);
    const { out, d } = deps();
    const emittedWith: unknown[] = [];
    d.emit = (r, conn) => {
      out.emitted.push(r);
      emittedWith.push(conn);
    };
    const ctx: HandlerCtx = { command: "run", run };
    const p = handleStopSignal("SIGINT", ctx, d);
    ctx.run = null; // run code moving on while the handler waits
    await p;
    expect(notes(t.path)).toBe(1);
    expect(out.emitted.length).toBe(1);
    expect(emittedWith).toEqual([db]);
    expect(out.err.at(-1)).toBe("styre: run interrupted; resume with: styre run --resume ENG-1\n");
    db.close();
  });

  test("a stop that never settles: the deadline still holds, the stops are forced, and the line says so", async () => {
    const h = agent(["sleep", "3081"]);
    // The stop never settles and holds no timer, so it cannot keep Bun alive; the real process it
    // would have stopped is killed below, so that cannot either.
    h.stop = () => new Promise(() => {});
    const { out, d } = deps();
    const t0 = Date.now();
    try {
      await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
      expect(Date.now() - t0).toBeLessThan(HANDLER_DEADLINE_MS);
      expect(door.stopAbort.forced).toBe(true);
      expect(out.err).toContain(
        `styre: could not confirm that sleep 3081 (pid ${h.record.pid}) stopped (it did not finish in time); if it is still running, stop it with: kill -9 ${h.record.pid}\n`,
      );
      expect(out.exited).toEqual([143]);
    } finally {
      h.proc.kill("SIGKILL");
      await h.proc.exited;
    }
  }, 15_000);

  test("a stop that fails is reported as unconfirmed with its reason", async () => {
    const h = agent(["sleep", "3085"]);
    h.stop = () => Promise.reject(new Error("boom"));
    const { out, d } = deps();
    await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
    expect(out.err).toContain(
      `styre: could not confirm that sleep 3085 (pid ${h.record.pid}) stopped (boom); if it is still running, stop it with: kill -9 ${h.record.pid}\n`,
    );
  });

  test("a leftover check that throws is said as skipped, and the interruption is still recorded", async () => {
    const { t, db, run } = ticketRun();
    agent(["sleep", "3086"], { stepId: t.stepId, worktree: scratch });
    const { out, d } = deps();
    d.leftovers = () => {
      throw new Error("lsof exploded");
    };
    await handleStopSignal("SIGTERM", { command: "run", run }, d);
    expect(out.err).toContain(
      "styre: skipped the check for processes the agent left running in the worktree (lsof exploded)\n",
    );
    expect(notes(t.path)).toBe(1);
    expect(out.emitted.length).toBe(1);
    db.close();
  });

  test("a third signal does not repeat the forcing line", async () => {
    const { out, d } = deps();
    agent(["bash", join(FX, "stubborn-cli.sh")]);
    const first = handleStopSignal("SIGINT", { command: "run", run: null }, d);
    await handleStopSignal("SIGINT", { command: "run", run: null }, d);
    await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
    await first;
    expect(out.err.filter((l) => l === "styre: forcing stop…\n")).toHaveLength(1);
    expect(out.reraised).toEqual(["SIGINT"]);
  });

  test("a re-raise that throws still reaches the fallback exit", async () => {
    const { out, d } = deps();
    d.reraise = () => {
      throw new Error("kill failed");
    };
    await handleStopSignal("SIGHUP", { command: "run", run: null }, d);
    expect(out.exited).toEqual([129]);
  });

  test("no agent line when the agent itself survived; its own survivor line is printed", async () => {
    const h = agent(["sleep", "3082"]);
    const pid = h.record.pid;
    door.__setStopDepsForTests({
      ...realStopDeps,
      kill: (t, s) => {
        if (t === pid) return;
        realStopDeps.kill(t, s);
      },
    });
    const { out, d } = deps();
    const first = handleStopSignal("SIGINT", { command: "run", run: null }, d);
    await Bun.sleep(200);
    await handleStopSignal("SIGINT", { command: "run", run: null }, d); // force it
    await first;
    expect(out.err.some((l) => l.startsWith("styre: stopped the agent"))).toBe(false);
    expect(out.err).toContain(
      `styre: could not stop sleep 3082 (pid ${pid}); stop it with: kill -9 ${pid}\n`,
    );
  }, 10_000);

  test("command (group) launches are left out of the leftover check", async () => {
    const g = door.launch({
      argv: ["sleep", "3087"],
      cwd: process.cwd(),
      env: process.env,
      kind: "group",
      context: { ident: "ENG-1", stepId: null, worktree: scratch },
    });
    const a = agent(["sleep", "3088"], { worktree: scratch });
    const { out, d } = deps();
    const seen: number[][] = [];
    d.leftovers = (stopped) => {
      seen.push(stopped.map((h) => h.record.pid));
      return [];
    };
    await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
    expect(seen).toEqual([[a.record.pid]]);
    expect(alive(g.record.pid)).toBe(false);
    // With only a group launch, there is no check and no skip line.
    door.__resetForTests();
    __resetSignalsForTests();
    door.launch({
      argv: ["sleep", "3089"],
      cwd: process.cwd(),
      env: process.env,
      kind: "group",
      context: { ident: "ENG-1", stepId: null, worktree: scratch },
    });
    const second = deps();
    let called = false;
    second.d.leftovers = () => {
      called = true;
      return [];
    };
    await handleStopSignal("SIGTERM", { command: "run", run: null }, second.d);
    expect(called).toBe(false);
    expect(second.out.err.some((l) => l.includes("skipped the check"))).toBe(false);
    void out;
  });
});

describe("deferred cleanups (m3)", () => {
  // The handler re-raises without waiting for the run code to unwind, so a baseline worktree the
  // run code would remove in its own `finally` must be removed by the handler before it exits.
  const ample = { manual: "remove it with: true" };

  test("the handler runs every pending cleanup once, after its stops and before it re-raises", async () => {
    // A command that outlives its SIGTERM for a moment: a cleanup run before the handler waited for
    // the stop would see it still alive.
    const g = door.launch({
      argv: [
        "bash",
        "-c",
        "trap 'sleep 0.4; exit 0' TERM; echo ready >&2; while :; do sleep 1 & wait $!; done",
      ],
      cwd: process.cwd(),
      env: process.env,
      kind: "group",
      context: { ident: "ENG-1", stepId: null, worktree: scratch },
    });
    // Only once its trap is set does it outlive the SIGTERM.
    expect(await readUntil(g.proc.stderr, /ready\n/)).toContain("ready");
    const { out, d } = deps();
    const events: string[] = [];
    const release = door.deferCleanup({
      ...ample,
      run: () => {
        events.push(alive(g.record.pid) ? "cleanup while the command ran" : "cleanup");
      },
    });
    d.reraise = (sig) => {
      events.push("reraise");
      out.reraised.push(sig);
    };
    await handleStopSignal("SIGINT", { command: "run", run: null }, d);
    expect(events).toEqual(["cleanup", "reraise"]);
    release(); // the run code's own release, if it ever gets there, runs nothing again
    expect(events).toEqual(["cleanup", "reraise"]);
  });

  test("a cleanup that fails is said, the others still run, and the stop still exits", async () => {
    const { out, d } = deps();
    let ran = false;
    door.deferCleanup({
      ...ample,
      run: () => {
        throw new Error("git worktree remove failed");
      },
    });
    door.deferCleanup({
      ...ample,
      run: () => {
        ran = true;
      },
    });
    await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
    expect(ran).toBe(true);
    expect(out.err).toContain(
      "styre: could not clean up after the run: git worktree remove failed\n",
    );
    expect(out.exited).toEqual([143]);
  });

  // I1: a held cleanup runs once the interruption is recorded, its telemetry written and the outcome
  // said, and it cannot hold the handler past its deadline.
  test("a slow cleanup runs after the interruption is recorded, and the re-raise still meets the deadline", async () => {
    const { t, run } = ticketRun();
    const { out, d } = deps();
    // Real time, with the handler's clock moved on by 5 s after its first reading: the deadline
    // falls 1.5 s after the signal, so the test need not wait the full 6.5 s.
    const SHIFT = 5_000;
    let readings = 0;
    d.now = () => Date.now() + (readings++ === 0 ? 0 : SHIFT);
    const seen = { recorded: -1, emitted: -1, said: false };
    door.deferCleanup({
      manual: "remove the slow thing with: true",
      run: () => {
        seen.recorded = notes(t.path);
        seen.emitted = out.emitted.length;
        seen.said = out.err.includes(
          "styre: run interrupted; resume with: styre run --resume ENG-1\n",
        );
        // Its own bound is the normal 120 s; it would take 20 s.
        const r = door.runBlocking(["sleep", "20"], { timeoutMs: 120_000, cleanup: true });
        if (!r.success) throw new Error(`the slow thing ${r.timedOut ? "timed out" : "failed"}`);
      },
    });
    let reraisedAfter = Number.POSITIVE_INFINITY;
    const t0 = Date.now();
    d.reraise = (sig) => {
      reraisedAfter = Date.now() - t0;
      out.reraised.push(sig);
    };
    await handleStopSignal("SIGTERM", { command: "run", run }, d);
    expect(seen).toEqual({ recorded: 1, emitted: 1, said: true });
    expect(reraisedAfter).toBeLessThanOrEqual(HANDLER_DEADLINE_MS - SHIFT);
    expect(out.err).toContain(
      "styre: could not clean up after the run: the slow thing timed out\n",
    );
    expect(out.reraised).toEqual(["SIGTERM"]);
  }, 30_000);

  test("with no time left before the deadline, a cleanup is skipped and its manual finish said", async () => {
    const { out, d } = deps();
    let readings = 0;
    // Every reading after the first is past the deadline.
    d.now = () => Date.now() + (readings++ === 0 ? 0 : HANDLER_DEADLINE_MS);
    let ran = false;
    door.deferCleanup({
      manual: "remove the worktree /w with: git -C /r worktree remove --force /w",
      run: () => {
        ran = true;
      },
    });
    await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
    expect(ran).toBe(false);
    expect(out.err).toContain(
      "styre: could not clean up after the run: no time was left before the stop deadline to remove the worktree /w with: git -C /r worktree remove --force /w\n",
    );
    expect(out.reraised).toEqual(["SIGTERM"]);
  });
});

describe("installing the handlers", () => {
  const SIGS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  const counts = () => SIGS.map((s) => process.listenerCount(s));

  test("listens for the four signals, guards stdout and stderr, and dispose removes the listeners", () => {
    const before = counts();
    // Injected re-raise and exit: a stray signal during the test must not end the test run.
    const h = installStopHandlers({ command: "run", run: null }, deps().d);
    try {
      expect(counts()).toEqual(before.map((n) => n + 1));
      // The stream guards are added once per process, by whichever install comes first: an earlier
      // test file in the same run (styre run and setup install the handlers) may already have
      // added them. The real process tests below prove what they do.
      expect(process.stdout.listenerCount("error")).toBeGreaterThanOrEqual(1);
      expect(process.stderr.listenerCount("error")).toBeGreaterThanOrEqual(1);
    } finally {
      h.dispose();
    }
    expect(counts()).toEqual(before);
  });

  test("suspendStopHandlers removes the listeners while it runs and restores them, even on a throw", async () => {
    const before = counts();
    const h = installStopHandlers({ command: "setup", run: null }, deps().d);
    try {
      const during = await suspendStopHandlers(() => counts());
      expect(during).toEqual(before);
      expect(counts()).toEqual(before.map((n) => n + 1));
      await expect(
        suspendStopHandlers(() => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(counts()).toEqual(before.map((n) => n + 1));
    } finally {
      h.dispose();
    }
  });

  test("the real telemetry path writes the note as one NDJSON event line on stdout", async () => {
    const t = makeTicketDb();
    const db = new Database(t.path);
    const { out, d } = deps();
    const h = installStopHandlers(
      { command: "run", run: null },
      { stderr: d.stderr, reraise: d.reraise, exit: d.exit, leftovers: d.leftovers },
    );
    h.setRun({ db, dbPath: t.path, ticketId: t.ticketId, ident: "ENG-1" });
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (s: string) => {
      lines.push(String(s));
      return true;
    };
    try {
      process.emit("SIGINT", "SIGINT");
      const until = Date.now() + 5_000;
      while (out.exited.length === 0 && Date.now() < until) await Bun.sleep(20);
    } finally {
      (process.stdout as { write: unknown }).write = write;
      h.dispose();
      db.close();
    }
    expect(out.exited).toEqual([130]);
    const events = lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "event", kind: "note", ticket_id: t.ticketId });
  });
});

describe("a real process with the handlers installed", () => {
  async function child(mode = "plain") {
    const p = Bun.spawn(["bun", join(FX, "signal-child.ts"), mode], {
      // Bun.spawn's default environment is the one Bun started with, which lacks the preload's test
      // state folder: pass this process's, so no launch record reaches the operator's real one (R29).
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = p.stderr.getReader();
    let text = "";
    const dec = new TextDecoder();
    while (!text.includes("ready\n")) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value);
    }
    const rest = (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) return text;
        text += dec.decode(r.value);
      }
    })();
    return { p, reader, rest };
  }

  test("each signal ends the process BY that signal, after the opening line", async () => {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
      const { p, rest } = await child();
      process.kill(p.pid, sig);
      await p.exited;
      const text = await rest;
      expect(p.signalCode).toBe(sig);
      expect(text).toContain(
        sig === "SIGINT" ? OPENING_INT : `styre: received a stop request (${sig}) — cleaning up…\n`,
      );
    }
  }, 20_000);

  test("after the terminal has closed, the writes are harmless and SIGHUP still ends it by SIGHUP", async () => {
    const { p, reader } = await child("slow");
    await reader.cancel();
    await p.stdout.cancel();
    await Bun.sleep(100);
    process.kill(p.pid, "SIGHUP");
    await p.exited;
    expect(p.exitCode).toBeNull();
    expect(p.signalCode).toBe("SIGHUP");
  }, 10_000);

  test("a second signal forces the stuck agent's stop, and the process ends by the first signal", async () => {
    const { p, rest } = await child("stubborn");
    await Bun.sleep(200);
    const t0 = Date.now();
    process.kill(p.pid, "SIGINT");
    await Bun.sleep(300);
    process.kill(p.pid, "SIGTERM");
    await p.exited;
    const text = await rest;
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(text).toContain("styre: forcing stop…\n");
    expect(p.signalCode).toBe("SIGINT");
  }, 10_000);
});
