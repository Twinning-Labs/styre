import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, releaseRunLock, runLockStatus } from "../../src/cli/run-lock.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "styre-lock-"));

test("acquire writes our pid; status reports self; release removes it", () => {
  const dir = tmp();
  const lock = acquireRunLock(dir);
  expect(lock?.pid).toBe(process.pid);
  expect(existsSync(join(dir, "run.lock"))).toBe(true);
  expect(runLockStatus(dir)).toEqual({ pid: process.pid, self: true });
  if (lock) releaseRunLock(lock);
  expect(existsSync(join(dir, "run.lock"))).toBe(false);
  expect(runLockStatus(dir)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("a stale (dead-pid) lock is reclaimed by acquire", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run.lock"), "999999999"); // a pid that cannot be alive
  expect(runLockStatus(dir)).toBeNull(); // dead → stale → null
  const lock = acquireRunLock(dir); // reclaims the stale lock
  expect(lock?.pid).toBe(process.pid);
  rmSync(dir, { recursive: true, force: true });
});

test("acquire returns null when a LIVE lock is held by a different pid", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run.lock"), String(process.ppid)); // parent pid: alive, not us
  expect(acquireRunLock(dir)).toBeNull();
  expect(runLockStatus(dir)?.self).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
