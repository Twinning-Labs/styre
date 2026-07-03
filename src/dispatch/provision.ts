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

/** Fixed filename the `provision` handler writes the check script to, inside a **fresh OS tempdir
 *  the caller creates OUTSIDE the worktree** (never inside `cwd` — Opus F-1 re-review: CPython
 *  sets `sys.path[0]` to the directory containing the invoked script, so a script written INTO the
 *  worktree makes `find_spec` find the worktree copy unconditionally — a FALSE PASS for flat-layout
 *  packages even when a real `import <pkg>` from a neutral location would resolve to a shadowing
 *  copy. It also polluted the worktree.). */
export const SOURCE_CHECK_SCRIPT_NAME = ".styre-provision-check.py";

/** Fixed, metachar-free-invoked python source (never interpolated — argv carries the variable
 *  parts). `del sys.path[0]` is belt-and-suspenders: it strips whatever directory CPython
 *  auto-prepended for the invoked script (normally the tempdir it lives in, which carries no
 *  package of its own — but this keeps the probe honest even if that ever changes), so the
 *  `find_spec` below faithfully mirrors what a plain `import <pkg>` would resolve to from a
 *  neutral location — never the script's own directory. Exits 0 iff `sys.argv[1]` resolves (via
 *  `importlib.util.find_spec`) to a module whose origin file sits under `sys.argv[2]`; else exits
 *  1 (not found, or found but shadowed from elsewhere on `sys.path`). */
const SOURCE_CHECK_SCRIPT = `import sys
del sys.path[0]
import importlib.util
import pathlib

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
 *  `scriptPath` (inside a tempdir OUTSIDE the worktree — Fix A), then run `command` (metachar-free
 *  — passes `isCommandSafe`; no inline `python -c "…find_spec(…)…"`, whose parens/quotes/`$` are
 *  fragile through `sh -c`). */
export interface SourceCheck {
  script: string;
  scriptPath: string;
  command: string;
}

/** An `importName` is only safe to interpolate into the check command's argv after it matches this
 *  shape (Fix E) — a worktree-authored `pyproject.toml`/`setup.py` name containing `"`/`$`/etc.
 *  must never reach the `sh -c` command line un-validated. */
const IMPORT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function isValidImportName(name: string): boolean {
  return IMPORT_NAME_RE.test(name);
}

/** Everything `sourceCheckCommand` needs: which component/shape is being provisioned, the derived
 *  `importName` (if any), and the pre-resolved I/O the caller already has in hand — a tempdir
 *  (`scriptDir`, created OUTSIDE the worktree, Fix A) to write the check script into, and the
 *  interpreter to invoke it with (`interp`, resolved once per Fix D). */
export interface SourceCheckInput {
  component: string;
  kind: string;
  prepare: string | undefined;
  cwd: string;
  importName: string | undefined;
  scriptDir: string;
  interp: string;
}

/** Decide whether — and how — to check that the worktree source is actually under test.
 *
 *  Returns `null` ONLY for shapes that carry no shadowing risk at all: `kind !== "python"`, or a
 *  `prepare` that isn't exactly the editable-install shape (`pip install -e .`). Every other
 *  python-editable-install component MUST be checked — an undefined or invalid (Fix E) importName
 *  is NOT a silent skip (Fix B): it THROWS, so the caller escalates instead of quietly trusting an
 *  unverified install. */
export function sourceCheckCommand(input: SourceCheckInput): SourceCheck | null {
  const { component, kind, prepare, cwd, importName, scriptDir, interp } = input;
  if (kind !== "python" || prepare !== "pip install -e .") return null;
  if (importName === undefined || !isValidImportName(importName)) {
    throw new Error(
      `provision: cannot verify worktree source (unresolvable import name) for ${component}`,
    );
  }
  const scriptPath = join(scriptDir, SOURCE_CHECK_SCRIPT_NAME);
  return {
    script: SOURCE_CHECK_SCRIPT,
    scriptPath,
    command: `${interp} "${scriptPath}" "${importName}" "${cwd}"`,
  };
}

/** Resolve the python interpreter for the source-check probe and the remediation reinstall
 *  (Fix D): prefer `python3`, fall back to `python` — never hardcode either. Neither being present
 *  is a distinct provisioning-infra failure: this throws (the caller escalates) rather than
 *  silently skipping the check or falling through to a bare, possibly-absent `python`. */
export function resolvePythonInterpreter(): string {
  for (const candidate of ["python3", "python"]) {
    if (Bun.which(candidate)) return candidate;
  }
  throw new Error("provision: no python3 or python interpreter found on PATH");
}
