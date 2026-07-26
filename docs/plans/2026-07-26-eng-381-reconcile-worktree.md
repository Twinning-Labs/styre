# ENG-381 reconcileWorktree Primitive (Prunable-Only Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the resume-only stale-worktree cleanup into a single `reconcileWorktree` primitive that frees the deterministic ticket branch **only** when its leftover worktree is `prunable`, refuses any live (non-prunable) holder with an actionable message, and is shared by `--resume`, the future `--fresh`, and (defensively) `ensureWorktree` — fixing the `git worktree add -B <branch>` → "already used by worktree at …" failure on a re-run.

**Architecture:** Add a pure porcelain parser (`parseWorktreePorcelain`) and a thin `listWorktrees` around `git worktree list --porcelain` to `src/dispatch/worktree.ts`. Build `reconcileWorktree` on top: it enumerates holders of the branch, prunes iff every holder is prunable (via `git worktree prune`, which by construction only ever drops already-gone worktrees), and throws before any mutation if a live holder exists. `ensureWorktree` calls it defensively right before `git worktree add`; `resumeRun` replaces its inline `removeWorktree` + `prune` block (park.ts:284-308) with one call.

**Tech Stack:** TypeScript on Bun; `bun test`; `Bun.spawnSync(["git", …])`; Biome (`bun run lint`). No new dependencies.

## Global Constraints

- Runtime is **Bun**; run git via `Bun.spawnSync(["git", …])` using the existing module-private `git()` helper in `src/dispatch/worktree.ts` (throws on failure, trims stdout).
- **Free only `prunable` holders.** The single removal mechanism is `git worktree prune`. A non-prunable holder MUST be refused (throw) and MUST NEVER be force-removed. No `git worktree remove --force` is added anywhere in this ticket.
- **No per-ticket lock and no process-liveness gate** (later sub-issue). Prunability (git reports the working dir already gone) is the only signal used to decide a worktree is safe to free.
- In-place mode (`worktreePath === repoPath`, a disposable single-use checkout) has no separate worktree: `reconcileWorktree` is a no-op there and must never touch the repo root.
- Deterministic branch name is `<prefix>/<ident>` via `branchNameFor` (`src/agent/branch.ts`) — do not recompute it inline.
- `bun run lint` and `bun test` must be green at every commit.

---

## File Structure

- `src/dispatch/worktree.ts` — **Modify.** Add `WorktreeRecord`, `parseWorktreePorcelain`, `listWorktrees`, `ReconcileResult`, `reconcileWorktree`; call `reconcileWorktree` inside `ensureWorktree` before `git worktree add`. This file already owns every git-worktree operation (`ensureWorktree`, `removeWorktree`, `commitWorktree`, …), so the new primitive belongs here.
- `src/cli/park.ts` — **Modify.** Replace the inline "Stale-worktree cleanup (Fix B)" block (lines ~284-308) with a single `reconcileWorktree(...)` call; hoist the resume worktree root so the same root feeds both the reconcile call and `buildDispatchRegistry`.
- `test/dispatch/reconcile-worktree.test.ts` — **Create.** Unit tests for the parser and the primitive (pure parser cases + real-git integration cases), plus the `ensureWorktree` defensive-reconcile cases.
- `test/cli/resume-reconcile.test.ts` — **Create.** Routing test: a resumed run whose recorded worktree is a prunable leftover proceeds to a terminal outcome (via the existing park/resume harness).

---

## Task 1: Porcelain parser (`parseWorktreePorcelain` + `listWorktrees`)

Pure record parser for `git worktree list --porcelain`, plus a thin git wrapper. Splitting the parser out makes prunable-detection exhaustively testable with fixed strings (no git needed) and keeps `reconcileWorktree` logic trivial to read.

**Files:**
- Modify: `src/dispatch/worktree.ts`
- Test: `test/dispatch/reconcile-worktree.test.ts`

**Interfaces:**
- Consumes: the existing module-private `git(args, cwd)` helper in `src/dispatch/worktree.ts`.
- Produces:
  - `export interface WorktreeRecord { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; locked: boolean; prunable: boolean; }` — `branch` is the full ref (`"refs/heads/feat/eng-1"`) or `null`.
  - `export function parseWorktreePorcelain(output: string): WorktreeRecord[]`
  - `export function listWorktrees(repoPath: string): WorktreeRecord[]`

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/reconcile-worktree.test.ts`:

```ts
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorktreePorcelain } from "../../src/dispatch/worktree.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// `git worktree list --porcelain`: records separated by a blank line; a `prunable <reason>` line
// marks a worktree whose working dir git can no longer find (verified against git 2.54).
const SAMPLE = [
  "worktree /repo",
  "HEAD aaaa",
  "branch refs/heads/main",
  "",
  "worktree /tmp/leak/child",
  "HEAD bbbb",
  "branch refs/heads/feat/eng-1",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

test("parseWorktreePorcelain splits records and reads branch/head", () => {
  const recs = parseWorktreePorcelain(SAMPLE);
  expect(recs).toHaveLength(2);
  expect(recs[0]).toMatchObject({ path: "/repo", branch: "refs/heads/main", head: "aaaa" });
  expect(recs[1]).toMatchObject({ path: "/tmp/leak/child", branch: "refs/heads/feat/eng-1" });
});

test("parseWorktreePorcelain marks a prunable record, leaves a live one unprunable", () => {
  const recs = parseWorktreePorcelain(SAMPLE);
  expect(recs[0].prunable).toBe(false); // the live main worktree
  expect(recs[1].prunable).toBe(true); // the leaked child
});

test("parseWorktreePorcelain handles a detached record and a missing trailing blank line", () => {
  const recs = parseWorktreePorcelain(
    ["worktree /repo", "HEAD cccc", "detached"].join("\n"), // no trailing "" terminator
  );
  expect(recs).toHaveLength(1);
  expect(recs[0]).toMatchObject({ branch: null, detached: true, prunable: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/reconcile-worktree.test.ts`
Expected: FAIL — `parseWorktreePorcelain` is not exported from `worktree.ts`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/dispatch/worktree.ts` (near the other git helpers):

```ts
export interface WorktreeRecord {
  path: string;
  head: string | null;
  /** Full ref, e.g. "refs/heads/feat/eng-1"; null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** git reports the working dir already gone → safe to drop via `git worktree prune`. */
  prunable: boolean;
}

/** Parse `git worktree list --porcelain` into one record per worktree. Records are separated by a
 *  blank line and each begins with a `worktree <path>` line. `HEAD`/`branch` carry values; `bare`,
 *  `detached`, `locked`, `prunable` are attribute lines (`locked`/`prunable` may carry a trailing
 *  reason). Unknown lines are ignored. Pure — no git call — so prunable detection is unit-testable. */
export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let cur: WorktreeRecord | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) records.push(cur);
      cur = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!cur) continue;
    if (line === "") {
      records.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length);
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
  }
  if (cur) records.push(cur);
  return records;
}

/** Enumerate the repo's worktrees (main + linked) via `git worktree list --porcelain`. */
export function listWorktrees(repoPath: string): WorktreeRecord[] {
  return parseWorktreePorcelain(git(["worktree", "list", "--porcelain"], repoPath));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/reconcile-worktree.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/worktree.ts test/dispatch/reconcile-worktree.test.ts
git commit -m "feat(worktree): parse git worktree list --porcelain for prunable detection"
```

---

## Task 2: `reconcileWorktree` primitive

Free the branch iff its leftover holder is prunable; refuse a live holder; no-op in-place. This is the core of the ticket.

**Files:**
- Modify: `src/dispatch/worktree.ts`
- Test: `test/dispatch/reconcile-worktree.test.ts`

**Interfaces:**
- Consumes: `listWorktrees`, `git` (Task 1).
- Produces:
  - `export interface ReconcileResult { freed: string[]; skipped: "in-place" | null; }`
  - `export function reconcileWorktree(repoPath: string, branch: string, staleWorktreePath: string | undefined, newWorktreeRoot: string): ReconcileResult`
  - **Contract:** returns `{ skipped: "in-place", freed: [] }` when `newWorktreeRoot === repoPath` OR `staleWorktreePath === repoPath`. Otherwise scans `listWorktrees(repoPath)` for holders of `refs/heads/<branch>` other than `repoPath`; if any holder is non-prunable it **throws** (never mutates); if all holders are prunable it runs `git worktree prune` and returns their paths in `freed`; if there are no holders it returns `{ freed: [], skipped: null }`.

- [ ] **Step 1: Write the failing test**

Append to `test/dispatch/reconcile-worktree.test.ts`:

```ts
import { reconcileWorktree } from "../../src/dispatch/worktree.ts";

// A real git repo with one commit on `main`.
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-reconcile-"));
  roots.push(root);
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: root });
    if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "# repo\n");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

// Add a worktree on `branch` at a fresh path and return it.
function addWorktree(repo: string, branch: string): string {
  const wt = join(mkdtempSync(join(tmpdir(), "styre-reconcile-wt-")), "child");
  roots.push(wt);
  const r = Bun.spawnSync(["git", "worktree", "add", "-B", branch, wt], { cwd: repo });
  if (!r.success) throw new Error(`worktree add: ${r.stderr.toString()}`);
  return wt;
}

test("reconcileWorktree frees a PRUNABLE holder so a fresh add -B <branch> succeeds (leak shape)", () => {
  const repo = makeRepo();
  const leaked = addWorktree(repo, "feat/eng-1");
  rmSync(leaked, { recursive: true, force: true }); // dir gone → git reports the holder prunable

  const res = reconcileWorktree(repo, "feat/eng-1", leaked, "/tmp/new-root");
  expect(res.freed).toContain(leaked);
  expect(res.skipped).toBeNull();

  // The branch is now free: the add git previously refused must succeed.
  const fresh = join(mkdtempSync(join(tmpdir(), "styre-reconcile-fresh-")), "child");
  roots.push(fresh);
  const add = Bun.spawnSync(["git", "worktree", "add", "-B", "feat/eng-1", fresh], { cwd: repo });
  expect(add.success).toBe(true);
});

test("reconcileWorktree REFUSES a live (non-prunable) holder and never removes it", () => {
  const repo = makeRepo();
  const live = addWorktree(repo, "feat/eng-2"); // dir still present → not prunable

  expect(() => reconcileWorktree(repo, "feat/eng-2", live, "/tmp/new-root")).toThrow(
    /not prunable/i,
  );
  expect(existsSync(join(live, "README.md"))).toBe(true); // still intact — never force-removed
});

test("reconcileWorktree is a no-op when the branch has no holder", () => {
  const repo = makeRepo();
  const res = reconcileWorktree(repo, "feat/unused", undefined, "/tmp/new-root");
  expect(res).toEqual({ freed: [], skipped: null });
});

test("reconcileWorktree skips in-place when newWorktreeRoot === repoPath (never touches the root)", () => {
  const repo = makeRepo();
  const res = reconcileWorktree(repo, "feat/eng-3", undefined, repo);
  expect(res).toEqual({ freed: [], skipped: "in-place" });
});

test("reconcileWorktree skips in-place when staleWorktreePath === repoPath", () => {
  const repo = makeRepo();
  const res = reconcileWorktree(repo, "feat/eng-4", repo, "/tmp/new-root");
  expect(res).toEqual({ freed: [], skipped: "in-place" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/reconcile-worktree.test.ts`
Expected: FAIL — `reconcileWorktree` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/dispatch/worktree.ts` (after `listWorktrees`):

```ts
export interface ReconcileResult {
  /** Worktree paths whose already-gone admin entries were pruned to free the branch. */
  freed: string[];
  /** "in-place" when there is no separate worktree to reconcile; null otherwise. */
  skipped: "in-place" | null;
}

/** Reconcile a leaked worktree so a fresh `git worktree add -B <branch>` can succeed.
 *
 *  A non-`done` run leaves its worktree checked out on the deterministic branch `<prefix>/<ident>`.
 *  A re-run/resume mints a NEW worktree root and re-adds the branch, which git refuses while the
 *  leftover still holds it. This primitive frees the branch — but ONLY when the holder is `prunable`
 *  (git reports its working dir already gone). A LIVE (non-prunable) holder is refused with an
 *  actionable message and NEVER force-removed: a leaked worktree has no live owner, a live one does.
 *  The single mutation is `git worktree prune`, which by construction only ever drops prunable
 *  worktrees — so a live worktree is unreachable by this code path even in the all-prunable branch.
 *
 *  In-place (the repo root itself is the working surface) is a no-op: there is no separate worktree,
 *  and the root must never be touched. Callers: `--resume` / `--fresh` (before dispatch) and
 *  `ensureWorktree` (defensively, before add). `staleWorktreePath` is the caller's best guess at the
 *  leftover (used for the in-place signal and messaging); the porcelain branch scan is authoritative. */
export function reconcileWorktree(
  repoPath: string,
  branch: string,
  staleWorktreePath: string | undefined,
  newWorktreeRoot: string,
): ReconcileResult {
  if (newWorktreeRoot === repoPath || staleWorktreePath === repoPath) {
    return { freed: [], skipped: "in-place" };
  }
  const ref = `refs/heads/${branch}`;
  // Holders of the branch OTHER than the main worktree — repoPath is never a removal candidate.
  const holders = listWorktrees(repoPath).filter((w) => w.branch === ref && w.path !== repoPath);
  if (holders.length === 0) return { freed: [], skipped: null };

  const live = holders.filter((w) => !w.prunable);
  if (live.length > 0) {
    const where = live.map((w) => w.path).join(", ");
    throw new Error(
      `reconcileWorktree: branch '${branch}' is held by a live worktree at ${where} — it is not ` +
        `prunable (its working tree still exists), so it will not be removed. Remove it yourself ` +
        `with 'git worktree remove ${live[0].path}' (or finish/park that run), then retry.`,
    );
  }
  // Every holder is prunable → its working dir is already gone. Prune drops the dead admin entries,
  // releasing the branch for the fresh add.
  git(["worktree", "prune"], repoPath);
  return { freed: holders.map((w) => w.path), skipped: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/reconcile-worktree.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/worktree.ts test/dispatch/reconcile-worktree.test.ts
git commit -m "feat(worktree): add reconcileWorktree prunable-only gate primitive"
```

---

## Task 3: `ensureWorktree` calls `reconcileWorktree` defensively

Make the worktree-add path self-healing: a re-run that hits a prunable leftover holding the branch frees it first (and refuses a live one with a clear message) instead of failing with git's opaque "already used by worktree at …".

**Files:**
- Modify: `src/dispatch/worktree.ts` (`ensureWorktree`)
- Test: `test/dispatch/reconcile-worktree.test.ts`

**Interfaces:**
- Consumes: `reconcileWorktree` (Task 2).
- Produces: no signature change — `ensureWorktree(repoPath, branch, worktreePath)` behaviour is extended only on the worktree-add branch.
- **On branch collision:** before `git worktree add -B <branch> <worktreePath>`, `ensureWorktree` calls `reconcileWorktree(repoPath, branch, undefined, worktreePath)`. `worktreePath` is passed as `newWorktreeRoot`; it is never equal to `repoPath` on this branch (the `worktreePath === repoPath` in-place case returned earlier), so the in-place skip cannot misfire. A prunable holder is freed → add succeeds; a live holder → `reconcileWorktree` throws before add; no holder → no-op, add proceeds unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/dispatch/reconcile-worktree.test.ts`:

```ts
import { ensureWorktree } from "../../src/dispatch/worktree.ts";

const headBranch = (dir: string) =>
  Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })
    .stdout.toString()
    .trim();

test("ensureWorktree recovers from a PRUNABLE leaked holder (re-run acceptance)", () => {
  const repo = makeRepo();
  const leaked = addWorktree(repo, "feat/eng-1");
  rmSync(leaked, { recursive: true, force: true }); // prunable leftover holding feat/eng-1

  // A re-run mints a FRESH worktree path and re-adds the same branch — the failing case today.
  const fresh = join(mkdtempSync(join(tmpdir(), "styre-ensure-fresh-")), "child");
  roots.push(fresh);
  ensureWorktree(repo, "feat/eng-1", fresh); // must NOT throw "already used by worktree at …"
  expect(headBranch(fresh)).toBe("feat/eng-1");
});

test("ensureWorktree refuses when the leftover holder is LIVE (never clobbers it)", () => {
  const repo = makeRepo();
  const live = addWorktree(repo, "feat/eng-2"); // dir present → not prunable
  const fresh = join(mkdtempSync(join(tmpdir(), "styre-ensure-live-")), "child");
  roots.push(fresh);
  expect(() => ensureWorktree(repo, "feat/eng-2", fresh)).toThrow(/not prunable/i);
  expect(existsSync(join(live, "README.md"))).toBe(true); // live worktree untouched
});

test("ensureWorktree still adds a worktree when the branch is unheld (regression)", () => {
  const repo = makeRepo();
  const fresh = join(mkdtempSync(join(tmpdir(), "styre-ensure-plain-")), "child");
  roots.push(fresh);
  ensureWorktree(repo, "feat/fresh", fresh);
  expect(headBranch(fresh)).toBe("feat/fresh");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/reconcile-worktree.test.ts`
Expected: FAIL — the prunable-recovery test fails with git's `fatal: 'feat/eng-1' is already used by worktree at …` (the bug), and the live-refuse test does not yet throw.

- [ ] **Step 3: Write minimal implementation**

In `src/dispatch/worktree.ts`, edit `ensureWorktree` — insert the reconcile call between the reuse early-return and the add:

```ts
export function ensureWorktree(repoPath: string, branch: string, worktreePath: string): void {
  if (worktreePath === repoPath) {
    // Called ~6x/unit; `checkout -B` resets the ref to HEAD each time, so skip when already on it.
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath) === branch) return;
    git(["checkout", "-B", branch], repoPath);
    return;
  }
  if (existsSync(join(worktreePath, ".git"))) {
    return;
  }
  // Defensive: a prior non-`done` run may have leaked a worktree still holding `branch`; git would
  // refuse the add with "already used by worktree at …". Free a prunable holder first (reconcile
  // refuses a live one with an actionable message). No-op when the branch is unheld. worktreePath is
  // != repoPath here (the in-place case returned above), so reconcile's in-place skip can't misfire.
  reconcileWorktree(repoPath, branch, undefined, worktreePath);
  git(["worktree", "add", "-B", branch, worktreePath], repoPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/reconcile-worktree.test.ts test/dispatch/worktree.test.ts`
Expected: PASS — new tests green AND the existing `worktree.test.ts` `ensureWorktree` cases (create/idempotent/in-place) still pass (regression).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/worktree.ts test/dispatch/reconcile-worktree.test.ts
git commit -m "fix(worktree): ensureWorktree reconciles a prunable leftover before add"
```

---

## Task 4: Route `resumeRun` through `reconcileWorktree`

Replace the resume-only inline cleanup (best-effort `removeWorktree` + `git worktree prune`) with the shared primitive, so `--resume` (and the future `--fresh`) go through one gated path. Hoist the resume worktree root so the reconcile call and `buildDispatchRegistry` use the same root.

**Files:**
- Modify: `src/cli/park.ts` (`resumeRun`, block at ~lines 284-308 and the `worktreeRoot` at ~line 337)
- Test: `test/cli/resume-reconcile.test.ts`

**Interfaces:**
- Consumes: `reconcileWorktree` (Task 2); the existing park/resume harness (`test/helpers/run-harness.ts`).
- Produces: no new exported signature. `resumeRun`'s worktree-mode cleanup becomes `reconcileWorktree(project.target_repo, branch, staleWorktreePath ?? undefined, newWorktreeRoot)`, where `newWorktreeRoot` is the freshly minted root also passed to `buildDispatchRegistry`. `removeWorktree` is no longer imported by `park.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/cli/resume-reconcile.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  cleanupParkedRun,
  resumeParkedTicket,
  runParkedTicket,
} from "../helpers/run-harness.ts";

test("resume proceeds when the parked worktree is a prunable leftover (single-primitive route)", async () => {
  // runParkedTicket parks ENG-1 mid-implement, creating a worktree under a temp root that the
  // harness then rm's in its finally — leaving git a PRUNABLE holder of the branch (dir gone),
  // exactly the leak shape ENG-381 fixes. The recorded worktree_path no longer exists on disk.
  const parked = await runParkedTicket();

  const { result, ran } = await resumeParkedTicket(parked); // routes through reconcileWorktree
  expect(ran).toBe(true); // a dispatch actually happened — resume was not blocked by the leftover
  expect(result.outcome === "pr-ready" || result.outcome === "done").toBe(true);

  cleanupParkedRun(parked);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/resume-reconcile.test.ts`
Expected: FAIL to compile/run at first only if the test references something absent — it does not, so this test is expected to **PASS against the current inline cleanup** (it encodes the behaviour to preserve). Treat this task as refactor-under-green: run the test now to confirm it passes, then keep it green through the edit. (If it does not pass now, the harness/leak shape has drifted — stop and investigate before editing.)

Run: `bun test test/cli/resume-reconcile.test.ts`
Expected: PASS (guards the behaviour before refactor).

- [ ] **Step 3: Apply the refactor**

In `src/cli/park.ts`:

(a) Remove `removeWorktree` from the import on line 36, leaving `branchHeadSha`:

```ts
import { branchHeadSha } from "../dispatch/worktree.ts";
```

Add `reconcileWorktree` to that same import:

```ts
import { branchHeadSha, reconcileWorktree } from "../dispatch/worktree.ts";
```

(b) Replace the two blocks — the "Stale-worktree cleanup (Fix B)" block and the provision-reset block (current lines ~284-308) — with a single reconcile + reset, and hoist the worktree root. Immediately after the existing line `const branch = branchNameFor(ticket);` region and before dispatch, structure it as:

```ts
  // Mint the fresh worktree root once so reconcile and buildDispatchRegistry agree on the location.
  // In-place: any value is inert (no separate worktree) — reuse target_repo without a tmpdir.
  const newWorktreeRoot = inPlace
    ? project.target_repo
    : mkdtempSync(join(tmpdir(), "styre-wt-"));

  // --- Reconcile the leaked worktree (single primitive; shared with --fresh and ensureWorktree) ---
  // The parked run left its worktree checked out on `branch`; git refuses re-adding the branch while
  // a leftover holds it. Free it iff prunable; refuse a live holder (reconcileWorktree throws). In
  // worktree mode only — in-place has no separate worktree (reconcileWorktree also no-ops there).
  if (!inPlace) {
    try {
      reconcileWorktree(project.target_repo, branch, staleWorktreePath ?? undefined, newWorktreeRoot);
    } catch (e) {
      db.close(); // surface the actionable refusal without leaking the db handle
      throw e;
    }
    // The worktree above is gone/rebuilt fresh — any deps a succeeded `provision` step installed are
    // gone with it. Re-arm provision so it re-runs before the next verify. In-place: the repo root is
    // never wiped, so the deps persist — resetting would needlessly discard the reuse payoff.
    resetProvisionForResume(db, ticketId);
  }
```

(c) In the `buildDispatchRegistry({ … })` call (current line ~337), replace the inline `worktreeRoot` expression with the hoisted constant:

```ts
        worktreeRoot: newWorktreeRoot,
```

Delete the now-obsolete `staleWorktreePath`-based `removeWorktree`/`git worktree prune` block entirely (it is fully replaced by the reconcile call). `staleWorktreePath` and `inPlace` are still computed above (lines ~228-231) and are still used.

- [ ] **Step 4: Run tests to verify green**

Run: `bun test test/cli/resume-reconcile.test.ts test/cli/park-resume-e2e.test.ts test/cli/park.test.ts test/cli/park-inplace.test.ts`
Expected: PASS — the new routing test stays green, and the existing park/resume e2e + in-place tests still pass (in-place resume must still skip cleanup; prunable-leftover resume still completes).

- [ ] **Step 5: Full suite + lint**

Run: `bun run lint && bun test`
Expected: PASS — Biome clean (no unused `removeWorktree` import) and the whole suite green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/park.ts test/cli/resume-reconcile.test.ts
git commit -m "refactor(park): route resume stale-worktree cleanup through reconcileWorktree"
```

---

## Self-Review

**1. Spec coverage (ticket → task):**

| Ticket item | Task |
| --- | --- |
| `reconcileWorktree(repoPath, branch, staleWorktreePath?, newWorktreeRoot)` primitive | Task 2 |
| `git worktree list --porcelain` prunable detection | Task 1 (parser) + Task 2 (use) |
| Free only prunable holders + `git worktree prune` | Task 2 |
| Refuse non-prunable holder with a clear message | Task 2 (throw) — asserted in Task 2 & Task 3 |
| In-place skip (`worktreePath === repoPath`) | Task 2 (both `newWorktreeRoot === repoPath` and `staleWorktreePath === repoPath`) |
| Route `--resume` through it | Task 4 |
| Callable defensively by `ensureWorktree` (future `--fresh` reuses this) | Task 3 |
| AC: re-run/resume with a prunable leaked worktree proceeds | Task 3 (ensureWorktree) + Task 4 (resume, real harness) |
| AC: non-prunable holder refused, never force-removed | Task 2 + Task 3 (asserts the live worktree still exists) |
| AC: `--resume` (+ future `--fresh`) go through the single primitive | Task 4 (resume) + Task 3 (the shared primitive `ensureWorktree`/`--fresh` will call) |
| AC: `bun run lint` + `bun test` green | Task 4 Step 5 |
| OUT: per-ticket lock, process-liveness, live-location journaling | Not implemented (Global Constraints) |

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" — every code and test step contains complete content. The refuse message is a concrete string; the prunable/live/no-holder/in-place branches are all spelled out.

**3. Type consistency:** `WorktreeRecord`, `ReconcileResult`, `parseWorktreePorcelain`, `listWorktrees`, `reconcileWorktree` are named identically across Tasks 1-4. `reconcileWorktree`'s 4-arg shape `(repoPath, branch, staleWorktreePath, newWorktreeRoot)` is used consistently: Task 3 passes `(repoPath, branch, undefined, worktreePath)`; Task 4 passes `(project.target_repo, branch, staleWorktreePath ?? undefined, newWorktreeRoot)`. `git worktree prune` is the sole mutation in every path.

**Safety invariant (how a live worktree is never destroyed):** `reconcileWorktree`'s only mutating command is `git worktree prune`, reached only after the `live.length > 0` guard has thrown. `git worktree prune` removes solely worktrees git already considers prunable (working dir gone), so even the all-prunable branch cannot touch a live checkout; `repoPath` itself is filtered out of `holders`, so the main worktree is never a candidate; and no `remove --force` is introduced anywhere. Prunability is derived from git's own `prunable` porcelain line, not from any heuristic Styre computes.
