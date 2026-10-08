import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temp folders that tests make, removed for them whether the test passes or fails.
 *
 * test/preload.ts drives the two scopes through global hooks: a folder made inside a test (its
 * body, or a beforeEach/afterEach) is removed when that test ends; a folder made anywhere else
 * (a beforeAll, a describe body, module scope) may be shared across tests, so it is removed when
 * the whole run ends. Folders that production code makes under tmpdir() are not tracked here on
 * purpose: if code under test leaves one behind, the preload's leak guard fails the run.
 *
 * Limits: "inside a test" is one flag, so this assumes tests run one at a time (no
 * `test.concurrent`). A test that times out has its folders removed while its body may still be
 * running; anything the body writes afterwards shows up as a leak in an already-failed run.
 */
const testScoped: string[] = [];
const runScoped: string[] = [];
const couldNotRemove: RemovalFailure[] = [];

export interface RemovalFailure {
  path: string;
  reason: string;
}
let inTest = false;
let armed = false;

/** mkdtemp under the run's temp root, tracked for removal. */
export function makeTempDir(prefix: string): string {
  assertArmed();
  return trackTempPath(mkdtempSync(join(tmpdir(), prefix)));
}

/** Track a path the caller creates itself (for example a `git worktree add` target that must not
 *  exist yet). Returns the path unchanged. */
export function trackTempPath(path: string): string {
  assertArmed();
  (inTest ? testScoped : runScoped).push(path);
  return path;
}

/** Without the preload's hooks nothing would remove a tracked folder, so refuse rather than leak. */
function assertArmed(): void {
  if (armed) return;
  throw new Error(
    "test/helpers/temp.ts: nothing would remove this temp folder because test/preload.ts is not " +
      "loaded. Run `bun test` from the repo root (bunfig.toml loads it) or pass " +
      "`--preload <repo>/test/preload.ts`; a process that is not a test run can call " +
      "removeTempDirsOnExit() instead.",
  );
}

/** Called by test/preload.ts when it installs the hooks that remove tracked folders. */
export function armForBunTest(): void {
  armed = true;
}

/** For a process that is not a `bun test` run (a `bun -e` script that uses test helpers): remove
 *  every tracked folder when the process exits. */
export function removeTempDirsOnExit(): void {
  armed = true;
  process.on("exit", () => removeRunScoped());
}

/** Run `fn` and track each `prefix*` entry it adds to the temp root, even when it throws. For
 *  folders that code under test makes there and keeps on purpose — `styre run` and resume keep the
 *  run's `styre-wt-*` worktree root after a pause or pr-ready. Tests run one at a time within a
 *  `bun test` process, so a new matching entry is this call's. */
export async function trackTempEntriesMadeBy<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  const matching = () => readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
  const before = new Set(matching());
  try {
    return await fn();
  } finally {
    for (const name of matching()) if (!before.has(name)) trackTempPath(join(tmpdir(), name));
  }
}

/** Try every path even when one fails; the failures go to the leak guard's report. */
function removeAll(paths: string[]): void {
  for (const path of paths.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      couldNotRemove.push({ path, reason: (error as Error).message });
    }
  }
}

/** Global beforeEach (test/preload.ts only). */
export function enterTest(): void {
  inTest = true;
}

/** Global afterEach (test/preload.ts only). */
export function leaveTest(): void {
  inTest = false;
  removeAll(testScoped);
}

/** Global afterAll (test/preload.ts only), before the leak guard looks at the temp root. Returns
 *  every tracked path that could not be removed during the run, with the reason. */
export function removeRunScoped(): RemovalFailure[] {
  removeAll(testScoped);
  removeAll(runScoped);
  return couldNotRemove.splice(0);
}
