# Python env reuse (the conda switch) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a ready Python environment already tests the worktree (e.g. an editable conda env), run `python -m pytest` in it instead of the detected harness (`tox`) — fixing astropy's env-rebuild timeout and the bare-`tox`-matrix problem at once.

**Architecture:** A runtime **readiness probe** reusing styre's existing source-under-test check: for a python `test` gate, if `import <pkg>` resolves under the worktree **and** `pytest` is importable in the active interpreter, the effective command becomes `<interp> -m pytest`; otherwise the detected command runs unchanged. The probe + resolver live in a new `src/dispatch/reuse.ts`; `verify:check` and `verify:integration` route python test commands through it. **No change** to the no-ready-env path (that's the deferred pre-warm plan).

**Tech Stack:** TypeScript, Bun (`bun test`), embedded SQLite. Runner: `bun test`; `bun run typecheck` + `bun run lint` stay green.

**Scope — deliberately minimal (operator: "one problem at a time").** This ships *only* the reuse switch. Deferred to separate work: **pre-warm** (`tox -e <env> --notest` + env-selection, for the no-ready-env case), the **whole-suite-runtime-vs-budget** question (measure first — a reused suite still runs under `VERIFY_TIMEOUT_MS`), **test-selection/TIA**, and **CI-reading**.

## Global Constraints

- Branch `feat/verify-gates` (continues PR #51); commit per task; **never `main`**; PR-only.
- **Reuse only when *proven*.** The probe (`import <pkg>` resolves under the worktree) IS the wrong-bytes guard — the exact refinement of the conda denial. If the probe can't run or fails → fall through to the detected command (no regression).
- Commands stay metachar-free; the probe reuses `SOURCE_CHECK_SCRIPT` (a temp `.py` run by argv, never inline `python -c`), written to a tempdir **outside** the worktree (existing Fix A).
- Runner: `bun test`; `bun run typecheck` + `bun run lint` green after each task.
- **Out of scope / deferred:** pre-warm + tox env-selection; skipping the (harmless, fast) `pip install tox` at provision; the whole-suite-budget question; TIA; CI-reading; ruby/php readiness probes.

## File Structure

- `src/dispatch/reuse.ts` — **new** — `pythonEnvReady()` (probe) + `reuseAwareTestCommand()` (resolver). One clear responsibility: "which test command should actually run for this component."
- `src/dispatch/handlers.ts` — `verify:check` `toRun` construction (~651-656) and `verify:integration` `jobs` construction (~814-820) route python `test` commands through `reuseAwareTestCommand`. **Modify.**
- Tests: `test/dispatch/reuse.test.ts`, `test/dispatch/handlers.test.ts`, `test/live/astropy-reuse.test.ts` (live-gated).

**Reused existing machinery (no change):** `SOURCE_CHECK_SCRIPT`, `SOURCE_CHECK_SCRIPT_NAME`, `isValidImportName`, `resolvePythonInterpreter` (`src/dispatch/provision.ts`); `pythonImportName` (`src/setup/lang/python.ts`); `commandFor` (`src/dispatch/components.ts`); `runCommand` (`src/util/run-command.ts`).

---

### Task 1: The reuse probe + resolver (`src/dispatch/reuse.ts`)

**Files:** Create `src/dispatch/reuse.ts` + `test/dispatch/reuse.test.ts`.
**Interfaces:**
- `export async function pythonEnvReady(absCwd: string, importName: string | undefined, interp: string): Promise<boolean>` — true iff `import <importName>` resolves to a file under `absCwd` AND `import pytest` succeeds, both run with `interp`.
- `export async function reuseAwareTestCommand(c: Component, checkType: string, detectedCommand: string, absCwd: string): Promise<string>` — returns `<interp> -m pytest` for a ready python `test` gate; else `detectedCommand`.

- [ ] **Step 1: Failing test** — `test/dispatch/reuse.test.ts`. Stub `runCommand` (via a module mock or dependency-injected variant — mirror how existing dispatch tests stub it) so the source-check exits 0 and `import pytest` exits 0 → `pythonEnvReady` true; source-check exits 1 → false; pytest missing (exit 1) → false; `importName` undefined → false. For `reuseAwareTestCommand`: a python component with `checkType==="test"` and a ready env → `"python3 -m pytest"`; a non-python component → `detectedCommand`; `checkType==="lint"` → `detectedCommand`.

```ts
test("pythonEnvReady true only when worktree imports AND pytest present", async () => {
  // stub: sourceCheck→0, `import pytest`→0
  expect(await pythonEnvReady("/wt", "astropy", "python3")).toBe(true);
});
test("reuseAwareTestCommand swaps to pytest for a ready python test gate", async () => {
  const c = { name: "python", kind: "python", paths: ["**"], commands: { test: "tox" } } as any;
  expect(await reuseAwareTestCommand(c, "test", "tox", "/wt")).toBe("python3 -m pytest");
});
test("reuseAwareTestCommand leaves non-python / non-test unchanged", async () => {
  const c = { name: "frontend", kind: "node", paths: ["**"], commands: { test: "npm run test" } } as any;
  expect(await reuseAwareTestCommand(c, "test", "npm run test", "/wt")).toBe("npm run test");
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/dispatch/reuse.ts`:**

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFor } from "./components.ts";
import type { Component } from "./profile.ts";
import {
  SOURCE_CHECK_SCRIPT,
  SOURCE_CHECK_SCRIPT_NAME,
  isValidImportName,
  resolvePythonInterpreter,
} from "./provision.ts";
import { pythonImportName } from "../setup/lang/python.ts";
import { runCommand } from "../util/run-command.ts";

const PROBE_TIMEOUT_MS = 60 * 1000; // a probe, not a build — bounded tight

export async function pythonEnvReady(
  absCwd: string,
  importName: string | undefined,
  interp: string,
): Promise<boolean> {
  if (importName === undefined || !isValidImportName(importName)) return false;
  const scriptDir = mkdtempSync(join(tmpdir(), "styre-reuse-")); // OUTSIDE the worktree (Fix A)
  try {
    const scriptPath = join(scriptDir, SOURCE_CHECK_SCRIPT_NAME);
    writeFileSync(scriptPath, SOURCE_CHECK_SCRIPT);
    const src = await runCommand(`${interp} "${scriptPath}" "${importName}" "${absCwd}"`, {
      cwd: absCwd,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (src.exitCode !== 0) return false;
    const runner = await runCommand(`${interp} -c "import pytest"`, {
      cwd: absCwd,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return runner.exitCode === 0;
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

export async function reuseAwareTestCommand(
  c: Component,
  checkType: string,
  detectedCommand: string,
  absCwd: string,
): Promise<string> {
  if (checkType !== "test" || c.kind !== "python") return detectedCommand;
  let interp: string;
  try {
    interp = resolvePythonInterpreter();
  } catch {
    return detectedCommand; // no interpreter → can't probe → run what was detected
  }
  const importName = pythonImportName(absCwd);
  if (await pythonEnvReady(absCwd, importName, interp)) return `${interp} -m pytest`;
  return detectedCommand;
}
```
*(Confirm `commandFor` import is used — if the resolver takes `detectedCommand` as a param it may not need `commandFor`; drop the unused import to keep lint green.)*

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(run): python env readiness probe + reuse-aware test command`

---

### Task 2: `verify:check` routes python test commands through the resolver

**Files:** Modify `src/dispatch/handlers.ts` (the `toRun` construction ~651-656); Test `test/dispatch/handlers.test.ts`.

**Interfaces:** Consumes `reuseAwareTestCommand` (Task 1).

- [ ] **Step 1: Failing test** — a python component whose detected `test` is `tox`, with a stubbed ready env → `verify:check test` runs `python3 -m pytest` (assert on the recorded `command`/`ran` detail), not `tox`. And with a NOT-ready env → runs `tox` (unchanged).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — replace the sync `toRun` map:

```ts
const toRun = realImpacted
  .filter((c) => commandFor(c, checkType) !== undefined)
  .map((c) => ({ component: c.name, command: commandFor(c, checkType) as string, dir: c.dir }));
```
with an async resolution:

```ts
const toRun = await Promise.all(
  realImpacted
    .filter((c) => commandFor(c, checkType) !== undefined)
    .map(async (c) => ({
      component: c.name,
      command: await reuseAwareTestCommand(
        c,
        checkType,
        commandFor(c, checkType) as string,
        join(worktreePath, c.dir ?? ""),
      ),
      dir: c.dir,
    })),
);
```
Add `import { reuseAwareTestCommand } from "./reuse.ts";`. (The surrounding handler is already `async`.)

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(verify): reuse a ready python env (pytest) instead of the detected harness`

---

### Task 3: `verify:integration` routes python test commands through the resolver

**Files:** Modify `src/dispatch/handlers.ts` (verify:integration `jobs` construction ~814-820); Test `test/dispatch/handlers.test.ts`.

- [ ] **Step 1: Failing test** — at `verify:integration`, a python component with `test: "tox"` and a stubbed ready env runs `python3 -m pytest` (not `tox`) for its test job; `build` jobs and non-python components unchanged.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — the current loop:

```ts
for (const c of deps.profile.components) {
  for (const key of ["build", "test"] as const) {
    const cmd = commandFor(c, key);
    if (cmd) jobs.push({ label: `${c.name}:${key}`, command: cmd, dir: c.dir });
  }
}
```
becomes:

```ts
for (const c of deps.profile.components) {
  for (const key of ["build", "test"] as const) {
    const cmd = commandFor(c, key);
    if (!cmd) continue;
    const command =
      key === "test"
        ? await reuseAwareTestCommand(c, key, cmd, join(worktreePath, c.dir ?? ""))
        : cmd;
    jobs.push({ label: `${c.name}:${key}`, command, dir: c.dir });
  }
}
```

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(verify): integration reuses a ready python env for the test gate`

---

### Task 4: Live validation against the astropy image (the "check how conda does" gate)

**Files:** Create `test/live/astropy-reuse.test.ts` (live-gated — skipped unless `STYRE_LIVE_ASTROPY=1` and Docker + the image are present, mirroring any existing live-gated test convention).

**Why:** the operator's stated goal — "check how styre does after it switches over to using conda." The reuse logic is unit-tested with stubs (Tasks 1–3); this is the real proof.

- [ ] **Step 1: Write the live test** — in the `swebench/sweb.eval.arm64.astropy_1776_astropy-12907` container (repo at `/testbed`, active conda `testbed` env): (a) assert `pythonEnvReady("/testbed", "astropy", "python")` is **true** (the editable env is detected); (b) assert `reuseAwareTestCommand(<python component, test, "tox">, "test", "tox", "/testbed")` returns `python -m pytest`; (c) run that command with a short timeout and assert it **starts collecting/running tests** (does not hang in an env build) — i.e. it gets past the tox-rebuild wall. Capture the elapsed time to inform the *deferred* budget question.
- [ ] **Step 2: Run gated** (`STYRE_LIVE_ASTROPY=1 bun test test/live/astropy-reuse.test.ts`) and record: does reuse detect the env, swap to pytest, and start running tests within budget?
- [ ] **Step 3:** ensure the default (ungated) `bun test` skips it cleanly; `bun test` + typecheck + lint green.
- [ ] **Step 4: Commit** `test(live): astropy conda-env reuse runs pytest (gated on STYRE_LIVE_ASTROPY)`

---

## Self-Review

- **Spec coverage (design §1.2):** readiness probe reusing the source-under-test check + `import pytest` (Task 1) ✓; reuse runs `<interp> -m pytest` when proven, else the detected command (Tasks 1–3) ✓; both verify sites routed (Tasks 2–3) ✓; live astropy proof (Task 4) ✓. Pre-warm, env-selection, the budget question, TIA, CI-reading all explicitly deferred ✓.
- **Placeholder scan:** the only soft spot is how existing dispatch tests stub `runCommand` (Task 1 Step 1) — the implementer must match the repo's real stubbing convention (module mock vs injected dep); flagged, not hand-waved. No TBDs.
- **Type consistency:** `pythonEnvReady(absCwd, importName, interp)` and `reuseAwareTestCommand(c, checkType, detectedCommand, absCwd)` (Task 1) are consumed with the same signatures in Tasks 2–3. `resolvePythonInterpreter`/`pythonImportName`/`SOURCE_CHECK_SCRIPT*`/`isValidImportName` are imported from their real modules (confirmed to exist).

## Deferred / named follow-ons

- **Pre-warm + tox env-selection** (the no-ready-env case) — separate plan; astropy doesn't need it (it has a ready env).
- **Whole-suite runtime vs `VERIFY_TIMEOUT_MS`** — operator decision: measure via Task 4 first; only address (longer budget / test-selection) if a reused run actually exceeds budget.
- **Skipping the wasted `pip install tox` at provision** when reuse applies — a harmless-fast optimization; not worth the cross-step coupling yet.
- **Ruby/PHP readiness probes**, native typecheckers, CI-reading.

## Execution Handoff

Plan saved to `docs/plans/2026-07-06-python-env-reuse-plan.md`. Two execution options: (1) subagent-driven (fresh subagent per task, review between) — recommended; (2) inline with checkpoints.
