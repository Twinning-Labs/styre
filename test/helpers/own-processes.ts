import { FFIType, dlopen } from "bun:ffi";
// Cleanup that touches only processes a test started itself (R28, and the operator's decision after
// the 2026-10-07 incident, when a weakened check let a test claim pid 1 and kill launchd's tree).
//
// A process is CLAIMED only by structure, judged in one read of the process table:
//   1. it descends from this test process: its ppid chain, walked in that same read, reaches
//      process.pid; or
//      Each parent on the way must have started no later than its child (a parent younger than
//      its child is a pid handed out again while the table was being read).
//   2. it sits in a process group this test created: `registerGroup` takes a group only when its
//      leader is this test process's own child (ppid === process.pid) and leads both its group
//      and its session (pgid === sid === pid: a `detached` spawn), and never this test's own group
//      or the group of any of its ancestors. Nothing outside that new session can join the group,
//      and the member must have started no earlier than the leader. A registered group is dropped
//      once a read shows it has no member left, or its id held by a process other than its
//      leader, so an id handed out again later is never taken for it.
// pid 1, this process and its ancestors are refused whatever the rules say (an extra layer).
// Each claim records pid AND start time. Only recorded processes are ever signalled, each one
// checked again just before its signal (same pid, same start time, not an ancestor). Nothing here
// finds a process by its command text (test/lifecycle/test-process-guard.test.ts refuses that).
import { readFileSync } from "node:fs";
import type { LaunchHandle } from "../../src/util/process/door.ts";
import {
  type ProcInfo,
  listProcesses,
  probe,
  sameProcess,
  tokenValue,
} from "../../src/util/process/proc-table.ts";
import { collectTree, groupMembers } from "../../src/util/process/stop.ts";

export interface Ident {
  pid: number;
  startedAt: string;
}

const key = (p: Ident): string => `${p.pid}:${p.startedAt}`;
/** Every process claimed and not yet cleaned up, across the test files of one run. */
const owned = new Map<string, Ident>();
/** Every process ever claimed in this run, cleaned up or not: the end of run leak check reads it
 *  (`stillRunning` and `stopStillRunning`, called from test/preload.ts). */
const claimed = new Map<string, Ident>();
/** The groups this test created, by group id, with their leader as it was when registered. */
const groups = new Map<number, Ident>();

/** This process's ancestors in one read: parent, its parent, and so on, up to pid 1. */
function ancestorsOf(table: ProcInfo[]): Set<number> {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const out = new Set<number>([1]);
  let p = byPid.get(process.pid);
  while (p !== undefined && p.ppid > 0 && !out.has(p.ppid)) {
    out.add(p.ppid);
    p = byPid.get(p.ppid);
  }
  return out;
}

/** Rule 1: the ppid chain of `pid`, walked in `table`, reaches this test process, and every parent
 *  on it (this process included) started no later than its child. */
function descends(pid: number, table: ProcInfo[]): boolean {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  let p = byPid.get(pid);
  while (p !== undefined && !seen.has(p.pid)) {
    if (p.ppid <= 1) return false;
    const parent = byPid.get(p.ppid);
    if (parent === undefined || tokenValue(parent.startedAt) > tokenValue(p.startedAt))
      return false;
    if (parent.pid === process.pid) return true;
    seen.add(p.pid);
    p = parent;
  }
  return false;
}

/** Drop every registered group that `table` shows with no member left, or whose id is held by a
 *  process other than its recorded leader: its id may be handed out again. */
function pruneGroups(table: ProcInfo[]): void {
  for (const [pgid, leader] of groups) {
    const members = table.some((q) => q.pgid === pgid && q.state !== "zombie");
    const holder = table.find((q) => q.pid === pgid);
    if (!members || (holder !== undefined && !sameProcess(leader, holder))) groups.delete(pgid);
  }
}

/** The session id of `pid` (Linux: /proc stat field 6; macOS: getsid), or null when unreadable. */
let getsid: ((pid: number) => number) | null = null;
function sessionOf(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      return Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[3]);
    }
    if (getsid === null) {
      const lib = dlopen("libSystem.B.dylib", {
        getsid: { args: [FFIType.i32], returns: FFIType.i32 },
      });
      getsid = (p) => lib.symbols.getsid(p) as number;
    }
    const sid = getsid(pid);
    return sid > 0 ? sid : null;
  } catch {
    return null;
  }
}

/** Rule 2: `p` sits in a group this test registered, and started no earlier than its leader. */
function inOwnGroup(p: ProcInfo, table: ProcInfo[]): boolean {
  const leader = groups.get(p.pgid);
  if (leader === undefined) return false;
  const self = table.find((q) => q.pid === process.pid);
  if (self === undefined || p.pgid === self.pgid) return false;
  const ancestors = ancestorsOf(table);
  if (table.some((q) => ancestors.has(q.pid) && q.pgid === p.pgid)) return false;
  return tokenValue(p.startedAt) >= tokenValue(leader.startedAt);
}

/** Whether `p`, as `table` shows it, may be claimed: the same process, alive, never pid 1, this
 *  process or an ancestor, and passing rule 1 or rule 2. */
function claimable(p: Ident, table: ProcInfo[]): ProcInfo | null {
  if (!Number.isInteger(p.pid) || p.pid <= 1 || p.pid === process.pid) return null;
  if (ancestorsOf(table).has(p.pid)) return null;
  const now = table.find((q) => q.pid === p.pid);
  if (now === undefined || !sameProcess(p, now) || now.state === "zombie") return null;
  return descends(now.pid, table) || inOwnGroup(now, table) ? now : null;
}

function record(p: ProcInfo): void {
  const id = { pid: p.pid, startedAt: p.startedAt };
  owned.set(key(p), id);
  claimed.set(key(p), id);
}

/**
 * Claim processes the test started, so `killOwned` stops them. Each is taken only if it passes
 * rule 1 or rule 2 in one fresh read of the table (`table` when given); the rest are refused.
 * Returns the ones taken.
 */
export function own<T extends Ident>(...ps: T[]): ProcInfo[] {
  return claimAll(ps, listProcesses());
}

function claimAll(ps: Ident[], table: ProcInfo[]): ProcInfo[] {
  pruneGroups(table);
  const taken: ProcInfo[] = [];
  for (const p of ps) {
    const now = claimable(p, table);
    if (now === null) continue;
    record(now);
    taken.push(now);
  }
  return taken;
}

/**
 * Register a group this test created: `leader` must be, in a fresh read, this test process's own
 * child (the same process) and lead its group and its session (a `detached` spawn), and the group
 * must be neither this process's nor an ancestor's. Its members are then claimable by rule 2, even
 * once their parent has died. Returns whether it was registered.
 */
export function registerGroup(leader: Ident): boolean {
  const table = listProcesses();
  pruneGroups(table);
  const now = table.find((q) => q.pid === leader.pid);
  if (now === undefined || !sameProcess(leader, now) || now.state === "zombie") return false;
  if (now.pid <= 1 || now.ppid !== process.pid || now.pgid !== now.pid) return false;
  if (sessionOf(now.pid) !== now.pid) return false; // a group made by setpgid alone can be joined
  const self = table.find((q) => q.pid === process.pid);
  if (self === undefined || now.pgid === self.pgid) return false;
  const ancestors = ancestorsOf(table);
  if (ancestors.has(now.pgid) || table.some((q) => ancestors.has(q.pid) && q.pgid === now.pgid))
    return false;
  groups.set(now.pgid, { pid: now.pid, startedAt: now.startedAt });
  return true;
}

/** Whether `p` would be claimed against `table` (the rules alone, nothing recorded or pruned): for
 *  tests that check the rules on a table they build themselves. */
export function wouldClaim(p: Ident, table: ProcInfo[]): boolean {
  return claimable(p, table) !== null;
}

/** The group ids registered now (read only). */
export function registeredGroups(): number[] {
  return [...groups.keys()];
}

/** Test seam for the rule 2 start time check on a built table: register a group WITHOUT the
 *  registration checks. Only test/lifecycle/own-processes.test.ts may use it (the guard checks). */
export function __registerGroupForTests(pgid: number, leader: Ident): () => void {
  groups.set(pgid, { pid: leader.pid, startedAt: leader.startedAt });
  return () => groups.delete(pgid);
}

/** Test seam: snapshot what is recorded now, the registered groups included; the returned function
 *  puts it back, dropping everything recorded or registered since. Refusal tests call it in a
 *  `finally`, so whatever a regression let them claim (a candidate, or the tree `ownTree` found
 *  under it) or register (a group whose members a later cleanup would claim) is never signalled.
 *  Only test/lifecycle/own-processes.test.ts may use it (the guard checks). */
export function __snapshotForTests(): () => void {
  const o = new Map(owned);
  const c = new Map(claimed);
  const g = new Map(groups);
  return () => {
    owned.clear();
    claimed.clear();
    groups.clear();
    for (const [k, v] of o) owned.set(k, v);
    for (const [k, v] of c) claimed.set(k, v);
    for (const [k, v] of g) groups.set(k, v);
  };
}

/** Test seam for the kill time check alone: record an identity WITHOUT the claim rules, as a
 *  recorded process whose pid has since been handed to another process would look. Only
 *  test/lifecycle/own-processes.test.ts may use it (the guard checks). */
export function __recordForTests(p: Ident): void {
  const id = { pid: p.pid, startedAt: p.startedAt };
  owned.set(key(id), id);
  claimed.set(key(id), id);
}

/** Test seam: drop a claimed process from the set still to clean up, keeping it in the run's record,
 *  as `killOwned` leaves each process it signals. Only test/lifecycle/own-processes.test.ts may use
 *  it (the guard checks). */
export function __releaseForTests(p: Ident): void {
  owned.delete(key(p));
}

/** Drop a process from every record: a test that handed the helper something it must refuse
 *  forgets it in a `finally`, so a regression fails that test without a signal being sent. */
export function forget(p: Ident): void {
  owned.delete(key(p));
  claimed.delete(key(p));
}

/** This test process's own group: never expanded by a tree collection. */
function selfPgid(table: ProcInfo[]): number | undefined {
  return table.find((p) => p.pid === process.pid)?.pgid;
}

/**
 * The root and what `collectTree` says belongs to it in one read (its descendants, and the members
 * of groups they lead), each claimed only if it passes rule 1 or rule 2 in that same read: a root
 * that is not the same process, or not claimable, gives nothing. Returns what was claimed.
 */
export function ownTree(root: Ident, table: ProcInfo[] = listProcesses()): ProcInfo[] {
  if (claimable(root, table) === null) return [];
  const self = selfPgid(table);
  return claimAll(collectTree(root, table, self === undefined ? [] : [self]), table);
}

/**
 * What a launch the test made still has running: for an agent, its tree; for a command group, its
 * group is registered (while its leader is still this test's child) and its tree and members are
 * claimed by the rules. Members of a group whose leader died before it was registered are not
 * claimable: the door's own stop is what ends those.
 */
export function ownLaunch(h: LaunchHandle, table: ProcInfo[] = listProcesses()): ProcInfo[] {
  const root = { pid: h.record.pid, startedAt: h.record.startedAt };
  if (h.record.kind === "group") registerGroup(root);
  const tree = ownTree(root, table);
  if (h.record.kind !== "group" || !groups.has(root.pid)) return tree;
  const members = claimAll(groupMembers(root.pid, table), table);
  return [...tree, ...members.filter((m) => !tree.some((t) => sameProcess(t, m)))];
}

/**
 * Claim a process whose pid a test only read from a fixture's output (`tool <pid>`, a pid file).
 * Rule 1 or rule 2 decides; it must also have started no earlier than `since` (a `nowToken()` read
 * before the fixture started) and, when given, sit in group `pgid`. Returns null when refused.
 */
export function ownPrinted(
  pid: number,
  since: string,
  opts: { pgid?: number } = {},
): ProcInfo | null {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  const p = probe(pid);
  if (p.kind !== "alive" || p.info.state === "zombie") return null;
  if (tokenValue(p.info.startedAt) < tokenValue(since)) return null;
  if (opts.pgid !== undefined && p.info.pgid !== opts.pgid) return null;
  return claimAll([p.info], listProcesses())[0] ?? null;
}

/**
 * Claim a process the test has just spawned itself (`Bun.spawn`), at once, while it is certainly
 * this test's child: rule 1 decides, in one fresh read. With `group` (a `detached` spawn), its group
 * is registered first, so what it leaves in that group stays claimable by rule 2 after it exits
 * (`ownGroupMembers`). Returns null when refused, or when it is already gone.
 */
export function ownChild(p: { pid: number }, opts: { group?: boolean } = {}): ProcInfo | null {
  if (!Number.isInteger(p.pid) || p.pid <= 1 || p.pid === process.pid) return null;
  const now = probe(p.pid);
  if (now.kind !== "alive" || now.info.state === "zombie") return null;
  if (opts.group) registerGroup(now.info);
  return claimAll([now.info], listProcesses())[0] ?? null;
}

/**
 * Claim every live member of every group this test registered (rule 2 decides each, in one read):
 * what a command left in its group after its leader exited, which no tree walk reaches any more.
 * Cleanups call it before `killOwned`, and the end of run leak check before it looks. Returns
 * what was claimed.
 */
export function ownGroupMembers(table: ProcInfo[] = listProcesses()): ProcInfo[] {
  pruneGroups(table);
  return claimAll(
    [...groups.keys()].flatMap((g) => groupMembers(g, table)),
    table,
  );
}

/** The pid in a fixture's `tool <pid>` line, or NaN. */
export function toolPid(text: string): number {
  const m = /tool (\d+)/.exec(text);
  return m ? Number(m[1]) : Number.NaN;
}

/** The command line of one process the test knows by pid and start time, or null once it is gone.
 *  Read with `ps -p`, for that pid only. */
export function commandOf(p: Ident): string | null {
  if (!isAlive(p)) return null;
  const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(p.pid)], {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 5_000,
  });
  const text = r.stdout.toString().trim();
  // Read again after ps: the pid must still be the same process the text was read for.
  return text !== "" && isAlive(p) ? text : null;
}

/** True while the process table shows this very process (same pid and start time), not a zombie. */
export function isAlive(p: Ident): boolean {
  const now = probe(p.pid);
  return now.kind === "alive" && sameProcess(p, now.info) && now.info.state !== "zombie";
}

/** A bounded poll, never a fixed sleep. */
export async function until(fn: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await Bun.sleep(20);
  }
  return fn();
}

/** Wait (bounded) until none of `ps` is alive. */
export function allGone(ps: Ident[], ms = 5_000): Promise<boolean> {
  return until(() => ps.every((p) => !isAlive(p)), ms);
}

/** Signal one recorded process (SIGKILL unless told otherwise), checked again just before the
 *  signal: the same pid and start time, alive, and never pid 1, this process or an ancestor of it.
 *  Returns whether it was signalled. */
function killRecorded(p: Ident, ancestors: Set<number>, sig: NodeJS.Signals = "SIGKILL"): boolean {
  if (!Number.isInteger(p.pid) || p.pid <= 1 || p.pid === process.pid || ancestors.has(p.pid))
    return false;
  if (!isAlive(p)) return false;
  try {
    process.kill(p.pid, sig);
    return true;
  } catch {
    return false; // it ended meanwhile
  }
}

/**
 * Send `sig` to one process the test has claimed and not yet cleaned up (a test's own stop request,
 * such as `kill -TERM` of a driver), checked again just before the signal as `killOwned` checks.
 * Anything not claimed is refused. The process stays claimed, so `killOwned` still ends it if the
 * signal did not. Returns whether it was signalled.
 */
export function signalOwned(p: Ident, sig: NodeJS.Signals): boolean {
  if (!owned.has(key(p))) return false;
  return killRecorded(p, ancestorsOf(listProcesses()), sig);
}

/**
 * Stop every claimed process. First, in one read, what `collectTree` finds under them that passes
 * rule 1 or rule 2 is claimed too (what a process the test started has started); then each recorded
 * process is signalled by pid after its own check (`killRecorded`), and all are forgotten. No
 * pattern and no group id are ever signalled. Returns how many were signalled.
 */
export function killOwned(): number {
  if (owned.size === 0) return 0;
  const table = listProcesses();
  const self = selfPgid(table);
  for (const p of [...owned.values()]) {
    if (!table.some((q) => sameProcess(p, q))) continue;
    claimAll(collectTree(p, table, self === undefined ? [] : [self]), table);
  }
  const ancestors = ancestorsOf(table);
  const doomed = [...owned.values()];
  owned.clear();
  let n = 0;
  for (const p of doomed) if (killRecorded(p, ancestors)) n++;
  return n;
}

/**
 * Every process claimed during the run that is still the same process and alive, after a bounded
 * wait for any that are just ending, each named by pid and command. A test that cleaned up leaves
 * none: a cleanup removed or broken does.
 */
export async function stillRunning(ms = 3_000): Promise<(Ident & { command: string })[]> {
  let left: Ident[] = [];
  await until(() => {
    left = [...claimed.values()].filter((p) => p.pid !== process.pid && isAlive(p));
    return left.length === 0;
  }, ms);
  return left.map((p) => ({ ...p, command: commandOf(p) ?? "(it ended meanwhile)" }));
}

/** Stop the claimed processes `stillRunning` named: recorded identities only, each checked again
 *  just before its signal. */
export function stopStillRunning(left: Ident[]): number {
  const ancestors = ancestorsOf(listProcesses());
  let n = 0;
  for (const p of left) if (claimed.has(key(p)) && killRecorded(p, ancestors)) n++;
  return n;
}
