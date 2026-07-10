# Scoped Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `commitWorktree`'s `git add -A` with per-step scoped commits so agent scratch files stop leaking into fix diffs, without ever silently dropping a legitimate new file.

**Architecture:** Each committing dispatch declares a *commit scope* (a predicate over pending paths). `runAgentDispatch` snapshots the untracked set before the agent runs, judges only what this dispatch created, rejects-and-retries undeclared new files on write steps (logs-and-continues on read-only steps), and stages by name (`git add -u` + `git add -- <declared new files>`). Failed attempts are surgically undone (`undoAttempt`) so retries start clean while sparing pre-existing cruft.

**Tech Stack:** TypeScript + Bun + embedded SQLite (bun:sqlite); zod for structured-output schemas; `bun test`.

**Design doc:** `docs/brainstorms/2026-07-11-scoped-commit-design.md` (read it — this plan implements it).

## Global Constraints

- **Never silently drop a legitimate new file.** An undeclared new file on a write step is *rejected* (loud, retried), never quietly excluded. This is the whole point of the fix.
- **Read-only steps never gate.** A stray file on a read-only step is logged (`event_log` `kind:"note"`) and left uncommitted; the dispatch still succeeds.
- **`event_log.kind` is CHECK-constrained** to `'transition'|'loopback'|'escalated'|'resumed'|'note'|'parked'` — the stray record MUST use `kind:"note"`.
- **Scope judges only files THIS dispatch created** — snapshot untracked-before, and `undoAttempt` (surgical) on every pre-commit failure exit so a failed attempt leaves no residue.
- **Emptiness is measured on the staged index** (`git diff --cached --quiet`), never `git status --porcelain`.
- **`undoAttempt` spares pre-existing cruft** (`*.egg-info` etc.) — it removes only the current attempt's new files, never a blanket clean.
- **Two checks call sites** (`handlers.ts` register ~542 + `reauthorCheckWrong` ~234) share one scope helper; that helper **defers** (allows all) on an unparseable sidecar so `reauthorCheckWrong`'s `return "rejected"` path is preserved.
- Run `bun install` first if a fresh worktree reports missing-dependency typecheck/test errors (node_modules is not shared into worktrees). No dependency changes are introduced by this plan.
- Follow existing patterns: git helpers via `Bun.spawnSync(["git", ...])` in `worktree.ts`; schemas mirror `checks-schema.ts`; prompts are `.md` files imported `with { type: "text" }`.

---

## File Structure

- `src/dispatch/worktree.ts` (modify) — add `pendingEntries`/`PendingEntry`, `stagedIndexEmpty`, `undoAttempt`; change `commitWorktree` to named staging; keep `pendingChanges` as a wrapper.
- `src/dispatch/docs-paths.ts` (modify) — add `isPlanPath` (repo-root `docs/plans/`).
- `src/dispatch/implement-schema.ts` (create) — `ImplementOutputSchema { new_files }`.
- `src/dispatch/checks-schema.ts` (modify) — add optional `new_files` to `ChecksOutputSchema`.
- `src/dispatch/commit-scope.ts` (create) — `CommitScope` type + `implementScope`, `checksScope`, `planScope`, `docScope`.
- `src/dispatch/run-dispatch.ts` (modify) — `DispatchSpec.commitScope` replaces `commitGuard`; untracked-before snapshot; scope/reject/named-staging flow; `undoAttempt` on reject/transport/park; stray `event_log` record.
- `src/dispatch/handlers.ts` (modify) — wire `commitScope` on the 5 write call sites; migrate `docs:revise` off `commitGuard`.
- `prompts/implement.md` (modify) — scratch-prevention + `new_files` sidecar instruction.
- Tests: `test/dispatch/worktree.test.ts`, `test/dispatch/commit-scope.test.ts` (create), `test/dispatch/run-dispatch.test.ts`, `test/dispatch/worktree-guard.test.ts`, `test/dispatch/docs-revise-handler.test.ts` (modify).

---

## Task 1: Worktree git primitives (additive)

New, self-contained git helpers. Nothing existing changes behavior yet, so the suite stays green.

**Files:**
- Modify: `src/dispatch/worktree.ts`
- Modify: `src/dispatch/docs-paths.ts`
- Test: `test/dispatch/worktree.test.ts` (add cases; create if absent)

**Interfaces:**
- Produces:
  - `interface PendingEntry { path: string; isNew: boolean }`
  - `function pendingEntries(worktreePath: string): PendingEntry[]`
  - `function pendingChanges(worktreePath: string): string[]` (now a wrapper over `pendingEntries`)
  - `function stagedIndexEmpty(worktreePath: string): boolean`
  - `function undoAttempt(worktreePath: string, untrackedBefore: Set<string>): void`
  - `function isPlanPath(file: string): boolean` (in `docs-paths.ts`)

- [ ] **Step 1: Write failing tests for `pendingEntries` + `isNew`**

Add to `test/dispatch/worktree.test.ts` (reuse the existing temp-git-repo helper pattern in that file; if the file lacks one, use the `gitRepo()` shape from `test/dispatch/run-dispatch.test.ts:16-26`):

```ts
import { pendingEntries, pendingChanges } from "../../src/dispatch/worktree.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-wt-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(dir, "tracked.txt"), "v1\n"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return dir;
}

test("pendingEntries: new file → isNew, tracked edit → not isNew, deletion → not isNew", () => {
  const dir = repo();
  writeFileSync(join(dir, "tracked.txt"), "v2\n");        // modify tracked
  writeFileSync(join(dir, "brand_new.py"), "x\n");         // untracked new
  Bun.spawnSync(["git", "rm", "--quiet", "already.txt"], { cwd: dir }); // (no-op if absent)
  const entries = pendingEntries(dir).sort((a, b) => a.path.localeCompare(b.path));
  expect(entries.find((e) => e.path === "brand_new.py")?.isNew).toBe(true);
  expect(entries.find((e) => e.path === "tracked.txt")?.isNew).toBe(false);
  expect(pendingChanges(dir).sort()).toEqual(["brand_new.py", "tracked.txt"]);
  rmSync(dir, { recursive: true, force: true });
});

test("pendingEntries: a staged rename's original-path token is isNew=false", () => {
  const dir = repo();
  Bun.spawnSync(["git", "mv", "tracked.txt", "renamed.txt"], { cwd: dir }); // staged rename → `R  renamed.txt\0tracked.txt`
  const entries = pendingEntries(dir);
  // Both the new path and the original path appear; neither is a brand-new untracked file.
  expect(entries.every((e) => e.isNew === false)).toBe(true);
  expect(entries.map((e) => e.path).sort()).toEqual(["renamed.txt", "tracked.txt"]);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: FAIL — `pendingEntries` is not exported.

- [ ] **Step 3: Implement `pendingEntries` + rewrite `pendingChanges` as a wrapper**

In `src/dispatch/worktree.ts`, replace the existing `pendingChanges` (currently `worktree.ts:125-147`) with:

```ts
export interface PendingEntry {
  path: string;
  isNew: boolean;
}

/** Every path in the uncommitted working-tree delta vs HEAD, with an `isNew` flag. Uses
 *  `--porcelain=v1 -z` (NUL-delimited, `quotePath=false`) so path escaping can never hide an entry.
 *  isNew ⇔ the porcelain status is exactly `??` (a brand-new untracked file). A rename/copy emits a
 *  second token (the ORIGINAL path) with no status prefix — that half is the deletion of a tracked
 *  file, so it is recorded isNew=false rather than status-parsed (its path bytes are not a status). */
export function pendingEntries(worktreePath: string): PendingEntry[] {
  const out = gitRaw(["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z"], worktreePath);
  if (out === "") return [];
  const tokens = out.split("\0").filter((t) => t !== "");
  const entries: PendingEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    const status = entry.slice(0, 2); // XY
    entries.push({ path: entry.slice(3), isNew: status === "??" });
    if (status.includes("R") || status.includes("C")) {
      i++;
      if (i < tokens.length) entries.push({ path: tokens[i], isNew: false }); // original path of the rename/copy
    }
  }
  return entries;
}

/** Paths only (compat wrapper for existing callers). */
export function pendingChanges(worktreePath: string): string[] {
  return pendingEntries(worktreePath).map((e) => e.path);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for `stagedIndexEmpty` and `undoAttempt`**

```ts
import { stagedIndexEmpty, undoAttempt } from "../../src/dispatch/worktree.ts";

test("stagedIndexEmpty: true when nothing staged, false with a staged deletion", () => {
  const dir = repo();
  expect(stagedIndexEmpty(dir)).toBe(true);
  Bun.spawnSync(["git", "rm", "--quiet", "tracked.txt"], { cwd: dir }); // staged deletion
  expect(stagedIndexEmpty(dir)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("undoAttempt: restores tracked, removes this attempt's new files, spares pre-existing cruft", () => {
  const dir = repo();
  writeFileSync(join(dir, "cruft.egg-info"), "pre\n"); // pre-existing untracked cruft
  const untrackedBefore = new Set(pendingEntries(dir).filter((e) => e.isNew).map((e) => e.path));
  // the "attempt": edit tracked + create a new file
  writeFileSync(join(dir, "tracked.txt"), "attempt\n");
  writeFileSync(join(dir, "scratch.py"), "junk\n");
  undoAttempt(dir, untrackedBefore);
  expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir }).stdout.toString().trim())
    .toBe("?? cruft.egg-info"); // tracked restored, scratch.py gone, cruft spared
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 6: Run to confirm failure** — `bun test test/dispatch/worktree.test.ts` → FAIL (not exported).

- [ ] **Step 7: Implement `stagedIndexEmpty` and `undoAttempt`**

Add to `src/dispatch/worktree.ts`:

```ts
/** True iff the STAGED INDEX has no changes. Uses `git diff --cached --quiet` (a non-throwing
 *  spawn): exit 0 → empty, exit 1 → has staged changes, anything else → a real git error → throw.
 *  Measuring the index (not `git status --porcelain`, which also reports untracked files) is what
 *  lets a read-only step with an untracked stray return changed=false instead of committing empty. */
export function stagedIndexEmpty(worktreePath: string): boolean {
  const res = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: worktreePath });
  if (res.exitCode === 0) return true;
  if (res.exitCode === 1) return false;
  throw new Error(`git diff --cached --quiet failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`);
}

/** Surgically discard the current attempt: restore all tracked files to HEAD and remove ONLY the
 *  untracked files this attempt created (untracked-now minus `untrackedBefore`). Pre-existing cruft
 *  (an earlier stray, provision's `*.egg-info`) is spared — a blanket `git clean` would delete it and
 *  break the editable install. Called on every pre-commit failure exit so retries start clean. */
export function undoAttempt(worktreePath: string, untrackedBefore: Set<string>): void {
  git(["checkout", "--", "."], worktreePath);
  const strays = pendingEntries(worktreePath)
    .filter((e) => e.isNew && !untrackedBefore.has(e.path))
    .map((e) => e.path);
  if (strays.length > 0) git(["clean", "-fd", "--", ...strays], worktreePath);
}
```

- [ ] **Step 8: Run to confirm pass** — `bun test test/dispatch/worktree.test.ts` → PASS.

- [ ] **Step 9: Write failing test for `isPlanPath`**

Add to `test/dispatch/docs-paths.test.ts` (create if absent, mirroring any existing docs-paths test):

```ts
import { isPlanPath } from "../../src/dispatch/docs-paths.ts";
test("isPlanPath: docs/plans/ only", () => {
  expect(isPlanPath("docs/plans/ENG-1.md")).toBe(true);
  expect(isPlanPath("./docs/plans/x.md")).toBe(true);
  expect(isPlanPath("docs/design/x.md")).toBe(false);
  expect(isPlanPath("src/plans/x.py")).toBe(false);
  expect(isPlanPath("docs/plans/../../src/x.py")).toBe(false);
});
```

- [ ] **Step 10: Run to confirm failure**, then implement `isPlanPath` in `src/dispatch/docs-paths.ts`:

```ts
const ROOT_PLANS_TREE = /^docs\/plans\//i;
/** True iff `file` (repo-root-relative) is under the repo-root docs/plans/ tree. Fail-closed on `..`. */
export function isPlanPath(file: string): boolean {
  const p = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.split("/").includes("..")) return false;
  return ROOT_PLANS_TREE.test(p);
}
```

- [ ] **Step 11: Run the full dispatch suite** — `bun test test/dispatch/` → all PASS (additive change, nothing regressed).

- [ ] **Step 12: Commit**

```bash
git add src/dispatch/worktree.ts src/dispatch/docs-paths.ts test/dispatch/worktree.test.ts test/dispatch/docs-paths.test.ts
git commit -m "feat(scoped-commit): worktree git primitives (pendingEntries/isNew, stagedIndexEmpty, undoAttempt, isPlanPath)"
```

---

## Task 2: Commit-scope predicates + structured-output schemas (additive)

Pure predicates + zod schemas. Additive — no existing behavior changes, suite stays green.

**Files:**
- Create: `src/dispatch/implement-schema.ts`
- Modify: `src/dispatch/checks-schema.ts`
- Create: `src/dispatch/commit-scope.ts`
- Test: `test/dispatch/commit-scope.test.ts` (create)

**Interfaces:**
- Consumes: `extractSidecar` (`src/dispatch/sidecar.ts`), `isDocPath`/`isPlanPath` (`docs-paths.ts`), `ChecksOutputSchema` (`checks-schema.ts`).
- Produces:
  - `ImplementOutputSchema` (zod) with `new_files: string[]` (default `[]`).
  - `ChecksOutputSchema` gains `new_files: string[]` (default `[]`).
  - `type CommitScope = (output: string) => (path: string, isNew: boolean) => boolean`
  - `implementScope`, `checksScope`, `planScope`, `docScope: CommitScope`.

- [ ] **Step 1: Create `ImplementOutputSchema`**

`src/dispatch/implement-schema.ts`:

```ts
import { z } from "zod";

/** implement:dispatch structured-output contract (control-loop §3a). The agent lists every NEW file
 *  it created as part of the fix so the runner can commit them by name; throwaway/debug files must
 *  NOT appear here and must not be left in the repo. Lenient: absent/empty means "no new files" (a
 *  pure-edit fix). An absent sidecar is NOT a transport failure for implement (unlike checks). */
export const ImplementOutputSchema = z.object({
  new_files: z.array(z.string()).default([]),
});

export type ImplementOutput = z.infer<typeof ImplementOutputSchema>;
```

- [ ] **Step 2: Add `new_files` to `ChecksOutputSchema`**

In `src/dispatch/checks-schema.ts`, change the `ChecksOutputSchema` object to:

```ts
export const ChecksOutputSchema = z.object({
  checksAuthored: z.array(AuthoredCheckSchema),
  /** Any NON-test helper files (a fixture / conftest.py) the author created, so a legitimate helper
   *  is committed rather than rejected as scratch. Test files themselves are already in
   *  `checksAuthored[].test_file` and need not be repeated here. Absent/empty for the common case. */
  new_files: z.array(z.string()).default([]),
});
```

- [ ] **Step 3: Write failing tests for the four scopes**

`test/dispatch/commit-scope.test.ts`:

```ts
import { test, expect } from "bun:test";
import { implementScope, checksScope, planScope, docScope } from "../../src/dispatch/commit-scope.ts";

const sidecar = (obj: unknown) => "prose\n```styre-sidecar\n" + JSON.stringify(obj) + "\n```\n";

test("implementScope: tracked edit always allowed; declared new file allowed; undeclared new rejected", () => {
  const inScope = implementScope(sidecar({ new_files: ["pkg/new.py"] }));
  expect(inScope("pkg/existing.py", false)).toBe(true);   // tracked edit
  expect(inScope("pkg/new.py", true)).toBe(true);          // declared new
  expect(inScope("./pkg/new.py", true)).toBe(true);        // normalized
  expect(inScope("test_bug.py", true)).toBe(false);        // undeclared scratch
});

test("implementScope: absent sidecar → any new file is out of scope (rejected, not dropped)", () => {
  const inScope = implementScope("no sidecar here");
  expect(inScope("pkg/existing.py", false)).toBe(true);
  expect(inScope("pkg/new.py", true)).toBe(false);
});

test("checksScope: authored test_file allowed; extra new_files helper allowed; undeclared rejected", () => {
  const inScope = checksScope(sidecar({ checksAuthored: [{ ac_id: 1, test_file: "tests/test_x.py", test_name: "test_x" }], new_files: ["tests/conftest.py"] }));
  expect(inScope("tests/test_x.py", true)).toBe(true);
  expect(inScope("tests/conftest.py", true)).toBe(true);
  expect(inScope("scratch.py", true)).toBe(false);
});

test("checksScope: unparseable sidecar → DEFERS (allows everything) so the handler decides", () => {
  const inScope = checksScope("no sidecar");
  expect(inScope("anything.py", true)).toBe(true);
  expect(inScope("tests/test_x.py", true)).toBe(true);
});

test("planScope / docScope: only their doc trees, edit or new", () => {
  const plan = planScope("");
  expect(plan("docs/plans/ENG-1.md", true)).toBe(true);
  expect(plan("src/x.ts", false)).toBe(false);            // stray tracked code edit rejected
  const doc = docScope("");
  expect(doc("docs/guide.md", true)).toBe(true);
  expect(doc("src/x.ts", false)).toBe(false);
});
```

- [ ] **Step 4: Run to confirm failure** — `bun test test/dispatch/commit-scope.test.ts` → FAIL (module missing).

- [ ] **Step 5: Implement `commit-scope.ts`**

```ts
import { ChecksOutputSchema } from "./checks-schema.ts";
import { isDocPath, isPlanPath } from "./docs-paths.ts";
import { ImplementOutputSchema } from "./implement-schema.ts";
import { extractSidecar } from "./sidecar.ts";

/** Given the agent's stdout, a predicate over each pending path: true ⇒ in scope (deliverable).
 *  `isNew` is true only for a brand-new untracked file. */
export type CommitScope = (output: string) => (path: string, isNew: boolean) => boolean;

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** implement: tracked edits always in scope; a new file must be declared in `new_files`. An absent/
 *  malformed sidecar ⇒ no declaration ⇒ any new file is out of scope (→ reject-and-retry, never a
 *  silent drop; the retry-feedback nudges the agent to declare it or delete it). */
export const implementScope: CommitScope = (output) => {
  const parsed = extractSidecar(output, ImplementOutputSchema);
  const declared = new Set(parsed.ok ? parsed.value.new_files.map(norm) : []);
  return (path, isNew) => !isNew || declared.has(norm(path));
};

/** checks: tracked edits in scope; a new file must be an authored test_file OR a declared helper.
 *  On an UNPARSEABLE sidecar the scope DEFERS (allows everything) so the two checks call sites keep
 *  their existing post-commit failure semantics (transport-failure / clean "rejected"). */
export const checksScope: CommitScope = (output) => {
  const parsed = extractSidecar(output, ChecksOutputSchema);
  if (!parsed.ok) return () => true;
  const declared = new Set<string>([
    ...parsed.value.checksAuthored.map((c) => norm(c.test_file)),
    ...parsed.value.new_files.map(norm),
  ]);
  return (path, isNew) => !isNew || declared.has(norm(path));
};

/** design:dispatch: everything (edit or new) must be under docs/plans/. */
export const planScope: CommitScope = () => (path) => isPlanPath(path);

/** docs:revise: everything must be under docs/. */
export const docScope: CommitScope = () => (path) => isDocPath(path);
```

- [ ] **Step 6: Run to confirm pass** — `bun test test/dispatch/commit-scope.test.ts` → PASS.

- [ ] **Step 7: Confirm no regression** — `bun test test/dispatch/` → PASS (schema `new_files` defaults to `[]`, so existing checks parsing is unaffected).

- [ ] **Step 8: Commit**

```bash
git add src/dispatch/implement-schema.ts src/dispatch/checks-schema.ts src/dispatch/commit-scope.ts test/dispatch/commit-scope.test.ts
git commit -m "feat(scoped-commit): commit-scope predicates + implement/checks new_files schemas"
```

---

## Task 3: Commit-path integration — `commitWorktree` named staging + `runAgentDispatch` scope flow + handler wiring

The core, atomic change: the moment `commitWorktree` stops doing `git add -A`, every write step needs its scope wired, so `commitWorktree` + `runAgentDispatch` + all 5 write call sites + the migrated tests change together.

**Files:**
- Modify: `src/dispatch/worktree.ts` (`commitWorktree` signature)
- Modify: `src/dispatch/run-dispatch.ts` (`DispatchSpec`, `runAgentDispatch`)
- Modify: `src/dispatch/handlers.ts` (5 write call sites + docs:revise migration)
- Modify (direct): `test/dispatch/run-dispatch.test.ts`, `test/dispatch/worktree-guard.test.ts`, `test/dispatch/docs-revise-handler.test.ts`, `test/dispatch/worktree.test.ts`
- Modify (restore-green — existing implement/checks-flow runners, review B1): `test/helpers/run-harness.ts` and every e2e/handler test whose fake implement runner creates a new file (Step 14 audits and lists them).

**Why this task is large but atomic:** the moment `commitWorktree` stops doing `git add -A` (Step 1) and the real handlers gain `commitScope` (Step 9), every existing test that drives `implement:dispatch` with a fake runner creating an *undeclared* new file starts getting rejected. Those cannot be fixed independently of the mechanism, so the task's green state depends on Steps 14. Do not commit until the FULL suite is green.

**Interfaces:**
- Consumes: `pendingEntries`, `undoAttempt`, `stagedIndexEmpty`, `worktreeHead` (Task 1); `CommitScope`, `implementScope`, `checksScope`, `planScope`, `docScope` (Task 2); `appendEvent` (`src/db/repos/event-log.ts`).
- Produces: `DispatchSpec.commitScope?: CommitScope` (replaces `commitGuard`); `commitWorktree(worktreePath, message, newPaths: string[])`.

- [ ] **Step 1: Change `commitWorktree` to named staging**

In `src/dispatch/worktree.ts` replace `commitWorktree` (currently `worktree.ts:37-47`):

```ts
/** Stage the scoped surface and commit (CL-COMMIT — the daemon commits, never the agent):
 *  `git add -u` (all tracked modifications/deletions — always in scope; scratch is never tracked)
 *  plus the named new files. Emptiness is decided on the STAGED INDEX (see stagedIndexEmpty), so an
 *  undeclared untracked file left in the worktree never forces an empty commit. No changes → no
 *  commit; returns current HEAD with changed=false. */
export function commitWorktree(
  worktreePath: string,
  message: string,
  newPaths: string[],
): { sha: string; changed: boolean } {
  git(["add", "-u"], worktreePath);
  if (newPaths.length > 0) git(["add", "--", ...newPaths], worktreePath);
  if (stagedIndexEmpty(worktreePath)) {
    return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: false };
  }
  git(["commit", "-m", message], worktreePath);
  return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: true };
}
```

- [ ] **Step 2: Update `DispatchSpec` — replace `commitGuard` with `commitScope`, and fix imports**

In `src/dispatch/run-dispatch.ts`:
- Add `import type { CommitScope } from "./commit-scope.ts";`
- Add `import { appendEvent } from "../db/repos/event-log.ts";`
- Rewrite the `worktree.ts` import block. It currently is exactly:
  ```ts
  import {
    commitWorktree,
    ensureWorktree,
    pendingChanges,
    revertWorktree,
    worktreeHead,
  } from "./worktree.ts";
  ```
  Change it to (drop **both** `pendingChanges` and `revertWorktree` — both become unused after Step 5, and `tsconfig` has `noUnusedLocals:true`; add `pendingEntries` + `undoAttempt`):
  ```ts
  import {
    commitWorktree,
    ensureWorktree,
    pendingEntries,
    undoAttempt,
    worktreeHead,
  } from "./worktree.ts";
  ```

Then in the `DispatchSpec` interface replace the `commitGuard?: ...` field (`run-dispatch.ts:43-48`) with:

```ts
  /** Per-step commit scope (control-loop §4). Given the agent's stdout, a predicate over each pending
   *  path: (path, isNew) => true means in-scope. PRESENT ⇒ a write step: an out-of-scope file this
   *  dispatch created is rejected (revert + dispatch-failed + retry). ABSENT ⇒ read-only step: a
   *  brand-new file is logged (event_log note) and left uncommitted; never gates. */
  commitScope?: CommitScope;
```

- [ ] **Step 3: Snapshot untracked-before, right after `ensureWorktree`**

In `runAgentDispatch`, immediately after `ensureWorktree(deps.repoPath, deps.branch, deps.worktreePath);` (`run-dispatch.ts:113`) add:

```ts
  // Only files THIS dispatch creates are in the scope's jurisdiction; pre-existing untracked cruft
  // (an earlier stray, provision's *.egg-info) is captured here and excluded from judgment/staging.
  const untrackedBefore = new Set(
    pendingEntries(deps.worktreePath).filter((e) => e.isNew).map((e) => e.path),
  );
```

- [ ] **Step 4: `undoAttempt` on the transport-failure and park exits**

In the `!result.completed || result.timedOut` block (`run-dispatch.ts:140-156`): before `throw new ParkSignal(...)` add `undoAttempt(deps.worktreePath, untrackedBefore);`, and before the `throw new Error(...transport failure...)` add `undoAttempt(deps.worktreePath, untrackedBefore);`. (Both leave the journal/outbox untouched — they only clean this attempt's uncommitted worktree delta.)

- [ ] **Step 5: Replace the `commitGuard` block + commit call with the scope flow**

Replace `run-dispatch.ts:158-191` (the `if (spec.commitGuard) {...}` block, the `commitWorktree(...)` call, and the `postcondition` try/catch) with:

```ts
  const preHead = worktreeHead(deps.worktreePath);
  const entries = pendingEntries(deps.worktreePath);
  // Judge only what this dispatch created (undoAttempt guarantees a failed prior attempt left none).
  const judged = entries.filter((e) => !(e.isNew && untrackedBefore.has(e.path)));

  let sha: string;
  let changed: boolean;
  if (spec.commitScope) {
    const inScope = spec.commitScope(result.stdout);
    const offenders = judged.filter((e) => !inScope(e.path, e.isNew));
    if (offenders.length > 0) {
      undoAttempt(deps.worktreePath, untrackedBefore);
      completeDispatch(ctx.db, inserted.id, {
        outcome: "dispatch-failed",
        branchHeadSha: preHead,
        endedAt: nowUtc(),
      });
      throw new Error(
        `dispatch ${did} out-of-scope files (declare them as part of the change, or delete them if they are throwaway/debug files): ${offenders
          .map((e) => e.path)
          .join(", ")}`,
      );
    }
    ({ sha, changed } = commitWorktree(
      deps.worktreePath,
      `${did} ${spec.handlerKey}`,
      judged.filter((e) => e.isNew).map((e) => e.path),
    ));
  } else {
    const stray = judged.filter((e) => e.isNew).map((e) => e.path);
    if (stray.length > 0) {
      // Read-only step produced a file it should not have. Loop-not-halt: record, do not gate.
      appendEvent(ctx.db, {
        ticketId: ctx.ticket.id,
        kind: "note",
        reason: `scratch-ignored:${spec.handlerKey}`,
        payload: { stray },
      });
    }
    ({ sha, changed } = commitWorktree(deps.worktreePath, `${did} ${spec.handlerKey}`, []));
  }

  const completion = {
    branchHeadSha: sha,
    endedAt: nowUtc(),
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    cacheRead: result.cacheRead ?? null,
    cacheCreate: result.cacheCreate ?? null,
  };
  try {
    spec.postcondition({ worktreePath: deps.worktreePath, changed, sha });
  } catch (err) {
    completeDispatch(ctx.db, inserted.id, { outcome: "postcondition-failed", ...completion });
    throw err;
  }
  completeDispatch(ctx.db, inserted.id, { outcome: "clean-success", ...completion });
  return { dispatchId: did, sha, changed, output: result.stdout };
```

- [ ] **Step 6: Update the existing `run-dispatch.test.ts` cases for the new commit path**

The FakeAgentRunner tests in `test/dispatch/run-dispatch.test.ts` write a **new** file (e.g. `feature.ts`) and expect it committed. Under scoping, a write step needs `commitScope`. Update those specs to include `commitScope: implementScope` and have the runner emit a declaring sidecar. Example — update the first test (`run-dispatch.test.ts:50-85`) runner + spec:

```ts
// runner writes feature.ts AND declares it:
const runner = new FakeAgentRunner((input) => {
  writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
  return { completed: true, exitCode: 0,
    stdout: "```styre-sidecar\n{\"new_files\":[\"feature.ts\"]}\n```",
    stderr: "", timedOut: false, costUsd: 0.1, tokensIn: 5, tokensOut: 2 };
});
// ...in the spec:
{ handlerKey: "implement:dispatch", template: "implement {{ident}}", vars: { ident: "ENG-1" },
  commitScope: implementScope, postcondition: ({ changed }) => { if (!changed) throw new Error("empty diff"); } },
```

Import `implementScope` at the top. Apply the same `commitScope: implementScope` + declaring sidecar to every existing test in THIS file whose runner creates a new file and asserts `changed:true`/`clean-success` (the first test :50, the postcondition-failure test :150 which expects the empty-diff throw — but note :150's runner writes NO file, so it stays a pure-edit no-op → `changed:false` → its "empty diff" postcondition still throws; leave :150 as-is).
- **Leave the stdout-marker test (:87) UNTOUCHED (review M6).** It asserts `result.output === "MARKER-STDOUT"` exactly and its postcondition is a no-op (does not require `changed`). With **no** `commitScope` it takes the read-only branch: its new `feature-stdout.ts` becomes a logged stray, `changed:false`, and `output` is unchanged → the test passes as written. Do NOT add a sidecar (would break the exact `toBe`) and do NOT add `commitScope` (would reject the undeclared file).
- The transport-failure test (:289) needs no scope (it fails before commit); leave its spec, and additionally assert its file was undone: `expect(existsSync(join(wt, "should-not-be-committed.ts"))).toBe(false)` (`undoAttempt` removed it). Import `existsSync` from `node:fs`.

- [ ] **Step 7: Add new `run-dispatch.test.ts` cases (the behaviors the design guarantees)**

```ts
test("scope reject: an undeclared new file → dispatch-failed at preHead, worktree undone, offenders named", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-scope-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "fix.ts"), "export const x = 1;\n");   // legit edit target (new, undeclared)
    writeFileSync(join(input.cwd, "test_bug.py"), "scratch\n");           // undeclared scratch
    return { completed: true, exitCode: 0, stdout: "no sidecar", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const ctx = ctxFor(db, ticketId);
  const preHead = /* HEAD before */ Bun.spawnSync(["git","rev-parse","HEAD"],{cwd:repo}).stdout.toString().trim();
  const call = runAgentDispatch(ctx, { runner, ...depsFor(repo, wt) },
    { handlerKey: "implement:dispatch", template: "implement {{ident}}", vars: { ident: "ENG-1" }, commitScope: implementScope, postcondition: () => {} });
  await expect(call).rejects.toThrow(/out-of-scope files.*test_bug\.py/);
  const rows = listByTicket(db, ticketId);
  expect(rows[0]?.outcome).toBe("dispatch-failed");
  expect(rows[0]?.branch_head_sha).toBe(preHead);
  expect(existsSync(join(wt, "fix.ts"))).toBe(false);   // undoAttempt cleaned the whole attempt
  db.close();
});

test("read-only stray: logged as an event_log note, dispatch still clean-success (non-gating)", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-ro-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "stray.txt"), "oops\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const out = await runAgentDispatch(ctxFor(db, ticketId), { runner, ...depsFor(repo, wt) },
    { handlerKey: "review", template: "review {{ident}}", vars: { ident: "ENG-1" }, postcondition: () => {} }); // no commitScope
  expect(listByTicket(db, ticketId)[0]?.outcome).toBe("clean-success");
  const notes = listEvents(db, ticketId).filter((e) => e.kind === "note" && e.reason?.startsWith("scratch-ignored"));
  expect(notes.length).toBe(1);
  expect(JSON.parse(notes[0].payload_json ?? "{}").stray).toContain("stray.txt");
  db.close();
});

test("no-drop across a transport-failure retry: a re-created declared file commits, never dropped", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-retry-${Date.now()}`);
  const deps = depsFor(repo, wt);
  const stepCtx = ctxFor(db, ticketId);   // same step across both attempts
  // Attempt 1: creates helper.ts then transport-fails (no revert in the old world → the bug).
  const run1 = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "helper.ts"), "export const h = 1;\n");
    return { completed: false, exitCode: null, stdout: "", stderr: "boom", timedOut: true, costUsd: null, tokensIn: null, tokensOut: null };
  });
  await expect(runAgentDispatch(stepCtx, { runner: run1, ...deps },
    { handlerKey: "implement:dispatch", template: "t {{ident}}", vars: { ident: "ENG-1" }, commitScope: implementScope, postcondition: () => {} })).rejects.toThrow();
  expect(existsSync(join(wt, "helper.ts"))).toBe(false); // undoAttempt removed attempt-1's file
  // Attempt 2 (retry of the same step): re-creates + declares helper.ts → it MUST commit.
  const run2 = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "helper.ts"), "export const h = 2;\n");
    return { completed: true, exitCode: 0, stdout: "```styre-sidecar\n{\"new_files\":[\"helper.ts\"]}\n```", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const out = await runAgentDispatch(stepCtx, { runner: run2, ...deps },
    { handlerKey: "implement:dispatch", template: "t {{ident}}", vars: { ident: "ENG-1" }, commitScope: implementScope, postcondition: ({ changed }) => { if (!changed) throw new Error("dropped!"); } });
  expect(out.changed).toBe(true);
  expect(Bun.spawnSync(["git","show","HEAD:helper.ts"],{cwd:wt}).success).toBe(true); // committed, not dropped
  db.close();
});
```

Add imports at the top: `import { existsSync } from "node:fs";`, `import { implementScope } from "../../src/dispatch/commit-scope.ts";`, and `import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";`.

- [ ] **Step 8: Run to confirm failure**, then implement Steps 1-5. Run: `bun test test/dispatch/run-dispatch.test.ts` → PASS.

- [ ] **Step 9: Wire `commitScope` on the 5 write call sites in `handlers.ts`**

Add imports: `import { checksScope, docScope, implementScope, planScope } from "./commit-scope.ts";`. Then:
- `implement:dispatch` (~`handlers.ts:847-861`): add `commitScope: implementScope,` to the spec.
- `checks:dispatch` register (~`handlers.ts:546-550`): add `commitScope: checksScope,`.
- `checks:dispatch` in `reauthorCheckWrong` (~`handlers.ts:238-242`): add `commitScope: checksScope,`.
- `design:dispatch` (~`handlers.ts:372-381`): add `commitScope: planScope,`.

- [ ] **Step 10: Migrate `docs:revise` off `commitGuard`**

In the `docs:revise` handler (`handlers.ts:505-526`) replace the `commitGuard: ({ pending }) => { ... }` block with `commitScope: docScope,`. Remove the now-unused `isDocPath` import from `handlers.ts` **only if** nothing else there uses it (grep first; keep it if the prompt/other code references it). Leave `carryVerifiedVerdictForward` untouched.

- [ ] **Step 11: Migrate the guard tests**

- `test/dispatch/worktree-guard.test.ts`:
  - The two `commitGuard:` specs (the "docs-only edit commits" ~:110 and "non-doc edit reverts, head unchanged" ~:136) → rewrite to `commitScope: docScope`. Keep the assertions: docs edit → `clean-success` + committed; a non-doc edit (tracked OR new) → `dispatch-failed`, `branch_head_sha === preHead`, worktree undone. **Update the throw regex** at ~:156 from `/non-doc path in diff/` to `/out-of-scope files/` (review M5 — the new reject path throws a different message). Import `docScope`.
  - **Rewrite the "no commitGuard → commits, clean-success" test at ~:166 (review B3).** It writes a NEW untracked `src/foo.py` with no guard and asserts `changed===true`. Under the new read-only semantics (no `commitScope`) that file is a logged stray and `git add -u` stages nothing → `changed:false`. Re-target it: either make its runner edit a **tracked** file (→ `changed:true`, `clean-success`) to keep testing "unscoped step commits tracked work", OR assert the new read-only-stray behavior (`changed:false` + an `event_log` `note`). Prefer the tracked-edit variant to preserve the test's original intent.
  - The standalone `revertWorktree` test (~:54) stays (the function is still exported and unchanged).
- `test/dispatch/docs-revise-handler.test.ts`: the "non-doc edit rejected" case (~:118) must stay green under `docScope` — assert a **tracked** non-doc edit is rejected (predicate false for `isNew=false`, non-doc path), not only a new file. **Update its throw regex** at ~:140 from `/docs:revise may only edit documentation/` to `/out-of-scope files/` (review M5 — docs:revise no longer emits its bespoke message; the generic scope-reject message applies).

- [ ] **Step 12: Fix the existing `commitWorktree` callers in `test/dispatch/worktree.test.ts` (review B2)**

`test/dispatch/worktree.test.ts:59` and `:70` call `commitWorktree(wt, "…")` with two args. The signature is now 3-arg (required), so `strict` typecheck fails and `newPaths.length` throws at runtime. Update both calls: pass a third argument — `[]` if the test only exercises tracked edits, or the created file's path(s) if it creates new files and expects them committed. Adjust each test's assertion to the named-staging behavior (a new file passed in `newPaths` commits; one omitted does not).

- [ ] **Step 13: Implement Steps 1-11, then run the DIRECT tests**

Run: `bun test test/dispatch/worktree.test.ts test/dispatch/run-dispatch.test.ts test/dispatch/commit-scope.test.ts test/dispatch/worktree-guard.test.ts test/dispatch/docs-revise-handler.test.ts`
Expected: PASS. (The broader suite is expected to be RED here — Step 14 restores it. If a fresh worktree shows unrelated missing-dep failures, run `bun install` first.)

- [ ] **Step 14: Restore green — audit & fix existing implement/checks-flow test runners (review B1)**

The `commitScope` wiring now rejects any fake runner that creates an *undeclared* new file in an implement/checks flow. Fix them:

1. **Central fix — the shared harness** (`test/helpers/run-harness.ts:269`): its `callCount === 1` implement branch writes `harness-impl.ts` with `stdout: "done"`. Change that `stdout` to declare the file:
   ```ts
   stdout: 'done\n```styre-sidecar\n{"new_files":["harness-impl.ts"]}\n```',
   ```
   This fixes every test that drives implement through the harness in one edit.

2. **Inline runners — audit and fix each.** Find them:
   ```bash
   rg -n "writeFileSync\(join\(input\.cwd" test/ | rg -v "test/dispatch/(worktree|run-dispatch|commit-scope)\.test\.ts"
   ```
   For each fake runner that (a) drives `implement:dispatch` (via `buildDispatchRegistry`/`advanceOneStep`/the harness) and (b) creates a NEW file and (c) expects that step to commit/verify, append a declaring sidecar to its `stdout` naming exactly the file(s) it writes:
   ```ts
   // before: stdout: "{}"   (or "done", etc.)
   stdout: '{}\n```styre-sidecar\n{"new_files":["feature.ts"]}\n```',
   ```
   Known files to check (from the plan-review): `test/dispatch/diff-gates-e2e.test.ts` (`feature.ts`, `c.ts`), `test/dispatch/verify-e2e.test.ts` (`feature.ts`), `test/dispatch/verify-gate-e2e.test.ts` (`note-*.ts`), `test/dispatch/arbiter-e2e.test.ts` (multiple `note*.ts`), `test/dispatch/verify-handlers.test.ts`, `test/dispatch/verify-routing-e2e.test.ts`, `test/dispatch/verify-routing.test.ts`, `test/dispatch/handlers.test.ts`, `test/dispatch/implement-allowlist.test.ts`, `test/dispatch/docs-revise-resolve.test.ts`.
   - **Checks-flow runners are already safe**: they emit a `checksAuthored` sidecar whose `test_file` `checksScope` declares — verify (don't blindly edit) that `test/dispatch/checks-handler.test.ts` and any checks e2e still pass; add a `new_files` entry only if a runner creates a NON-test helper file.
   - Do NOT add a sidecar to a runner whose test asserts an **exact** stdout string; instead let that step run unscoped/read-only (as with `run-dispatch.test.ts:87`) if it isn't asserting a commit.

- [ ] **Step 15: Run the full suite + typecheck**

Run: `bun test` then the repo's typecheck (`bun run typecheck` / `tsc --noEmit`).
Expected: ALL PASS. Iterate Step 14 until green — every remaining red implement/checks test is a runner that still creates an undeclared new file.

- [ ] **Step 16: Commit**

```bash
git add -- src/dispatch/worktree.ts src/dispatch/run-dispatch.ts src/dispatch/handlers.ts test/dispatch/ test/helpers/run-harness.ts
# plus any other test files touched in Step 14 (name them explicitly):
git commit -m "feat(scoped-commit): named staging + per-step commit scope + undoAttempt in the dispatch flow"
```

---

## Task 4: Implement prompt — scratch prevention + `new_files` declaration

The prevention layer: tell the implement agent not to leave scratch and to declare genuine new files, so first-try commits are clean and the reject gate rarely fires.

**Files:**
- Modify: `prompts/implement.md`
- Test: `test/dispatch/prompt-vars.test.ts` (add a render assertion; create if absent)

**Interfaces:**
- Consumes: `IMPLEMENT_TEMPLATE` / `implementVars` render path (`src/dispatch/prompt-vars.ts`). No new template variable is needed — the instruction and sidecar format are static text.

- [ ] **Step 1: Write a failing render test**

In `test/dispatch/prompt-vars.test.ts`:

```ts
import { IMPLEMENT_TEMPLATE } from "../../src/dispatch/prompt-vars.ts";
test("implement prompt instructs new_files declaration + scratch prevention", () => {
  expect(IMPLEMENT_TEMPLATE).toContain("new_files");
  expect(IMPLEMENT_TEMPLATE.toLowerCase()).toContain("do not leave");
  expect(IMPLEMENT_TEMPLATE).toContain("```styre-sidecar");
});
```

- [ ] **Step 2: Run to confirm failure** — `bun test test/dispatch/prompt-vars.test.ts` → FAIL.

- [ ] **Step 3: Append the instruction to `prompts/implement.md`**

Add at the end of `prompts/implement.md`:

````markdown
## Reporting the files you created (required whenever you add a file)

Do NOT leave throwaway, debug, or reproduction files in the repository. If you write a script to
reproduce the bug or exercise your change, delete it — or keep it outside the repository — before you
finish. The commit is REJECTED if it contains any file you did not declare below, and you will have to
redo the change.

For every NEW file that is a genuine part of the fix, list its repo-relative path in a sidecar block
at the very end of your output:

```styre-sidecar
{ "new_files": ["path/to/the_new_file.py"] }
```

If your change only edits existing files, omit the block (or emit `{ "new_files": [] }`).
````

- [ ] **Step 4: Run to confirm pass** — `bun test test/dispatch/prompt-vars.test.ts` → PASS.

- [ ] **Step 5: Full suite** — `bun test` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add prompts/implement.md test/dispatch/prompt-vars.test.ts
git commit -m "feat(scoped-commit): implement prompt declares new_files + forbids leaving scratch"
```

---

## Self-Review

**1. Spec coverage** — every design section maps to a task:
- §3.1 `commitScope` type + replaces `commitGuard` → Task 3 (Step 2).
- §3.2 untracked-before snapshot, scope flow, `undoAttempt` on reject/transport/park, `recordStray` → Task 3 (Steps 3-5).
- §3.3 `commitWorktree` named staging + `stagedIndexEmpty` exit codes → Task 1 (Step 7) + Task 3 (Step 1).
- §3.4 `pendingEntries`/`isNew` incl. rename second token → Task 1 (Steps 1-3).
- §4 per-call-site wiring incl. the reauthor site → Task 3 (Step 9).
- §5 implement `new_files` schema + checks `new_files` + unparseable-sidecar deferral → Task 2 (Steps 1-5) + Task 4 (prompt).
- §6 `event_log` `kind:"note"`, `payload:{ stray }` → Task 3 (Step 5).
- §7/§8 edge cases (rename, ignored, cruft, undoAttempt) → covered by Task 1 + Task 3 tests.
- §9 test migration → Task 3 (Steps 6, 7, 11) + green-keeping across the existing e2e/harness suite → Task 3 (Steps 12-15: `worktree.test.ts` callers, the shared harness runner, and every inline implement-flow runner that creates an undeclared new file).
- §10 strict planning scope + non-gating read-only → Task 2 (`planScope`) + Task 3 (Step 5).

**2. Placeholder scan** — no TBD/TODO; every code step shows real code; every test shows real assertions.

**3. Type consistency** — `CommitScope = (output) => (path, isNew) => boolean` is defined once (Task 2) and consumed identically in `DispatchSpec` and the four scope constants; `commitWorktree(worktreePath, message, newPaths)` and `undoAttempt(worktreePath, untrackedBefore: Set<string>)` match between definition (Task 1/3) and call sites (Task 3); `ImplementOutputSchema.new_files` / `ChecksOutputSchema.new_files` names match between schema (Task 2) and scope predicates (Task 2). `appendEvent({ ticketId, kind, reason, payload })` matches the real signature (`event-log.ts:56-70`).

**One deliberate residual (design §3.3, honest-bound):** tracked-file mutations from a *successful* upstream step's test run are not policed here (out of scope; pre-existing; `git add -A` leaked them too). Not a task; noted so no reviewer treats it as a gap.
