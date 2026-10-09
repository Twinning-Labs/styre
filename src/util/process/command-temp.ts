import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEnv } from "../../agent/agent-env.ts";
import { RunInterrupted, isStopping, liveLaunches, selfIdentity } from "./door.ts";
import { printable, shellWord } from "./printable.ts";
import { bootId } from "./proc-table.ts";
import { removeTempNote, writeTempNote } from "./records.ts";
import { removeTree } from "./remove-tree.ts";

/**
 * The temp folder of the project commands a Styre process starts. Every command `runCommand` and
 * `runBoundedCommand` start gets TMPDIR, TMP and TEMP pointed at one folder this process owns,
 * `os.tmpdir()/styre-cmd-XXXXXX` (mode 700), made when the first command starts.
 * What a command leaves there (a browser profile karma never removed because a stop cut it short, a
 * Python TemporaryDirectory that SIGTERM ended before its cleanup ran) stays out of the system temp
 * folder, and Styre removes the folder on its way out: the exit check of `run` and `setup`, or the
 * stop handler. While it exists it is noted in the launch records folder (records.ts), so the sweep
 * of a later Styre command removes it when this process was force quit.
 *
 * Only tools that read TMPDIR, TMP or TEMP use it: Node, Python, Go, Ruby, mktemp and most others
 * do. A JVM on Linux uses /tmp unless told otherwise (java.io.tmpdir), so it is not covered.
 */
interface Made {
  dir: string;
  /** The note's path, fixed when it was written: the state folder may differ by the time it goes. */
  note: string;
}
let made: Made | null = null;

/** This process's command temp folder, made (and noted) the first time. Throws when it cannot be
 *  made or noted: a command must not run with a temp folder nothing would remove. */
export function commandTempDir(): string {
  if (made) {
    if (stillOurs(made.dir)) return made.dir;
    // Something removed it while Styre runs (a temp cleaner, or the removal at a simulated exit in
    // a test), or put something else under its name. Whatever is there now is left alone: its note
    // goes, so no sweep acts on it, and a new folder is made under a new name.
    removeTempNote(made.note);
    made = null;
  }
  // Once a stop has begun the door refuses every launch; a folder made for one would outlive Styre.
  if (isStopping()) throw new RunInterrupted();
  const me = selfIdentity();
  // Short on purpose: a Unix socket path holds at most 104 bytes on macOS, and tools put sockets
  // below TMPDIR (Python's multiprocessing listener adds 32 characters). The note names the owner.
  const dir = mkdtempSync(join(tmpdir(), "styre-cmd-"));
  try {
    const note = writeTempNote({
      version: 1,
      owner: { pid: me.pid, startedAt: me.startedAt },
      bootId: bootId(),
      path: dir,
    });
    made = { dir, note };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

/** Still the folder this process made: a real folder (not a link) of this user's. */
function stillOurs(dir: string): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  const me = process.geteuid?.();
  return st.isDirectory() && (me === undefined || st.uid === me);
}

/** The environment of a project command: the daemon's creds stripped (`verifyEnv`), and the temp
 *  folder variables pointed at this process's command temp folder. */
export function commandEnv(): Record<string, string> {
  const dir = commandTempDir();
  return { ...verifyEnv(process.env), TMPDIR: dir, TMP: dir, TEMP: dir };
}

/** Removes the folder and then its note, on Styre's way out. Kept, and said, while a command Styre
 *  started is still running: it may still be using it, and the sweep removes it once that command
 *  has been stopped. With a time budget (the stop handler's), a removal that runs out of time stops
 *  and is said (a budget of 0 skips it), and the note stays so the sweep finishes it. A removal that fails is said once, with
 *  how to finish it by hand, and its note goes so no later command says it again. Never throws. */
export function removeCommandTempDir(
  say: (s: string) => void,
  opts: { budgetMs?: number; now?: () => number } = {},
): void {
  if (!made) return;
  const { dir, note } = made;
  if (!stillOurs(dir)) {
    // Gone, or something that is not Styre's now has its name: nothing of Styre's to remove, and
    // what is there is left alone. Its note goes, so no sweep acts on it.
    removeTempNote(note);
    made = null;
    return;
  }
  if (liveLaunches().some((h) => h.record.kind === "group")) {
    say(
      `styre: kept the temp folder ${dir}: a command Styre started is still running; the next Styre command removes it once that command has stopped\n`,
    );
    return;
  }
  const now = opts.now ?? Date.now;
  try {
    const deadline = opts.budgetMs === undefined ? undefined : now() + opts.budgetMs;
    if (opts.budgetMs === 0 || !removeTree(dir, { deadline, now })) {
      say(
        `styre: left the temp folder ${dir} for the next Styre command to remove: no time was left before the stop deadline\n`,
      );
      return;
    }
    removeTempNote(note);
  } catch (e) {
    const word = shellWord(printable(dir));
    say(
      `styre: could not remove the temp folder ${dir}: ${e instanceof Error ? e.message : String(e)}; remove it with: chmod -R u+w ${word} && rm -rf ${word}\n`,
    );
    try {
      removeTempNote(note);
    } catch {
      /* said above; the sweep will say it again, once */
    }
  }
  made = null;
}

/** Test seam: replaces what this process made, returning what it had, so a test can work on a
 *  folder of its own and then put the run's back. */
export function __swapCommandTempForTests(next: Made | null): Made | null {
  const prev = made;
  made = next;
  return prev;
}
