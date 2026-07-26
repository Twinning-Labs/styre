import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RunLock = { dir: string; pid: number };

/** True iff `pid` is a live process (mirrors recover.ts's liveness probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The lock's live owner, or null when the lock is absent OR its pid is dead/malformed (stale). */
export function runLockStatus(dir: string): { pid: number; self: boolean } | null {
  const file = join(dir, "run.lock");
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || !isAlive(pid)) return null;
  return { pid, self: pid === process.pid };
}

/** Take the per-ticket run lock in `dir` via an atomic O_EXCL create. On collision: reclaim a stale
 *  (dead-pid) lock and retry; return null when a LIVE lock is held by another process. */
export function acquireRunLock(dir: string): RunLock | null {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "run.lock");
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" }); // O_EXCL — fails if it already exists
      return { dir, pid: process.pid };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isInteger(pid) && isAlive(pid)) return null; // a live owner → the ticket is locked
      rmSync(file, { force: true }); // stale (dead/malformed) → reclaim and retry the exclusive create
    }
  }
}

/** Release the lock iff it still holds our pid (never clobbers another process's lock). */
export function releaseRunLock(lock: RunLock): void {
  const file = join(lock.dir, "run.lock");
  if (!existsSync(file)) return;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  if (pid === lock.pid) rmSync(file, { force: true });
}
