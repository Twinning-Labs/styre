# Path-free disposable wiring (discovery + marker gate) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make `styre run --in-place` (and `styre setup`) **path-free** — styre discovers the repo root from its cwd instead of being told — while keeping the disposability gate a **repo-scoped marker** (`<repoRoot>/.styre-disposable`), fixing the resume gap and dropping the bench-specific detached-HEAD signal.

**Architecture:** a `discoverRepoRoot()` helper (`git rev-parse --show-toplevel`, fail-closed) resolves the root; `run.ts` overrides the single source `profile.targetRepo` with it before ports/dispatch; the gate (`assertInPlaceSafe`) becomes marker-presence + tracked-dirty (detached-HEAD dropped); resume re-checks marker presence (language-agnostic) and re-applies the override; `setup` no-arg discovers + gates on the marker before its write-capable enrichment agent. Builds on the in-place mechanics already in this branch (PR #52).

**Tech Stack:** TypeScript, Bun (`bun test`). Runner: `bun test`; `bun run typecheck` + `bun run lint` stay green.

## Global Constraints

- Branch `feat/in-place-execution` (PR #52); commit per task (**Conventional Commits** titles/subjects — `feat(run): …` etc.; the `pr-title` CI check + squash-merge changelog depend on it); **never `main`**; PR-only.
- **Discovery is cwd-only and fail-closed:** `discoverRepoRoot` **throws** if cwd isn't a git repo — it must NEVER swallow the failure and let the stale `profile.targetRepo` stay live (that reintroduces "operate on a repo cwd isn't in"). No marker-carried-path fallback.
- **Single override:** `profile.targetRepo` is the one mutable source (→ `insertProject`/`project.target_repo`, forge ports, preflight). Override it with the discovered root **before** ports/`runTicket` (fresh run) and **before** ports (resume).
- **Gate = repo-scoped marker (regular file) + tracked-dirty; detached-HEAD DROPPED.** Marker stays at `<repoRoot>/.styre-disposable` (already there in #52). The marker is **defense-in-depth against misuse, not proof** — the code implements the checks; the honesty lives in the design doc.
- **Resume re-checks marker PRESENCE only** (language-agnostic) — NOT tracked-dirty (the run's own in-progress commits legitimately dirty the tree mid-run).
- **`setup` gate before enrichment:** no-arg `setup` must assert the marker **before** `runSetup` invokes the enrichment agent (repo write). Explicit `setup <repo>` is unchanged (operator named the target).
- Test seam = **dependency injection** (no mock convention); real git in temp repos; `RUN_LIVE=1`-gated where a full run/agent is needed.

## File Structure

- `src/dispatch/in-place.ts` — **modify** — add `discoverRepoRoot()` + `assertInPlaceMarker()`; rework `assertInPlaceSafe` (drop detached-HEAD, reuse the marker helper). One responsibility: in-place preconditions.
- `src/cli/run.ts` — **modify** — discover + override `profile.targetRepo` in the `--in-place` preflight (`run.ts` `async run`, the `if (args["in-place"] && !resume)` block).
- `src/cli/park.ts` — **modify** — resume: re-apply the override + re-check the marker before dispatch (`resumeRun`, after the `inPlace` derivation ~:184).
- `src/cli/setup.ts` — **modify** — `repo` positional optional; no-arg discovers + gates on the marker (citty wrapper, before `runSetup`).
- Tests: `test/dispatch/in-place.test.ts`, `test/cli/park-inplace.test.ts`, `test/cli/setup*.test.ts`.

**Reused (confirmed on branch):** `defaultGit`/`GitRun` + `assertInPlaceSafe`/`assertInPlaceIdentity` (`in-place.ts`); `profile.targetRepo` single source (`run.ts:102` ports, `:119` runTicket → `insertProject` `run-ticket.ts:98`); `resumeRun` (`park.ts`, `inPlace` at :184, ports at :263); `runSetup` (`setup.ts:82`, resolve at :92, enrichment at :98/:102).

---

### Task 1: In-place safety primitives (`in-place.ts`) — discovery, marker helper, gate rework

**Files:** Modify `src/dispatch/in-place.ts`; Test `test/dispatch/in-place.test.ts`.
**Interfaces — Produces:** `discoverRepoRoot(cwd?, git?): string`, `assertInPlaceMarker(repoPath): void`; `assertInPlaceSafe` now marker+tracked-dirty (no detached-HEAD).

- [ ] **Step 1: Failing tests** (real git temp repos; `tmpRepo()`/`tmpRepoOnBranch()` from the existing file):

```ts
import { statSync } from "node:fs";
test("discoverRepoRoot returns the git toplevel of cwd", () => {
  const repo = tmpRepo();
  expect(discoverRepoRoot(repo)).toBe(Bun.spawnSync(["git","rev-parse","--show-toplevel"],{cwd:repo}).stdout.toString().trim());
});
test("discoverRepoRoot throws (fail-closed) when cwd is not a git repo", () => {
  expect(() => discoverRepoRoot(mkdtempSync(join(tmpdir(),"nonrepo-")))).toThrow(/no git repo/);
});
test("assertInPlaceMarker passes with a regular-file marker, throws without", () => {
  const repo = tmpRepo();
  expect(() => assertInPlaceMarker(repo)).toThrow(/marker/);
  writeFileSync(join(repo,".styre-disposable"),"");
  expect(() => assertInPlaceMarker(repo)).not.toThrow();
});
test("assertInPlaceMarker rejects a non-regular-file marker (F5)", () => {
  const repo = tmpRepo();
  Bun.spawnSync(["mkdir", join(repo,".styre-disposable")]);
  expect(() => assertInPlaceMarker(repo)).toThrow(/regular file/);
});
test("assertInPlaceSafe: marker required even on a NAMED branch (detached-HEAD dropped)", () => {
  const repo = tmpRepoOnBranch();          // on a named branch, no marker
  expect(() => assertInPlaceSafe(repo)).toThrow(/marker/);
  writeFileSync(join(repo,".styre-disposable"),"");
  expect(() => assertInPlaceSafe(repo)).not.toThrow();   // marker present + clean → ok, branch state irrelevant
});
test("assertInPlaceSafe: tracked-dirty still refused", () => {
  const repo = tmpRepo(); writeFileSync(join(repo,".styre-disposable"),"");
  writeFileSync(join(repo,"f.txt"),"x"); Bun.spawnSync(["git","add","f.txt"],{cwd:repo});
  expect(() => assertInPlaceSafe(repo)).toThrow(/tracked/);
});
```
**Also update the existing detached-HEAD tests:** the #52 test "detached HEAD + clean passes" must change — detached-HEAD alone (no marker) now **throws**. Rewrite those cases to the marker-only semantics; do not leave them asserting the old behavior.

- [ ] **Step 2: Run → FAIL** (`discoverRepoRoot`/`assertInPlaceMarker` don't exist; `assertInPlaceSafe` still accepts detached).
- [ ] **Step 3: Implement** in `src/dispatch/in-place.ts` (add `import { statSync } from "node:fs";`):

```ts
export function discoverRepoRoot(cwd: string = process.cwd(), git: GitRun = defaultGit): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new Error(`--in-place: no git repo at the working directory ${cwd}; launch with WORKDIR / docker -w set to the checkout.`);
  }
}

/** Repo-scoped disposability signal: a REGULAR file <repoPath>/.styre-disposable. Defense-in-depth
 *  against misuse, NOT proof (a mount/hook/commit could forge it — see the design doc). */
export function assertInPlaceMarker(repoPath: string): void {
  const m = join(repoPath, ".styre-disposable");
  if (!existsSync(m) || !statSync(m).isFile()) {
    throw new Error(`--in-place refused: no .styre-disposable marker (regular file) at ${repoPath}; refusing to mutate a checkout that may be owned.`);
  }
}
```
Rework `assertInPlaceSafe` (drop the `detached` line + the `!detached && !marker` block; reuse the helper):

```ts
export function assertInPlaceSafe(repoPath: string, git: GitRun = defaultGit): void {
  assertInPlaceMarker(repoPath);
  if (git(["status", "--porcelain", "--untracked-files=no"], repoPath) !== "") {
    throw new Error(`--in-place refused: ${repoPath} has uncommitted tracked changes.`);
  }
  console.error(`IN-PLACE: mutating ${repoPath} on a branch (HEAD ${git(["rev-parse", "--short", "HEAD"], repoPath)}).`);
}
```
Update `assertInPlaceSafe`'s docstring to drop the detached-HEAD mention.

- [ ] **Step 4: Run → PASS.** `bun test test/dispatch/in-place.test.ts`, typecheck, lint green.
- [ ] **Step 5: Commit** `feat(run): repo-root discovery + repo-scoped marker gate (drop detached-HEAD)`

---

### Task 2: Fresh-run discovery + override (`run.ts`)

**Files:** Modify `src/cli/run.ts`; Test `test/dispatch/in-place.test.ts` (override-propagation unit) or a `RUN_LIVE` run test.
**Interfaces — Consumes:** `discoverRepoRoot` (Task 1).

- [ ] **Step 1: Failing test** — assert that with `--in-place`, `profile.targetRepo` is overridden to the discovered root before it reaches `insertProject`/ports. Prefer a focused test: extract nothing new — call the preflight logic path via a `RUN_LIVE`-gated run of `styre run --in-place` in a temp git repo (marker present), then assert the DB's `project.target_repo` equals the repo root (not the profile's original `targetRepo`). If a full run is too heavy, assert the wiring by unit-testing that `discoverRepoRoot()`'s result is what's assigned (read-through), and rely on Task 1's discovery unit + this task's code review.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `src/cli/run.ts`, the `--in-place` preflight block becomes:

```ts
if (args["in-place"] && !(args.resume && args.resume.length > 0)) {
  const { discoverRepoRoot, assertInPlaceSafe, assertInPlaceIdentity } = await import("../dispatch/in-place.ts");
  profile.targetRepo = discoverRepoRoot();     // cwd git-toplevel; THROWS (fail-closed) if not a repo — never falls through to the stale profile path
  assertInPlaceSafe(profile.targetRepo);
  await assertInPlaceIdentity(profile.targetRepo, profile);
}
```
`profile` is the same mutable object later passed to `makeProjectorPorts` (`run.ts:102`), `buildDispatchRegistry`, and `runTicket` (`run.ts:119` → `insertProject`), so the one assignment routes the discovered root everywhere. **Do not** wrap `discoverRepoRoot()` in a try/catch here — its throw must abort the run (caught by the outer `try` → `analytics.cliError`).

- [ ] **Step 4: Run → PASS.** `bun test`, typecheck, lint green.
- [ ] **Step 5: Commit** `feat(run): --in-place discovers the repo root from cwd and overrides targetRepo`

---

### Task 3: Resume — re-apply override + marker re-check (`park.ts`)

**Files:** Modify `src/cli/park.ts`; Test `test/cli/park-inplace.test.ts`.
**Interfaces — Consumes:** `assertInPlaceMarker` (Task 1).

- [ ] **Step 1: Failing test** — an in-place resume (DB latest `worktree_path === project.target_repo`) where the marker is **absent** → resume **throws before any repo mutation** (assert no branch created / HEAD unchanged); with the marker present → proceeds; and `profile.targetRepo` is re-applied so ports use `project.target_repo`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `resumeRun` (`src/cli/park.ts`), immediately after `const inPlace = getLatestWorktreePath(db, ticketId) === project.target_repo;` (~:184), and **before** the ports build (~:263) and the dispatch drive:

```ts
if (inPlace) {
  profile.targetRepo = project.target_repo;                       // re-apply the discovered override (feasibility: forge ports read profile.targetRepo)
  const { assertInPlaceMarker } = await import("../dispatch/in-place.ts");
  assertInPlaceMarker(project.target_repo);                       // F1: language-agnostic disposability re-check before checkout -B (assertInPlaceSafe is NOT re-run — HEAD sits on the styre branch mid-run; tracked-dirty is noisy)
}
```

- [ ] **Step 4: Run → PASS.** Full `bun test`, typecheck, lint green.
- [ ] **Step 5: Commit** `feat(run): in-place resume re-checks the disposability marker + re-applies the override`

---

### Task 4: `setup` no-arg discovery + marker gate (`setup.ts`)

**Files:** Modify `src/cli/setup.ts`; Test `test/cli/setup*.test.ts`.
**Interfaces — Consumes:** `discoverRepoRoot`, `assertInPlaceMarker` (Task 1).

- [ ] **Step 1: Failing test** — the citty `setup` wrapper with **no** `repo` arg, in a temp git repo: **without** a marker → throws (before any enrichment/agent call — inject a spy `deps` that records whether enrichment ran and assert it did NOT); **with** a marker → discovers the cwd root and calls `runSetup({ repo: <discovered>, … })`. Explicit `setup <repo>` path unchanged (no marker required).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**
  - `setup.ts` wrapper args: `repo: { type: "positional", required: false, description: "Path to the target repo (omit to discover the cwd repo — requires a .styre-disposable marker)" }`.
  - In the wrapper `async run({ args })`, before calling `runSetup`, resolve + gate:
    ```ts
    let repo = args.repo;
    if (!repo) {
      const { discoverRepoRoot, assertInPlaceMarker } = await import("../dispatch/in-place.ts");
      repo = discoverRepoRoot();          // no-arg → discover cwd's repo (throws fail-closed if not a repo)
      assertInPlaceMarker(repo);          // gate BEFORE runSetup runs the write-capable enrichment agent
    }
    // ... runSetup({ repo, out: args.out, ... })   // pass the resolved `repo`
    ```
  (The gate sits in the wrapper, ahead of `runSetup`'s enrichment at `setup.ts:98,102`. `runSetup(explicitPath)` keeps its named-target contract — no marker required when the operator passes a path.)

- [ ] **Step 4: Run → PASS.** `bun test`, typecheck, lint green.
- [ ] **Step 5: Commit** `feat(setup): optional repo arg — discover cwd root, gated by the disposability marker`

---

## Self-Review

- **Spec coverage (v3):** discovery cwd-only fail-closed (Task 1 `discoverRepoRoot` throws; Task 2 no try/catch) ✓; single override on fresh run (Task 2) + resume (Task 3) ✓; gate = marker(regular file)+tracked-dirty, detached-HEAD dropped (Task 1) ✓; resume marker re-check, language-agnostic (Task 3, F1) ✓; setup no-arg discover+marker-gate-before-enrichment (Task 4, F4/F5) ✓; F5 lstat regular file (Task 1) ✓. The forgeability honesty (F2) is design-doc text, not code. The deferred overlay-vs-mount check is out of scope.
- **Placeholder scan:** the soft spot is Task 2's test (run.ts is a CLI entry with no clean unit seam) — named honestly with a `RUN_LIVE` fallback, matching the repo's real-command convention; the discovery *logic* is unit-tested in Task 1. Existing detached-HEAD tests are explicitly flagged for rewrite (Task 1).
- **Type consistency:** `discoverRepoRoot(cwd?, git?)`, `assertInPlaceMarker(repoPath)` (Task 1) are consumed verbatim in Tasks 2–4; `GitRun`/`defaultGit` reused; `assertInPlaceSafe` signature unchanged (callers unaffected).

## Execution Handoff

Plan saved to `docs/plans/2026-07-06-in-place-discovery-plan.md`. Recommended: subagent-driven execution — the **safety-critical crux is Task 1 (the gate rework + discovery) and Task 3 (the resume marker re-check, the F1 fix)**; review those on the strongest model, with an overall review at the end.
