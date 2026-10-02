import { type ProcInfo, listProcesses } from "./proc-table.ts";

/**
 * Stop functions (ENG-485 section 6). "Gone" is always read from the process table, including its
 * state field: a zombie counts as gone, and kill(pid, 0) is never used because it succeeds on a
 * zombie (spec 2.5).
 */
export interface StopReport {
  /** Everything the stop collected that is no longer alive, including processes that were already
   *  gone (or zombies) before any signal: use `signalled` to count what the stop itself ended. */
  stopped: ProcInfo[];
  survivors: ProcInfo[];
  /** The processes a signal was actually sent to without error (a group signal counts for the
   *  live members listed just before it). Zombies and processes already gone are never in it. A
   *  process that exits between the listing and the signal can still appear (ESRCH is not an
   *  error), a window of microseconds. */
  signalled: ProcInfo[];
  /** Why a survivor could not be signalled (for example EPERM), one entry per survivor that a
   *  signal failed for. Only processes still alive at the end appear: a refusal that did not
   *  matter, because the process exited anyway, is not a failure. */
  failures: { proc: ProcInfo; code: string }[];
}
export interface StopDeps {
  list: () => ProcInfo[];
  kill: (target: number, sig: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Sends a signal; a process or group that is already gone (ESRCH) is not an error. Any other error
 * is thrown here, and the stop functions below catch it per target and report it, so one refusal
 * never abandons a stop.
 */
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

const errCode = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
};

/** Styre's own group, read from the table; undefined if this process is not in it (simulated tables). */
const ownPgid = (table: ProcInfo[]): number | undefined =>
  table.find((p) => p.pid === process.pid)?.pgid;

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
 * Groups in `exclude` (Styre's own, the owner's) are never expanded, and the root's own group is
 * added to it here (the set is mutated). Every link is checked by pid AND
 * start time, so a different process that reuses a collected pid is not mistaken for it. The
 * collection only grows. This is the only place the rule lives; stopTree and collectTree share it.
 */
function grow(
  root: { pid: number; startedAt: string },
  table: ProcInfo[],
  seen: Map<string, ProcInfo>,
  exclude: Set<number>,
): void {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const rootNow = byPid.get(root.pid);
  if (rootNow && rootNow.startedAt === root.startedAt) {
    seen.set(key(rootNow), rootNow);
    // The group the root itself belongs to is never taken in, whatever the caller passed, and it
    // stays excluded after the root has left the table (the set is kept by the caller).
    exclude.add(rootNow.pgid);
  }
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
  const own = ownPgid(d.list());
  if (root.pid <= 1 || root.pid === process.pid || root.pid === own) {
    throw new Error(
      `stopTree: refusing root pid ${root.pid}: it is init, Styre, or Styre's own group leader`,
    );
  }
  const seen = new Map<string, ProcInfo>();
  const failed = new Map<string, string>();
  const signalled = new Map<string, ProcInfo>();
  const send = (p: ProcInfo, sig: NodeJS.Signals): void => {
    try {
      d.kill(p.pid, sig);
      signalled.set(key(p), p);
    } catch (err) {
      failed.set(key(p), errCode(err)); // keep signalling the others; the final listing decides
    }
  };
  const finish = (table: ProcInfo[]): StopReport => {
    const survivors = stillAlive(seen, table);
    const left = new Set(survivors.map(key));
    return {
      stopped: [...seen.values()].filter((p) => !left.has(key(p))),
      survivors,
      signalled: [...signalled.values()],
      failures: survivors.flatMap((p) => {
        const code = failed.get(key(p));
        return code === undefined ? [] : [{ proc: p, code }];
      }),
    };
  };

  grow(root, d.list(), seen, exclude);
  if (how === "graceful") {
    for (const p of stillAlive(seen, d.list())) send(p, "SIGTERM");
    const deadline = d.now() + opts.graceMs;
    while (d.now() < deadline && !opts.abort?.forced) {
      const table = d.list();
      grow(root, table, seen, exclude);
      if (stillAlive(seen, table).length === 0) return finish(table);
      await d.sleep(POLL_MS);
    }
  }

  // Escalate. List again first: anything new joins the collection, and every collected process that
  // is still alive with the same start time gets SIGKILL whether or not it is still linked.
  const table = d.list();
  grow(root, table, seen, exclude);
  for (const p of stillAlive(seen, table)) send(p, "SIGKILL");

  const confirmBy = d.now() + CONFIRM_MS;
  let after = d.list();
  while (stillAlive(seen, after).length > 0 && d.now() < confirmBy) {
    await d.sleep(POLL_MS);
    after = d.list();
  }
  return finish(after);
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
  // kill(-1) reaches every process the user owns and kill(-0) the caller's own group: a caller bug
  // must be loud, never a mass signal.
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(`stopGroup: refusing pgid ${pgid}: a group id must be greater than 1`);
  }
  const d = opts.deps ?? realStopDeps;
  const firstTable = d.list();
  if (pgid === ownPgid(firstTable)) {
    throw new Error(`stopGroup: refusing pgid ${pgid}: it is Styre's own group`);
  }
  const first = groupMembers(pgid, firstTable);
  if (first.length === 0) return { stopped: [], survivors: [], signalled: [], failures: [] };
  const seen = new Map(first.map((p) => [key(p), p]));
  const signalled = new Map<string, ProcInfo>();

  // A refused or failed group signal is recorded, not thrown. On macOS a group that holds only
  // zombies answers EPERM, and a group that emptied during the stop answers ESRCH or EPERM; the
  // listings below decide whether anything is really left, so a group that died is simply gone.
  let lastError: string | undefined;
  const send = (sig: NodeJS.Signals, members: ProcInfo[]): void => {
    try {
      d.kill(-pgid, sig);
      lastError = undefined;
      for (const p of members) signalled.set(key(p), p);
    } catch (err) {
      lastError = errCode(err);
    }
  };
  const report = (survivors: ProcInfo[]): StopReport => {
    const left = new Set(survivors.map(key));
    return {
      stopped: [...seen.values()].filter((p) => !left.has(key(p))),
      survivors,
      signalled: [...signalled.values()],
      failures:
        lastError === undefined
          ? []
          : survivors.map((proc) => ({ proc, code: lastError as string })),
    };
  };

  if (how === "graceful") {
    send("SIGTERM", first);
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
  send("SIGKILL", before);

  const confirmBy = d.now() + CONFIRM_MS;
  let survivors = groupMembers(pgid, d.list());
  while (survivors.length > 0 && d.now() < confirmBy) {
    await d.sleep(POLL_MS);
    survivors = groupMembers(pgid, d.list());
  }
  return report(survivors);
}
