// Fixtures for the leftover check tests: real detached `sleep` processes carrying a unique marker
// (the sleep's duration), so a check's report can be matched to the fixture. Each one is known by
// pid and start time from the moment it starts (its pid is printed or it is a launch's own), and
// it is removed by that identity, even when a test fails: never by searching for the marker (R28).
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchHandle } from "../../src/util/process/door.ts";
import { nowToken, tokenValue } from "../../src/util/process/proc-table.ts";
import {
  type Ident,
  commandOf,
  killOwned,
  own,
  ownLaunch,
  ownPrinted,
  until,
} from "./own-processes.ts";

export { until };

const roots: string[] = [];
/** The process carrying each marker, once the test knows it. */
const carriers = new Map<string, Ident>();
let seq = 0;

/** A sleep duration no other process uses; the fraction is the marker. */
export function marker(): string {
  return `61.${String(process.pid).padStart(7, "0")}${String(seq++).padStart(3, "0")}`;
}

export function folder(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** The process carrying marker `m` is the one with this pid and start time. */
export function claim(m: string, p: Ident): void {
  own(p);
  carriers.set(m, { pid: p.pid, startedAt: p.startedAt });
}

/** Claim a launch whose own process is `sleep <m>`. */
export function claimLaunch(m: string, h: LaunchHandle): LaunchHandle {
  claim(m, { pid: h.record.pid, startedAt: h.record.startedAt });
  return h;
}

/**
 * Claim the process carrying marker `m` from a pid a fixture printed on `stream` (its whole text is
 * the pid), started no earlier than `since`.
 */
export async function claimPrinted(
  m: string,
  stream: ReadableStream<Uint8Array>,
  since: string,
): Promise<void> {
  const text = (await new Response(stream).text()).trim();
  const p = ownPrinted(Number(text), since);
  expect(
    p,
    `the fixture for marker ${m} printed "${text}", not the pid of a live process`,
  ).not.toBe(null);
  if (p) claim(m, p);
}

/** Starts `nohup sleep <m>` detached in `dir`, the way an agent's `nohup server &` would. */
export async function leave(dir: string, m: string): Promise<void> {
  const since = nowToken();
  // Bun.spawn with ignored stdio, not spawnSync: under `bun test` a spawnSync that leaves a
  // background process behind stalls the runner until the test times out. The shell prints the
  // background process's pid; nohup and then sleep replace that process, so the pid stays. (With
  // `cd && nohup … &` the whole list would run in a subshell that waits for nohup while holding the
  // output pipe, and `$!` would be that subshell.)
  const sh = 'cd "$1" || exit 1; nohup sleep "$2" >/dev/null 2>&1 & echo $!';
  const p = Bun.spawn(["sh", "-c", sh, "sh", dir, m], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  await claimPrinted(m, p.stdout, since);
  await p.exited;
  // Until it has become `sleep`, the process is nohup (or the forked shell): wait for the real thing.
  expect(await until(() => isRunning(m))).toBe(true);
}

/** True while the process claimed for `m` is alive and is `sleep <m>`. */
export function isRunning(m: string): boolean {
  const p = carriers.get(m);
  if (p === undefined) throw new Error(`no process was claimed for marker ${m}`);
  return commandOf(p) === `sleep ${m}`;
}

/** True when a process of launch `h` (its tree, or a member of its group) is `sleep <m>`. */
export function runsIn(h: LaunchHandle, m: string): boolean {
  return ownLaunch(h).some((p) => commandOf(p) === `sleep ${m}`);
}

/** Remove every fixture process and folder made so far. Call from afterEach. */
export function cleanupFixtures(): void {
  killOwned();
  carriers.clear();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/** Wait until the clock has moved past `token`, so a later `nowToken()` is strictly after it. */
export async function pastToken(token: string): Promise<void> {
  expect(await until(() => tokenValue(nowToken()) > tokenValue(token), 3000)).toBe(true);
}
