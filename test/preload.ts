// Loaded once before the whole test run (bunfig.toml). Launch records are written under
// $XDG_STATE_HOME/styre-processes, so a test that starts a command must never reach the operator's
// real ~/.local/state. When the environment does not already name a state folder, use a fresh one
// for this run and remove it when the run ends. Tests that set their own folder still do, and
// restore this one.
//
// A guard then watches the operator's REAL records folder ($HOME/.local/state/styre-processes,
// whatever XDG_STATE_HOME says) for the whole run, and fails the run, naming the files, if a launch
// record was written there. A child started with Bun.spawn and no `env` gets the environment Bun
// started with, not this preload's XDG_STATE_HOME, so that is how a test leaks (R29). The watch sees
// a record even when it was removed again before the run ended. A real Styre the operator runs
// during the test run would trip it too; that failure says so.
import { afterAll } from "bun:test";
import { type FSWatcher, existsSync, mkdtempSync, readdirSync, rmSync, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.XDG_STATE_HOME) {
  const dir = mkdtempSync(join(tmpdir(), "styre-test-state-"));
  process.env.XDG_STATE_HOME = dir;
  // bun test does not emit the process exit event, so the end of the run is the last afterAll.
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

/** A launch record, a claimed copy, or the temporary file a record is written through. */
const RECORD_NAME = /^\.?\d+-\d+(?:\.\d{6})?\.json/;
const realDir = join(process.env.HOME || homedir(), ".local", "state", "styre-processes");
const testDir = join(process.env.XDG_STATE_HOME ?? "", "styre-processes");

if (realDir !== testDir) {
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
