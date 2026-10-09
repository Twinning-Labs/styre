// Fixtures for the leftover check tests: real detached `sleep` processes carrying a unique marker
// (the sleep's duration), so a check's report can be matched to the fixture. Each one is claimed by
// structure while it is still this test's descendant (test/helpers/own-processes.ts), with its pid
// and start time, and removed by that identity, even when a test fails: never by searching for the
// marker (R28).
import { expect } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaunchHandle } from "../../src/util/process/door.ts";
import { listProcesses, nowToken, probe, tokenValue } from "../../src/util/process/proc-table.ts";
import { collectTree, groupMembers } from "../../src/util/process/stop.ts";
import {
  type Ident,
  commandOf,
  killOwned,
  own,
  ownPrinted,
  registerGroup,
  until,
} from "./own-processes.ts";
import { makeTempDir } from "./temp.ts";

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
  const d = makeTempDir(prefix);
  roots.push(d);
  return d;
}

/** The process carrying marker `m` is the one with this pid and start time: claimed (by the
 *  helper's rules) and remembered for `isRunning`. */
export function claim(m: string, p: Ident): void {
  const [taken] = own(p);
  expect(taken, `the process for marker ${m} (pid ${p.pid}) could not be claimed`).toBeDefined();
  carriers.set(m, { pid: p.pid, startedAt: p.startedAt });
}

/**
 * A file that lets a fixture shell go on: the shell prints what the test must claim, then waits
 * for this file, so what it started is still its descendant (and so the test's) when claimed.
 */
export function goFile(): { path: string; go: () => void } {
  const path = join(folder("styre-go-"), "go");
  return { path, go: () => writeFileSync(path, "") };
}

/** Claim a launch whose own process is `sleep <m>`. */
export function claimLaunch(m: string, h: LaunchHandle): LaunchHandle {
  claim(m, { pid: h.record.pid, startedAt: h.record.startedAt });
  return h;
}

/**
 * Claim the process carrying marker `m` from a pid a fixture printed on `stream`, alone on its first
 * line, started no earlier than `since`. The pid is claimed as soon as that line is there (waiting
 * at most `ms`), not at the end of the output: a fixture whose background child keeps the pipe open
 * would otherwise be waited for until the test times out, and never claimed. The rest of the stream
 * is let go.
 */
export async function claimPrinted(
  m: string,
  stream: ReadableStream<Uint8Array>,
  since: string,
  ms = 5_000,
): Promise<Ident | null> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  try {
    while (!text.includes("\n")) {
      const r = await Promise.race([reader.read(), timeout]);
      if (r === "timeout" || r.done) break;
      text += dec.decode(r.value);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  const line = text.split("\n")[0]?.trim() ?? "";
  const p = ownPrinted(Number(line), since);
  expect(
    p,
    `the fixture for marker ${m} printed "${line}", not the pid of a live process`,
  ).not.toBe(null);
  if (p) claim(m, p);
  return p;
}

/**
 * Starts `nohup sleep <m>` in `dir`, in a session and group of its own, the way an agent's
 * `nohup server &` would look to the leftover check. It is this test's own child, so it is claimed
 * by descent, and its group is registered as one the test made. (A shell that backgrounds it and
 * exits would orphan it before it could be claimed.)
 */
export async function leave(dir: string, m: string): Promise<void> {
  // Bun.spawn with ignored stdio, not spawnSync: under `bun test` a spawnSync that leaves a
  // background process behind stalls the runner until the test times out.
  const p = Bun.spawn(["nohup", "sleep", m], {
    cwd: dir,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  p.unref(); // it must not keep the test run alive
  const now = probe(p.pid);
  expect(now.kind, `the fixture for marker ${m} is not in the table`).toBe("alive");
  if (now.kind !== "alive") return;
  expect(registerGroup(now.info)).toBe(true);
  claim(m, now.info);
  // Until it has become `sleep`, the process is nohup: wait for the real thing.
  expect(await until(() => isRunning(m))).toBe(true);
}

/** True while the process claimed for `m` is alive and is `sleep <m>`. */
export function isRunning(m: string): boolean {
  const p = carriers.get(m);
  if (p === undefined) throw new Error(`no process was claimed for marker ${m}`);
  return commandOf(p) === `sleep ${m}`;
}

/** True when a process of launch `h` (its tree, or a member of its group) is `sleep <m>`. It only
 *  looks: nothing is claimed (the launch's own stop ends what it started). */
export function runsIn(h: LaunchHandle, m: string): boolean {
  const table = listProcesses();
  const root = { pid: h.record.pid, startedAt: h.record.startedAt };
  const seen = [
    ...collectTree(root, table, []),
    ...(h.record.kind === "group" ? groupMembers(h.record.pid, table) : []),
  ];
  return seen.some((p) => commandOf(p) === `sleep ${m}`);
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
