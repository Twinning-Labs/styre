# In-place execution — work on a branch in the repo root when the checkout is disposable

**Status:** Design v2 (brainstorm output) — direction agreed with the operator; independently reviewed (feasibility + adversarial + fact-check); two operator decisions incorporated (safety gate = detached-HEAD-or-marker; resume = same-container-only). Plan next.
**Date:** 2026-07-06
**Scope:** add an **in-place execution mode** to `styre run`: when the caller declares the checkout *disposable* (single-use container / CI), styre works on a branch **in the repo root** instead of a separate git worktree. This makes a pre-built editable environment (which points at the repo root) the source-under-test, so the **shipped conda reuse fires natively** — completing the astropy fix with no re-point, no recompile, no build-isolation problem. **Supersedes** `docs/brainstorms/2026-07-06-provision-repoint-design.md`.
**Builds on:**
- The shipped python env reuse (PR #51) — the probe requires `import <pkg>` to resolve *under styre's working dir*.
- The execution-isolation decision (operator, 2026-07-06): the rule is keyed on a caller-declared disposable-checkout flag, NOT on OSS-vs-commercial.
- `CLAUDE.md` invariants: capability isolation (move 4); single transactional writer (B2); the runner commits (CL-COMMIT); loop-not-halt.

---

## The rule

> **styre isolates its work in a git worktree by default; when the caller declares the checkout disposable (single-use container/CI), it works in-place on a branch off the base commit.**

Keyed on **disposable vs. shared checkout**, not on plane. (First cut targets `styre run`; the daemon needs a per-run-container topology first — see §9.)

---

## 0. Why

A git worktree exists to protect a checkout something *else* owns (a dev's working tree, uncommitted changes) — capability isolation, move 4. In a **single-use container**, the container *is* that boundary: the repo (`repoPath = project.target_repo`, e.g. `/testbed`) is a throwaway clone used by exactly one run. There the worktree adds **zero** isolation and creates a source-under-test mismatch: styre's worktree is `join(worktreeRoot, ident)` (a tmpdir, `run.ts:95`), while a pre-built editable env points at the repo root.

The failure that mismatch causes is worth stating precisely (review NIT): the reuse probe declines because `import <pkg>` resolves outside styre's worktree — and then, for an **editable-prepare** python component, provision's *existing remediation* force-reinstalls editable at the worktree (`handlers.ts:462`), which for a C-extension package is a `build_ext` **recompile** (the exact cost the re-point died on); for a `tox` component like astropy it instead falls back to `tox`, which rebuilds its envs → the 10-min timeout. Either way, worktree mode loses. Working **in-place** makes the working dir *be* the repo root the editable env already points at → the probe passes → reuse fires, no remediation, no recompile.

---

## 1. The trigger — a CLI flag only

`styre run --in-place` (a boolean added to `src/cli/run.ts` `args`). **No env var.** (Review: `STYRE_IN_PLACE` inherits into every child process and persists across a shell/CI session, so one `export` turns *every* run into a silent in-place repo mutation — the opposite of explicit intent.) This is **invocation-level**: the same profile/config may run in-place in a container or with a worktree natively, so it belongs on the CLI layer, not `ProfileSchema` and not `runtime-config`.

---

## 2. The safety gate (operator decision: detached-HEAD-or-marker)

In-place mutates the real repo (`git checkout -B` moves HEAD, the runner commits onto the branch). "Clean tree" is **not** a sufficient guard (review, adversarial F2): a developer on a *clean named branch* passes it, then `git checkout -B <branch>` switches them off it; and if `branchNameFor(ticket)` already exists with commits not on HEAD, `-B` **resets that ref, orphaning those commits** (reflog-only recovery) — all with an empty `git status`. So `--in-place` is **refused unless BOTH**:

1. **Nobody owns this ref:** HEAD is **detached** (SWE-bench/CI containers check out a base commit → detached, so this is the natural fit) **OR** a disposable marker file (`.styre-disposable`, written by the container image) is present. This structurally blocks hijacking a developer's named branch.
2. **No un-committed *tracked* work:** `git status --porcelain --untracked-files=no` is empty. (Review, feasibility F2: plain `--porcelain` also reports untracked `*.so`/`*.egg-info`/`build/` — the editable env's own residue — and would false-refuse the exact case this targets; scope the guard to *tracked* modifications so it still catches a mis-declared real checkout while ignoring benign build artifacts.)

On entering in-place, log a **loud banner**: `IN-PLACE: mutating <repoPath> on branch <branch> (HEAD was <sha>)`. Refusal is a hard, clear error, never a silent fallback.

---

## 3. The identity assertion (the deepest review finding — adversarial F1)

The whole payoff assumes `project.target_repo` **is** the path the pre-built editable env points at. That is not guaranteed (a container mount/symlink/copy, or a realpath-vs-symlink mismatch, can make `styre setup`'s recorded `target_repo` differ from where the image ran `pip install -e`). If they differ, in-place still diverges and silently degrades into the recompile it claims to supersede.

So when `--in-place` is set, styre **asserts the identity once, up front** (at run start / provision): for each python component, `import <pkg>` (via the shipped `SOURCE_CHECK_SCRIPT`) must resolve **under `realpath(target_repo)`**. If it does **not**, styre **fails fast** with a clear error — `--in-place: the active environment's <pkg> is installed against <X>, not the repo root <target_repo>` — and does **not** proceed into provision's editable remediation (no silent recompile). This turns the design's weakest assumption into a checked precondition.

---

## 4. The seam (exact changes)

Localized — fact-check confirmed `deps.worktreeRoot` is consumed in exactly two functions, the implement path is not special-cased, and all six `ensureWorktree` callers funnel through one function.

1. **Thread `inPlace` into dispatch deps.** Add `inPlace: boolean` to `RegistryDeps` (`handlers.ts:80-87`); `buildDispatchRegistry` sets it from the CLI flag. `worktreeFor` (`handlers.ts:105-109`) and `depsFor` (`handlers.ts:125-134`) return:
   `worktreePath = deps.inPlace ? repoPath : join(deps.worktreeRoot, ctx.ticket.ident)` (in-place, `worktreeRoot` is unused).
2. **`ensureWorktree` in-place path** (`worktree.ts:15-19`) — **the least-localized change** (review, feasibility F1). Its first line `if (existsSync(join(worktreePath, ".git"))) return;` would **no-op in-place** (the repo root always has `.git`) → the branch is never created and commits land on detached HEAD. So restructure: when `worktreePath === repoPath`, **bypass the `.git` short-circuit** and instead:
   - enforce the §2 safety gate (once, at first call);
   - **guard against redundant resets:** `ensureWorktree` is called ~6×/unit, and `git checkout -B` *resets the ref to HEAD each time* — so skip if already on `<branch>` (`git rev-parse --abbrev-ref HEAD === branch`); otherwise `git checkout -B <branch>` (off the base commit; works from detached HEAD).
   - **never** `git worktree add` at the repo root.
3. **`removeWorktree` no-op in-place** (`worktree.ts:40-42`). Guard *inside* the function: if `worktreePath === repoPath`, return without running `git worktree remove`. This single guard covers **both** callers — `handlers.ts:942` (`released:project`) and `park.ts:209` (resume cleanup, which passes a DB-stored path that in-place equals `repoPath`).
4. **`commitWorktree` / `worktreeHasChanges` / `changedFiles*`** — unchanged; they operate on `worktreePath` (== `repoPath` in-place); the runner commits on the branch in the repo root (CL-COMMIT holds).

---

## 5. Park / resume — same-container only (operator decision)

In-place, the run's durable state (the branch commits **and** the park dump) lives inside the disposable container; if it's torn down, resume can't run in a fresh clone (feasibility's weakest-assumption finding). So **in-place resume is supported only within a still-alive container**, and this is documented as a limitation (a torn-down in-place run is re-run from scratch, not resumed).

No new persistence is needed (feasibility F3): resume can **derive** the mode from state it already reads — `inPlace = (getLatestWorktreePath(db, ticketId) === project.target_repo)` (`park.ts:206` already calls `getLatestWorktreePath`; the value is persisted per dispatch row at `run-dispatch.ts:84`). Given that:
- skip the fresh `worktreeRoot` mint (`park.ts:246`) — nothing to mint;
- the parked-worktree wipe is `removeWorktree` (`park.ts:209`) + `git worktree prune` (`park.ts:214`) — the §4.3 guard makes the first a no-op and prune is harmless at the repo root;
- `resetProvisionForResume` (`park.ts:217-219`) re-arms provision on the premise "the wiped worktree took the deps with it" — **false in-place** (deps persist in the repo root). Re-provisioning is idempotent so it's not a correctness bug, but it wastes the reuse payoff; **skip the re-arm when in-place** (and fix the now-false comment).
- The branch-HEAD-moved guard (`--accept-head`, via `branchHeadSha`/`headBaseline`) is **ref-based and mode-independent** — genuinely unaffected (both reviews concede this).

---

## 6. Interaction with the shipped reuse (the payoff)

With the §3 identity assertion holding, in-place makes `cwd == repoPath ==` the editable env's target → `pythonEnvReady`'s check passes → `reuseAwareTestCommand` returns `<interp> -m pytest` → astropy runs the agent's branch, fast. **No new reuse code** — in-place is purely the working-dir change that lets the shipped probe fire. This is what turns the PR-#51 "safe no-op" into the actual fix.

---

## 7. Invariants — honestly stated

- **Capability isolation (move 4) is DELEGATED, not structurally guaranteed** (review, adversarial F4). A worktree *guarantees* isolation by construction; in-place *assumes* it — the container boundary is the isolation, and styre cannot verify the caller's container is truly single-use. The §2 gate (detached-HEAD/marker) is the strongest check styre can make locally; beyond that, isolation is the caller's contract. State this plainly rather than claiming parity with worktree mode.
- **Single transactional writer (B2) / CL-COMMIT** — unchanged; the runner commits on the branch in the repo root.
- **Ground truth / loop-not-halt** — unchanged; only the working-dir location moves.

---

## 8. Supersedes

`docs/brainstorms/2026-07-06-provision-repoint-design.md` (banner-marked). The re-point recompiled a C-extension package offline at provision; in-place removes the problem by not diverging the working dir from the editable env in the first place.

---

## 9. Risks / scope

1. **Daemon is OUT of scope (review, adversarial F5).** `daemon/loop.ts` `tick()` advances up to K tickets in **one** process sharing **one** `worktreeRoot`; setting `inPlace` there makes K branches fight over one working dir with `git checkout -B` thrashing HEAD. In-place is **`styre run` (single-run) only** for now; the "universal, both planes" rule is **aspirational** and requires the commercial plane to adopt a one-container-per-run topology (which the operator leans toward) before `inPlace` can be threaded into the daemon. The spec must not imply it works in today's `tick` loop.
2. **★ Result extraction (integration requirement).** In-place moves the repo's HEAD onto `styre/<ident>` and commits there. Any caller/harness that reads styre's output from a *pre-recorded* ref, or `git diff`s against a base it captured before launch, must be updated to read the `styre/<ident>` branch (or styre must leave the result where the harness expects). This is a bench/CI integration point, not styre-internal — but it must be confirmed for the bench harness or in-place produces a correct fix the harness can't find.
3. **C-source rebuild residual.** For a fix editing a `.pyx`/`.c` (rare — most are pure-Python), the editable makes `.py` live but not the compiled `.so`. In-place this is a *cheap incremental* `build_ext --inplace` in the repo root (which has the build env + prior object files) — strictly better than the re-point's cold compile — but styre still doesn't *trigger* a rebuild. Later follow-up (rebuild trigger keyed on extension-source changes); not blocking.
4. **Audit completeness (plan step 1):** grep every co-use of `worktreePath`/`repoPath` and every `ensureWorktree`/`removeWorktree` caller to confirm nothing else treats them as load-bearing-distinct. Reviews traced these (2 `removeWorktree` callers, 6 `ensureWorktree` callers via one function, impl path == verify path); the plan re-verifies.

---

## 10. Evidence

- **The mismatch:** `worktreeRoot = mkdtempSync(join(tmpdir(), "styre-wt-"))` (`run.ts:95`, `park.ts:246`); `worktreePath = join(deps.worktreeRoot, ctx.ticket.ident)` (`handlers.ts:106,129`); `repoPath = project.target_repo` (`handlers.ts:105,128`).
- **The creation seam:** `ensureWorktree` — the `.git` short-circuit at `worktree.ts:16-18`, `git worktree add -B` at `:19`; `removeWorktree` `git worktree remove --force` at `worktree.ts:40-42`; `commitWorktree` operates on `worktreePath` (`worktree.ts:28-38`). Callers of `ensureWorktree`: `run-dispatch.ts:69`, `handlers.ts:337,374,495,561,811`. Callers of `removeWorktree`: `handlers.ts:942`, `park.ts:209`.
- **Flag entry:** `styre run` args `src/cli/run.ts:44-55`; deps assembled `run.ts:88-96`.
- **Park/resume (corrected line refs):** re-mint `park.ts:246`; wipe = `removeWorktree` `park.ts:209` + `git worktree prune` `park.ts:214`; `resetProvisionForResume` `park.ts:217-219`; `getLatestWorktreePath` used at `park.ts:206`, persisted per dispatch row at `run-dispatch.ts:84`. (v1 wrongly cited `:106`/`:204` — those are comments.)
- **Identity/probe machinery:** `SOURCE_CHECK_SCRIPT` (`provision.ts:82-101`); the editable remediation that in-place must NOT trigger on a failed identity: `handlers.ts:462-481`.

## 11. Changelog
- *v1 → v2 (2026-07-06, post 3-lens review + 2 operator decisions):* **safety gate** = detached-HEAD-or-marker + tracked-dirty refusal + loud banner (was "clean tree", which reviewers showed is insufficient — branch hijack / ref-reset orphaning); **dropped the env var** (footgun). **Added §3 identity assertion** (fail fast if `target_repo` ≠ the editable env's target — the deepest finding; otherwise in-place degrades into the recompile it supersedes). **Fixed the `ensureWorktree` `.git`-short-circuit no-op trap** and the ~6×/unit `checkout -B` reset (guard on already-on-branch). **Dirty-tree guard scoped to tracked files.** **Resume = same-container only**, mode *derived* from the DB `worktree_path` (no new schema), skip mint/wipe/provision-reset. **Daemon scoped OUT** (shared `worktreeRoot`/K-ticket loop can't do in-place; universality aspirational). **Downgraded the isolation claim** to "delegated to the container boundary, unverified." Added the **result-extraction** integration requirement. Corrected park line refs (v1 cited comments).
