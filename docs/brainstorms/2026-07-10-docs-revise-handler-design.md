# `docs:revise` handler — Bug A fix (spec'd-but-unbuilt step)

**Status:** design v2.1 — two independent review rounds folded; implemented (7 tasks, subagent-driven TDD) and whole-branch-reviewed READY-TO-MERGE; awaiting operator merge
**Date:** 2026-07-10
**Branch/worktree:** `fix/docs-revise-handler` (off `origin/main` @ #67 `1d5f43a`)

---

## §0 — The bug

In a SMOKE=2 bench run against post-M6 `main`, `astropy-12907` passed the M1–M6
change-scoped verify gate (`ac-check-gate = PASS`, `tox` correctly advisory) and then **crashed**:

```
ERROR advanceOneStep: no handler registered for 'docs:revise'
```

→ the run threw, the bench recorded `infra`, retried 2× (deterministic), gave up.

**Root cause (traced).** `docs:revise` is a **spec'd-but-unbuilt** step:
- `design:extract` sets `ticket.needs_docs = 1` on `cdotImpact.documentation.applies`
  (`handlers.ts:423`; `.applies` is `z.boolean()`, `extract-schema.ts`).
- After every unit is verified, the resolver emits a `docs:revise` step
  (`resolver.ts:213-214`, `needs_docs === 1 && !done("docs:revise")`).
- The step has a tier (`tiers.ts:15` → `cheap`/Haiku), an allowlist (`tool-allowlists.ts:15` →
  `[...READ_ONLY,"Write","Edit"]`), the `needs_docs` schema column, and a full spec
  (`control-loop.md:386`) — but **no registered handler** in `buildDispatchRegistry`
  (`advance.ts:104-106` throws). astropy is docs-heavy → design flagged docs → the crash.

Pre-existing, unrelated to M1–M6 (verify had already passed). Fix = build the spec'd handler.

## §0.1 — Independent review (v1 → v2): two fatal flaws folded

The v1 "just a handler + a post-commit docs-only postcondition" design was **wrong**. A
code-grounded review found:

- **Blocker 1 (fatal).** A `docs:revise` that actually edits a doc **moves HEAD**. In the
  implement-stage tail the resolver re-checks the verify gate at the *current* HEAD
  (`resolver.ts:149` ac-check-gate, `:207` integration) **before** it checks
  `done("docs:revise")` (`:213`). The new (docs) sha is in neither the gate-passed set nor the
  integration-ran set → it re-serves `verify:checks-gate`, which is journaled `succeeded` and
  merely *replays* (no new signal, `step-journal.ts:73-79`, `advance.ts:129-136`) → the ticket
  spins to `no-progress` (`run-ticket.ts` `DEFAULT_CAP=200`), never reaching review. The v1
  no-op case worked (HEAD unmoved); the moment docs:revise does its job, it wedges — including
  on the **failure** path (a rejected commit also moves the recorded sha).
- **Blocker 2.** `runAgentDispatch` commits **before** the postcondition
  (`run-dispatch.ts:114` then `:125`). A per-commit post-hoc check lets a rejected attempt's
  source edit stay on HEAD; a docs-only retry commits *on top* and passes while the source edit
  rides in history → "cannot invalidate verify" is false across a retry.
- **Important 3.** `isDocPath` accepting a `docs/` segment *anywhere* would bless source under a
  nested `docs/` dir (e.g. `src/docs/Component.tsx`).

v2 folds all three: **carry the verified verdict forward** (operator-chosen) for Blocker 1, a
**pre-commit scope gate** for Blocker 2, and a **repo-root-only `isDocPath`** for #3.

---

## §1 — The spec being implemented (`control-loop.md:386`)

**`docs:revise`** — ticket-level documentation sync (conditional; Haiku 4.5). Guard: verify
passed **and** design set `needs_docs=true`. Input: the completed change + plan + existing docs
+ doc locations. Output: updated docs → runner commits; a `dispatch` row. Tools: Read/Grep/Glob
+ Write/Edit **docs only** (cannot touch source/tests → can't invalidate verify → no re-verify).
Failure → C1 (retry→escalate). Everything except the handler already exists.

---

## §2 — Architecture & flow (v2)

One new dispatch handler + a small opt-in extension to the shared dispatch flow. No schema,
resolver, tier, or allowlist change.

```
all units verified + gate passed  (branch HEAD = verified baseline V)
        │  resolver: needs_docs===1 && !done("docs:revise")   (resolver.ts:213, UNCHANGED)
        ▼
   docs:revise handler → runAgentDispatch(handlerKey:"docs:revise", template, vars,
                                          commitGuard, ...)
     1. agent (Haiku, Read/Grep/Glob + Write/Edit) reads the worktree + docs/plans/<ident>
        + existing docs; edits documentation to match the completed change
     2. commitGuard (PRE-commit, new): pending = the FULL working-tree delta vs HEAD=V,
          INCLUDING untracked files — `git -c core.quotePath=false status --porcelain -z`
          (tracked modifications/deletions/renames AND new `??` files). NOT a bare `git diff`.
          offenders = pending.filter(f => !isDocPath(f))
          offenders.length > 0  → the guard THROWS; runAgentDispatch reverts the working tree
                                   (discard the whole attempt), records dispatch-failed with head
                                   UNCHANGED (=V), and rethrows → C1 retry
          offenders.length === 0 → proceed to commit
     3. commitWorktree → { sha=C1, changed }   (only reached when all changes are docs)
     4. onSucceed CARRY-FORWARD (only when changed, i.e. HEAD moved V→C1):
          if listAcChecks(ticket).length > 0: insertSignal("ac-check-gate", pass, sha=C1)
          insertSignal("integration", result=<the verified integration result>, sha=C1)
        │  resolver next tick: branchSha=C1 ∈ gatePassedShas (if checks) ∩ integrationRanShas
        │                       → gate/integration checks fall through → done("docs:revise")
        ▼
   advance implement → review   (review sees the committed docs)
```

**Blocker 1 fix — carry the verdict forward (operator-chosen).** On a clean docs commit that
moved HEAD (V→C1), the handler records that the gate + integration **still pass at C1**. The
pre-commit scope gate (step 2) guarantees C1 differs from the verified V **only in doc paths**, so
the verify verdict established at V carries to C1 **under the assumption that doc paths are not
executed by the checks** — true for the overwhelming majority of docs (prose/Markdown/RST content),
but NOT universally: e.g. astropy runs `pytest --doctest-rst` + a Sphinx build in CI, so a
`docs/**` edit *can* affect a build/doctest outcome. The residual risk is narrow and backstopped
three ways in the existing loop: (a) `verify:integration` is **advisory** (`resolver.ts:202` routes
on ran-at-sha, never on result), so a carried integration value never blocks; (b) the only hard
gate, `ac-check-gate`, re-runs **scoped AC-check selectors over code behavior**
(`handlers.ts:1358-1398`), not docs — so a doc edit flips it only if an AC transitively depends on a
`docs/` path (rare); (c) `merge` waits on `external_checks` — real PR CI — before
`human_merge_approval` (`resolver.ts:235`), and the reviewer sees the committed docs first. So a
doc edit that breaks doctest CI surfaces at the merge gate, not silently. Carry-forward asserts a
verdict that holds under a stated, backstopped assumption — not an unconditional proof. The
resolver is **unchanged**: it routes on "did the gate pass at
this sha", and now C1 qualifies, so it advances to review. The ac-check-gate carry-forward is
written **only when the ticket has active checks** (matching the resolver's own
`gateHasChecks` guard, `resolver.ts:142`); integration is always carried (S4 always runs). The
carried integration signal replicates the verified integration result at V (so `ranShasFor`
includes C1; a pass stays a pass, an advisory-fail stays recorded).

**Blocker 2 fix — pre-commit scope gate (no commit on offense).** The docs-only check runs
**before** `commitWorktree`, over the FULL working-tree delta (tracked **and untracked**, vs
HEAD=V — an agent with `Write` can *create* a new source file, so a bare `git diff` that omits
untracked would let `commitWorktree`'s `git add -A` bless it: the guard MUST see untracked). The
guard is a pure predicate that only **throws** on an offender; `runAgentDispatch` owns the reaction
— it reverts the working tree and records the failed dispatch with the head unchanged. On an
offense **nothing is committed** — HEAD stays at V, the recorded `branch_head_sha` stays V, and the
retry (via failure-policy) starts from a clean verified baseline. This closes both the
history-pollution hole and the failure-path wedge (a failed docs:revise never moves the sha the
resolver gates on). Because HEAD==V on every attempt, the pre-commit delta is exactly that
attempt's edits — no cumulative-since-V bookkeeping needed.

**No-op case (free & correct).** Agent changes nothing → `pending` empty → 0 offenders → commit
is a no-op (`commitWorktree` returns HEAD=V unchanged, `changed=false`) → no carry-forward needed
(branchSha already == V, gate already passes) → step done → advance. A docs-flagged ticket whose
change needed no doc edit is a legitimate outcome, never a failure.

**Bash-less, like `review`** (`[...READ_ONLY]`; prompt reads the worktree + `docs/plans/<ident>`
directly). No `git diff` injection.

---

## §3 — Components

1. **`src/dispatch/run-dispatch.ts`** — add an **opt-in `commitGuard`** to `DispatchSpec`
   (`commitGuard?: (args: { worktreePath: string; pending: string[] }) => void`). When present,
   `runAgentDispatch`, **after the agent runs and before `commitWorktree`**, computes `pending` =
   the full working-tree delta **including untracked files** via
   `git -c core.quotePath=false status --porcelain -z` (parse the path column; `??` = untracked,
   `R` = rename → the new path) — **not** a bare `git diff --name-only HEAD`, which would omit
   untracked additions (B1). It calls the guard (a pure predicate); on the guard's throw it reverts
   the working tree (`git checkout -- .` to restore tracked mods/deletions + `git clean -fd` for
   untracked — spares ignored files, so the ephemeral SQLite under XDG state is untouched even when
   `worktreePath === repoPath` in `--in-place`), records
   `completeDispatch(dispatch-failed, branchHeadSha=<pre-dispatch HEAD>)` (unchanged sha), and
   rethrows. `runAgentDispatch` captures the pre-dispatch HEAD (`git rev-parse HEAD`) before the
   agent runs. Handlers with no `commitGuard` are byte-for-byte unaffected
   (the only shared-flow change is guarded behind the optional field). The carry-forward is **not**
   a runAgentDispatch concern — the handler performs it on the returned `{sha, changed}` (§3.4),
   which runs exactly once (a succeeded step is never re-run), so no `onSucceed` hook is added to
   the shared flow.
2. **`src/dispatch/docs-paths.ts`** *(new, pure)* — single source of truth for "what is a doc",
   shared by the commitGuard (enforcement) and the prompt (guidance):
   - `isDocPath(file: string): boolean` — true iff, case-insensitively:
     - the path is under the **repo-root** `docs/` tree (`^docs/…`), **or**
     - the path is repo-root (no `/`) and its basename matches `README*` / `CHANGELOG*` /
       `CONTRIBUTING*` / `mkdocs.yml`.
     Repo-root-scoped and fail-closed: a nested `src/docs/x.tsx` or `src/README.md` is **not** a
     doc path (closes review Important-3). Paths are normalized (git `-z` / `core.quotePath=false`
     so non-ASCII names aren't octal-quoted; forward-slash; no `./` prefix).
   - `DOC_PATHS_HINT: string` — the human-readable allowed-path list, used verbatim in the prompt
     so guidance and enforcement never drift.
3. **`prompts/docs-revise.md`** *(new)* — Haiku prompt mirroring `review.md`'s framing: the change
   is complete and committed; read the plan under `docs/plans/<ident>`, the code, and existing
   docs; update the documentation to match; edit **only** the paths in `{{doc_paths}}`; if nothing
   needs updating, make no changes.
4. **`src/dispatch/handlers.ts`** — register `docs:revise`:
   ```ts
   registry.register("docs:revise", async (ctx: HandlerContext) => {
     const { sha, changed } = await runAgentDispatch(
       ctx,
       depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
       {
         handlerKey: "docs:revise",
         template: DOCS_REVISE_TEMPLATE,
         vars: docsVars(ctx.ticket, deps.profile),
         commitGuard: ({ pending }) => {
           const offenders = pending.filter((f) => !isDocPath(f));
           if (offenders.length > 0) {
             throw new Error(
               `docs:revise may only edit documentation; refusing to commit: ${offenders.join(", ")}`,
             );
           }
         },
         postcondition: () => {},
       },
     );
     if (changed) carryVerifiedVerdictForward(ctx.db, ctx.ticket.id, sha); // §3.5
     return { docsRevised: changed };
   });
   ```
5. **`src/dispatch/prompt-vars.ts`** — `docsVars(ticket, profile)`: mirrors `reviewVars`
   (`ident`,`title`,`slug`,`...profile.promptVars`) + `doc_paths: DOC_PATHS_HINT`.
6. **Carry-forward helper** (`carryVerifiedVerdictForward`, in handlers.ts or a small module) — at
   the docs commit `sha`, in one transaction: `insertSignal("integration", …)` always, replicating
   the verified `integration` signal at V **verbatim — result AND `detail`** (the V row carries
   `detail:{ran, advisory:true}`, `handlers.ts:1353`; copying it keeps C1 a faithful replica and
   robust to any future advisory reader that scopes to HEAD); and `insertSignal("ac-check-gate",
   "pass", sha)` **iff** `listAcChecks(db, ticketId).length > 0` (matching the resolver's own
   `gateHasChecks` guard). Reads the verified integration row from the existing signal at V.

**Unchanged (already present):** the resolver emission, `cheap`/Haiku tier, the allowlist, the
`needs_docs` column + setter, and the failure-policy C1 route for a `dispatch` step.

---

## §4 — Error handling & edge cases

- **Non-doc edit** → commitGuard reverts the attempt (no commit), records `dispatch-failed`, HEAD
  stays V → failure-policy retries a fresh dispatch from the clean verified baseline; on repeated
  offense → escalate (C1). Fail-closed; a source edit never reaches the branch.
- **No-op** → no commit, `changed=false`, no carry-forward, step done.
- **Clean docs edit** → commit C1 + carry-forward → advance to review.
- **Transport failure / timeout / park** → existing `runAgentDispatch` paths, unchanged.
- **Resume/replay** — a succeeded `docs:revise` returns its journaled result; the carry-forward
  signals written on first (real) execution persist; the resolver's `!done` guard makes emission
  idempotent.
- **Non-standard doc locations** (docs kept outside repo-root `docs/`, e.g. `documentation/`) →
  commitGuard rejects → C1 escalate (visible), never a silent wrong-scope edit. Broadening from
  profile-declared locations is a possible future refinement (YAGNI now; the repo-root set covers
  the common cases and astropy).
- **Carry-forward safety** — only ever written for a sha the commitGuard proved docs-only-vs-V, so
  it never blesses an unverified source *change*. For a no-ac-check ticket the ac-check-gate carry-
  forward is skipped (and would be inert anyway — the resolver's gate branch is `gateHasChecks`-
  guarded, and M6's report reads `ac_check` rows, of which there are none). A `.py` docstring edit
  is correctly **rejected** by the commitGuard (a source file → not a doc path), which is right:
  editing an imported source file would change what the checks run, invalidating the carry-forward
  premise.
- **No leak to a later sha** — after a review→implement loopback, a new implement commit C2 becomes
  `getLatestForTicket`; C2 ∉ the gate/integration sha-sets (only V, C1 are), so the resolver
  correctly re-gates at C2. The C1 carry-forward is inert. (Known, pre-existing quality gap,
  unrelated to this fix: docs:revise is once-per-ticket via the `done` guard, so docs are not
  re-synced against a post-loopback C2 delta — flagged, not fixed here.)
- **Offense outcome** — recorded as `dispatch-failed` (the failure-policy routes off the
  `workflow_step`, so this works); a distinct `scope-rejected` outcome would read better in
  telemetry — optional, deferred to the plan.

---

## §5 — Alternatives considered (and rejected)

- **Minimal no-op stub / stop emitting docs:revise** — un-crash but silently drop the spec'd doc-
  sync (a lie, or dead `needs_docs`). Rejected; operator chose the real handler.
- **Blocker 1 via resolver restructure** (move docs:revise to the review stage head) — also works,
  but the operator chose carry-forward (keeps the resolver pure; uses the existing sha-signal-
  routing pattern). Rejected in favor of carry-forward.
- **Prompt-only docs-scope (no gate)** — self-report; a misbehaving dispatch could edit source and
  invalidate verify. Rejected; operator chose the structural gate.
- **Post-commit docs-only postcondition (v1)** — commits before checking → history pollution +
  failure-path wedge (§0.1). Rejected for the pre-commit gate.

---

## §6 — Testing

- **`isDocPath` (pure, table-driven):** `docs/x.rst`→✓, `README.md`→✓, `CHANGELOG.md`→✓,
  `CONTRIBUTING.md`→✓, `mkdocs.yml`→✓; `src/foo.py`→✗, `test/foo_test.py`→✗, `src/README.md`→✗,
  `src/docs/Component.tsx`→✗ (nested docs rejected — review Important-3), `Docs/x.md`→✓
  (case-insensitive), a non-ASCII root `README` name→✓ (quoting handled).
- **commitGuard in `runAgentDispatch` (FakeAgentRunner writing prescribed files, real git):**
  edits only `docs/api.md` → commit happens, `clean-success`; modifies tracked `src/foo.py` (± docs)
  → NO commit, worktree reverted, `dispatch-failed`, `branch_head_sha` == pre-dispatch HEAD;
  **creates a NEW untracked `src/evil.py` (± docs) → NO commit, reverted, `dispatch-failed`** (the
  B1 regression test — proves `pending` includes untracked); edits nothing → no commit,
  `changed=false`. A handler *without* `commitGuard` is unchanged (regression).
- **`docs:revise` handler + resolver (the crux — reproduces & fixes the astropy wedge):**
  - a `needs_docs=1` ticket, all units verified + gate passed, whose docs:revise makes a **real
    doc edit** → the resolver **advances to review** (carry-forward worked); assert a `review`
    step is reached and no `no handler registered` / `no-progress`.
  - a docs:revise that edits source → step fails, HEAD unchanged, ticket does **not** advance and
    does **not** wedge to `no-progress` (retries then escalates).
  - post-retry clean HEAD: an offending attempt then a clean attempt → the review-reaching HEAD
    carries **no** source edit.
  - no-op docs:revise → advances to review.
- **Full suite** green; lint + typecheck clean before every commit.

---

## §7 — What this is NOT

- Not a re-verify — the pre-commit gate + carry-forward keep verify valid without re-running it.
- Not a resolver/schema/tier/allowlist change — only the handler + an opt-in dispatch hook.
- Not a docs *quality* gate — quality is judged by the reviewer at cutover (`control-loop.md`).

---

## §8 — Changelog

- **2026-07-10 (v2.1)** — Folded round-2 review. **B1:** `pending` must include untracked files
  (`git status --porcelain -z`) — an agent can create an untracked source file a bare `git diff`
  would miss, which carry-forward would then bless (false-green); test added. **I1:** softened the
  carry-forward soundness claim to state its assumption (doc paths non-executable by the checks) and
  name the `pytest --doctest-rst` exception + the merge `external_checks`/reviewer backstop. Minors:
  harmonized "guard throws / runAgentDispatch reverts" ownership; carry the integration signal's
  `detail` verbatim; noted in-place `git clean` scope, the once-per-ticket loopback gap, and the
  optional `scope-rejected` outcome. Round-2 verdict: sound with B1/I1 folded — no wedge, no
  unbackstopped false-green, no regression to other `runAgentDispatch` callers.
- **2026-07-10 (v2)** — Folded round-1 review. Blocker 1 (docs commit re-gates verify → wedge)
  → carry the verified verdict forward at the docs sha (operator-chosen). Blocker 2 (post-commit
  check → pollution + failure wedge) → pre-commit scope gate (opt-in `commitGuard` on
  runAgentDispatch; offense reverts + no commit → HEAD stays at the verified baseline). Important-3
  → `isDocPath` restricted to repo-root `^docs/` + root doc-family, case-insensitive, git-quoting-
  safe. Tests now assert review-reached-after-a-real-doc-edit and post-retry-clean-HEAD.
- **2026-07-10 (v1)** — Initial design (handler + post-commit postcondition). Superseded.
