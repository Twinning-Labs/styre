// Cleanup that touches only processes a test started itself (R28). A process is known by its pid AND
// its start time, read while it was certainly the test's own, and it is signalled only while the
// process table still shows that same process. Nothing here finds a process by its command text:
// matching by text across the machine kills a developer's own processes and those of a parallel
// test run (test/lifecycle/test-process-guard.test.ts refuses that in every test file).
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
/** Every process remembered and not yet cleaned up, across the test files of one run. */
const owned = new Map<string, Ident>();

/** Remember processes the test started, so `killOwned` stops them. Returns them unchanged. */
export function own<T extends Ident>(...ps: T[]): T[] {
  for (const p of ps) owned.set(key(p), { pid: p.pid, startedAt: p.startedAt });
  return ps;
}

/** This test process's own group: never expanded, never signalled. */
function selfPgid(table: ProcInfo[]): number | undefined {
  return table.find((p) => p.pid === process.pid)?.pgid;
}

/**
 * The root and everything `collectTree` says belongs to it in one listing (its descendants, and the
 * members of groups they lead), remembered. A root that is no longer in the table gives nothing.
 */
export function ownTree(root: Ident, table: ProcInfo[] = listProcesses()): ProcInfo[] {
  const self = selfPgid(table);
  const tree = collectTree(root, table, self === undefined ? [] : [self]).filter(
    (p) => p.pid !== process.pid,
  );
  own(...tree);
  return tree;
}

/**
 * What a launch the test made still has running: for an agent, its tree; for a command group, its
 * tree and every member of its group. The group's members count only while the leader is the
 * launch's own process or gone: a group id cannot be handed out again while any member is alive,
 * so members of a group whose leader has exited are still the launch's.
 */
export function ownLaunch(h: LaunchHandle, table: ProcInfo[] = listProcesses()): ProcInfo[] {
  const root = { pid: h.record.pid, startedAt: h.record.startedAt };
  const tree = ownTree(root, table);
  if (h.record.kind !== "group") return tree;
  const leader = table.find((p) => p.pid === root.pid);
  if (leader !== undefined && !sameProcess(root, leader)) return tree;
  if (root.pid <= 1 || root.pid === selfPgid(table)) return tree;
  const members = groupMembers(root.pid, table);
  own(...members);
  return [...tree, ...members.filter((m) => !tree.some((t) => sameProcess(t, m)))];
}

/**
 * Remember a process whose pid a test only read from a fixture's output (`tool <pid>`, a pid file).
 * It is taken only if it is alive now, started no earlier than `since` (a `nowToken()` read before
 * the fixture was started), and, when given, sits in the group `pgid`: the checks that tell a pid
 * handed out again to someone else's process apart from the fixture's. Returns null when the
 * process is not (or no longer) there.
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
  own(p.info);
  return p.info;
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

/**
 * SIGKILL every remembered process that the table still shows as the same process, and everything
 * `collectTree` finds under it in that same listing (what a process the test started has started
 * is the test's too), then forget them all. One listing is read before any kill, and every kill is
 * by pid: no pattern, no group id. Returns how many were signalled.
 */
export function killOwned(): number {
  if (owned.size === 0) return 0;
  const table = listProcesses();
  const self = selfPgid(table);
  const doomed = new Map<string, ProcInfo>();
  for (const p of owned.values()) {
    for (const q of collectTree(p, table, self === undefined ? [] : [self])) doomed.set(key(q), q);
  }
  owned.clear();
  let n = 0;
  for (const p of doomed.values()) {
    if (p.pid <= 1 || p.pid === process.pid || p.state === "zombie") continue;
    try {
      process.kill(p.pid, "SIGKILL");
      n++;
    } catch {
      /* it ended meanwhile */
    }
  }
  return n;
}
