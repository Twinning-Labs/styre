import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every check executor must launch through `launcherFor`, never `binaryFor`.
 *
 * WHY THIS EXISTS. styre has THREE places that execute an AC check — `checks:dispatch`'s
 * red-first run (handlers.ts), the post-implement re-run (post-implement-rerun.ts), and the
 * base-replay harness (replay-harness.ts). ENG-399's first fix changed only the first. The
 * post-implement re-run kept calling `binaryFor`, so on darkreader__darkreader-7241 it failed
 * with
 *
 *     sh: 1: jest: not found
 *
 * while the very same check passed through `npm test --` — jest lives in node_modules/.bin and
 * is reachable only via the package manager's script environment. The check was recorded
 * still-red at HEAD and the run escalated, even though the implementation was correct.
 *
 * A grep-level invariant is the right guard here: the defect was not a wrong line, it was a
 * MISSED line, and no behavioural test of one executor can catch a fourth being added later.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("every runCheckForRed call site passes launcherFor, never binaryFor", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    // check-selector.ts DEFINES both; launcherFor delegates to binaryFor as its fallback.
    if (file.endsWith("check-selector.ts")) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("runCheckForRed")) continue;
    if (/binary:\s*binaryFor\(/.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("no module outside check-selector.ts imports binaryFor", () => {
  // Stops a new executor reaching for the bare binary before it ever runs.
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    if (file.endsWith("check-selector.ts")) continue;
    const text = readFileSync(file, "utf8");
    if (/import\s*\{[^}]*\bbinaryFor\b[^}]*\}\s*from\s*["'][^"']*check-selector/.test(text)) {
      offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});

test("the known executors are all still present (guards a silent rename)", () => {
  // If an executor is renamed or removed, the invariants above would pass vacuously.
  const executors = [
    "src/dispatch/handlers.ts",
    "src/dispatch/post-implement-rerun.ts",
    "src/dispatch/replay-harness.ts",
  ];
  for (const f of executors) {
    const text = readFileSync(f, "utf8");
    expect(text).toContain("runCheckForRed");
    expect(text).toContain("launcherFor");
  }
});
