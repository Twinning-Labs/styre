# In-place execution — work on a branch in the repo root when the checkout is disposable

**Status:** Design (brainstorm output). Direction agreed with the operator; this writes it up + names the open decisions. Independent review next, then plan.
**Date:** 2026-07-06
**Scope:** add an **in-place execution mode** to `styre run`: when the caller declares the checkout *disposable* (single-use container / CI), styre works on a branch **in the repo root** instead of a separate git worktree. This makes a pre-built editable environment (which points at the repo root) the source-under-test, so the **shipped conda reuse fires natively** — completing the astropy fix with no re-point, no recompile, no build-isolation problem. **Supersedes** `docs/brainstorms/2026-07-06-provision-repoint-design.md`.
**Builds on:**
- The shipped python env reuse (PR #51) — the probe requires `import <pkg>` to resolve *under styre's working dir*.
- The execution-isolation decision (operator, 2026-07-06): the rule is universal (both planes), keyed on a caller-declared disposable-checkout flag, NOT on OSS-vs-commercial.
- `CLAUDE.md` invariants: capability isolation (move 4); single transactional writer (B2); the runner commits (CL-COMMIT); loop-not-halt.

---

## The rule

> **styre isolates its work in a git worktree by default; when the caller declares the checkout disposable (single-use container/CI), it works in-place on a branch off the base commit.**

Universal — both OSS `styre run` and the commercial plane (whose execution is most likely isolated per-run containers, not long-lived client-repo instances). The only distinction that matters is **disposable vs. shared checkout.**

---

## 0. Why

A git worktree exists to protect a checkout something *else* owns — a developer's working tree, uncommitted changes, other branches (capability isolation, move 4). In a **single-use container**, the container *is* that boundary: the repo (`repoPath` = `project.target_repo`, e.g. `/testbed`) is a throwaway clone used by exactly one run. There, the worktree adds **zero** isolation and actively creates a source-under-test mismatch: styre's worktree is `join(worktreeRoot, ident)` (a tmpdir, `run.ts:95`), while a pre-built editable env points at the repo root — so the shipped reuse probe (`import <pkg>` under the working dir) correctly declines, and astropy stays on `tox` → timeout. Working **in-place** makes the working dir *be* the repo root the editable env already points at → the probe passes → reuse fires.

---

## 1. The trigger (a caller-declared flag) — **OPEN DECISION**

The caller that *launches the container* is what knows the checkout is disposable, so styre must be **told**, not infer it. Do **not** auto-detect Docker: a Docker dev-container with a bind-mounted user checkout would be unsafe to work in-place.

**Proposed:** a `styre run --in-place` boolean flag (added to `src/cli/run.ts` `args`), also honoured via env var `STYRE_IN_PLACE=1` for container ergonomics (the container image sets the env; both feed one `inPlace: boolean`). This is **invocation-level**, not profile shape and not runtime operator policy — the *same* profile/config may run in-place in a container or with a worktree natively, so it belongs on the CLI/env layer, not `ProfileSchema` and not `runtime-config` (per the config-layering rule).

*Decision to confirm: flag name (`--in-place` vs `--disposable-checkout`), and whether to also accept the env var. Everything else follows.*

---

## 2. The seam (exact changes)

Small and localized — everything downstream already uses `worktreePath` uniformly, so making it equal `repoPath` in-place "just works" for provision, verify, and commit.

1. **Thread `inPlace` into dispatch deps.** `buildDispatchRegistry` (`run.ts:88`) already builds `RegistryDeps`; add `inPlace: boolean`. `worktreeFor` (`handlers.ts:105-109`) and `depsFor` (`handlers.ts:125-134`) return:
   `worktreePath = deps.inPlace ? repoPath : join(deps.worktreeRoot, ctx.ticket.ident)`.
   (In-place, `worktreeRoot` is simply unused — no tmpdir needed.)
2. **`ensureWorktree` gets an in-place branch** (`worktree.ts:15`). Today: `git worktree add -B <branch> <worktreePath>` in `repoPath`. When `worktreePath === repoPath` (in-place), that command is invalid (can't add a worktree at the repo root); instead:
   - **dirty-tree guard:** `git status --porcelain` must be empty — else throw (`in-place requires a clean checkout; found uncommitted changes`), protecting a mis-declared real checkout;
   - `git checkout -B <branch>` in `repoPath` — create/reset the branch at current HEAD (the base commit; works from a detached HEAD, which SWE-bench containers usually are).
3. **`removeWorktree` becomes a no-op in-place** (`worktree.ts:41`). Guard: if `worktreePath === repoPath`, do nothing — **never** `git worktree remove` the repo root. (Audit every caller.)
4. **`commitWorktree` / `worktreeHasChanges` / `changedFiles*`** are unchanged — they operate on `worktreePath`, which in-place is `repoPath`; the runner commits on the branch in the repo root (CL-COMMIT holds).

---

## 3. Park / resume (the one non-trivial area)

`run.ts:95` and `park.ts:246` mint a fresh `worktreeRoot = mkdtempSync(...)`; resume **wipes the parked worktree** and re-mints (`park.ts:106,204,246`). In-place there is *no* separate worktree to wipe or re-mint — resume operates on the branch already in the repo root. So `inPlace` must be **persisted with the park state** and threaded through resume: skip the worktreeRoot mint and the worktree wipe; the existing branch-HEAD-moved check (`--accept-head`) already works on HEAD and is unaffected. This is the trickiest part of the plan and the place to write the most tests.

---

## 4. Safety guards

- **Explicit flag only** (§1) — never infer from Docker.
- **Dirty-tree guard** (§2.2) — refuse in-place on an unclean checkout; fail loud, never clobber.
- **Never remove the repo** (§2.3).
- **Branch off HEAD** (the base commit), not a hardcoded `main`.

---

## 5. Interaction with the shipped reuse (the payoff)

In-place, `cwd == repoPath` == the editable env's target, so `pythonEnvReady`'s source-under-test check passes → `reuseAwareTestCommand` returns `<interp> -m pytest` → astropy runs the agent's branch, fast. **No new reuse code** — in-place is purely the working-dir change that lets the shipped probe fire. This is what turns the PR-#51 "safe no-op" into the actual fix.

---

## 6. Invariants held

- **Capability isolation (move 4)** is preserved — the *container* is the writable boundary in-place, exactly as the worktree is natively. The agent still gets no `gh`/Linear tools; the repo root is the writable surface, bounded by the disposable container.
- **Single transactional writer (B2)** and **CL-COMMIT** — unchanged; the runner commits on the branch in the repo root.
- **Ground truth / loop-not-halt** — unchanged; only the working-dir location moves.

---

## 7. Supersedes

`docs/brainstorms/2026-07-06-provision-repoint-design.md` (already banner-marked). The re-point recompiled a C-extension package offline at provision (build-isolation failure, cold compile, stale `.so`); in-place removes the entire problem by not diverging the working dir from the editable env in the first place.

---

## 8. Risks / open decisions

1. **★ The flag mechanism (§1)** — confirm name + env-var. Load-bearing but small.
2. **★ Park/resume in-place (§3)** — the real implementation risk; persist `inPlace`, skip mint/wipe. Needs careful tests.
3. **C-source rebuild residual.** For a fix that edits a `.pyx`/`.c` (rare — most are pure-Python), the editable makes `.py` live but not the compiled `.so`. In-place this is a *cheap incremental* `build_ext --inplace` in the repo root (which has the build env + prior object files) — vs the re-point's cold compile — but styre still doesn't *trigger* a rebuild. Later follow-up (rebuild trigger keyed on extension-source changes); not blocking, and strictly better than the superseded design.
4. **Daemon threading.** If/when the commercial daemon (`src/daemon/loop.ts`) runs disposable per-run containers, it threads the same `inPlace` into its `buildDispatchRegistry`. Out of scope for this spec's first cut (OSS `styre run`), but the seam is identical.
5. **Audit completeness.** Confirm no other code treats `worktreePath ≠ repoPath` as load-bearing (grep of `worktreePath`/`repoPath` co-uses; `removeWorktree` callers). The plan starts with that audit.

---

## 9. Evidence

- **The mismatch:** `worktreeRoot = mkdtempSync(join(tmpdir(), "styre-wt-"))` (`run.ts:95`, `park.ts:246`); `worktreePath = join(deps.worktreeRoot, ctx.ticket.ident)` (`handlers.ts:106,129`); `repoPath = project.target_repo` (`handlers.ts` `worktreeFor`).
- **The creation seam:** `ensureWorktree` `git worktree add -B <branch> <worktreePath>` (`worktree.ts:15-20`); `removeWorktree` `git worktree remove --force` (`worktree.ts:41-43`); `commitWorktree` operates on `worktreePath` (`worktree.ts:27-38`).
- **Flag entry:** `styre run` args in `src/cli/run.ts:44-58`; deps assembled `run.ts:88-96`.
- **Park/resume:** worktreeRoot re-mint + wipe at `park.ts:106,204,246`.

## 10. Changelog
- *2026-07-06 (v1)* — first spec of in-place execution: caller-declared disposable-checkout flag, the `worktreeFor`→`repoPath` + `ensureWorktree`(`git checkout -B`) + `removeWorktree`-no-op seam, the dirty-tree guard, and the park/resume threading. Universal rule (both planes). Supersedes the provision re-point. Named the two load-bearing items: the flag mechanism and the park/resume in-place path.
