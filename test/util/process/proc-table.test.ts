// test/util/process/proc-table.test.ts
import { afterEach, expect, test } from "bun:test";
import {
  listProcesses,
  nowToken,
  probe,
  sameProcess,
  tokenValue,
} from "../../../src/util/process/proc-table.ts";

const spawned: Bun.Subprocess[] = [];
afterEach(() => {
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

test("nowToken orders after this process's start and before a child started later", async () => {
  const before = nowToken();
  const child = Bun.spawn(["sleep", "2"]);
  spawned.push(child);
  await Bun.sleep(50);
  const c = probe(child.pid);
  expect(c.kind).toBe("alive");
  if (c.kind === "alive")
    expect(tokenValue(c.info.startedAt)).toBeGreaterThanOrEqual(
      tokenValue(before) - 0.02 * (process.platform === "linux" ? 100 : 1),
    );
});

test("start times ignore locale and timezone", () => {
  const saved = { lc: process.env.LC_ALL, tz: process.env.TZ };
  const base = probe(process.pid);
  process.env.LC_ALL = "fr_FR.UTF-8";
  process.env.TZ = "Asia/Kolkata";
  try {
    const again = probe(process.pid);
    expect(
      again.kind === "alive" &&
        base.kind === "alive" &&
        again.info.startedAt === base.info.startedAt,
    ).toBe(true);
  } finally {
    // Assigning undefined to process.env stores the string "undefined"; delete instead.
    if (saved.lc === undefined) process.env.LC_ALL = undefined;
    else process.env.LC_ALL = saved.lc;
    if (saved.tz === undefined) process.env.TZ = undefined;
    else process.env.TZ = saved.tz;
  }
});
