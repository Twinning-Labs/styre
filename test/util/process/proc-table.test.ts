// test/util/process/proc-table.test.ts
import { afterEach, expect, test } from "bun:test";
import {
  _forcePsFallbackForTest,
  listProcesses,
  nowToken,
  probe,
  sameProcess,
  tokenValue,
} from "../../../src/util/process/proc-table.ts";

const spawned: Bun.Subprocess[] = [];
afterEach(() => {
  _forcePsFallbackForTest(false);
  for (const p of spawned.splice(0))
    try {
      p.kill("SIGKILL");
    } catch {}
});

test("lists this process with its parent, group and a start time", () => {
  const me = listProcesses().find((p) => p.pid === process.pid);
  expect(me).toBeDefined();
  expect(me?.ppid).toBe(process.ppid);
  expect(me?.startedAt).toMatch(/^\d+(\.\d{6})?$/);
  expect(me?.state).toBe("running");
});

test("a child's start time is stable across reads and differs from ours", async () => {
  const child = Bun.spawn(["sleep", "5"]);
  spawned.push(child);
  await Bun.sleep(50);
  const a = probe(child.pid);
  const b = probe(child.pid);
  expect(a.kind).toBe("alive");
  expect(b.kind).toBe("alive");
  if (a.kind === "alive" && b.kind === "alive") {
    expect(a.info.startedAt).toBe(b.info.startedAt);
    expect(a.info.ppid).toBe(process.pid);
    expect(sameProcess({ pid: child.pid, startedAt: a.info.startedAt }, b.info)).toBe(true);
  }
});

test("a pid that does not exist is gone, not alive and not 'not allowed'", () => {
  expect(probe(2_000_000_000).kind).toBe("gone");
});

test("a process owned by another user is reported as alive or not allowed, never gone", () => {
  // pid 1 is root's on both platforms.
  expect(probe(1).kind).not.toBe("gone");
});

test("an exited, unreaped child reads as a zombie", async () => {
  const child = Bun.spawn(["sh", "-c", "exit 0"]);
  spawned.push(child);
  // Block the event loop so Bun cannot reap it, then read the table synchronously.
  const end = Date.now() + 300;
  while (Date.now() < end) {}
  const p = probe(child.pid);
  expect(p.kind === "gone" || (p.kind === "alive" && p.info.state === "zombie")).toBe(true);
});

for (const forcePs of [false, true]) {
  test(`nowToken orders before a child started later (ps fallback forced: ${forcePs})`, async () => {
    _forcePsFallbackForTest(forcePs);
    const before = nowToken();
    if (forcePs && process.platform !== "linux") expect(before).toMatch(/^\d+\.000000$/);
    const child = Bun.spawn(["sleep", "2"]);
    spawned.push(child);
    await Bun.sleep(50);
    const c = probe(child.pid);
    expect(c.kind).toBe("alive");
    if (c.kind === "alive") {
      expect(tokenValue(c.info.startedAt)).toBeGreaterThanOrEqual(
        tokenValue(before) - 0.02 * (process.platform === "linux" ? 100 : 1),
      );
    }
  });
}

// Linux reads /proc and never launches ps: skipped there, never passed silently.
test.skipIf(process.platform === "linux")(
  "the ps fallback ignores ambient locale and timezone",
  () => {
    const sysctl = probe(process.pid);
    const saved = { lc: process.env.LC_ALL, tz: process.env.TZ };
    process.env.LC_ALL = "fr_FR.UTF-8";
    process.env.TZ = "Asia/Kolkata";
    let viaPs: ReturnType<typeof probe>;
    try {
      _forcePsFallbackForTest(true);
      viaPs = probe(process.pid);
    } finally {
      _forcePsFallbackForTest(false);
      if (saved.lc === undefined) Reflect.deleteProperty(process.env, "LC_ALL");
      else process.env.LC_ALL = saved.lc;
      if (saved.tz === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = saved.tz;
    }
    expect(sysctl.kind).toBe("alive");
    expect(viaPs.kind).toBe("alive");
    if (sysctl.kind === "alive" && viaPs.kind === "alive") {
      expect(Math.floor(tokenValue(viaPs.info.startedAt))).toBe(
        Math.floor(tokenValue(sysctl.info.startedAt)),
      );
    }
  },
);

test("sameProcess is false when the start time or the pid differs (pid reuse defence)", () => {
  const p = probe(process.pid);
  expect(p.kind).toBe("alive");
  if (p.kind !== "alive") return;
  expect(sameProcess({ pid: p.info.pid, startedAt: p.info.startedAt }, p.info)).toBe(true);
  expect(sameProcess({ pid: p.info.pid, startedAt: `${p.info.startedAt}1` }, p.info)).toBe(false);
  expect(sameProcess({ pid: p.info.pid + 1, startedAt: p.info.startedAt }, p.info)).toBe(false);
});

function psPgid(pid: number): number {
  return Number(
    Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)])
      .stdout.toString()
      .trim(),
  );
}

test("pgid matches ps for this process, and a detached child leads its own group", async () => {
  const me = probe(process.pid);
  expect(me.kind).toBe("alive");
  if (me.kind === "alive") expect(me.info.pgid).toBe(psPgid(process.pid));
  const child = Bun.spawn(["sleep", "5"], { detached: true });
  spawned.push(child);
  await Bun.sleep(50);
  const c = probe(child.pid);
  expect(c.kind).toBe("alive");
  if (c.kind === "alive" && me.kind === "alive") {
    expect(c.info.pgid).toBe(child.pid);
    expect(c.info.pgid).not.toBe(me.info.pgid);
    expect(c.info.pgid).toBe(psPgid(child.pid));
  }
});
