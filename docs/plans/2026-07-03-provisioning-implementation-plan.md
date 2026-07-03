# Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `styre run` provisions its own verify environment — a runner-owned `provision` step that, before the first verify, installs each component's deps (recorded at `styre setup` in the `prepare` field) so the **detected** verify command runs against the **worktree source**.

**Architecture:** `styre setup`'s per-language detectors record a lockfile/harness-matched install command in the existing `Component.prepare` field. A new `provision` resolver step (before the first `verify:check`) runs each component's `prepare` deterministically via `runCommand`, skipping when a cheap per-kind readiness probe says the env is already ready. It is a **probed effect** (re-runs after park/resume because the worktree is wiped), never overriding the verify command.

**Tech stack:** TypeScript, Zod, Bun (`bun test`), SQLite step-journal.

**Design doc:** `docs/brainstorms/2026-07-03-provisioning-design.md` (read it — this plan implements it).

## Global Constraints

- Branch `feat/polyglot-setup`; commit per task; never `main`.
- **Never override the detected verify command** (`commands.test`). `provision` only makes it runnable + ensures the worktree source is under test. (Design §5; review F1/F2.)
- `prepare` stays an **optional** field; **no `schemaVersion` bump** (additive). The change is a *semantic* reinterpretation (stored → executed) — update the two doc-comments that assert "never run" (Task 3).
- All install commands must pass the existing `isCommandSafe` gate in `runRegistry` (`src/setup/detect-components.ts:14-32`) — no shell metacharacters. Keep install commands metachar-free single strings.
- `provision` runs via `runCommand(command, { cwd, timeoutMs })` with `verifyEnv` (creds scrubbed) — identical capability treatment to `verify:check`.
- A component with **no** `prepare` is **skipped** (graceful degradation, design §9) — never a hard failure at run-start. Do **not** add `prepare` to `assertResolved`/`MUST_HAVE` in `src/cli/run.ts`.
- `provision` is a **step, not a stage** (DS-2). It lives inside `implement`, before the first verify.
- Security posture (design §6, decided here): `provision` executes the setup-recorded, `isCommandSafe`-validated `prepare` — the operator already sees it at setup (`src/cli/setup.ts:150`), and it runs under the same trust model + sandbox containment as verify commands. **No new run-time approval gate**; the doc-comment updates (Task 3) state plainly that it executes install code contained by the sandbox.
- Test runner: `bun test`. Also run `bun run typecheck` and `bun run lint`; both must stay green.

## File map

- `src/setup/lang/node.ts` — emit lockfile-aware `prepare` (Task 1).
- `src/setup/lang/python.ts` — emit test-command-matched `prepare` (Task 2).
- `src/dispatch/profile.ts`, `src/setup/command-safety.ts` — flip the "never run" doc-comments (Task 3).
- `src/dispatch/provision.ts` (**new**) — the pure readiness probe + provision-plan builder (Task 4).
- `src/dispatch/handlers.ts` — register the `provision` handler (Task 4).
- `src/daemon/resolver.ts` — insert the `provision` step before first verify (Task 5).
- `src/cli/park.ts` (resume path) — reset `provision` to pending on resume (Task 6).
- `docs/architecture/control-loop.md`, `docs/architecture/minimal-loop.md` — step-catalog + loopback entry (Task 7).

---

### Task 1: Node detector emits a lockfile-aware `prepare`

**Files:**
- Modify: `src/setup/lang/node.ts` (the `prepare: "npm install"` at ~line 39; add a `nodePrepare(dir)` helper)
- Test: `test/setup/lang/node.test.ts`

**Interfaces:**
- Produces: `export function nodePrepare(compDir: string): string` — the install command for a Node component rooted at absolute path `compDir`.

- [ ] **Step 1: Write the failing test**

Add to `test/setup/lang/node.test.ts` (match the file's existing `fixture(files)` helper that mkdtemps a repo + returns root):

```ts
import { nodeDef, nodePrepare } from "../../../src/setup/lang/node.ts";

describe("nodePrepare (lockfile-aware)", () => {
  test("yarn.lock -> frozen yarn install", () => {
    const root = fixture({ "yarn.lock": "", "package.json": '{"scripts":{"test":"jest"}}' });
    expect(nodePrepare(root)).toBe("yarn install --frozen-lockfile");
  });
  test("pnpm-lock.yaml -> frozen pnpm install", () => {
    const root = fixture({ "pnpm-lock.yaml": "", "package.json": "{}" });
    expect(nodePrepare(root)).toBe("pnpm install --frozen-lockfile");
  });
  test("package-lock.json -> npm ci", () => {
    const root = fixture({ "package-lock.json": "{}", "package.json": "{}" });
    expect(nodePrepare(root)).toBe("npm ci");
  });
  test("no lockfile -> npm install (last resort)", () => {
    const root = fixture({ "package.json": "{}" });
    expect(nodePrepare(root)).toBe("npm install");
  });
  test("detect() sets the lockfile-aware prepare on the component", () => {
    const root = fixture({ "package.json": '{"scripts":{"test":"jest"}}', "package-lock.json": "{}" });
    expect(nodeDef.detect(root)[0]?.prepare).toBe("npm ci");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`bun test test/setup/lang/node.test.ts` → `nodePrepare` undefined / component still `"npm install"`).

- [ ] **Step 3: Implement**

In `src/setup/lang/node.ts`, add (near the top, after imports):

```ts
/** The install command for a Node component rooted at `compDir` — lockfile-aware so the
 *  provision step is deterministic (frozen installs). Falls back to `npm install` only when
 *  no lockfile is present. Runner-executed by the provision step (dispatch/provision.ts). */
export function nodePrepare(compDir: string): string {
  if (existsSync(join(compDir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(compDir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(join(compDir, "package-lock.json"))) return "npm ci";
  return "npm install";
}
```

Then replace the `prepare: "npm install",` line in the `components.push({...})` with:

```ts
        prepare: nodePrepare(isRoot ? repoDir : join(repoDir, dir)),
```

(`join`/`existsSync` are already imported in this file.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: `bun test` (full) + `bun run typecheck` + `bun run lint` — all green.** (No existing test should assert `prepare === "npm install"`; if one does, update it to the lockfile-aware value.)
- [ ] **Step 6: Commit**

```bash
git add src/setup/lang/node.ts test/setup/lang/node.test.ts
git commit -m "feat(setup): node prepare is lockfile-aware (npm ci/yarn/pnpm), for the provision step"
```

---

### Task 2: Python detector emits a test-command-matched `prepare`

**Files:**
- Modify: `src/setup/lang/python.ts`
- Test: `test/setup/lang/python.test.ts`

**Interfaces:**
- Produces: `export function pythonPrepare(repoDir: string): string | undefined` — the install command matched to `pythonTestCommand(repoDir)`, or `undefined` when no safe install can be determined (→ component skipped by provision).

**Rationale (design §5):** the prepare must make the *detected* command runnable AND put the worktree source under test. For a source-building harness (`tox`/`nox`) that means installing the harness (it builds from source). For bare `pytest`, an **editable** install (`pip install -e .`) so `import <pkg>` resolves to the worktree, never a separately-installed copy (review F1/F2). Unknown → `undefined` (skip; honestly measured).

- [ ] **Step 1: Write the failing test**

Add to `test/setup/lang/python.test.ts` (existing `fixture` helper):

```ts
import { pythonDef, pythonPrepare } from "../../../src/setup/lang/python.ts";

describe("pythonPrepare (matched to the detected test command)", () => {
  test("tox.ini -> pip install tox (tox builds from source)", () => {
    const root = fixture({ "tox.ini": "", "setup.py": "" });
    expect(pythonPrepare(root)).toBe("pip install tox");
  });
  test("noxfile.py -> pip install nox", () => {
    const root = fixture({ "noxfile.py": "" });
    expect(pythonPrepare(root)).toBe("pip install nox");
  });
  test("pytest project with pyproject -> editable install (worktree under test)", () => {
    const root = fixture({ "pyproject.toml": "[tool.pytest.ini_options]\n" });
    expect(pythonPrepare(root)).toBe("pip install -e .");
  });
  test("no package + requirements.txt -> requirements install", () => {
    const root = fixture({ "requirements.txt": "requests\n" });
    expect(pythonPrepare(root)).toBe("pip install -r requirements.txt");
  });
  test("nothing installable -> undefined (component skipped by provision)", () => {
    const root = fixture({ "main.py": "print(1)" });
    expect(pythonPrepare(root)).toBeUndefined();
  });
  test("detect() sets prepare on the component", () => {
    const root = fixture({ "tox.ini": "", "setup.py": "" });
    expect(pythonDef.detect(root)[0]?.prepare).toBe("pip install tox");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

In `src/setup/lang/python.ts`, add after `pythonTestCommand`:

```ts
/** Install command matched to the detected test command, for the runner-executed provision
 *  step. tox/nox build from source, so we install the harness itself; bare pytest needs the
 *  worktree editable-installed so it imports the worktree source (NOT a separately-installed
 *  copy). `undefined` when nothing installable is detected — provision skips that component. */
export function pythonPrepare(repoDir: string): string | undefined {
  const test = pythonTestCommand(repoDir);
  if (test === "tox") return "pip install tox";
  if (test === "nox") return "pip install nox";
  // pytest / python -m pytest: editable install so the worktree source is under test.
  if (
    existsSync(join(repoDir, "pyproject.toml")) ||
    existsSync(join(repoDir, "setup.py")) ||
    existsSync(join(repoDir, "setup.cfg"))
  ) {
    return "pip install -e .";
  }
  if (existsSync(join(repoDir, "requirements.txt"))) return "pip install -r requirements.txt";
  return undefined;
}
```

Then in `pythonDef.detect`, set `prepare` on **both** the root and nested `components.push({...})` (nested uses `join(repoDir, dir)` for its component dir, mirroring how the test command is computed per-dir):

```ts
        prepare: pythonPrepare(repoDir),   // root component
```
```ts
        prepare: pythonPrepare(join(repoDir, dir)),   // nested component
```

(Confirm `existsSync`/`join`/`readFileSync` imports exist; add `existsSync`/`join` if the nested branch needs them.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: `bun test` + typecheck + lint — green.**
- [ ] **Step 6: Commit**

```bash
git add src/setup/lang/python.ts test/setup/lang/python.test.ts
git commit -m "feat(setup): python prepare matched to test command (tox/nox harness, else editable install)"
```

---

### Task 3: Flip the `prepare` "never run" contract in the doc-comments

**Files:**
- Modify: `src/dispatch/profile.ts` (the `prepare` field comment ~line 100 and the parse-boundary comment ~76-81)
- Modify: `src/setup/command-safety.ts` (the "HYGIENE, NOT A SANDBOX" / F1 framing comment)
- Test: none (comment-only; correctness is that the codebase's stated contract matches the new behavior).

This is a load-bearing honesty change (review P0-1, F6): `prepare` becomes runner-executed. The comments that assert it is "never run by styre" are now false and must be corrected so a future reader (and the commercial plane) has the right contract.

- [ ] **Step 1: Edit `src/dispatch/profile.ts`** — change the `prepare` field comment to:

```ts
  /** Install command for this component, EXECUTED by the runner-owned `provision` step
   *  (src/dispatch/provision.ts) before the first verify — makes the detected verify command
   *  runnable against the worktree source. Optional; absent → provision skips this component.
   *  Validated by isCommandSafe at setup (detect-components.ts). (Was WO-12 detect-only.) */
  prepare: z.string().optional(),
```

Update any nearby parse-boundary comment (the block ~lines 76-81 asserting `prepare` is never executed) to note it is now executed by the provision step under the same command-safety + sandbox treatment as verify commands.

- [ ] **Step 2: Edit `src/setup/command-safety.ts`** — update the doc-comment so it no longer claims `prepare` is stored-only; state that `prepare` (like verify/build/check commands) is executed via `runCommand`/`sh -c` and that `isCommandSafe` is hygiene (no metachars), containment being the sandbox — for provision and verify alike.

- [ ] **Step 3: `bun run typecheck` + `bun run lint` — green** (comment-only; no behavior).
- [ ] **Step 4: Commit**

```bash
git add src/dispatch/profile.ts src/setup/command-safety.ts
git commit -m "docs(profile): prepare is now runner-executed by the provision step (flip WO-12 'never run')"
```

---

### Task 4: The provision plan/probe (pure) + the `provision` handler

**Files:**
- Create: `src/dispatch/provision.ts` (pure: readiness probe + per-component plan)
- Create: `test/dispatch/provision.test.ts`
- Modify: `src/dispatch/handlers.ts` (register the `"provision"` handler)

**Interfaces:**
- Produces:
  - `export interface ProvisionAction { component: string; command: string; cwd: string }`
  - `export function isComponentReady(kind: string, compAbsDir: string): boolean` — cheap probe: does the env already satisfy the detected command? Node/sveltekit → `node_modules/` present. Everything else → `false` (always run prepare; the honest "install every run" for Python, per §5).
  - `export function planProvision(components: Component[], worktreePath: string): ProvisionAction[]` — for each component with a `prepare` that isn't already-ready, an action with `cwd = join(worktreePath, dir ?? "")`.
- Consumes (handler): `HandlerContext` (`{db, ticket, step, workUnitId, config}`), `RegistryDeps` (`{runner, agentConfig, profile, worktreeRoot, timeoutMs, resumeContext}`), `worktreeFor`, `ensureWorktree`, `runCommand`, `insertSignal` — all already in `handlers.ts` scope.

- [ ] **Step 1: Write the failing test** (`test/dispatch/provision.test.ts`) — pure functions only, using a tmp dir:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "../../src/dispatch/profile.ts";
import { isComponentReady, planProvision } from "../../src/dispatch/provision.ts";

function comp(over: Partial<Component>): Component {
  return { name: "c", kind: "node", paths: ["**"], commands: {}, extensions: [], ...over } as Component;
}

describe("isComponentReady", () => {
  test("node with node_modules present -> ready (skip)", () => {
    const d = mkdtempSync(join(tmpdir(), "prov-"));
    mkdirSync(join(d, "node_modules"));
    expect(isComponentReady("node", d)).toBe(true);
  });
  test("node without node_modules -> not ready", () => {
    const d = mkdtempSync(join(tmpdir(), "prov-"));
    expect(isComponentReady("node", d)).toBe(false);
  });
  test("python -> never probed-ready (always install; honest install-every-run)", () => {
    const d = mkdtempSync(join(tmpdir(), "prov-"));
    expect(isComponentReady("python", d)).toBe(false);
  });
});

describe("planProvision", () => {
  test("emits an action per component with a prepare that isn't ready", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    const actions = planProvision(
      [comp({ name: "py", kind: "python", prepare: "pip install -e ." }),
       comp({ name: "fe", kind: "node", prepare: "npm ci", dir: "web" })],
      wt,
    );
    expect(actions).toEqual([
      { component: "py", command: "pip install -e .", cwd: wt },
      { component: "fe", command: "npm ci", cwd: join(wt, "web") },
    ]);
  });
  test("skips components with no prepare", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    expect(planProvision([comp({ name: "x", kind: "go" })], wt)).toEqual([]);
  });
  test("skips a node component whose node_modules already exists (ready)", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    mkdirSync(join(wt, "web", "node_modules"), { recursive: true });
    expect(
      planProvision([comp({ name: "fe", kind: "node", prepare: "npm ci", dir: "web" })], wt),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module absent).

- [ ] **Step 3: Implement `src/dispatch/provision.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "./profile.ts";

export interface ProvisionAction {
  component: string;
  command: string;
  cwd: string;
}

/** Cheap readiness probe: is the detected verify command already runnable without provisioning?
 *  Node/sveltekit: node_modules present (also how a plane pre-warm is consumed). Every other
 *  kind returns false — we always run its prepare (the honest "install every run" for Python,
 *  since "worktree source under test" is not observable by a cheap check; design §5, review F2). */
export function isComponentReady(kind: string, compAbsDir: string): boolean {
  if (kind === "node" || kind === "sveltekit") return existsSync(join(compAbsDir, "node_modules"));
  return false;
}

/** One action per component that has a `prepare` and isn't already ready. cwd is the component's
 *  dir under the worktree (root component → worktree root). Never touches commands.test. */
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

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Register the handler in `src/dispatch/handlers.ts`** — inside `buildDispatchRegistry`, register `"provision"` (mirror `verify:check`'s worktree + runCommand + insertSignal shape):

```ts
  registry.register("provision", async (ctx: HandlerContext) => {
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);
    const actions = planProvision(deps.profile.components, worktreePath);
    for (const a of actions) {
      const run = await runCommand(a.command, {
        cwd: a.cwd,
        timeoutMs: deps.timeoutMs ?? PROVISION_TIMEOUT_MS,
      });
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: null,
        signalType: "provision",
        result: run.exitCode === 0 ? "pass" : run.timedOut ? "error" : "fail",
        branchHeadSha: null,
        detail: { component: a.component, command: a.command, exitCode: run.exitCode },
      });
      if (run.exitCode !== 0) {
        throw new Error(
          `provision: ${a.component} '${a.command}' exited ${run.exitCode}${run.timedOut ? " (timed out)" : ""}: ${run.stderr.slice(0, 500)}`,
        );
      }
    }
    return { provisioned: actions.length };
  });
```

Add near the other timeout consts: `const PROVISION_TIMEOUT_MS = 15 * 60 * 1000;` (installs can be slow; design §5). Add `import { planProvision } from "./provision.ts";` and confirm `insertSignal`'s `branchHeadSha` accepts null (it does elsewhere; if not, pass the latest sha via the same helper `verify:check` uses).

- [ ] **Step 6: `bun test` + typecheck + lint — green.**

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/provision.ts test/dispatch/provision.test.ts src/dispatch/handlers.ts
git commit -m "feat(run): provision handler — install each component's prepare before verify (probe-then-install)"
```

---

### Task 5: Resolver inserts `provision` before the first verify

**Files:**
- Modify: `src/daemon/resolver.ts` (implement branch, ~106-135)
- Test: `test/daemon/resolver.test.ts`

**Interfaces:**
- Consumes: existing `done(db, ticketId, stepKey)` and `step(stepKey, stepType, handlerKey, workUnitId)` helpers.
- Produces: when the first `verify:check` would fire and `provision` has not succeeded, the resolver returns `step("provision", "provision", "provision", null)` first.

- [ ] **Step 1: Write the failing test** (extend `test/daemon/resolver.test.ts`, matching its `makeTestDb`/`succeed`/`nextStepKey` pattern):

```ts
test("provision runs once before the first verify, then verify proceeds", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  // unit dispatched -> now verifying
  succeed(db, ticketId, "implement:wu1:dispatch");
  setWorkUnitStatus(db, ticketId, 1, "verifying"); // use the file's existing status helper

  // first thing before verify is provision
  expect(nextStepKey(db, ticketId)).toEqual({
    kind: "step",
    stepKey: "provision",
    stepType: "provision",
    handlerKey: "provision",
    workUnitId: null,
  });

  // after provision succeeds, verify proceeds
  succeed(db, ticketId, "provision");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "verify:wu1:test" });
  db.close();
});
```

(Use whatever helper the file already has to mark a unit `verifying`; if none, mirror the existing dispatch→verify test's setup.)

- [ ] **Step 2: Run — expect FAIL** (resolver returns `verify:wu1:test` directly).

- [ ] **Step 3: Implement** — in the implement branch, gate the first verify:

```ts
        const check = nextUnrunCheck(db, u);
        if (check !== null) {
          if (!done(db, ticketId, "provision")) {
            return step("provision", "provision", "provision", null);
          }
          return step(`verify:wu${u.seq}:${check}`, "verify", "verify:check", u.id);
        }
```

(Insert only the two `if (!done(...)) return step(...)` lines before the existing verify return. The `verify:integration` path (§119-128) needs no change: `done("provision")` is already true by the time all units verify.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: `bun test` + typecheck + lint — green.**
- [ ] **Step 6: Commit**

```bash
git add src/daemon/resolver.ts test/daemon/resolver.test.ts
git commit -m "feat(run): resolver runs provision once before the first verify"
```

---

### Task 6: Re-provision after park/resume (the probed-effect requirement)

**Files:**
- Modify: `src/cli/park.ts` (resume path, after the stale-worktree wipe ~line 189-201)
- Test: `test/cli/park.test.ts` (or the resume test file — match where resume is tested)

**Why (review P0-2):** resume wipes the worktree and mints a fresh `worktreeRoot`, so installed deps are gone; but the journaled `provision` step is `succeeded`, so the resolver's `done("provision")` would skip it → the post-resume verify runs in an un-provisioned tree. Fix: on resume, **reset the `provision` step to pending** so it re-runs against the fresh worktree. (`recover()` won't do this — it only resets `running` steps.)

- [ ] **Step 1: Write the failing test** — resume a parked ticket whose `provision` step is `succeeded`; assert that after the resume-prep, the `provision` step is back to `pending` (so it will re-run). Use `makeTestDb` + the step-journal + park's resume-prep function. If resume logic isn't unit-testable in isolation, extract the reset into a small pure-ish helper `resetProvisionForResume(db, ticketId)` and test that directly:

```ts
test("resume resets a succeeded provision step to pending (deps are gone on the fresh worktree)", () => {
  const { db, ticketId } = makeTestDb();
  succeed(db, ticketId, "provision");
  expect(getByKey(db, ticketId, "provision")?.status).toBe("succeeded");
  resetProvisionForResume(db, ticketId);
  expect(getByKey(db, ticketId, "provision")?.status).toBe("pending");
  db.close();
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — add the helper (next to the resume logic in `src/cli/park.ts`, reusing the step-journal repo functions `getByKey` and `steps.resetToPending`):

```ts
/** On resume the worktree is wiped + re-created fresh, so any installed deps are gone. The
 *  journaled provision step is `succeeded`, which would make the resolver skip it — reset it so
 *  it re-runs (probe-then-install) against the fresh worktree. Provision is a PROBED EFFECT
 *  (design §9): its idempotency is the handler's readiness probe, not exactly-once journaling. */
export function resetProvisionForResume(db: Database, ticketId: number): void {
  const s = getByKey(db, ticketId, "provision");
  if (s && s.status === "succeeded") steps.resetToPending(db, s.id);
}
```

Call `resetProvisionForResume(db, ticketId)` in the resume path immediately after the stale-worktree cleanup block. (Confirm the exact imports: `getByKey` from the workflow-step repo the resolver's `done()` uses; `steps.resetToPending` as in `src/daemon/recover.ts`.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: `bun test` + typecheck + lint — green.**
- [ ] **Step 6: Commit**

```bash
git add src/cli/park.ts test/cli/park.test.ts
git commit -m "fix(run): re-provision on resume — reset the provision step (fresh worktree loses deps)"
```

---

### Task 7: Step-catalog + loopback documentation

**Files:**
- Modify: `docs/architecture/control-loop.md` (step catalog §4; Loopback Atlas §8)
- Modify: `docs/architecture/minimal-loop.md` (the `next_step_key` state machine)

**Interfaces:** documentation only — encodes the invariants a future step-author must hold.

- [ ] **Step 1: Add a step-catalog entry** for `provision` in `control-loop.md` §4, at the Implement→Verify boundary (a new **S2c**), matching the S3 template:

```
**S2c · `provision`** — runner-executed (no LLM): before the first verify of the ticket, make
each component's detected verify command runnable against the worktree source.
- **Guard:** ticket in `implement`, a unit is `verifying`, and `provision` has not yet succeeded
  (reset on park/resume — a probed effect, not exactly-once).
- **Input:** `profile.components[].prepare` (recorded at setup); the worktree.
- **Output:** `signal(type="provision")` per component; installed deps in the worktree.
- **Commands/Capability:** runs `prepare` via `runCommand`+`verifyEnv` (creds scrubbed);
  `isCommandSafe`-validated at setup; NEVER runs or overrides `commands.test`.
- **Failure → route:** a non-zero `prepare` exit fails the step → [Loopback Atlas code, §8]:
  an environment/provisioning failure (distinct from a code-verify fail) → escalate, not a
  code loopback (it will not self-heal via re-implementation).
```

- [ ] **Step 2: Add the loopback routing** in §8 for a provision failure (environment error → escalation path, per the design's "honest failure" — do NOT route it back to implement as if the code were wrong).

- [ ] **Step 3: Update `minimal-loop.md`** — note the `provision` step fires once before the first `verify:check` and re-runs on resume.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/control-loop.md docs/architecture/minimal-loop.md
git commit -m "docs(control-loop): step catalog + loopback routing for the provision step"
```

---

## Self-Review

**1. Spec coverage (design doc → tasks):** §4 files all covered (node T1, python T2, profile/command-safety comments T3, provision.ts+handlers T4, resolver T5, park T6, docs T7). §5 correctness (never override command; editable install; worktree-under-test) → T2 + T4 (`isComponentReady` returns false for python = always install; pytest→editable). §6 security posture → T3 comments + global constraint (decided: no new gate; sandbox containment). §7 seam → nothing built (correct; deferred). §9 crash-resume/probed-effect → T6. §9 graceful degradation (no prepare → skip) → T4 `planProvision`. §10 all components → T4 iterates `profile.components`.

**2. Placeholder scan:** the one soft spot — the exact status helper to mark a unit `verifying` (T5) and the exact step-journal import names (`getByKey`, `steps.resetToPending`) in T6 — are flagged inline to reconcile against the file's existing helpers, not invented. No TBDs.

**3. Type consistency:** `ProvisionAction`/`planProvision`/`isComponentReady` signatures identical across T4 def, its test, and the handler call. `step("provision","provision","provision",null)` matches the resolver test's expected `StepDescriptor` and the handler's registered key. `prepare` is read (never written) at run; `commands.test` is never mutated (C1 invariant holds by construction — no task touches it).

## Deferred (named, not dropped — from the design)

- **Go/Rust/JVM/Ruby/PHP** prepare/probe (same template as T1/T2).
- **Monorepo** lockfile-at-root handling for nested Node components (T1 checks the component dir only).
- **The replace-provisioning config-override seam** (design §7) — until a real customer env needs it.
- **styre's "can't-verify → deliver nothing"** behavior (design §12) — separate fix; provisioning alone doesn't close the exotic tail.

## Post-merge handoff (cross-repo)

After this lands on `feat/polyglot-setup`, re-pin styre-bench (`styreCommit` → new tip) and re-run `SMOKE=2` to confirm a SWE-bench + an MSB instance go from "blocked (env)" to verified + PR-opened.
