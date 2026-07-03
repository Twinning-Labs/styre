import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "./profile.ts";

/** One `prepare` install command to run, resolved against the worktree. */
export interface ProvisionAction {
  component: string;
  command: string;
  cwd: string;
}

/** Is this component's dependency install already complete? Node/sveltekit: a **completed**
 *  `node_modules` (marker `node_modules/.package-lock.json`, written by npm/yarn on success —
 *  review F6; a bare/partial `node_modules/` dir is NOT sufficient). Python + unknown kinds:
 *  always re-install; correctness is assured by the post-install source check (Task 5). */
export function isComponentReady(kind: string, compAbsDir: string): boolean {
  if (kind === "node" || kind === "sveltekit") {
    return existsSync(join(compAbsDir, "node_modules", ".package-lock.json"));
  }
  return false;
}

/** Plan the `provision` step's install actions: one per prepare-bearing, not-yet-ready
 *  component. A component with no `prepare` is skipped (graceful degradation — never a hard
 *  fail at run-start). */
export function planProvision(components: Component[], worktreePath: string): ProvisionAction[] {
  const out: ProvisionAction[] = [];
  for (const c of components) {
    if (!c.prepare) continue;
    const cwd = join(worktreePath, c.dir ?? "");
    if (isComponentReady(c.kind, cwd)) continue;
    out.push({ component: c.name, command: c.prepare, cwd });
  }
  return out;
}

/** Fixed filename the `provision` handler writes the check script to, inside the component's
 *  cwd (worktree-relative — never outside it). Task 5 / review F-1: `pip install -e .` exiting 0
 *  does NOT prove `import <pkg>` resolves to the worktree source — a pre-installed/conda copy can
 *  shadow it on `sys.path` ahead of the editable install. This script is the ground-truth probe. */
export const SOURCE_CHECK_SCRIPT_NAME = ".styre-provision-check.py";

/** Fixed, metachar-free-invoked python source (never interpolated — argv carries the variable
 *  parts). Exits 0 iff `sys.argv[1]` resolves (via `importlib.util.find_spec`) to a module whose
 *  origin file sits under `sys.argv[2]`; else exits 1 (not found, or found but shadowed from
 *  elsewhere on `sys.path`). */
const SOURCE_CHECK_SCRIPT = `import importlib.util
import pathlib
import sys

name = sys.argv[1]
cwd = pathlib.Path(sys.argv[2]).resolve()

spec = importlib.util.find_spec(name)
if spec is None or spec.origin is None:
    sys.exit(1)

origin = pathlib.Path(spec.origin).resolve()
try:
    origin.relative_to(cwd)
except ValueError:
    sys.exit(1)

sys.exit(0)
`;

/** A worktree-source check to run after a component's `prepare` succeeds: write `script` to
 *  `scriptName` inside `cwd`, then run `command` (metachar-free — passes `isCommandSafe`; no
 *  inline `python -c "…find_spec(…)…"`, whose parens/quotes/`$` are fragile through `sh -c`). */
export interface SourceCheck {
  script: string;
  scriptName: string;
  command: string;
}

/** Decide whether a worktree-source check applies. Non-null ONLY for the python editable-install
 *  case — component `kind === "python"`, its recorded `prepare` is exactly `pip install -e .`
 *  (the only prepare shape where a shadowing copy can silently win), and a known `importName`.
 *  Every other shape (node, python via tox/nox/requirements, unknown import name) returns `null`
 *  — no check, no escalation risk from a guess. */
export function sourceCheckCommand(
  kind: string,
  prepare: string | undefined,
  cwd: string,
  importName: string | undefined,
): SourceCheck | null {
  if (kind !== "python" || prepare !== "pip install -e ." || !importName) return null;
  const scriptPath = join(cwd, SOURCE_CHECK_SCRIPT_NAME);
  return {
    script: SOURCE_CHECK_SCRIPT,
    scriptName: SOURCE_CHECK_SCRIPT_NAME,
    command: `python "${scriptPath}" "${importName}" "${cwd}"`,
  };
}
