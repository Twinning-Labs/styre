// Fixtures for the leftover check tests: real detached `sleep` processes carrying a unique marker,
// found and removed by that marker so a failing test never leaves one behind.
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowToken, tokenValue } from "../../src/util/process/proc-table.ts";

const markers: string[] = [];
const roots: string[] = [];
let seq = 0;

/** A sleep duration no other process uses; the fraction is the marker. */
export function marker(): string {
  const m = `61.${String(process.pid).padStart(7, "0")}${String(seq++).padStart(3, "0")}`;
  markers.push(m);
  return m;
}

export function folder(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** Starts `nohup sleep <m>` detached in `dir`, the way an agent's `nohup server &` would. */
export async function leave(dir: string, m: string): Promise<void> {
  // Bun.spawn with ignored stdio, not spawnSync: under `bun test` a spawnSync that leaves a
  // background process behind stalls the runner until the test times out.
  const sh = 'cd "$1" && nohup sleep "$2" >/dev/null 2>&1 &';
  const p = Bun.spawn(["sh", "-c", sh, "sh", dir, m], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await p.exited;
  // The forked shell is also in the folder until it becomes `sleep`; wait for the real thing.
  expect(await until(() => isRunning(m))).toBe(true);
}

/** Remove every fixture process and folder made so far. Call from afterEach. */
export function cleanupFixtures(): void {
  for (const m of markers.splice(0)) Bun.spawnSync(["pkill", "-9", "-f", `sleep ${m}`]);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export function isRunning(m: string): boolean {
  return Bun.spawnSync(["pgrep", "-f", `sleep ${m}`]).exitCode === 0;
}

/** A bounded poll, never a fixed sleep. */
export async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await Bun.sleep(20);
  }
  return fn();
}

/** Wait until the clock has moved past `token`, so a later `nowToken()` is strictly after it. */
export async function pastToken(token: string): Promise<void> {
  expect(await until(() => tokenValue(nowToken()) > tokenValue(token), 3000)).toBe(true);
}
