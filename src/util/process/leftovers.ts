import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import {
  type LaunchHandle,
  RunInterrupted,
  describeProcess,
  isStopping,
  launch,
  launchDiagnostic,
  liveLaunches,
  runBlocking,
} from "./door.ts";
import { type ProcInfo, listProcesses, nowToken, tokenValue } from "./proc-table.ts";
import { readPipe } from "./read-pipe.ts";
import { collectTree, groupMembers } from "./stop.ts";

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

/** Said when a check could not finish, so a missing report is never read as a clean worktree. The
 *  signal handler uses it too, when no time is left for the check. */
export function skippedLine(why: string): string {
  return `styre: skipped the check for processes the agent left running in the worktree (${why})\n`;
}

/** A check that could not finish, with the reason the operator is told. */
interface Skip {
  skipped: string;
}
type Cwds = Map<number, string> | Skip;
interface ReadArgs {
  timeoutMs: number;
  /** The processes whose folder is wanted. Linux reads exactly these; `lsof` lists them all. */
  pids: number[];
}
interface Readers {
  sync?: (a: ReadArgs) => Map<number, string> | "skipped";
  async?: (a: ReadArgs) => Promise<Map<number, string> | "skipped">;
}
let readers: Readers | undefined;
/** Test seam: replaces how working folders are read. Production never sets it. */
export function __setCwdReadersForTests(r: Readers | undefined): void {
  readers = r;
}
const seamResult = (r: Map<number, string> | "skipped"): Cwds =>
  r === "skipped" ? { skipped: "it did not finish in time" } : r;
const isSkip = (c: unknown): c is Skip =>
  typeof c === "object" && c !== null && !Array.isArray(c) && "skipped" in c;

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

let lsofPathForTests: string | undefined;
/** Test seam: the program run as `lsof`. Production never sets it. */
export function __setLsofPathForTests(path: string | undefined): void {
  lsofPathForTests = path;
}
/** macOS keeps lsof in /usr/sbin, which a restricted PATH may not list: use the absolute path. */
function lsofArgv(): string[] {
  const exe = lsofPathForTests ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof");
  return [exe, "-a", "-d", "cwd", "-Fpn", "-u", String(process.getuid?.() ?? 0)];
}

/** One fixed locale for every way of running lsof, so its output never depends on the caller's. */
export function lsofEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
}

const LSOF_ESCAPES: Record<string, number> = { t: 9, n: 10, r: 13, b: 8, f: 12, "\\": 92 };
/**
 * `lsof -F` escapes what is not printable: `\xNN` for each byte of a multibyte character (in the C
 * locale), `\t \n \r \b \f \\`, and `^X` for a control character. Decode back to the bytes, then
 * read them as UTF-8, so the name matches what the file system holds. Text with no escape, such as
 * raw UTF-8 from a UTF-8 locale, passes through unchanged.
 */
export function decodeLsofName(s: string): string {
  const enc = new TextEncoder();
  const chars = Array.from(s);
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (c === "\\" && next !== undefined) {
      const hex = `${chars[i + 2] ?? ""}${chars[i + 3] ?? ""}`;
      if (next === "x" && /^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 3;
        continue;
      }
      const known = LSOF_ESCAPES[next];
      if (known !== undefined) {
        bytes.push(known);
        i += 1;
        continue;
      }
    }
    if (c === "^" && next !== undefined && /^[@A-Z[\\\]^_?]$/.test(next)) {
      bytes.push(next === "?" ? 127 : next.charCodeAt(0) - 64);
      i += 1;
      continue;
    }
    bytes.push(...enc.encode(c));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** `lsof -Fpn` prints `p<pid>` and then `n<path>` for each process. */
function parseLsof(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null && Number.isInteger(pid))
      out.set(pid, decodeLsofName(line.slice(1)));
  }
  return out;
}

function lsofResult(
  r: {
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  },
  timeoutMs: number,
): Cwds {
  if (r.timedOut) return { skipped: `lsof did not finish within ${timeoutMs} ms` };
  // Styre itself has a working folder, so an empty listing means `lsof` did not work.
  if (!r.success && r.stdout.trim() === "") {
    const why = r.stderr.trim().split("\n")[0];
    const status =
      r.exitCode === null ? "lsof was ended by a signal" : `lsof exited with status ${r.exitCode}`;
    return { skipped: why ? `${status}: ${why}` : status };
  }
  return parseLsof(r.stdout);
}

function syncCwds(a: ReadArgs, viaDiagnostic: boolean): Cwds {
  if (readers?.sync) return seamResult(readers.sync(a));
  if (process.platform === "linux") return linuxCwds(a.pids);
  try {
    const r = viaDiagnostic
      ? launchDiagnostic(lsofArgv(), { timeoutMs: a.timeoutMs, env: lsofEnv() })
      : runBlocking(lsofArgv(), { timeoutMs: LSOF_BLOCKING_MS, env: lsofEnv() });
    return lsofResult(r, viaDiagnostic ? a.timeoutMs : LSOF_BLOCKING_MS);
  } catch (err) {
    if (err instanceof RunInterrupted) throw err;
    return { skipped: `could not run lsof: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** After a step: `lsof` as an ordinary group launch through the door, so a stop signal can end it. */
async function lsofThroughDoor(timeoutMs: number): Promise<Cwds> {
  const h = launch({
    argv: lsofArgv(),
    cwd: "/",
    env: lsofEnv(),
    kind: "group",
    context: { ident: null, stepId: null, worktree: null },
  });
  let text = "";
  let errText = "";
  const out = readPipe(h.proc.stdout, (t) => {
    text += t;
  });
  const err = readPipe(h.proc.stderr, (t) => {
    errText += t;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const r = await Promise.race([h.proc.exited, limit]);
    if (r === "timeout") {
      await h.stop("forced");
      return { skipped: `lsof did not finish within ${timeoutMs} ms` };
    }
    if (!(await out.finish(1_000))) return { skipped: "the lsof output was cut off" };
    await err.finish(200);
    return lsofResult(
      { success: r === 0, exitCode: r, stdout: text, stderr: errText, timedOut: false },
      timeoutMs,
    );
  } finally {
    clearTimeout(timer);
    out.cancel();
    err.cancel();
    await h.finish().catch(() => {}); // releases the record; an exited group returns at once
  }
}

async function asyncCwds(a: ReadArgs): Promise<Cwds> {
  if (readers?.async) return seamResult(await readers.async(a));
  if (process.platform === "linux") return linuxCwds(a.pids);
  return lsofThroughDoor(a.timeoutMs);
}

/** The command line of a process, for the report: from /proc on Linux (no process launched), from
 *  `ps` elsewhere. At most 120 characters. */
export function commandFromCmdline(raw: string): string {
  return raw.replace(/\0+$/, "").split("\0").join(" ").slice(0, 120);
}
function commandOf(pid: number): string {
  if (process.platform === "linux") {
    try {
      const text = commandFromCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
      if (text !== "") return text;
    } catch {
      /* gone, or unreadable: fall through to ps */
    }
  }
  return describeProcess(pid, "?");
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
    // A command group also owns what was reparented out of the tree but stayed in the group, even
    // after its leader has exited: the same rule `stopGroup` uses.
    if (h.record.kind === "group" && h.record.pid !== myGroup)
      for (const p of groupMembers(h.record.pid, table)) own.add(p.pid);
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
    if (within(cwd, root)) found.push({ pid: p.pid, command: commandOf(p.pid), cwd });
  }
  return found;
}

function scanSync(a: {
  worktree: string;
  since: string;
  until?: string;
  timeoutMs: number;
  viaDiagnostic: boolean;
}): Leftover[] | Skip {
  const until = a.until ?? nowToken();
  const table = listProcesses();
  const candidates = inWindow(table, a.since, until);
  const cwds = syncCwds(
    { timeoutMs: a.timeoutMs, pids: candidates.map((p) => p.pid) },
    a.viaDiagnostic,
  );
  return isSkip(cwds) ? cwds : select(a.worktree, candidates, cwds, table);
}

/**
 * Synchronous check, for callers that cannot await (tests, the handler, the sweep). With
 * `viaDiagnostic`, `lsof` runs as a diagnostic, which works while the door is closed; without it
 * `lsof` goes through `runBlocking`. A check that could not finish gives "skipped".
 */
export function findLeftovers(a: {
  worktree: string;
  since: string;
  /** The end of the window. Defaults to now. */
  until?: string;
  timeoutMs: number;
  viaDiagnostic: boolean;
}): Leftover[] | "skipped" {
  const r = scanSync(a);
  return isSkip(r) ? "skipped" : r;
}

/** The same check, saying why when it could not finish (the sweep prints that reason). */
export function findLeftoversOrReason(a: {
  worktree: string;
  since: string;
  timeoutMs: number;
  viaDiagnostic: boolean;
}): Leftover[] | { skipped: string } {
  return scanSync(a);
}

async function findLeftoversAsync(a: {
  worktree: string;
  since: string;
  until: string;
  timeoutMs: number;
}): Promise<Leftover[] | Skip> {
  const table = listProcesses();
  const candidates = inWindow(table, a.since, a.until);
  const cwds = await asyncCwds({ timeoutMs: a.timeoutMs, pids: candidates.map((p) => p.pid) });
  return isSkip(cwds) ? cwds : select(a.worktree, candidates, cwds, table);
}

/** The signal handler's step 5 (section 7.3): for each stopped agent launch, report what it left in
 *  its worktree, from that launch's own start. The diagnostic form works with the door closed.
 *  Returns the lines to print. */
export function checkLeftovers(a: { stopped: LaunchHandle[]; timeoutMs: number }): string[] {
  const lines: string[] = [];
  const reported = new Set<number>();
  for (const h of a.stopped) {
    const worktree = h.context.worktree;
    if (h.record.kind !== "agent" || worktree === null) continue;
    const r = scanSync({
      worktree,
      since: h.record.startedAt,
      timeoutMs: a.timeoutMs,
      viaDiagnostic: true,
    });
    if (isSkip(r)) {
      lines.push(skippedLine(r.skipped));
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
      // A stop that began meanwhile has the handler run its own check: say nothing here.
      if (isStopping()) return;
      if (isSkip(r)) say([skippedLine(r.skipped)]);
      else if (r.length > 0) say(r.map(formatLeftover));
    } catch (err) {
      if (err instanceof RunInterrupted || isStopping()) return;
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
