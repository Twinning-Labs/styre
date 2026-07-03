# Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `styre run` provisions its own verify environment — a runner-owned `provision` step that, before the first verify, installs each component's deps (recorded at `styre setup` in `prepare`) so the **detected** verify command runs against the **worktree source**, and **proves** the worktree source is what's under test.

**Architecture:** setup's per-language detectors record a lockfile/harness-matched install command in the existing `Component.prepare`. A `provision` resolver step (before the first `verify:check` AND before `verify:integration`) runs each component's `prepare` deterministically via `runCommand`, then — for editable-install stacks (Python `pytest`) — **asserts the imported source resolves to the worktree** (escalating if not, never shipping wrong bytes). It re-runs on resume (worktree wiped) and when a loopback touches a dependency manifest.

**Tech stack:** TypeScript, Zod, Bun (`bun test`), SQLite step-journal.

**Design doc:** `docs/brainstorms/2026-07-03-provisioning-design.md`. **This plan was revised after two Opus plan-reviews; the findings (F-1…F-7) are folded in and cited per task.**

## Global Constraints

- Branch `feat/polyglot-setup`; commit per task; never `main`.
- **Never override the detected verify command** (`commands.test`). (Design §5; review F1/F2.)
- **The worktree source MUST be provably under test.** For editable-install stacks, provision runs a post-install assertion that `import <pkg>` resolves under the worktree; on failure it force-reinstalls editable, and if still failing, **fails provision → escalate** (never verifies an installed/stale copy). This is the load-bearing correctness guard the design's §11/§13 mandated. (Review F-1.)
- `prepare` stays **optional**; **no `schemaVersion` bump** (additive). It's a *semantic* reinterpretation (stored→executed) — update the two doc-comments (Task 3).
- Install/assert commands must pass `isCommandSafe` (`src/setup/command-safety.ts:8`) — no shell metacharacters (`;&|` `` ` `` `$()<>` newlines). Keep each a single metachar-free command; **do not chain with `;`/`&&`** (the handler runs multiple commands as separate steps).
- All commands run via `runCommand(cmd, {cwd, timeoutMs})` with `verifyEnv` (creds scrubbed).
- A component with no `prepare` is **skipped** (graceful degradation) — never a hard fail at run-start; do not add `prepare` to `assertResolved`.
- `provision` is a **step, not a stage** (DS-2), inside `implement`, before the first verify.
- Security posture (design §6): provision executes the setup-recorded, `isCommandSafe`-validated `prepare` (operator sees it at `setup.ts:150`), under the same trust model + sandbox as verify. **No new run-time gate.**
- Provision gets an **independent** timeout (`PROVISION_TIMEOUT_MS`, 15 min), NOT the shared `deps.timeoutMs` (review F-5).
- Runner: `bun test`; also `bun run typecheck` + `bun run lint` stay green.

## File map

- `src/setup/lang/node.ts`, `python.ts` — emit `prepare` (Tasks 1, 2).
- `src/dispatch/profile.ts`, `src/setup/command-safety.ts` — flip "never run" comments (Task 3).
- `src/dispatch/provision.ts` (**new**) — pure plan/probe + the source-check command builder (Tasks 4, 5).
- `src/dispatch/handlers.ts` — the `provision` handler (Tasks 4, 5).
- `src/daemon/resolver.ts` — insert provision before first-verify AND integration (Task 6).
- `src/cli/park.ts` — reset provision on resume (Task 7).
- `src/daemon/failure-policy.ts` — provision-failure routing (Task 8).
- `src/daemon/advance.ts` / implement handler — re-provision on manifest-touch (Task 9).
- `docs/architecture/control-loop.md`, `minimal-loop.md` — step-catalog + loopback (Task 10).

---

### Task 1: Node detector emits a lockfile-aware `prepare`

**Files:** Modify `src/setup/lang/node.ts`; Test `test/setup/lang/node.test.ts`.
**Interfaces:** `export function nodePrepare(compDir: string): string`.

- [ ] **Step 1: failing test** — add to `test/setup/lang/node.test.ts` (file's `fixture(files)` helper):

```ts
import { nodeDef, nodePrepare } from "../../../src/setup/lang/node.ts";
describe("nodePrepare (lockfile-aware)", () => {
  test("yarn.lock -> frozen", () => { const r = fixture({ "yarn.lock": "", "package.json": "{}" }); expect(nodePrepare(r)).toBe("yarn install --frozen-lockfile"); });
  test("pnpm-lock.yaml -> frozen", () => { const r = fixture({ "pnpm-lock.yaml": "", "package.json": "{}" }); expect(nodePrepare(r)).toBe("pnpm install --frozen-lockfile"); });
  test("package-lock.json -> npm ci", () => { const r = fixture({ "package-lock.json": "{}", "package.json": "{}" }); expect(nodePrepare(r)).toBe("npm ci"); });
  test("no lockfile -> npm install", () => { const r = fixture({ "package.json": "{}" }); expect(nodePrepare(r)).toBe("npm install"); });
  test("detect() sets it", () => { const r = fixture({ "package.json": '{"scripts":{"test":"jest"}}', "package-lock.json": "{}" }); expect(nodeDef.detect(r)[0]?.prepare).toBe("npm ci"); });
});
```

- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — add to `node.ts` (imports `join`/`existsSync` present):

```ts
export function nodePrepare(compDir: string): string {
  if (existsSync(join(compDir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(compDir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(join(compDir, "package-lock.json"))) return "npm ci";
  return "npm install";
}
```
Replace `prepare: "npm install",` in the `components.push({...})` with `prepare: nodePrepare(isRoot ? repoDir : join(repoDir, dir)),`.

- [ ] **Step 4: run → PASS.** (Note review F6: the two existing `node.test.ts` prepare assertions have no lockfile → still `"npm install"` → unaffected.)
- [ ] **Step 5: `bun test` + typecheck + lint green.**
- [ ] **Step 6: commit** `feat(setup): node prepare is lockfile-aware (npm ci/yarn/pnpm)`

---

### Task 2: Python detector emits a test-command-matched `prepare`

**Files:** Modify `src/setup/lang/python.ts`; Test `test/setup/lang/python.test.ts`.
**Interfaces:** `export function pythonPrepare(repoDir: string): string | undefined`.

- [ ] **Step 1: failing test** — add (file's `fixture`):

```ts
import { pythonDef, pythonPrepare } from "../../../src/setup/lang/python.ts";
describe("pythonPrepare", () => {
  test("tox -> pip install tox", () => { expect(pythonPrepare(fixture({ "tox.ini": "", "setup.py": "" }))).toBe("pip install tox"); });
  test("nox -> pip install nox", () => { expect(pythonPrepare(fixture({ "noxfile.py": "" }))).toBe("pip install nox"); });
  test("pytest+pyproject -> editable", () => { expect(pythonPrepare(fixture({ "pyproject.toml": "[tool.pytest.ini_options]\n" }))).toBe("pip install -e ."); });
  test("requirements only -> requirements", () => { expect(pythonPrepare(fixture({ "requirements.txt": "requests\n" }))).toBe("pip install -r requirements.txt"); });
  test("nothing installable -> undefined", () => { expect(pythonPrepare(fixture({ "main.py": "print(1)" }))).toBeUndefined(); });
});
```

- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — add after `pythonTestCommand` (imports present):

```ts
export function pythonPrepare(repoDir: string): string | undefined {
  const test = pythonTestCommand(repoDir);
  if (test === "tox") return "pip install tox";
  if (test === "nox") return "pip install nox";
  if (existsSync(join(repoDir, "pyproject.toml")) || existsSync(join(repoDir, "setup.py")) || existsSync(join(repoDir, "setup.cfg"))) return "pip install -e .";
  if (existsSync(join(repoDir, "requirements.txt"))) return "pip install -r requirements.txt";
  return undefined;
}
```
Set `prepare` on **both** `out.push({...})` sites (NOT `components.push` — review F2): root `prepare: pythonPrepare(repoDir)`, nested `prepare: pythonPrepare(join(repoDir, dir))`.

- [ ] **Step 4: run → PASS.**
- [ ] **Step 5: FIX the existing exact-match test** (review F2) — `test/setup/lang/python.test.ts:67-72` uses `.toEqual([{...}])`; add `prepare: "pip install -e ."` to its expected object (its fixture has `pyproject.toml`). Then `bun test` + typecheck + lint green.
- [ ] **Step 6: commit** `feat(setup): python prepare matched to test command (tox/nox/editable/requirements)`

---

### Task 3: Flip the `prepare` "never run" doc-comments

**Files:** `src/dispatch/profile.ts` (lines **93** and **101-102** — the two "never run" assertions; review F7), `src/setup/command-safety.ts:8`.

- [ ] **Step 1** — profile.ts:101-102 field comment → "Install command EXECUTED by the runner-owned `provision` step before the first verify; makes the detected verify command runnable against the worktree source. Optional; absent → skipped. isCommandSafe-validated at setup." Update the schema doc-comment at line 93 similarly (drop "stored, never run").
- [ ] **Step 2** — command-safety.ts doc-comment: state `prepare` is now executed (like verify/build/check) via `runCommand`/`sh -c`; `isCommandSafe` is hygiene, containment is the sandbox.
- [ ] **Step 3: typecheck + lint green** (comment-only).
- [ ] **Step 4: commit** `docs(profile): prepare is runner-executed by provision (flip WO-12 'never run')`

---

### Task 4: Provision plan/probe (pure) + the `provision` handler

**Files:** Create `src/dispatch/provision.ts` + `test/dispatch/provision.test.ts`; modify `src/dispatch/handlers.ts`.
**Interfaces:**
- `interface ProvisionAction { component: string; command: string; cwd: string }`
- `function isComponentReady(kind: string, compAbsDir: string): boolean` — Node/sveltekit: a **completed** `node_modules` (marker `node_modules/.package-lock.json`, written by npm/yarn on success — review F6). Else `false`.
- `function planProvision(components: Component[], worktreePath: string): ProvisionAction[]`.

- [ ] **Step 1: failing test** (`test/dispatch/provision.test.ts`) — pure fns over tmp dirs: node with `node_modules/.package-lock.json` → ready; node with only a partial `node_modules/` dir → NOT ready (F6); python → not ready; `planProvision` emits one action per prepare-bearing, not-ready component with `cwd = join(worktree, dir ?? "")`; skips no-prepare and ready components. (Shape mirrors the earlier draft; assert exact `ProvisionAction[]`.)
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement `src/dispatch/provision.ts`:**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "./profile.ts";
export interface ProvisionAction { component: string; command: string; cwd: string; }
export function isComponentReady(kind: string, compAbsDir: string): boolean {
  if (kind === "node" || kind === "sveltekit") return existsSync(join(compAbsDir, "node_modules", ".package-lock.json"));
  return false; // python + unknown: always install; correctness assured by the post-install source check (Task 5)
}
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
```

- [ ] **Step 4: run → PASS.**
- [ ] **Step 5: register the handler in `handlers.ts`** (mirror `verify:check`; independent timeout; DROP `branchHeadSha` — review F1). Add `const PROVISION_TIMEOUT_MS = 15 * 60 * 1000;`:

```ts
registry.register("provision", async (ctx: HandlerContext) => {
  const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
  ensureWorktree(repoPath, branch, worktreePath);
  const actions = planProvision(deps.profile.components, worktreePath);
  for (const a of actions) {
    const run = await runCommand(a.command, { cwd: a.cwd, timeoutMs: PROVISION_TIMEOUT_MS });
    insertSignal(ctx.db, { ticketId: ctx.ticket.id, workUnitId: null, signalType: "provision",
      result: run.exitCode === 0 ? "pass" : run.timedOut ? "error" : "fail",
      detail: { component: a.component, command: a.command, exitCode: run.exitCode } });
    if (run.exitCode !== 0) throw new Error(`provision: ${a.component} '${a.command}' exited ${run.exitCode}${run.timedOut ? " (timed out)" : ""}: ${run.stderr.slice(0, 500)}`);
    // Task 5 inserts the worktree-source assertion for editable-install components here.
  }
  return { provisioned: actions.length };
});
```
Import `planProvision` (+ the Task-5 helpers). Note: no `branchHeadSha` key; `workUnitId: null` and `detail` (unknown) are accepted by `insertSignal` (`ground-truth-signal.ts:49`).

- [ ] **Step 6: `bun test` + typecheck + lint green.**
- [ ] **Step 7: commit** `feat(run): provision handler installs each component's prepare before verify`

---

### Task 5 (CRITICAL — review F-1): prove the worktree source is under test

**Files:** `src/dispatch/provision.ts` (+ its test), `src/setup/lang/python.ts` (import-name), `src/dispatch/handlers.ts` (wire the assertion).

**Why:** `pip install -e .` exiting 0 does NOT prove `import <pkg>` resolves to the worktree — a pre-installed/conda copy can shadow it (design's exact F1/F2 disease). Provision must assert it, remediate, and escalate rather than verify wrong bytes.

**Interfaces:**
- `python.ts`: `export function pythonImportName(repoDir: string): string | undefined` — from `pyproject [project].name` (normalize `-`→`_`), else the sole top-level dir containing `__init__.py`; else `undefined`.
- `provision.ts`: `export function sourceCheckCommand(kind: string, cwd: string, importName: string | undefined): string | null` — for `python` with an editable `prepare` and a known `importName`, returns a metachar-free `python -c '...'` that imports the package and asserts its `__file__` resolves under `cwd`; else `null`.

- [ ] **Step 1: failing tests** — `sourceCheckCommand` returns a `python -c` string containing the importName + the cwd for a python editable case, `null` for node/unknown/no-name; `pythonImportName` reads `[project]\nname = "astropy"` → `astropy`, and finds a top-level `pkg/__init__.py` → `pkg`. **Regression guard (the §11 test):** an integration-style test that seeds a tmp "worktree" whose editable install is shadowed by a copy earlier on `sys.path`, runs the `sourceCheckCommand`, and asserts it **exits non-zero** (proves we detect wrong-bytes). Mark it live-gated if it needs a real `python` on PATH.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — `pythonImportName` in `python.ts` (reuse `readFileSync`/`findManifests`); `sourceCheckCommand` in `provision.ts`. The command (single line, no forbidden metachars — note `python -c` uses a string arg; keep it free of `;&|$()` by using a module-file check via `importlib.util.find_spec` and `str.__contains__`, e.g. a `python -c "import importlib.util,pathlib as p,sys; s=importlib.util.find_spec('NAME'); sys.exit(0 if s and s.origin and str(p.Path('CWD').resolve()) in str(p.Path(s.origin).resolve()) else 1)"` — verify it passes `isCommandSafe`; if `()`/`$`/`;` are unavoidable, write the check to a temp `.py` file in the worktree at provision time and run `python that_file.py NAME CWD`, which is metachar-free).
- [ ] **Step 4: wire into the handler** (Task 4 Step 5 marker). After a component's `prepare` succeeds, if `sourceCheckCommand(c.kind, cwd, pythonImportName(cwd))` is non-null: run it; if it exits non-zero, run a remediation `pip install -e . --force-reinstall --no-deps` (cwd) and re-run the check; if STILL non-zero, `throw` a `"provision: worktree source not under test for <c>"` error (→ escalate, Task 8). Record a `signal(type="provision", result="fail")` on the escalate path.
- [ ] **Step 5: run → PASS; `bun test` + typecheck + lint green.**
- [ ] **Step 6: commit** `feat(run): provision asserts the worktree source is under test (never verify a shadowed copy)`

---

### Task 6: Resolver runs provision before the first verify AND before integration

**Files:** `src/daemon/resolver.ts`; Test `test/daemon/resolver.test.ts`.

- [ ] **Step 1: failing tests** (async; `await succeed(...)` — review F3; use `insertWorkUnit({..., status: "verifying"})` — review F4):

```ts
test("provision runs once before the first unit verify", async () => {
  const { db, ticketId } = makeTestDb(); setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verifying" });
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "step", stepKey: "provision", stepType: "provision", handlerKey: "provision", workUnitId: null });
  await succeed(db, ticketId, "provision");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "verify:wu1:test" });
  db.close();
});
test("provision also gates verify:integration when units have no per-unit checks", async () => {
  const { db, ticketId } = makeTestDb(); setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "data", verifyCheckTypes: [], status: "verifying" });
  // all units verified with no checks -> integration; provision must gate it
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
  db.close();
});
```

- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — gate BOTH sites with `if (!done(db, ticketId, "provision")) return step("provision", "provision", "provision", null);`: (a) inside the implement branch before returning `verify:wu…`, and (b) in the `allUnitsVerified` branch before returning `verify:integration` (review F-3).
- [ ] **Step 4: run → PASS; full suite + typecheck + lint green.**
- [ ] **Step 5: commit** `feat(run): resolver runs provision before first unit-verify and before integration`

---

### Task 7: Re-provision on park/resume

**Files:** `src/cli/park.ts` (resume path, after the stale-worktree cleanup ~189-201, before `recover()`); Test `test/cli/park.test.ts`.

- [ ] **Step 1: failing test** — define a local `async succeed` (or call `runStep` directly — `succeed` is NOT shared, review F5); assert `resetProvisionForResume(db, ticketId)` turns a succeeded provision step `pending` **and** zeroes `attempt` (review F-7). Import `getByKey` from `db/repos/workflow-step.ts`.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — add to `park.ts`, call it in `resumeRun` after the cleanup block:

```ts
export function resetProvisionForResume(db: Database, ticketId: number): void {
  const s = getByKey(db, ticketId, "provision");
  if (s && s.status === "succeeded") { steps.resetToPending(db, s.id); steps.resetAttempt(db, s.id); }
}
```
(Add a `resetAttempt(db, id)` repo helper in `workflow-step.ts` setting `attempt = 0` if none exists.)

- [ ] **Step 4: run → PASS. Add a wiring assertion** (review F-7 testing gap): a test that `resumeRun` on a parked ticket leaves `provision` pending (covers `--resume`; note `--accept-head` reaches the same call site).
- [ ] **Step 5: full suite + typecheck + lint green.**
- [ ] **Step 6: commit** `fix(run): re-provision on resume (fresh worktree loses deps; reset step + attempt)`

---

### Task 8: Provision-failure routing (escalate, don't loopback)

**Files:** `src/daemon/failure-policy.ts`; Test `test/daemon/failure-policy.test.ts`.

**Why (review F-4):** a provision throw currently falls through to the generic `retry` tail → escalates only at `attempt>=max` (3×, ~45 min of identical failing installs). A broken lockfile won't self-heal on identical retry, and the "never loopback to implement" property is unenforced/untested.

- [ ] **Step 1: failing test** — a `step_type: "provision"` failure returns `{ decision: "escalated" }` (or retry once then escalate), and NEVER sets a work-unit to pending (never loopback).
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — add near the top of `applyFailurePolicy`, before the verify branches: `if (step.step_type === "provision") { ...escalate to human_resume after 1 attempt... return { decision: "escalated" }; }` (mirror the existing `human_resume` escalation insert used at `failure-policy.ts:62`).
- [ ] **Step 4: run → PASS; full suite green.**
- [ ] **Step 5: commit** `feat(run): provision failure escalates (env error won't self-heal via re-implement)`

---

### Task 9: Re-provision when a loopback edits a dependency manifest

**Files:** the implement post-commit path (`src/daemon/advance.ts` or the implement handler where the unit's diff is known); Test alongside.

**Why (review F-2):** if a later `implement` adds a dependency (edits a manifest), the once-gated provision is skipped → verify fails "module not found" → loopback → the agent can't install → escalation loop.

- [ ] **Step 1: failing test** — a pure helper `diffTouchesManifest(changedPaths: string[]): boolean` returns true for `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`; false otherwise.
- [ ] **Step 2/3: implement** the helper in `src/dispatch/provision.ts`; after an implement dispatch whose committed diff touches a manifest, `resetProvisionForResume`-style reset the `provision` step to pending (reuse the Task-7 helper or a shared `resetProvision(db, ticketId)`), so the resolver's `!done("provision")` gate re-fires before the next verify.
- [ ] **Step 4: run → PASS; full suite green.**
- [ ] **Step 5: commit** `fix(run): re-provision when a loopback edits a dependency manifest`

---

### Task 10: Step-catalog + loopback documentation

**Files:** `docs/architecture/control-loop.md` (§4 step catalog as **S2c**; §8 Loopback Atlas), `minimal-loop.md`.

- [ ] Add the `S2c · provision` catalog entry (runner-executed; guard = implement + a unit verifying/all-verified + `!done("provision")`, reset on resume/manifest-touch; input `prepare`; output `signal(type="provision")` + installed deps + proven worktree-under-test; commands = `prepare` + editable-source assertion via `runCommand`/`verifyEnv`, never `commands.test`; failure → **escalate** (env error, not a code loopback)). Add the §8 routing. Update `minimal-loop.md`. Commit `docs(control-loop): provision step catalog + loopback`.

---

## Self-Review

**Spec coverage:** design §4 files all covered; §5 correctness → Tasks 2+4+**5**; §6 posture → Task 3 + constraints; §9 resume → Task 7; §9 degradation → Task 4; §10 all components → Task 4. **Review findings:** F-1→Task 5; F-2→Task 9; F-3→Task 6(b); F-4→Task 8; F-5→Task 4 (independent timeout); F-6→Task 4 (completeness marker); F-7→Task 7 (attempt reset + wiring test); mechanical F1-F5→folded (branchHeadSha dropped, python.test fix, async/await, `insertWorkUnit(status)`, local `succeed`); F7 line refs→Task 3.

**Placeholder scan:** the one soft spot — whether the `python -c` source check passes `isCommandSafe` (`()`/`$` may be forbidden) — is flagged in Task 5 Step 3 with a concrete fallback (write a temp `.py` and run it metachar-free). No TBDs.

**Type consistency:** `ProvisionAction`/`planProvision`/`isComponentReady`/`sourceCheckCommand`/`pythonImportName` signatures consistent across defs, tests, and handler. `commands.test` is never written (C1 holds by construction). `step("provision","provision","provision",null)` matches the resolver test + the registered handler key.

## Honest limitation (surface to the operator)
Task 5's correctness guard means a SWE-bench-style repo whose pre-installed copy cannot be displaced (conda-managed files pip can't remove) will **escalate** rather than verify-green. That is the *correct* outcome (honesty over a false pass), but it means such instances won't resolve until a stronger remediation (env rebuild) exists — deferred. The bench will record them as provisioning-escalations, not false resolves.

## Deferred (named)
Go/Rust/JVM/Ruby/PHP; monorepo lockfile-at-root; the replace-provisioning config-override seam; styre's "can't-verify → deliver nothing" behavior; stronger conda-displacement remediation.

## Post-merge handoff
Re-pin styre-bench (`styreCommit` → new tip) and re-run `SMOKE=2`; confirm a Node (MSB) instance goes blocked(env)→verified→PR, and observe the Python (SWE-bench) instance either verify-green or **escalate honestly** (not false-resolve).
