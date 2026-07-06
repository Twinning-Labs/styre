# Python env reuse (the conda switch) — Implementation Plan (v2, post-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a ready Python environment already tests the worktree AND can collect the suite, run `<interp> -m pytest` in it instead of the detected harness (`tox`) — fixing astropy's env-rebuild timeout and the bare-`tox`-matrix at once.

**Architecture:** A runtime **readiness probe** reusing styre's source-under-test check plus a **collection** check: for a python `test` gate, if `import <pkg>` resolves under the worktree **and** `pytest --collect-only` exits 0 (the env can actually collect *this* suite — plugins/deps present), the effective command becomes `<interp> -m pytest`; else the detected command runs unchanged. Probe + resolver live in a new `src/dispatch/reuse.ts` with an **injected runner** (the repo has no mock convention — DI is the test seam). `verify:check` and `verify:integration` route python `test` commands through it.

**Tech Stack:** TypeScript, Bun (`bun test`), embedded SQLite.

**Scope — minimal (operator: "one problem at a time").** Ships *only* the reuse switch. **Deferred:** pre-warm + tox env-selection (no-ready-env case); the whole-suite-runtime-vs-budget question (measure via the bench first); test-selection/TIA; CI-reading.

## Global Constraints

- Branch `feat/verify-gates` (continues PR #51); commit per task; **never `main`**; PR-only.
- **Reuse only when *proven*.** Two guards, both must pass: (a) `import <pkg>` resolves under the worktree (the wrong-bytes guard — effectively requires an editable install), (b) `pytest --collect-only` exits 0 (the missing-plugin guard — an env that imports pytest but lacks the suite's plugins fails here). If the probe can't run or either guard fails → run the detected command (no regression).
- **Testing seam = dependency injection.** The repo has **no** `runCommand` mock/`spyOn` convention (its live tests run real commands under `RUN_LIVE=1`, e.g. `provision.test.ts:412`). So `pythonEnvReady`/`reuseAwareTestCommand` take an **injected `run` param defaulting to `runCommand`** — unit tests pass a fake; a `RUN_LIVE` test exercises real python.
- **Honest limit (design §5.1):** reuse runs the *standard runner*, not the harness's exact config (`changedir`/`setenv`). This is **not** a claim of bit-identical reproduction; the verdict-parity gate is the **bench's held-out oracle** (validation below), not a unit assertion.
- Runner: `bun test`; `bun run typecheck` + `bun run lint` green after each task.
- **Out of scope / deferred:** pre-warm + env-selection; skipping the (fast, harmless) `pip install tox` at provision; the whole-suite budget; TIA; CI-reading; ruby/php probes.

## File Structure

- `src/dispatch/provision.ts` — **add `export`** to the module-private `SOURCE_CHECK_SCRIPT` (line 82) so `reuse.ts` can import it. **Modify (one word).**
- `src/dispatch/reuse.ts` — **new** — `pythonEnvReady()` (probe) + `reuseAwareTestCommand()` (resolver), both with an injected runner.
- `src/dispatch/handlers.ts` — `verify:check` `toRun` (~650-656) and `verify:integration` `jobs` (~814-819) route python `test` commands through the resolver. **Modify.**
- Tests: `test/dispatch/reuse.test.ts` (unit, DI + a `RUN_LIVE` real-python fixture), `test/dispatch/verify-handlers.test.ts` + `test/dispatch/verify-integration.test.ts` (wiring).

**Reused existing exports (confirmed):** `SOURCE_CHECK_SCRIPT_NAME`, `isValidImportName`, `resolvePythonInterpreter` (`provision.ts:72,133,180`); `pythonImportName` (`python.ts:43`); `commandFor` (`components.ts:59`); `runCommand` (`util/run-command.ts`). **`SOURCE_CHECK_SCRIPT` is currently NOT exported (provision.ts:82) — Task 1 fixes that.**

---

### Task 1: Export the probe script + the reuse probe/resolver (`reuse.ts`)

**Files:** Modify `src/dispatch/provision.ts` (add `export`); Create `src/dispatch/reuse.ts` + `test/dispatch/reuse.test.ts`.
**Interfaces:**
- `export type CmdRunner = (cmd: string, opts: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>`
- `export async function pythonEnvReady(absCwd: string, importName: string | undefined, interp: string, run?: CmdRunner): Promise<boolean>`
- `export async function reuseAwareTestCommand(c: Component, checkType: string, detectedCommand: string, absCwd: string, run?: CmdRunner): Promise<string>`

- [ ] **Step 1: Export the script** — in `src/dispatch/provision.ts:82`, change `const SOURCE_CHECK_SCRIPT = \`...` to `export const SOURCE_CHECK_SCRIPT = \`...`. Run `bun run typecheck` — still green.
- [ ] **Step 2: Failing test** (`test/dispatch/reuse.test.ts`) — inject a fake runner; assert the *decision logic* without real python:

```ts
import { pythonEnvReady, reuseAwareTestCommand } from "../../src/dispatch/reuse.ts";
import { resolvePythonInterpreter } from "../../src/dispatch/provision.ts";
const fake = (results: Record<string, number>) =>
  async (cmd: string) => ({ exitCode: Object.entries(results).find(([k]) => cmd.includes(k))?.[1] ?? 0, stdout: "", stderr: "", timedOut: false });

test("pythonEnvReady true only when source-check AND collect-only both exit 0", async () => {
  expect(await pythonEnvReady("/wt", "astropy", "python3", fake({ "styre-provision-check": 0, "--collect-only": 0 }))).toBe(true);
  expect(await pythonEnvReady("/wt", "astropy", "python3", fake({ "styre-provision-check": 1, "--collect-only": 0 }))).toBe(false); // wrong bytes
  expect(await pythonEnvReady("/wt", "astropy", "python3", fake({ "styre-provision-check": 0, "--collect-only": 1 }))).toBe(false); // missing plugin
  expect(await pythonEnvReady("/wt", undefined, "python3", fake({}))).toBe(false); // no import name
});
test("reuseAwareTestCommand: ready python test → pytest with the resolved interp", async () => {
  const c = { name: "python", kind: "python", paths: ["**"], commands: { test: "tox" } } as any;
  const cmd = await reuseAwareTestCommand(c, "test", "tox", "/wt", fake({ "styre-provision-check": 0, "--collect-only": 0 }));
  expect(cmd).toBe(`${resolvePythonInterpreter()} -m pytest`);
});
test("reuseAwareTestCommand: non-python / non-test unchanged (no python needed)", async () => {
  const node = { name: "fe", kind: "node", paths: ["**"], commands: { test: "npm run test" } } as any;
  expect(await reuseAwareTestCommand(node, "test", "npm run test", "/wt", fake({}))).toBe("npm run test");
  const py = { name: "py", kind: "python", paths: ["**"], commands: { lint: "ruff" } } as any;
  expect(await reuseAwareTestCommand(py, "lint", "ruff", "/wt", fake({}))).toBe("ruff");
});
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement `src/dispatch/reuse.ts`:**

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "./profile.ts";
import { SOURCE_CHECK_SCRIPT, SOURCE_CHECK_SCRIPT_NAME, isValidImportName, resolvePythonInterpreter } from "./provision.ts";
import { pythonImportName } from "../setup/lang/python.ts";
import { runCommand } from "../util/run-command.ts";

export type CmdRunner = typeof runCommand;
const SOURCE_CHECK_TIMEOUT_MS = 60 * 1000;
const COLLECT_TIMEOUT_MS = 3 * 60 * 1000; // collection imports test modules; bounded well under a full run

export async function pythonEnvReady(
  absCwd: string, importName: string | undefined, interp: string, run: CmdRunner = runCommand,
): Promise<boolean> {
  if (importName === undefined || !isValidImportName(importName)) return false;
  const scriptDir = mkdtempSync(join(tmpdir(), "styre-reuse-")); // OUTSIDE the worktree (Fix A)
  try {
    const scriptPath = join(scriptDir, SOURCE_CHECK_SCRIPT_NAME);
    writeFileSync(scriptPath, SOURCE_CHECK_SCRIPT);
    const src = await run(`${interp} "${scriptPath}" "${importName}" "${absCwd}"`, { cwd: absCwd, timeoutMs: SOURCE_CHECK_TIMEOUT_MS });
    if (src.exitCode !== 0) return false;
    const collect = await run(`${interp} -m pytest --collect-only -q`, { cwd: absCwd, timeoutMs: COLLECT_TIMEOUT_MS });
    return collect.exitCode === 0;
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

export async function reuseAwareTestCommand(
  c: Component, checkType: string, detectedCommand: string, absCwd: string, run: CmdRunner = runCommand,
): Promise<string> {
  if (checkType !== "test" || c.kind !== "python") return detectedCommand;
  let interp: string;
  try { interp = resolvePythonInterpreter(); } catch { return detectedCommand; }
  const importName = pythonImportName(absCwd);
  if (await pythonEnvReady(absCwd, importName, interp, run)) return `${interp} -m pytest`;
  return detectedCommand;
}
```

- [ ] **Step 5: Run → PASS.** Add a **`RUN_LIVE`-gated real-python test** (mirror `provision.test.ts:412`'s `const live = process.env.RUN_LIVE === "1" ? test : test.skip;`): in a temp dir write a minimal editable package (`setup.py` + `pkg/__init__.py` + `tests/test_x.py`), `pip install -e .` into the ambient env, then assert `pythonEnvReady(tmp, "pkg", resolvePythonInterpreter())` is **true** (real source-check + real collect-only), and returns **false** when the package is not installed. `bun test` (skips live) + typecheck + lint green.
- [ ] **Step 6: Commit** `feat(run): python env readiness probe (source-under-test + collect-only) + reuse-aware command`

---

### Task 2: `verify:check` routes python test commands through the resolver

**Files:** Modify `src/dispatch/handlers.ts` (the `toRun` construction ~650-656); Test `test/dispatch/verify-handlers.test.ts`.

- [ ] **Step 1: Failing test** (real-command style, `RUN_LIVE`-gated, OR assert via the recorded `command`): a python component with detected `test: "tox"` where a ready env is present → `verify:check test` runs `<interp> -m pytest` (assert the `ran`/`lastCommand` detail), not `tox`; with no ready env → runs `tox`. *(If a `RUN_LIVE` real-env fixture is impractical here, assert the wiring by spying that `reuseAwareTestCommand`'s result is what reaches `runCommand` — but prefer extending the reuse unit test over a handler mock, since the handler has no runCommand seam.)*
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — replace the sync `toRun` map (handlers.ts:650-656):

```ts
const toRun = await Promise.all(
  realImpacted
    .filter((c) => commandFor(c, checkType) !== undefined)
    .map(async (c) => ({
      component: c.name,
      command: await reuseAwareTestCommand(c, checkType, commandFor(c, checkType) as string, join(worktreePath, c.dir ?? "")),
      dir: c.dir,
    })),
);
```
Add `import { reuseAwareTestCommand } from "./reuse.ts";`. (Handler is already `async`; `worktreePath` is in scope at :553.)

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(verify): reuse a ready python env (pytest) instead of the detected harness`

---

### Task 3: `verify:integration` routes python test commands through the resolver

**Files:** Modify `src/dispatch/handlers.ts` (verify:integration `jobs` construction ~814-819); Test `test/dispatch/verify-integration.test.ts`.

- [ ] **Step 1: Failing test** — at `verify:integration`, a python component with `test: "tox"` + a ready env runs `<interp> -m pytest` for its test job; `build` jobs and non-python components unchanged. **Note:** the separate `repoCommands` loop (handlers.ts:820-822) is intentionally left on the detected command — repo-wide commands aren't per-component/per-stack, so reuse doesn't apply.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — the component loop:

```ts
for (const c of deps.profile.components) {
  for (const key of ["build", "test"] as const) {
    const cmd = commandFor(c, key);
    if (!cmd) continue;
    const command = key === "test"
      ? await reuseAwareTestCommand(c, key, cmd, join(worktreePath, c.dir ?? ""))
      : cmd;
    jobs.push({ label: `${c.name}:${key}`, command, dir: c.dir });
  }
}
```

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(verify): integration reuses a ready python env for the test gate`

---

### Task 4: Validation — the bench is the verdict-parity gate

The reuse logic is unit-tested (Task 1 DI) and probe-tested against a real editable fixture (Task 1 `RUN_LIVE`). The **verdict-parity** proof (does reuse give the same result as the harness on a known-good change?) is **not** a host unit test — `bun test` runs on the host, astropy's env is in the container, and only the bench's held-out oracle can confirm the verdict. So:

- [ ] **Step 1: Post-merge bench handoff** — after merge, re-pin `styre-bench` (`styreCommit` → this tip) and run `SMOKE=2`. **Record:** does the astropy (`astropy__astropy-12907`) instance go from **blocked (tox timeout) → the reuse path (pytest in the conda env) → verified + PR-opened**, and does the held-out oracle score the gold fix **resolved** (the parity check)? Capture the reused-run wall-clock to inform the deferred whole-suite-budget question (design §5.2).
- [ ] **Step 2:** document the result in the PR (or a follow-up note) — this is the "how does styre do after switching to conda" answer the operator asked for. If the reused run exceeds `VERIFY_TIMEOUT_MS`, that's the signal to pick up the deferred budget/test-selection lever — not a defect in this change.

*(No `bun test` in this task — the prior plan's fictional `test/e2e/`/`test/live/` container harness does not exist and is not invented here.)*

---

## Self-Review

- **Spec coverage (design §1):** source-under-test + **collect-only** probe (Task 1, review F2 fix) ✓; reuse runs `<interp> -m pytest` only when proven, else detected (Tasks 1–3) ✓; both verify sites routed, `repoCommands` intentionally not (Tasks 2–3) ✓; bench = verdict-parity gate (Task 4, review F1 fix) ✓. Pre-warm/env-selection/budget/TIA/CI-reading deferred ✓.
- **Placeholder scan:** the export fix (Task 1 Step 1) and the DI seam (no-mock-convention) are now explicit, not "mirror an existing stub." The `RUN_LIVE` gate copies the real `provision.test.ts:412` pattern. Task 2's handler test honestly notes the no-runCommand-seam and prefers the reuse-unit test. No fictional `test/e2e`/`test/live`.
- **Type consistency:** `CmdRunner`/`pythonEnvReady`/`reuseAwareTestCommand` signatures (Task 1) are consumed unchanged in Tasks 2–3; assertions use `resolvePythonInterpreter()` (not a literal `python3`) per review; `SOURCE_CHECK_SCRIPT` is exported in Task 1 Step 1 before it's imported.

## Deferred / named follow-ons
Pre-warm + tox env-selection (no-ready-env case); the whole-suite-runtime-vs-budget question (measure via Task 4 first); test-selection/TIA; skipping the wasted `pip install tox` at provision; ruby/php readiness probes; CI-reading.

## Changelog
- *v1 → v2 (2026-07-06, post 3-lens review):* exported `SOURCE_CHECK_SCRIPT` (was module-private → wouldn't compile); switched tests to **dependency injection** (repo has no mock convention — its live tests are `RUN_LIVE`-gated real commands); **strengthened the probe with `pytest --collect-only`** (import-pytest under-proved readiness → a missing plugin would turn a correct change into a fast wrong fail — review F2); **reframed validation** — the fictional container/`test/live` harness is dropped; the verdict-parity proof is the bench's held-out oracle via `SMOKE=2` (review F1); asserted the resolved interpreter, not a literal; noted `repoCommands` is intentionally not routed. Added the verdict-parity honest limit to the design (§5.1).
