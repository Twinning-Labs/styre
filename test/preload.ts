import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enterTest, leaveTest, removeRunScoped } from "./helpers/temp.ts";

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
 * the guard looks inside.
 */
const runRoot = mkdtempSync(join(tmpdir(), "styre-test-run-"));
process.env.TMPDIR = runRoot;

beforeEach(enterTest);
afterEach(leaveTest);

afterAll(() => {
  removeRunScoped();
  const leftBehind = readdirSync(runRoot).sort();
  // Remove the root even when the guard trips, so a leaking run does not pile up on disk.
  rmSync(runRoot, { recursive: true, force: true });
  if (leftBehind.length > 0) {
    const names = leftBehind.map((name) => `  ${name}`).join("\n");
    const fix =
      "Make them with makeTempDir/trackTempPath (test/helpers/temp.ts) or remove them in the test.";
    throw new Error(
      `bun test left behind ${leftBehind.length} temp folder(s) in ${runRoot}:\n${names}\n${fix}`,
    );
  }
});
