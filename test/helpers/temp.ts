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
 */
const testScoped: string[] = [];
const runScoped: string[] = [];
let inTest = false;

/** mkdtemp under the run's temp root, tracked for removal. */
export function makeTempDir(prefix: string): string {
  return trackTempPath(mkdtempSync(join(tmpdir(), prefix)));
}

/** Track a path the caller creates itself (for example a `git worktree add` target that must not
 *  exist yet). Returns the path unchanged. */
export function trackTempPath(path: string): string {
  (inTest ? testScoped : runScoped).push(path);
  return path;
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

function removeAll(paths: string[]): void {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
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

/** Global afterAll (test/preload.ts only), before the leak guard looks at the temp root. */
export function removeRunScoped(): void {
  removeAll(testScoped);
  removeAll(runScoped);
}
