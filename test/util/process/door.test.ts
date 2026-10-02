import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../../src/util/process/door.ts";
import { listProcesses, probe } from "../../../src/util/process/proc-table.ts";
import { listRecords, processesDir } from "../../../src/util/process/records.ts";
import type { StopDeps } from "../../../src/util/process/stop.ts";

const sh = (script: string): string[] => ["sh", "-c", script];
const ctx = { ident: "ENG-1", stepId: 1, worktree: null };
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let state: string;
const saved = process.env.XDG_STATE_HOME;
let childrenBefore: Set<number>;

const liveChildren = (): number[] =>
  listProcesses()
    .filter((p) => p.ppid === process.pid && p.state !== "zombie")
    .map((p) => p.pid);

async function waitFor(pred: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(20);
  }
  return pred();
}

function start(argv: string[], kind: "agent" | "group", env = process.env) {
  return door.launch({ argv, cwd: process.cwd(), env, kind, context: ctx });
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "styre-door-"));
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
  childrenBefore = new Set(liveChildren());
});
afterEach(async () => {
  // Cleanup runs even when a test failed: stop every live launch, then kill any child it missed.
  for (const dir of [state, processesDir()]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* not there */
    }
  }
  door.__setStopDepsForTests(undefined);
  for (const h of door.liveLaunches()) {
    try {
      await h.stop("forced");
    } catch {
      /* the test may have broken it on purpose */
    }
  }
  for (const pid of liveChildren()) {
    if (childrenBefore.has(pid)) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* not a group leader */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await waitFor(() => liveChildren().every((p) => childrenBefore.has(p)), 2_000);
  rmSync(state, { recursive: true, force: true });
  if (saved === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  else process.env.XDG_STATE_HOME = saved;
});

// --- the Bun contract the timeout detection relies on -------------------------------------------

test("Bun 1.4 reports a sync timeout as exitedDueToTimeout, and a signal exit as something else", () => {
  const slow = Bun.spawnSync(["sleep", "30"], { timeout: 100, killSignal: "SIGKILL" });
  expect(slow.exitedDueToTimeout).toBe(true);
  expect(slow.exitCode).toBeNull();
  const selfKilled = Bun.spawnSync(sh("kill -TERM $$"), { timeout: 10_000 });
  expect(selfKilled.exitedDueToTimeout).toBe(false);
  expect(selfKilled.exitCode).toBeNull();
});

// --- launch ----------------------------------------------------------------------------------

test("a launch is recorded on disk and in memory, and released after it finishes", async () => {
  const h = start(["sleep", "30"], "group");
  expect(door.liveLaunches()).toContain(h);
  const listed = listRecords();
  expect(listed.map((l) => l.record.pid)).toEqual([h.proc.pid]);
  const rec = listed[0]?.record;
  expect(rec).toEqual(h.record);
  expect(rec?.kind).toBe("group");
  expect(rec?.ident).toBe("ENG-1");
  expect(rec?.stepId).toBe(1);
  expect(rec?.command).toBe("sleep 30");
  expect(rec?.owner).toEqual(door.selfIdentity());
  expect(h.interrupted).toBe(false);
  // Make the leader exit, then finish releases the record.
  process.kill(h.proc.pid, "SIGKILL");
  await h.proc.exited;
  const rep = await h.finish();
  expect(rep.survivors).toEqual([]);
  expect(door.liveLaunches()).not.toContain(h);
  expect(listRecords()).toEqual([]);
});

test("a launch that exits at once still gives a handle that finishes and releases cleanly", async () => {
  const h = start(sh("exit 0"), "group");
  await h.proc.exited;
  const rep = await h.finish();
  expect(rep.survivors).toEqual([]);
  expect(door.liveLaunches()).toEqual([]);
  expect(listRecords()).toEqual([]);
  const a = start(sh("exit 0"), "agent");
  await a.proc.exited;
  expect((await a.finish()).survivors).toEqual([]);
  expect((await a.stop("forced")).survivors).toEqual([]);
  expect(door.liveLaunches()).toEqual([]);
  expect(listRecords()).toEqual([]);
});

test("group launches lead their own group; agent launches stay in ours", async () => {
  const g = start(["sleep", "30"], "group");
  const a = start(["sleep", "30"], "agent");
  const t = listProcesses();
  expect(t.find((p) => p.pid === g.proc.pid)?.pgid).toBe(g.proc.pid);
  expect(t.find((p) => p.pid === a.proc.pid)?.pgid).toBe(door.selfIdentity().pgid);
  expect(g.proc.pid).not.toBe(door.selfIdentity().pgid);
  const [gr, ar] = await Promise.all([g.stop("forced"), a.stop("forced")]);
  expect(gr.survivors).toEqual([]);
  expect(ar.survivors).toEqual([]);
  expect(door.liveLaunches()).toEqual([]);
  expect(listRecords()).toEqual([]);
});

test("stopping a group launch stops its descendants; finish stops what a leader left behind", async () => {
  const g = start(sh("sleep 30 & wait"), "group");
  const members = () =>
    listProcesses().filter((p) => p.pgid === g.proc.pid && p.state !== "zombie");
  expect(await waitFor(() => members().length === 2)).toBe(true);
  expect((await g.stop("forced")).survivors).toEqual([]);
  expect(members()).toEqual([]);

  // The leader exits normally and leaves a background child in its group.
  const h = start(sh("sleep 30 & exit 0"), "group");
  await h.proc.exited;
  const left = () => listProcesses().filter((p) => p.pgid === h.proc.pid && p.state !== "zombie");
  expect(left().length).toBe(1);
  const rep = await h.finish();
  expect(rep.survivors).toEqual([]);
  expect(rep.stopped.length).toBeGreaterThanOrEqual(1);
  expect(left()).toEqual([]);
  expect(listRecords()).toEqual([]);
});

test("stopping an agent launch stops its descendants and releases the record", async () => {
  const a = start(sh("sleep 30 & wait"), "agent");
  const kids = () => listProcesses().filter((p) => p.ppid === a.proc.pid && p.state !== "zombie");
  expect(await waitFor(() => kids().length === 1)).toBe(true);
  const rep = await a.stop("graceful");
  expect(rep.survivors).toEqual([]);
  expect(rep.stopped.length).toBe(2);
  expect(kids()).toEqual([]);
  expect(listRecords()).toEqual([]);
  expect(door.liveLaunches()).toEqual([]);
});

test("the record stays, and the launch stays live, while anything survives a stop", async () => {
  const g = start(["sleep", "30"], "group");
  let t = 0;
  // A world where signals do nothing and the clock jumps: the group never empties.
  const deaf: StopDeps = {
    list: listProcesses,
    kill: () => {},
    sleep: async () => {},
    now: () => {
      t += 250;
      return t;
    },
  };
  door.__setStopDepsForTests(deaf);
  const rep = await g.stop("forced");
  expect(rep.survivors.length).toBe(1);
  expect(door.liveLaunches()).toContain(g);
  expect(listRecords().map((l) => l.record.pid)).toEqual([g.proc.pid]);
  // Once the stop works, the record goes.
  door.__setStopDepsForTests(undefined);
  expect((await g.stop("forced")).survivors).toEqual([]);
  expect(listRecords()).toEqual([]);
  expect(door.liveLaunches()).toEqual([]);
});

test("a record that cannot be removed is a loud failure, not a silent one", async () => {
  if (isRoot) return; // root ignores folder permissions
  const g = start(["sleep", "30"], "group");
  chmodSync(processesDir(), 0o500);
  await expect(g.stop("forced")).rejects.toThrow();
  expect(door.liveLaunches()).toContain(g); // still held: the record is still on disk
  chmodSync(processesDir(), 0o700);
  expect((await g.stop("forced")).survivors).toEqual([]);
  expect(listRecords()).toEqual([]);
});

test("a stop signal in flight (stopAbort.forced) cuts a graceful stop's wait short", async () => {
  // The leader ignores SIGTERM, so a graceful stop would wait the whole grace period.
  const g = start(sh("trap '' TERM; while :; do sleep 1; done"), "group");
  await Bun.sleep(300); // let the trap install
  door.stopAbort.forced = true;
  const t0 = Date.now();
  const rep = await g.stop("graceful");
  expect(rep.survivors).toEqual([]);
  expect(Date.now() - t0).toBeLessThan(door.GRACE_MS - 1_500);
  expect(listRecords()).toEqual([]);
});

test("a launch starts in the cwd it was given, for both kinds", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "styre-door-cwd-")));
  try {
    for (const kind of ["group", "agent"] as const) {
      const h = door.launch({ argv: ["pwd"], cwd: dir, env: process.env, kind, context: ctx });
      const out = await new Response(h.proc.stdout).text();
      await h.proc.exited;
      await h.finish();
      expect(realpathSync(out.trim())).toBe(dir);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finish on a live agent stops it, and only then releases the record", async () => {
  const a = start(["sleep", "30"], "agent");
  const alive = () => listProcesses().some((p) => p.pid === a.proc.pid && p.state !== "zombie");
  expect(alive()).toBe(true);
  const rep = await a.finish();
  expect(rep.survivors).toEqual([]);
  expect(alive()).toBe(false);
  expect(door.liveLaunches()).toEqual([]);
  expect(listRecords()).toEqual([]);
});

test("a finish that leaves a survivor keeps the record and the live entry", async () => {
  const a = start(["sleep", "30"], "agent");
  let t = 0;
  door.__setStopDepsForTests({
    list: listProcesses,
    kill: () => {},
    sleep: async () => {},
    now: () => {
      t += 250;
      return t;
    },
  });
  const rep = await a.finish();
  expect(rep.survivors.length).toBeGreaterThan(0);
  expect(door.liveLaunches()).toContain(a);
  expect(listRecords().map((l) => l.record.pid)).toEqual([a.proc.pid]);
});

test("a stop signal in flight (stopAbort.forced) also cuts a graceful AGENT stop short", async () => {
  // The agent's shell ignores SIGTERM and respawns its child, so only SIGKILL ends it.
  const a = start(sh("trap '' TERM; while :; do sleep 1; done"), "agent");
  await Bun.sleep(300); // let the trap install
  door.stopAbort.forced = true;
  const t0 = Date.now();
  const rep = await a.stop("graceful");
  expect(rep.survivors).toEqual([]);
  expect(Date.now() - t0).toBeLessThan(door.GRACE_MS - 1_500);
  expect(listRecords()).toEqual([]);
});

test("a launch passes its stdin and env through, an undefined env value is left unset", async () => {
  const h = start(sh('cat; echo "[$KEPT][${DROPPED-unset}]"'), "group", {
    PATH: process.env.PATH,
    KEPT: "yes",
    DROPPED: undefined,
  } as Record<string, string | undefined> as NodeJS.ProcessEnv);
  // stdin was not given: "ignore", so cat ends at once.
  const out = await new Response(h.proc.stdout).text();
  await h.proc.exited;
  expect(out).toBe("[yes][unset]\n");
  await h.finish();
  const s = door.launch({
    argv: ["cat"],
    cwd: process.cwd(),
    env: process.env,
    stdin: new TextEncoder().encode("from stdin"),
    kind: "agent",
    context: ctx,
  });
  expect(await new Response(s.proc.stdout).text()).toBe("from stdin");
  await s.proc.exited;
  await s.finish();
  expect(listRecords()).toEqual([]);
});

for (const kind of ["group", "agent"] as const) {
  test(`an unwritable state folder stops what it just started and throws (${kind})`, async () => {
    if (isRoot) return;
    chmodSync(state, 0o500);
    let message = "";
    try {
      start(["sleep", "30"], kind);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      chmodSync(state, 0o700);
    }
    expect(message).toMatch(/launch record/);
    expect(door.liveLaunches()).toEqual([]);
    expect(listRecords()).toEqual([]);
    // No child is left running: the one just started was stopped.
    expect(await waitFor(() => liveChildren().every((p) => childrenBefore.has(p)))).toBe(true);
  });
}

// --- stopping --------------------------------------------------------------------------------

test("once stopping, launch and runBlocking refuse with RunInterrupted; cleanup and diagnostics still run", () => {
  expect(door.isStopping()).toBe(false);
  door.beginStopping();
  expect(door.isStopping()).toBe(true);
  expect(() => start(["true"], "group")).toThrow(door.RunInterrupted);
  expect(() => start(["true"], "agent")).toThrow(door.RunInterrupted);
  expect(() => door.runBlocking(["true"], { timeoutMs: 1000 })).toThrow(door.RunInterrupted);
  expect(door.runBlocking(["true"], { timeoutMs: 1000, cleanup: true }).success).toBe(true);
  expect(door.launchDiagnostic(["true"], { timeoutMs: 1000 }).success).toBe(true);
  // A refused launch leaves nothing behind.
  expect(door.liveLaunches()).toEqual([]);
  expect(listRecords()).toEqual([]);
  expect(existsSync(processesDir())).toBe(false);
});

test("the door is open before a stop begins, for blocking calls with or without cleanup", () => {
  expect(door.runBlocking(["true"], { timeoutMs: 1000 }).success).toBe(true);
  expect(door.runBlocking(["true"], { timeoutMs: 1000, cleanup: true }).success).toBe(true);
});

test("a launch made before the stop can still be stopped while stopping", async () => {
  const g = start(["sleep", "30"], "group");
  door.beginStopping();
  expect((await g.stop("forced")).survivors).toEqual([]);
  expect(listRecords()).toEqual([]);
  expect(door.liveLaunches()).toEqual([]);
});

test("a diagnostic launch is not recorded and not tracked", () => {
  const r = door.launchDiagnostic(sh("echo hi"), { timeoutMs: 5_000 });
  expect(r.stdout).toBe("hi\n");
  expect(listRecords()).toEqual([]);
  expect(door.liveLaunches()).toEqual([]);
});

// --- blocking calls ----------------------------------------------------------------------------

test("runBlocking enforces its timeout, even against a program that ignores SIGTERM", () => {
  const t0 = Date.now();
  const r = door.runBlocking(sh("trap '' TERM; exec sleep 30"), { timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(r.success).toBe(false);
  expect(Date.now() - t0).toBeLessThan(10_000);
});

test("runBlocking reports output, status, env, cwd and stdin; a normal or signalled exit is not a timeout", () => {
  const ok = door.runBlocking(sh('pwd; echo "$A"; cat; echo err >&2; exit 3'), {
    cwd: tmpdir(),
    timeoutMs: 10_000,
    env: { PATH: process.env.PATH, A: "from-env", B: undefined },
    stdin: new TextEncoder().encode("piped\n"),
  });
  expect(ok.exitCode).toBe(3);
  expect(ok.success).toBe(false);
  expect(ok.timedOut).toBe(false);
  expect(ok.stdout.split("\n")).toEqual([realpathSync(tmpdir()), "from-env", "piped", ""]);
  expect(ok.stderr).toBe("err\n");
  const sig = door.runBlocking(sh("kill -TERM $$"), { timeoutMs: 10_000 });
  expect(sig.timedOut).toBe(false);
  expect(sig.exitCode).toBeNull();
  expect(door.runBlocking(["true"], { timeoutMs: 10_000 })).toMatchObject({
    success: true,
    exitCode: 0,
    timedOut: false,
  });
});

test("a blocking call without a usable timeout is refused", () => {
  expect(() => door.runBlocking(["true"], { timeoutMs: 0 })).toThrow(/timeout/);
  expect(() => door.runBlocking(["true"], { timeoutMs: Number.NaN })).toThrow(/timeout/);
  expect(() => door.launchDiagnostic(["true"], { timeoutMs: -1 })).toThrow(/timeout/);
});

// --- the step in flight ------------------------------------------------------------------------

test("the in-flight step records headAtStart and the latest reported head", () => {
  expect(door.inFlightStep()).toBeNull();
  door.beginStep({ stepId: 3, startedAt: "t", ident: "ENG-1", headAtStart: "aaa" });
  expect(door.inFlightStep()?.headAtStop).toBe("aaa"); // nothing reported yet
  door.noteHead("bbb");
  door.noteHead("ccc");
  expect(door.inFlightStep()).toEqual({
    stepId: 3,
    startedAt: "t",
    ident: "ENG-1",
    headAtStart: "aaa",
    headAtStop: "ccc",
  });
  door.endStep();
  expect(door.inFlightStep()).toBeNull();
});

test("noteHead with no step in flight does nothing, and a new step starts fresh", () => {
  door.noteHead("zzz");
  expect(door.inFlightStep()).toBeNull();
  door.beginStep({ stepId: 1, startedAt: "t1", ident: "ENG-1", headAtStart: null });
  expect(door.inFlightStep()?.headAtStop).toBeNull();
  door.noteHead("aaa");
  door.endStep();
  door.beginStep({ stepId: 2, startedAt: "t2", ident: "ENG-1", headAtStart: "bbb" });
  expect(door.inFlightStep()).toEqual({
    stepId: 2,
    startedAt: "t2",
    ident: "ENG-1",
    headAtStart: "bbb",
    headAtStop: "bbb",
  });
});

test("inFlightStep returns a copy, so a caller cannot change the step", () => {
  door.beginStep({ stepId: 1, startedAt: "t", ident: "ENG-1", headAtStart: "a" });
  const s = door.inFlightStep();
  if (s) s.headAtStop = "tampered";
  expect(door.inFlightStep()?.headAtStop).toBe("a");
});

// --- identity ----------------------------------------------------------------------------------

test("selfIdentity matches the process table and is stable", () => {
  const me = door.selfIdentity();
  const p = probe(process.pid);
  expect(p.kind).toBe("alive");
  if (p.kind === "alive") {
    expect(me).toEqual({ pid: process.pid, startedAt: p.info.startedAt, pgid: p.info.pgid });
  }
  expect(door.selfIdentity()).toBe(me);
});
