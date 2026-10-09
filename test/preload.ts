// Loaded once before the whole test run (bunfig.toml). Launch records are written under
// $XDG_STATE_HOME/styre-processes, so a test that starts a command must never reach the operator's
// real records folder. The run always gets a fresh state folder of its own, whatever the
// environment already says (an XDG_STATE_HOME the operator set names their REAL state folder), and
// it is removed when the run ends. Tests that set their own folder still do, and restore this one.
//
// A guard then watches the operator's REAL records folders for the whole run: the one the
// environment named before this preload ran ($XDG_STATE_HOME/styre-processes, or
// $HOME/.local/state/styre-processes when it was not set), and the default one too when they differ.
// It fails the run, naming the files, if a launch record was written there. A child started with
// Bun.spawn and no `env` gets the environment Bun started with, not this preload's XDG_STATE_HOME,
// so that is how a test leaks (R29). The watch sees a record even when it was removed again before
// the run ended. A real Styre the operator runs during the test run would trip it too; that failure
// says so.
//
// The temp folder setup comes first, so this run's state folder is made inside its temp root.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { type FSWatcher, existsSync, mkdtempSync, readdirSync, rmSync, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandTempDir, removeCommandTempDir } from "../src/util/process/command-temp.ts";
import { isStopping } from "../src/util/process/door.ts";
import { ownGroupMembers, stillRunning, stopStillRunning } from "./helpers/own-processes.ts";
import { armForBunTest, enterTest, leaveTest, removeRunScoped } from "./helpers/temp.ts";

/**
 * Loaded once per `bun test` run (bunfig.toml). Every run gets its own temp root. At the end of
 * the run the root must be empty once the tracked folders (test/helpers/temp.ts) are gone;
 * anything still there is a leak, and the run fails.
 *
 * What lands in the root: everything that reads tmpdir() in this process (tests and the code under
 * test), and children spawned with node:child_process or with `env: process.env`. A Bun.spawn with
 * no `env` passes the environment this process STARTED with, so such a child still sees the
 * original TMPDIR and this guard cannot see what it leaves; give that child an explicit TMPDIR.
 *
 * The root itself is made with a bare mkdtempSync on purpose: tracking it would remove it before
 * the guard looks inside. A run that never reaches afterAll (`--bail`, Ctrl-C, a crash) leaves
 * this one root behind, unreported.
 */
const runRoot = mkdtempSync(join(tmpdir(), "styre-test-run-"));
process.env.TMPDIR = runRoot;
// npm on Node 22+ keeps a compile cache in tmpdir() for good; children of tests (suite commands
// that run npm) inherit this and skip it. It only affects start-up speed.
process.env.NODE_DISABLE_COMPILE_CACHE = "1";
armForBunTest();

const home = process.env.HOME || homedir();
const defaultState = join(home, ".local", "state");
/** The operator's state folder as the environment named it before this preload. */
const originalState = process.env.XDG_STATE_HOME || defaultState;
const testState = mkdtempSync(join(tmpdir(), "styre-test-state-"));
process.env.XDG_STATE_HOME = testState;
// The temp folder of the commands this test process runs (src/util/process/command-temp.ts), made
// now so its note lands in this run's state folder, never in a test's own. It is removed the way
// Styre removes it at exit, before the temp folder check below: if it cannot be, that check names it.
commandTempDir();
// A test that runs the stop handler or the exit check removes that folder, as Styre does on its way
// out, and the next command would then make one in whatever TMPDIR and state folder that test set.
// So each test starts with a folder in this run's temp root again, noted in this run's state folder.
beforeEach(() => {
  // A test file that left the door closed (a simulated stop) opens it again itself.
  if (isStopping()) return;
  const tmp = process.env.TMPDIR;
  const stateHome = process.env.XDG_STATE_HOME;
  process.env.TMPDIR = runRoot;
  process.env.XDG_STATE_HOME = testState;
  try {
    // One a test made under a TMPDIR of its own goes the way Styre removes it.
    if (dirname(commandTempDir()) !== runRoot) {
      removeCommandTempDir((line) => console.error(line));
      commandTempDir();
    }
  } finally {
    process.env.TMPDIR = tmp;
    process.env.XDG_STATE_HOME = stateHome;
  }
});
// bun test does not emit the process exit event, so the end of the run is the last afterAll.
afterAll(() => {
  removeCommandTempDir((s) => console.error(s));
  rmSync(testState, { recursive: true, force: true });
});

// Temp folder leak guard, in two hooks. Bun skips every later afterAll once one throws, so the check
// itself never throws: it runs here, right after the state folder is gone and before the guards
// below that may throw, removes the run's temp root whatever it finds, and keeps its report. The
// last afterAll in this file raises it, so a temp leak never stops the process guard below from
// stopping leftover processes.
beforeEach(enterTest);
afterEach(leaveTest);
let tempLeakReport: string | undefined;
afterAll(() => {
  const couldNotRemove = removeRunScoped();
  // A tracked folder whose removal failed is reported with its reason, not as untracked.
  const failed = (name: string) =>
    couldNotRemove.some(
      ({ path }) => path === join(runRoot, name) || path.startsWith(join(runRoot, name, "/")),
    );
  const untracked = readdirSync(runRoot)
    .sort()
    .filter((name) => !failed(name));
  // Remove the root even when the guard trips, so a leaking run does not pile up on disk.
  try {
    rmSync(runRoot, { recursive: true, force: true });
  } catch (error) {
    couldNotRemove.push({ path: runRoot, reason: (error as Error).message });
  }
  if (untracked.length === 0 && couldNotRemove.length === 0) return;
  const lines = [`bun test left temp folders behind in ${runRoot}.`];
  if (untracked.length > 0) {
    const fix =
      "make them with makeTempDir/trackTempPath from test/helpers/temp.ts, or remove them";
    lines.push(`${untracked.length} that nothing removed (${fix} in the test):`);
    for (const name of untracked) lines.push(`  ${name}`);
  }
  if (couldNotRemove.length > 0) {
    lines.push("Tracked paths that could not be removed (fix what blocks the removal):");
    for (const { path, reason } of couldNotRemove) lines.push(`  ${path}: ${reason}`);
  }
  tempLeakReport = lines.join("\n");
  // Printed now as well: a guard below that throws makes Bun skip the afterAll that raises this.
  console.error(tempLeakReport);
});

/** A launch record, a claimed copy, a temp folder note, or the temporary file either is written
 *  through. */
const RECORD_NAME = /^\.?(?:tmp-)?\d+-\d+(?:\.\d{6})?\.json/;
const realDirs = [...new Set([originalState, defaultState])].map((d) => join(d, "styre-processes"));
const testDir = join(testState, "styre-processes");

for (const realDir of realDirs.filter((d) => d !== testDir)) {
  const records = (): string[] => {
    try {
      return readdirSync(realDir).filter((n) => RECORD_NAME.test(n));
    } catch {
      return [];
    }
  };
  const existed = existsSync(realDir);
  const before = new Set(records());
  const seen = new Set<string>();
  let watcher: FSWatcher | null = null;
  if (existed) {
    try {
      watcher = watch(realDir, (_event, name) => {
        if (typeof name === "string" && RECORD_NAME.test(name)) seen.add(name);
      });
      watcher.unref?.();
    } catch {
      watcher = null; // the end check below still compares the folder's contents
    }
  }
  afterAll(async () => {
    await Bun.sleep(200); // let the last events arrive
    watcher?.close();
    for (const n of records()) if (!before.has(n)) seen.add(n);
    // Only writing a record creates the folder: a folder that appeared held one, even if it was
    // removed again (there was no watch on a folder that did not exist yet).
    if (!existed && existsSync(realDir)) seen.add("(the folder itself was created)");
    if (seen.size > 0) {
      throw new Error(
        `a test wrote launch records into the operator's real ${realDir}: ${[...seen].sort().join(", ")}. A child started with Bun.spawn needs env: { ...process.env } to inherit the test state folder (or a real Styre ran during the test run).`,
      );
    }
  });
}

// The end of run leak check: every process a test remembered through test/helpers/own-processes.ts
// (its launches' trees, printed pids, fixture sleeps, members of the groups it created) must be gone
// by now, because each test file cleans up after itself. One still running means a cleanup was
// removed or broken: the run fails, naming each by pid and command, and the processes are then
// stopped (recorded identities only, each checked again just before its signal).
afterAll(async () => {
  // What a command left in a group a test created is claimed now too (rule 2), even when no
  // cleanup reached it: its leader has exited, so no tree walk finds it.
  ownGroupMembers();
  const left = await stillRunning();
  if (left.length === 0) return;
  stopStillRunning(left);
  throw new Error(
    `test processes were still running at the end of the run (a test did not clean up after itself; they are stopped now): ${left.map((l) => `pid ${l.pid} "${l.command}"`).join(", ")}`,
  );
});

afterAll(() => {
  if (tempLeakReport !== undefined) throw new Error(tempLeakReport);
});
