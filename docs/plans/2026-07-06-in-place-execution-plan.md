# In-place execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add a `styre run --in-place` mode that works on a branch in the repo root (instead of a separate git worktree) when the caller declares the checkout disposable — so a pre-built editable env (which points at the repo root) is the source-under-test and the shipped conda reuse fires natively.

**Architecture:** one flag threaded as `RegistryDeps.inPlace`; `worktreeFor`/`depsFor` resolve `worktreePath = inPlace ? repoPath : join(worktreeRoot, ident)`; the two git primitives (`ensureWorktree`, `removeWorktree`) detect in-place via `worktreePath === repoPath` (no signature change); a run-start **preflight** enforces the safety gate (detached-HEAD-or-marker + tracked-dirty) and the identity assertion (the active env's `<pkg>` resolves under the repo root) and fails fast; park/resume **derives** in-place from the persisted `worktree_path` (no new schema). No changes to `reuse.ts` or the verify handlers.

**Tech Stack:** TypeScript, Bun (`bun test`), embedded SQLite. Runner: `bun test`; `bun run typecheck` + `bun run lint` stay green.

## Global Constraints

- Branch `feat/in-place-execution` (draft PR #52); commit per task; **never `main`**; PR-only.
- **In-place is refused unless BOTH:** (a) HEAD is **detached** OR a `.styre-disposable` marker file exists in the repo root, AND (b) `git status --porcelain --untracked-files=no` is empty (no un-committed *tracked* work). Refusal is a hard, clear error. Log a loud banner on entry. (Reviewers: "clean tree" alone allows branch hijack / ref-reset orphaning; untracked `--porcelain` would false-refuse the editable env's `.so`/`.egg-info` residue.)
- **CLI flag only** (`--in-place`); **no `STYRE_IN_PLACE` env var** (it inherits into child processes → silent global hijack).
- **Identity assertion:** when `--in-place`, each python component's `import <pkg>` must resolve under `realpath(profile.targetRepo)`; else **fail fast** (never fall into provision's editable-remediation recompile).
- **Never** `git worktree remove` the repo root; **never** `git worktree add` at the repo root.
- **Resume is same-container only**; derive `inPlace` from `getLatestWorktreePath(db, ticketId) === project.target_repo` — no new schema.
- **Daemon is out of scope** (its shared-`worktreeRoot`/K-ticket loop can't do in-place); `--in-place` is `styre run` only.
- Test seam = **dependency injection** (repo has no mocks; live tests gate on `RUN_LIVE=1`, e.g. `provision.test.ts`).

## File Structure

- `src/dispatch/worktree.ts` — **modify** `ensureWorktree` (in-place branch-in-repo path) + `removeWorktree` (no-op in-place). One responsibility: git working-surface primitives.
- `src/dispatch/handlers.ts` — **modify** `RegistryDeps` (+`inPlace`), `worktreeFor` (:97), `depsFor` (:120) to resolve `worktreePath` by `inPlace`.
- `src/cli/run.ts` — **modify** add `--in-place` arg (:44) + thread into `buildDispatchRegistry` (:91) + call the preflight.
- `src/dispatch/in-place.ts` — **new** — `assertInPlaceSafe(repoPath, git?)` + `assertInPlaceIdentity(repoPath, profile, run?)`. One responsibility: in-place preconditions.
- `src/cli/park.ts` — **modify** `resumeRun` (:156) to derive `inPlace` and skip mint/wipe/provision-reset.
- Tests: `test/dispatch/worktree.test.ts`, `test/dispatch/handlers-inplace.test.ts`, `test/dispatch/in-place.test.ts`, `test/cli/park-inplace.test.ts`.

**Reused (confirmed on main post-#51):** `git` helper + `ensureWorktree`/`removeWorktree`/`commitWorktree` (`worktree.ts`); `SOURCE_CHECK_SCRIPT`, `SOURCE_CHECK_SCRIPT_NAME`, `isValidImportName`, `resolvePythonInterpreter` (`provision.ts`, exported); `pythonImportName` (`python.ts:43`); `runCommand` (`util/run-command.ts`); `Profile`/`profile.targetRepo` (`profile.ts:117`); `getLatestWorktreePath` (`db/repos/dispatch.ts`), `getProject` (`db/repos/project.ts`).

---

### Task 1: In-place git primitives (`worktree.ts`)

**Files:** Modify `src/dispatch/worktree.ts`; Create `test/dispatch/worktree.test.ts`.
**Interfaces — Produces:** `ensureWorktree(repoPath, branch, worktreePath)` and `removeWorktree(repoPath, worktreePath)` gain in-place behavior when `worktreePath === repoPath` (signatures unchanged).

- [ ] **Step 1: Failing tests** (`test/dispatch/worktree.test.ts`) — real git in a temp repo (mirror the real-command style of `verify-handlers.test.ts`):

```ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorktree, removeWorktree } from "../../src/dispatch/worktree.ts";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-wt-test-"));
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  run(["init", "-q"]);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"]);
  run(["checkout", "-q", "--detach"]); // simulate a disposable container checkout
  return dir;
}
const head = (dir: string) =>
  Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).stdout.toString().trim();

test("ensureWorktree in-place: checks out the branch in the repo root", () => {
  const repo = tmpRepo();
  ensureWorktree(repo, "styre/eng-1", repo); // worktreePath === repoPath
  expect(head(repo)).toBe("styre/eng-1");
});
test("ensureWorktree in-place is idempotent (no reset error on repeat)", () => {
  const repo = tmpRepo();
  ensureWorktree(repo, "styre/eng-1", repo);
  ensureWorktree(repo, "styre/eng-1", repo); // ~6x/unit in reality
  expect(head(repo)).toBe("styre/eng-1");
});
test("removeWorktree in-place is a no-op (never removes the repo root)", () => {
  const repo = tmpRepo();
  ensureWorktree(repo, "styre/eng-1", repo);
  removeWorktree(repo, repo); // must not throw, must not delete the repo
  expect(head(repo)).toBe("styre/eng-1");
});
test("worktree mode still creates a separate worktree (regression)", () => {
  const repo = tmpRepo();
  const wt = join(mkdtempSync(join(tmpdir(), "styre-wt-out-")), "eng-1");
  ensureWorktree(repo, "styre/eng-1", wt);
  expect(Bun.spawnSync(["git","rev-parse","--abbrev-ref","HEAD"],{cwd:wt}).stdout.toString().trim()).toBe("styre/eng-1");
});
```

- [ ] **Step 2: Run → FAIL** (`bun test test/dispatch/worktree.test.ts`) — in-place calls currently hit `git worktree add` at the repo root and error.
- [ ] **Step 3: Implement** — edit `src/dispatch/worktree.ts`:

```ts
export function ensureWorktree(repoPath: string, branch: string, worktreePath: string): void {
  if (worktreePath === repoPath) {
    // In-place: no separate worktree. Create/switch the branch in the repo root.
    // Called ~6x/unit; `checkout -B` resets the ref to HEAD each time, so skip when already on it.
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath) === branch) return;
    git(["checkout", "-B", branch], repoPath);
    return;
  }
  if (existsSync(join(worktreePath, ".git"))) {
    return;
  }
  git(["worktree", "add", "-B", branch, worktreePath], repoPath);
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  if (worktreePath === repoPath) return; // in-place: never remove the repo root
  git(["worktree", "remove", "--force", worktreePath], repoPath);
}
```

- [ ] **Step 4: Run → PASS.** `bun test test/dispatch/worktree.test.ts`, `bun run typecheck`, `bun run lint` all green.
- [ ] **Step 5: Commit** `feat(run): in-place git primitives — branch in the repo root, no-op removeWorktree`

---

### Task 2: The `--in-place` flag + `inPlace` threading

**Files:** Modify `src/dispatch/handlers.ts` (RegistryDeps :81, worktreeFor :97, depsFor :120), `src/cli/run.ts` (:44 args, :91 registry); Test `test/dispatch/handlers-inplace.test.ts`.
**Interfaces — Consumes:** Task 1's in-place primitives. **Produces:** `RegistryDeps.inPlace: boolean`; `worktreeFor`/`depsFor` return `worktreePath = repoPath` when `inPlace`.

- [ ] **Step 1: Failing test** — export `worktreeFor` for testing (add `export` to `function worktreeFor` at handlers.ts:97), then:

```ts
import { test, expect } from "bun:test";
import { worktreeFor } from "../../src/dispatch/handlers.ts";
// build a real in-memory DB + project row (reuse the seeding helper used by verify-handlers.test.ts;
// project.target_repo = "/some/repo"), a ticket with ident "ENG-1".
test("worktreeFor: inPlace resolves worktreePath to repoPath", () => {
  const { ctx } = seedCtx({ targetRepo: "/some/repo", ident: "ENG-1" });
  const wt = worktreeFor(ctx, { inPlace: true, worktreeRoot: "/tmp/x" } as any);
  expect(wt.worktreePath).toBe("/some/repo");
  expect(wt.repoPath).toBe("/some/repo");
});
test("worktreeFor: default (worktree) resolves under worktreeRoot", () => {
  const { ctx } = seedCtx({ targetRepo: "/some/repo", ident: "ENG-1" });
  const wt = worktreeFor(ctx, { inPlace: false, worktreeRoot: "/tmp/x" } as any);
  expect(wt.worktreePath).toBe("/tmp/x/ENG-1");
});
```
*(If a `seedCtx` helper doesn't exist, build the ctx inline the way `verify-handlers.test.ts` seeds its DB — real DB, real project/ticket rows.)*

- [ ] **Step 2: Run → FAIL** (`inPlace` not a field; worktreeFor ignores it).
- [ ] **Step 3: Implement:**
  - `handlers.ts` RegistryDeps (after `worktreeRoot: string;` at :85): add `inPlace: boolean;`
  - `worktreeFor` (:105-108) and `depsFor` (:129-130): change `worktreePath: join(deps.worktreeRoot, ctx.ticket.ident),` to
    `worktreePath: deps.inPlace ? project.target_repo : join(deps.worktreeRoot, ctx.ticket.ident),`
    (in both functions; `project` is already in scope in both).
  - `run.ts` args (after `inspect` at :54): add
    ```ts
    "in-place": {
      type: "boolean",
      description: "Work on a branch in the repo root instead of a worktree (disposable single-use checkout only)",
    },
    ```
  - `run.ts` `buildDispatchRegistry({...})` (:91-96): add `inPlace: (args["in-place"] as boolean | undefined) ?? false,`
- [ ] **Step 4: Run → PASS.** `bun test`, typecheck, lint green. *(Fix any other `buildDispatchRegistry` call sites the compiler flags for the new required field — the daemon and park; park is handled in Task 4, the daemon passes `inPlace: false`.)*
- [ ] **Step 5: Commit** `feat(run): --in-place flag threads inPlace so dispatch works in the repo root`

---

### Task 3: The run-start preflight (safety gate + identity)

**Files:** Create `src/dispatch/in-place.ts` + `test/dispatch/in-place.test.ts`; Modify `src/cli/run.ts` (call the preflight).
**Interfaces — Produces:** `assertInPlaceSafe(repoPath, git?)`, `assertInPlaceIdentity(repoPath, profile, run?)` — throw on violation, return void/Promise<void> on success.

- [ ] **Step 1: Failing tests** (`test/dispatch/in-place.test.ts`) — real git temp repos for the gate; injected fakes for DI:

```ts
import { test, expect } from "bun:test";
import { assertInPlaceSafe } from "../../src/dispatch/in-place.ts";
// tmpRepo() from Task 1's pattern; a variant tmpRepoOnBranch() that stays on a named branch.
test("safe: detached HEAD + clean tracked tree passes", () => {
  expect(() => assertInPlaceSafe(tmpRepo())).not.toThrow();
});
test("refuse: on a named branch with no marker", () => {
  expect(() => assertInPlaceSafe(tmpRepoOnBranch())).toThrow(/refused/);
});
test("allow: named branch but .styre-disposable marker present", () => {
  const repo = tmpRepoOnBranch();
  writeFileSync(join(repo, ".styre-disposable"), "");
  expect(() => assertInPlaceSafe(repo)).not.toThrow();
});
test("refuse: uncommitted tracked change", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "tracked.txt"), "x");
  Bun.spawnSync(["git","add","tracked.txt"],{cwd:repo});
  expect(() => assertInPlaceSafe(repo)).toThrow(/refused/);
});
test("identity: throws when import resolves outside the repo (injected)", async () => {
  const { assertInPlaceIdentity } = await import("../../src/dispatch/in-place.ts");
  const profile = { targetRepo: "/repo", components: [{ name:"py", kind:"python", paths:["**"], commands:{} }] } as any;
  const failing = async () => ({ exitCode: 2, stdout:"", stderr:"", timedOut:false }); // source-check "elsewhere"
  await expect(assertInPlaceIdentity("/repo", profile, failing)).rejects.toThrow(/in-place/);
});
```

- [ ] **Step 2: Run → FAIL** (module doesn't exist).
- [ ] **Step 3: Implement `src/dispatch/in-place.ts`:**

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "./profile.ts";
import {
  SOURCE_CHECK_SCRIPT, SOURCE_CHECK_SCRIPT_NAME, isValidImportName, resolvePythonInterpreter,
} from "./provision.ts";
import { pythonImportName } from "../setup/lang/python.ts";
import { runCommand } from "../util/run-command.ts";

type GitRun = (args: string[], cwd: string) => string;
const defaultGit: GitRun = (args, cwd) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

/** Refuse in-place unless (detached HEAD OR .styre-disposable marker) AND no un-committed tracked work. */
export function assertInPlaceSafe(repoPath: string, git: GitRun = defaultGit): void {
  const detached = git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath) === "HEAD";
  const marker = existsSync(join(repoPath, ".styre-disposable"));
  if (!detached && !marker) {
    throw new Error(
      `--in-place refused: ${repoPath} is on a named branch and has no .styre-disposable marker; ` +
        `refusing to mutate a checkout that may be owned (use a detached HEAD or write .styre-disposable).`,
    );
  }
  if (git(["status", "--porcelain", "--untracked-files=no"], repoPath) !== "") {
    throw new Error(`--in-place refused: ${repoPath} has uncommitted tracked changes.`);
  }
  console.error(`IN-PLACE: styre will mutate ${repoPath} on a branch (HEAD ${git(["rev-parse", "--short", "HEAD"], repoPath)}).`);
}

/** Assert the active env's <pkg> for each python component resolves UNDER repoPath — else fail fast,
 *  so in-place never degrades into provision's editable-remediation recompile. */
export async function assertInPlaceIdentity(
  repoPath: string, profile: Profile, run: typeof runCommand = runCommand,
): Promise<void> {
  const pythonComponents = profile.components.filter((c) => c.kind === "python");
  if (pythonComponents.length === 0) return;
  let interp: string;
  try { interp = resolvePythonInterpreter(); } catch { return; } // no python → nothing to assert here
  const importName = pythonImportName(repoPath);
  if (importName === undefined || !isValidImportName(importName)) return; // can't derive → skip (reuse just won't fire)
  const scriptDir = mkdtempSync(join(tmpdir(), "styre-inplace-"));
  try {
    const scriptPath = join(scriptDir, SOURCE_CHECK_SCRIPT_NAME);
    writeFileSync(scriptPath, SOURCE_CHECK_SCRIPT);
    const res = await run(`${interp} "${scriptPath}" "${importName}" "${repoPath}"`, { cwd: repoPath, timeoutMs: 60_000 });
    if (res.exitCode !== 0) {
      throw new Error(
        `--in-place: the active environment's '${importName}' is not installed against the repo root ${repoPath} ` +
          `(source-check exit ${res.exitCode}). In-place requires the editable env to target the repo root.`,
      );
    }
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}
```
  Then wire into `src/cli/run.ts` — after `assertResolved(profile);` (:58) and before the resume/run branch:
```ts
if (args["in-place"] && !(args.resume && args.resume.length > 0)) {
  const { assertInPlaceSafe, assertInPlaceIdentity } = await import("../dispatch/in-place.ts");
  assertInPlaceSafe(profile.targetRepo);
  await assertInPlaceIdentity(profile.targetRepo, profile);
}
```

- [ ] **Step 4: Run → PASS.** `bun test test/dispatch/in-place.test.ts`, typecheck, lint green.
- [ ] **Step 5: Commit** `feat(run): in-place preflight — safety gate (detached/marker + tracked-dirty) + identity assertion`

---

### Task 4: Park/resume — same-container in-place derivation

**Files:** Modify `src/cli/park.ts` (`resumeRun` :156-246); Test `test/cli/park-inplace.test.ts`.
**Interfaces — Consumes:** Task 2's `RegistryDeps.inPlace`; Task 1's no-op `removeWorktree`.

- [ ] **Step 1: Failing test** — seed a DB whose latest dispatch `worktree_path` equals `project.target_repo` (an in-place park), and assert resume: (a) derives `inPlace`, (b) builds the registry with `inPlace: true`, (c) does NOT call `resetProvisionForResume`. Use the DI/seeding pattern from existing park tests; assert on the registry's `inPlace` and that provision rows are untouched.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** in `resumeRun` (`park.ts`), after `const project = getProject(...)` (:177):
```ts
const inPlace = getLatestWorktreePath(db, ticketId) === project.target_repo;
```
  - Guard the stale-worktree cleanup block (`park.ts:206-214`): `if (!inPlace) { ... removeWorktree + prune ... }` (in-place `removeWorktree` already no-ops via Task 1, but skipping avoids the harmless prune too).
  - Guard the provision re-arm (`park.ts:219`): `if (!inPlace) resetProvisionForResume(db, ticketId);` — in-place the deps persist in the repo root, so re-arming needlessly discards the reuse payoff. Update the now-false comment above it.
  - `buildDispatchRegistry({...})` in resume (`park.ts:242-246`): add `inPlace,` and, when in-place, avoid minting a tmpdir: `worktreeRoot: inPlace ? project.target_repo : mkdtempSync(join(tmpdir(), "styre-wt-")),` (unused in-place; any value is inert).
- [ ] **Step 4: Run → PASS.** Full `bun test`, typecheck, lint green.
- [ ] **Step 5: Commit** `feat(run): resume derives in-place from the persisted worktree path (same-container)`

---

## Self-Review

- **Spec coverage:** flag+seam (Task 2, spec §1/§4.1) ✓; in-place git primitives incl. the `.git`-short-circuit fix + checkout-B guard + removeWorktree no-op (Task 1, spec §4.2/§4.3) ✓; safety gate detached-HEAD-or-marker + tracked-dirty + banner (Task 3, spec §2) ✓; identity fail-fast (Task 3, spec §3) ✓; same-container resume derived from DB, skip mint/wipe/provision-reset (Task 4, spec §5) ✓. Daemon-out-of-scope, isolation-delegated, result-extraction, C-source residual = design notes, no task (spec §7/§9) ✓.
- **Placeholder scan:** the two soft spots are named, not hand-waved — the test-seeding helper (`seedCtx`/park seeding) must match `verify-handlers.test.ts`'s real-DB pattern (no mock convention), and exporting `worktreeFor` for Task 2's unit test. No fictional harness; live-python path uses DI, not a container test.
- **Type consistency:** `RegistryDeps.inPlace: boolean` (Task 2) is consumed by `worktreeFor`/`depsFor` (Task 2) and set by `run.ts` (Task 2) + `park.ts` (Task 4) + the daemon (`false`); `assertInPlaceSafe`/`assertInPlaceIdentity` (Task 3) signatures are used verbatim in `run.ts`. `ensureWorktree`/`removeWorktree` signatures are unchanged (Task 1) so all existing callers keep compiling.

## Execution Handoff

Plan saved to `docs/plans/2026-07-06-in-place-execution-plan.md`. Recommended: subagent-driven execution — fresh subagent per task, independent review between tasks (Task 3, the preflight/safety-critical one, reviewed on the strongest model), overall review at the end.
