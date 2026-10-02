import { readlinkSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import {
  type LaunchHandle,
  RunInterrupted,
  describeProcess,
  launch,
  launchDiagnostic,
  liveLaunches,
  runBlocking,
} from "./door.ts";
import { type ProcInfo, listProcesses, nowToken, tokenValue } from "./proc-table.ts";
import { readPipe } from "./read-pipe.ts";
import { collectTree } from "./stop.ts";

/**
 * The detached leftover check (ENG-485 section 9). It finds processes whose working folder is inside
 * a worktree, that started during a step's window, and that are not part of anything Styre is
 * running. It REPORTS them. It never stops them: in place, the developer may have started one.
 */

/** The `lsof` bound of the check (section 9.1). */
export const LEFTOVER_TIMEOUT_MS = 5_000;
/** The bound of the one `lsof` that goes through `runBlocking` (a literal the source guard reads). */
const LSOF_BLOCKING_MS = 5_000;

export interface Leftover {
  pid: number;
  command: string;
  cwd: string;
}

/** The exact operator line of section 9.4, with its newline. */
export function formatLeftover(l: Leftover): string {
  return `styre: the agent left "${l.command}" (pid ${l.pid}) running in the worktree; stop it with: kill ${l.pid} (if it is not yours)\n`;
}

/** Said when a check could not finish, so a missing report is never read as a clean worktree. */
function skippedLine(why: string): string {
  return `styre: skipped the check for processes the agent left running in the worktree (${why})\n`;
}

type Cwds = Map<number, string> | "skipped";
interface ReadArgs {
  timeoutMs: number;
  /** The processes whose folder is wanted. Linux reads exactly these; `lsof` lists them all. */
  pids: number[];
}
interface Readers {
  sync?: (a: ReadArgs) => Cwds;
  async?: (a: ReadArgs) => Promise<Cwds>;
}
let readers: Readers | undefined;
/** Test seam: replaces how working folders are read. Production never sets it. */
export function __setCwdReadersForTests(r: Readers | undefined): void {
  readers = r;
}

// ---- reading working folders ---------------------------------------------------------------------

function linuxCwds(pids: number[]): Cwds {
  const out = new Map<number, string>();
  for (const pid of pids) {
    try {
      out.set(pid, readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      /* gone, or not ours to read */
    }
  }
  return out;
}

function lsofArgv(): string[] {
  return ["lsof", "-a", "-d", "cwd", "-Fpn", "-u", String(process.getuid?.() ?? 0)];
}

/** `lsof -Fpn` prints `p<pid>` and then `n<path>` for each process. */
function parseLsof(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null && Number.isInteger(pid))
      out.set(pid, line.slice(1));
  }
  return out;
}

function lsofResult(r: { success: boolean; stdout: string; timedOut: boolean }): Cwds {
  // Styre itself has a working folder, so an empty listing means `lsof` did not work.
  if (r.timedOut || (!r.success && r.stdout.trim() === "")) return "skipped";
  return parseLsof(r.stdout);
}

function syncCwds(a: ReadArgs, viaDiagnostic: boolean): Cwds {
  if (readers?.sync) return readers.sync(a);
  if (process.platform === "linux") return linuxCwds(a.pids);
  try {
    const r = viaDiagnostic
      ? launchDiagnostic(lsofArgv(), { timeoutMs: a.timeoutMs })
      : runBlocking(lsofArgv(), { timeoutMs: LSOF_BLOCKING_MS });
    return lsofResult(r);
  } catch (err) {
    if (err instanceof RunInterrupted) throw err;
    return "skipped"; // lsof missing or not startable
  }
}

/** After a step: `lsof` as an ordinary group launch through the door, so a stop signal can end it. */
async function lsofThroughDoor(timeoutMs: number): Promise<Cwds> {
  const h = launch({
    argv: lsofArgv(),
    cwd: "/",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    kind: "group",
    context: { ident: null, stepId: null, worktree: null },
  });
  let text = "";
  const out = readPipe(h.proc.stdout, (t) => {
    text += t;
  });
  const err = readPipe(h.proc.stderr, () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const r = await Promise.race([h.proc.exited, limit]);
    if (r === "timeout") {
      await h.stop("forced");
      return "skipped";
    }
    if (!(await out.finish(1_000))) return "skipped";
    return lsofResult({ success: r === 0, stdout: text, timedOut: false });
  } finally {
    clearTimeout(timer);
    out.cancel();
    err.cancel();
    await h.finish().catch(() => {}); // releases the record; an exited group returns at once
  }
}

async function asyncCwds(a: ReadArgs): Promise<Cwds> {
  if (readers?.async) return readers.async(a);
  if (process.platform === "linux") return linuxCwds(a.pids);
  return lsofThroughDoor(a.timeoutMs);
}

// ---- selecting leftovers -------------------------------------------------------------------------

/** Processes that could be leftovers by time alone: alive, not Styre, started inside the window. */
function inWindow(table: ProcInfo[], since: string, until: string): ProcInfo[] {
  const lo = tokenValue(since);
  const hi = tokenValue(until);
  return table.filter((p) => {
    if (p.state === "zombie" || p.pid === process.pid) return false;
    const t = tokenValue(p.startedAt);
    return t >= lo && t <= hi;
  });
}

/** Every process of a launch Styre is running now (section 9.2 condition 3), and Styre itself. One
 *  collection rule: the same one a stop uses. */
function ownProcesses(table: ProcInfo[]): Set<number> {
  const own = new Set<number>([process.pid]);
  const myGroup = table.find((p) => p.pid === process.pid)?.pgid;
  for (const h of liveLaunches()) {
    const root = { pid: h.record.pid, startedAt: h.record.startedAt };
    for (const p of collectTree(root, table, myGroup === undefined ? [] : [myGroup]))
      own.add(p.pid);
  }
  return own;
}

const within = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(root + sep);

function select(
  worktree: string,
  candidates: ProcInfo[],
  cwds: Map<number, string>,
  table: ProcInfo[],
): Leftover[] {
  let root: string;
  try {
    root = realpathSync(worktree);
  } catch {
    return []; // no such folder: nothing can be running in it
  }
  const own = ownProcesses(table);
  const found: Leftover[] = [];
  for (const p of candidates) {
    const raw = cwds.get(p.pid);
    if (raw === undefined || own.has(p.pid)) continue;
    let cwd: string;
    try {
      cwd = realpathSync(raw); // both sides canonical: spaces, symlinks, /var and /private/var
    } catch {
      continue; // the folder was removed under it
    }
    if (within(cwd, root)) found.push({ pid: p.pid, command: describeProcess(p.pid, "?"), cwd });
  }
  return found;
}

/**
 * Synchronous check, for callers that cannot await (tests, the handler, the sweep). With
 * `viaDiagnostic`, `lsof` runs as a diagnostic, which works while the door is closed; without it
 * `lsof` goes through `runBlocking`. A timeout gives "skipped".
 */
export function findLeftovers(a: {
  worktree: string;
  since: string;
  /** The end of the window. Defaults to now. */
  until?: string;
  timeoutMs: number;
  viaDiagnostic: boolean;
}): Leftover[] | "skipped" {
  const until = a.until ?? nowToken();
  const table = listProcesses();
  const candidates = inWindow(table, a.since, until);
  const cwds = syncCwds(
    { timeoutMs: a.timeoutMs, pids: candidates.map((p) => p.pid) },
    a.viaDiagnostic,
  );
  return cwds === "skipped" ? "skipped" : select(a.worktree, candidates, cwds, table);
}

async function findLeftoversAsync(a: {
  worktree: string;
  since: string;
  until: string;
  timeoutMs: number;
}): Promise<Leftover[] | "skipped"> {
  const table = listProcesses();
  const candidates = inWindow(table, a.since, a.until);
  const cwds = await asyncCwds({ timeoutMs: a.timeoutMs, pids: candidates.map((p) => p.pid) });
  return cwds === "skipped" ? "skipped" : select(a.worktree, candidates, cwds, table);
}

/** The signal handler's step 5 (section 7.3): for each stopped agent launch, report what it left in
 *  its worktree, from that launch's own start. Returns the lines to print. */
export function checkLeftovers(a: { stopped: LaunchHandle[]; timeoutMs: number }): string[] {
  const lines: string[] = [];
  const reported = new Set<number>();
  for (const h of a.stopped) {
    const worktree = h.context.worktree;
    if (h.record.kind !== "agent" || worktree === null) continue;
    const r = findLeftovers({
      worktree,
      since: h.record.startedAt,
      timeoutMs: a.timeoutMs,
      viaDiagnostic: true,
    });
    if (r === "skipped") {
      lines.push(skippedLine("it did not finish in time"));
      continue;
    }
    for (const l of r) {
      if (reported.has(l.pid)) continue;
      reported.add(l.pid);
      lines.push(formatLeftover(l));
    }
  }
  return lines;
}

// ---- the background check ------------------------------------------------------------------------

const pending = new Set<Promise<void>>();

/**
 * Starts the check for one step and returns at once with the promise of its end. `since` is a start
 * token (a launch's `record.startedAt`, or `nowToken()` when the step began); the window ends now.
 * It never rejects. A stop in progress ends it silently: the handler runs its own check.
 */
export function checkLeftoversInBackground(a: {
  worktree: string;
  since: string;
  report: (lines: string[]) => void;
  timeoutMs?: number;
}): Promise<void> {
  const until = nowToken();
  const timeoutMs = a.timeoutMs ?? LEFTOVER_TIMEOUT_MS;
  const say = (lines: string[]): void => {
    try {
      a.report(lines);
    } catch {
      /* a failing report must not fail a check that nobody awaits */
    }
  };
  const run = async (): Promise<void> => {
    await Promise.resolve(); // leave the caller's own code path first
    try {
      const r = await findLeftoversAsync({
        worktree: a.worktree,
        since: a.since,
        until,
        timeoutMs,
      });
      if (r === "skipped") say([skippedLine("it did not finish in time")]);
      else if (r.length > 0) say(r.map(formatLeftover));
    } catch (err) {
      if (err instanceof RunInterrupted) return;
      say([skippedLine(err instanceof Error ? err.message : String(err))]);
    }
  };
  const p = run().finally(() => {
    pending.delete(p);
  });
  pending.add(p);
  return p;
}

/** Resolves when every check started so far has ended. Each check is bounded by its own timeout. */
export async function pendingLeftoverChecks(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
