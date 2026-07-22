import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getByKey, resetAttempt, resetToPending } from "../db/repos/workflow-step.ts";
import type { Component } from "./profile.ts";

/** One `prepare` install command to run, resolved against the worktree. */
export interface ProvisionAction {
  component: string;
  command: string;
  cwd: string;
}

/** Per-package-manager completeness marker written under `node_modules/` on a successful
 *  install — npm/yarn/pnpm each write a different one, so all three are checked (whole-branch
 *  review Finding 3: yarn/pnpm previously had NO readiness cache at all, so `isComponentReady`
 *  fell through `false` and re-installed on every provision run for those managers). */
const NODE_INSTALL_MARKERS = [".package-lock.json", ".yarn-state.yml", ".modules.yaml"];

/** Manifest/lockfile basenames whose mtime, if newer than the install marker, proves the
 *  install is stale (a dependency was added/changed after the last install completed). */
const NODE_MANIFEST_FILES = ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

/** Is this component's dependency install already complete? Node/sveltekit: **content-aware**
 *  per-manager (whole-branch review Finding 1): ready iff a manager's completeness marker exists
 *  under `node_modules/` AND its mtime is >= the newest mtime among the manifest/lockfiles
 *  present in `compAbsDir`. A manifest edited (loopback dependency change) after the last install
 *  makes the marker stale → not ready → `planProvision` reinstalls, closing the silent no-op
 *  where a later manifest touch reset `provision` to pending but the marker (never invalidated)
 *  still read "ready" and the reinstall was skipped. No marker at all → not ready. Python +
 *  unknown kinds: always re-install; correctness is assured by the post-install source check
 *  (Task 5). */
export function isComponentReady(kind: string, compAbsDir: string): boolean {
  if (kind !== "node" && kind !== "sveltekit") return false;

  const nodeModulesDir = join(compAbsDir, "node_modules");
  const markerMtimes = NODE_INSTALL_MARKERS.map((m) => join(nodeModulesDir, m))
    .filter((p) => existsSync(p))
    .map((p) => statSync(p).mtimeMs);
  if (markerMtimes.length === 0) return false;
  const freshestMarkerMtime = Math.max(...markerMtimes);

  const manifestMtimes = NODE_MANIFEST_FILES.map((f) => join(compAbsDir, f))
    .filter((p) => existsSync(p))
    .map((p) => statSync(p).mtimeMs);
  if (manifestMtimes.length === 0) return true; // no manifest present to compare against
  const newestManifestMtime = Math.max(...manifestMtimes);

  return freshestMarkerMtime >= newestManifestMtime;
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
export const SOURCE_CHECK_SCRIPT = `import sys
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

/** Matches any pip-editable-install invocation shape, not just the canonical `pip install -e .`
 *  (whole-branch review Finding 2 / F-1 reopen): `pip install -e .[dev]`, `pip install --editable
 *  .`, `python -m pip install -e .`, etc. — any config-overridden `prepare` that still installs
 *  editable via pip must still trip the worktree-source-under-test guard, or a shadowed copy can
 *  verify silently. Matched against the raw `prepare` string; `kind === "python"` is checked
 *  separately by callers. Residual, accepted gap: a non-pip editable install supplied via the
 *  config-override seam (e.g. `poetry install`) does not match this pattern and is NOT guarded —
 *  narrower than "every editable install", but broader than the single exact-string match this
 *  replaces. See docs/brainstorms/2026-07-03-provisioning-design.md. */
const EDITABLE_PIP_RE = /(^|\s)(python -m\s+)?pip\s+install\s+(.*\s)?(-e|--editable)(\s|$)/;

export function isEditablePythonPrepare(prepare: string): boolean {
  return EDITABLE_PIP_RE.test(prepare);
}

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
 *  `prepare` that doesn't match the pip-editable-install PATTERN (`isEditablePythonPrepare` —
 *  whole-branch review Finding 2: not just the exact string `pip install -e .`, but also e.g.
 *  `pip install -e .[dev]`, `pip install --editable .`, `python -m pip install -e .`). Every other
 *  python-editable-install component MUST be checked — an undefined or invalid (Fix E) importName
 *  is NOT a silent skip (Fix B): it THROWS, so the caller escalates instead of quietly trusting an
 *  unverified install. */
export function sourceCheckCommand(input: SourceCheckInput): SourceCheck | null {
  const { component, kind, prepare, cwd, importName, scriptDir, interp } = input;
  if (kind !== "python" || prepare === undefined || !isEditablePythonPrepare(prepare)) return null;
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

// ─── Task 9: re-provision when a loopback edits a dependency manifest ──────────

/** Basenames that identify a dependency manifest/lockfile for an ecosystem that HAS an install
 *  step (`prepare`) — node/sveltekit, python, ruby, php.
 *
 *  Deliberately excludes rust/go/jvm. Two reasons, stated at their real strength:
 *  1. No DETECTOR emits a `prepare` for those kinds (`src/setup/lang/{rust,go,jvm}.ts`), so in a
 *     detected profile `planProvision` produces nothing for them and the re-arm would be waste.
 *     This is a fact about the detectors, NOT a schema guarantee: `ComponentSchema.prepare` is
 *     optional on ANY `kind` and `profile.json` is hand-editable, so a hand-added `prepare` on a
 *     rust component would install without a manifest here to re-arm it. Accepted residual, same
 *     config-override seam `EDITABLE_PIP_RE` below already documents.
 *  2. `resetProvision` is TICKET-level (it keys on ticketId + "provision"), so listing these would
 *     re-run a sibling component's install. Note the cost is real only for python/ruby/php
 *     siblings, which always reinstall — for a node/sveltekit sibling `isComponentReady` is
 *     content-aware and short-circuits, so a spurious reset costs nothing there.
 *
 *  Patterns that a fixed basename can't express are matched separately below. */
const MANIFEST_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
]);

/** Manifests whose filename varies, so they cannot be a fixed basename:
 *  - `requirements*.txt` — pip's convention allows an arbitrary suffix (`requirements-dev.txt`).
 *  - `*.gemspec` — named after the gem. In a gem repo the `Gemfile` is often just
 *    `source ...; gemspec`, and every runtime/dev dependency is declared in the gemspec via
 *    `add_dependency`, so a dependency change touches ONLY this file. Anchored both ends like its
 *    sibling: a bare `.gemspec` dotfile is not a gemspec.
 *
 *  NOT listed: bundler's `gems.rb`/`gems.locked` Gemfile aliases. Harmless today ONLY because
 *  `rubyDef.detect` hard-gates on `Gemfile` (`src/setup/lang/ruby.ts`), so a `gems.rb`-only repo
 *  yields no ruby component and there is nothing to re-arm. If that gate ever learns `gems.rb`,
 *  add the aliases here in the same change or this silently regresses. */
const MANIFEST_PATTERNS: readonly RegExp[] = [/^requirements.*\.txt$/, /^.+\.gemspec$/];

/** True iff any changed path's basename is a dependency manifest/lockfile — i.e. an `implement`
 *  dispatch's committed diff could have added/changed a dependency, which the once-gated
 *  `provision` step (already `done`) would otherwise miss (review F-2). Path-independent: matches
 *  on basename only, so a nested `apps/api/pyproject.toml` counts. */
export function diffTouchesManifest(changedPaths: string[]): boolean {
  return changedPaths.some((p) => {
    const base = basename(p);
    return MANIFEST_BASENAMES.has(base) || MANIFEST_PATTERNS.some((re) => re.test(base));
  });
}

/** Reset a succeeded `provision` step back to `pending` (and zero its `attempt` — a fresh install
 *  is not a retry of a prior attempt) so the resolver's `!done("provision")` gate re-fires before
 *  the next verify. A no-op if provision hasn't run yet or isn't currently `succeeded` (e.g.
 *  already pending/running/failed). Shared by the resume path (`src/cli/park.ts`) and the
 *  manifest-touch hook below. */
export function resetProvision(db: Database, ticketId: number): void {
  const s = getByKey(db, ticketId, "provision");
  if (s && s.status === "succeeded") {
    resetToPending(db, s.id);
    resetAttempt(db, s.id);
  }
}

/** The `implement:dispatch` post-commit hook (review F-2): if the dispatch's committed diff
 *  touched a dependency manifest, re-arm `provision` so it re-installs before the next verify.
 *  Only resets when provision is currently `succeeded` — a not-yet-run/already-pending provision
 *  needs no reset. */
export function resetProvisionIfManifestTouched(
  db: Database,
  ticketId: number,
  changedFiles: string[],
): void {
  if (diffTouchesManifest(changedFiles)) {
    resetProvision(db, ticketId);
  }
}
