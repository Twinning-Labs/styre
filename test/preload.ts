import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const runRoot = realpathSync(mkdtempSync(join(tmpdir(), "styre-test-run-")));
process.env.TMPDIR = runRoot;
// npm on Node 22+ keeps a compile cache in tmpdir() for good; children of tests (suite commands
// that run npm) inherit this and skip it. It only affects start-up speed.
process.env.NODE_DISABLE_COMPILE_CACHE = "1";
armForBunTest();

beforeEach(enterTest);
afterEach(leaveTest);

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
  throw new Error(lines.join("\n"));
});
