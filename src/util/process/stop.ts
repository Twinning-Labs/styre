import { type ProcInfo, listProcesses } from "./proc-table.ts";

/**
 * Stop functions (ENG-485 section 6). "Gone" is always read from the process table, including its
 * state field: a zombie counts as gone, and kill(pid, 0) is never used because it succeeds on a
 * zombie (spec 2.5).
 */
export interface StopReport {
  stopped: ProcInfo[];
  survivors: ProcInfo[];
}
export interface StopDeps {
  list: () => ProcInfo[];
  kill: (target: number, sig: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Sends a signal; a process or group that is already gone (ESRCH) is not an error. */
export const realStopDeps: StopDeps = {
  list: listProcesses,
  kill: (target, sig) => {
    try {
      process.kill(target, sig);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  },
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};

const POLL_MS = 50;
/** How long to keep checking, after SIGKILL, for the last process to leave the table. */
const CONFIRM_MS = 500;

const key = (p: { pid: number; startedAt: string }) => `${p.pid}:${p.startedAt}`;

/** Live members of one group, read from `table`. Zombies are excluded: they are gone. */
export function groupMembers(pgid: number, table: ProcInfo[]): ProcInfo[] {
  return table.filter((p) => p.pgid === pgid && p.state !== "zombie");
}

/**
 * Grow `seen` from one table listing (spec 6.1). A process joins when it is
 *   - the root itself (same pid and start time), or
 *   - a child of a collected process, or
 *   - a member of a group LED by a collected process (the group id is the leader's pid). The leader
 *     may have exited since: then no process holds that pid, and the remembered pid stands for it.
 * Groups in `exclude` (Styre's own, the owner's) are never expanded. Every link is checked by pid AND
 * start time, so a different process that reuses a collected pid is not mistaken for it. The
 * collection only grows. This is the only place the rule lives; stopTree and collectTree share it.
 */
function grow(
  root: { pid: number; startedAt: string },
  table: ProcInfo[],
  seen: Map<string, ProcInfo>,
  exclude: ReadonlySet<number>,
): void {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const rootNow = byPid.get(root.pid);
  if (rootNow && rootNow.startedAt === root.startedAt) seen.set(key(rootNow), rootNow);
  const seenPids = new Set([...seen.values()].map((p) => p.pid));

  const linked = (p: ProcInfo): boolean => {
    const parent = byPid.get(p.ppid);
    if (parent !== undefined && seen.has(key(parent))) return true;
    if (exclude.has(p.pgid)) return false;
    const leader = byPid.get(p.pgid);
    return leader !== undefined ? seen.has(key(leader)) : seenPids.has(p.pgid);
  };

  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table) {
      if (seen.has(key(p)) || !linked(p)) continue;
      seen.set(key(p), p);
      seenPids.add(p.pid);
      grew = true;
    }
  }
}

/**
 * Everything one listing says belongs to the root: the root, its descendants, and the members of
 * groups led by a collected process, never expanding the groups in `excludePgids`. Zombies are
 * included; callers decide liveness. Reads only the table it is given.
 */
export function collectTree(
  root: { pid: number; startedAt: string },
  table: ProcInfo[],
  excludePgids: number[],
): ProcInfo[] {
  const seen = new Map<string, ProcInfo>();
  grow(root, table, seen, new Set(excludePgids));
  return [...seen.values()];
}

/** The collected processes that are still in `table` with the same start time and not zombies. */
function stillAlive(seen: Map<string, ProcInfo>, table: ProcInfo[]): ProcInfo[] {
  const now = new Map(table.map((p) => [key(p), p]));
  return [...seen.values()].filter((p) => {
    const n = now.get(key(p));
    return n !== undefined && n.state !== "zombie";
  });
}

/**
 * Stop an agent and everything it started (spec 6.1). The agent stays in Styre's own group, so
 * signals go to individual processes by pid, never to a group. `graceful` sends SIGTERM to every
 * collected process at once, waits up to `graceMs` (polling with `await`), then escalates; `forced`
 * goes straight to SIGKILL. `abort.forced`, set by a second signal, ends the wait early.
 */
export async function stopTree(
  root: { pid: number; startedAt: string },
  how: "graceful" | "forced",
  opts: {
    graceMs: number;
    excludePgids: number[];
    deps?: StopDeps;
    abort?: { forced: boolean };
  },
): Promise<StopReport> {
  const d = opts.deps ?? realStopDeps;
  const exclude = new Set(opts.excludePgids);
  const seen = new Map<string, ProcInfo>();
  const stoppedAndSurvivors = (table: ProcInfo[]): StopReport => {
    const survivors = stillAlive(seen, table);
    const left = new Set(survivors.map(key));
    return { stopped: [...seen.values()].filter((p) => !left.has(key(p))), survivors };
  };

  grow(root, d.list(), seen, exclude);
  if (how === "graceful") {
    for (const p of stillAlive(seen, d.list())) d.kill(p.pid, "SIGTERM");
    const deadline = d.now() + opts.graceMs;
    while (d.now() < deadline && !opts.abort?.forced) {
      const table = d.list();
      grow(root, table, seen, exclude);
      if (stillAlive(seen, table).length === 0) return stoppedAndSurvivors(table);
      await d.sleep(POLL_MS);
    }
  }

  // Escalate. List again first: anything new joins the collection, and every collected process that
  // is still alive with the same start time gets SIGKILL whether or not it is still linked.
  const table = d.list();
  grow(root, table, seen, exclude);
  for (const p of stillAlive(seen, table)) d.kill(p.pid, "SIGKILL");

  const confirmBy = d.now() + CONFIRM_MS;
  let after = d.list();
  while (stillAlive(seen, after).length > 0 && d.now() < confirmBy) {
    await d.sleep(POLL_MS);
    after = d.list();
  }
  return stoppedAndSurvivors(after);
}

/**
 * Stop a command's own group (spec 6.2). If the table shows the group already empty, nothing is
 * signalled and nothing is waited for. Otherwise SIGTERM to the group, a wait of up to `graceMs`,
 * SIGKILL to the group, and a check that the group is empty. `forced` skips the SIGTERM and the wait.
 */
export async function stopGroup(
  pgid: number,
  how: "graceful" | "forced",
  opts: { graceMs: number; deps?: StopDeps; abort?: { forced: boolean } },
): Promise<StopReport> {
  const d = opts.deps ?? realStopDeps;
  const first = groupMembers(pgid, d.list());
  if (first.length === 0) return { stopped: [], survivors: [] };
  const seen = new Map(first.map((p) => [key(p), p]));
  const report = (survivors: ProcInfo[]): StopReport => {
    const left = new Set(survivors.map(key));
    return { stopped: [...seen.values()].filter((p) => !left.has(key(p))), survivors };
  };

  if (how === "graceful") {
    d.kill(-pgid, "SIGTERM");
    const deadline = d.now() + opts.graceMs;
    while (d.now() < deadline && !opts.abort?.forced) {
      const members = groupMembers(pgid, d.list());
      if (members.length === 0) return report([]);
      for (const p of members) seen.set(key(p), p);
      await d.sleep(POLL_MS);
    }
  }

  const before = groupMembers(pgid, d.list());
  if (before.length === 0) return report([]); // it emptied after the last poll: nothing to kill
  for (const p of before) seen.set(key(p), p);
  d.kill(-pgid, "SIGKILL");

  const confirmBy = d.now() + CONFIRM_MS;
  let survivors = groupMembers(pgid, d.list());
  while (survivors.length > 0 && d.now() < confirmBy) {
    await d.sleep(POLL_MS);
    survivors = groupMembers(pgid, d.list());
  }
  return report(survivors);
}
