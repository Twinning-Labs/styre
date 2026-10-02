// Loaded once before the whole test run (bunfig.toml). Launch records are written under
// $XDG_STATE_HOME/styre-processes, so a test that starts a command must never reach the operator's
// real ~/.local/state. When the environment does not already name a state folder, use a fresh one
// for this run and remove it when the run ends. Tests that set their own folder still do, and
// restore this one.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.XDG_STATE_HOME) {
  const dir = mkdtempSync(join(tmpdir(), "styre-test-state-"));
  process.env.XDG_STATE_HOME = dir;
  // bun test does not emit the process exit event, so the end of the run is the last afterAll.
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
