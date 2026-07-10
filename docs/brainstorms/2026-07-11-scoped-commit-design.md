# Scoped commit — stop `git add -A` from committing agent scratch

**Status:** design, pending independent review
**Branch:** `fix/scoped-commit` (off main #69)
**Type:** bug fix (styre-core)

## 1. Problem & root cause

`commitWorktree` (`src/dispatch/worktree.ts:41`) stages every dispatch commit with `git add -A`.
That sweeps in **any** file present in the worktree — including throwaway files an agent creates
for its own use (reproduction scripts, debug harnesses, scratch test runners).

On the astropy bench instance (SMOKE=2 @ #69) the implement agent left four scratch scripts at the
repo root (`test_bug.py`, `check_tests.py`, `run_ac_tests.py`, `run_separable_tests.py`). The core
fix itself was correct (a pure edit to `astropy/modeling/separable.py`), but `git add -A` committed
the scratch into the fix diff. styre's own review gate correctly flagged the scope leakage as a
`major` + `deferral_candidate` finding and escalated to the (non-existent, headless) human — a
terminal block on an otherwise-clean run.

`commitWorktree` is the **single shared commit path** for every dispatch step (`run-dispatch.ts:174`),
so this affects every step that commits: `implement:dispatch`, `checks:dispatch`, `design:dispatch`,
`docs:revise`.

## 2. The governing decision (operator-made)

An out-of-scope brand-new file is handled **differently depending on whether the step produces a
committed deliverable**:

- **Steps that commit real work** (`implement`, `checks`, `design:dispatch`, `docs:revise`) →
  **reject-and-retry** (loud). A brand-new file the step produces *might be genuine deliverable
  work*; silently excluding it could drop part of a real fix. So the commit is refused, the worktree
  reverted, and the agent re-dispatched with feedback naming the offending files ("declare them as
  part of the fix, or delete them"). This never silently drops a legitimate file.

- **Read-only steps** (`review`, `design:review`, `design:size`, `checks:classify`,
  `checks:arbitrate`, `design:extract`) → **log-and-continue** (non-gating). These produce no
  committed deliverable, so a stray file is *never* genuine work being lost. There is nothing to
  protect, so gating buys nothing and only adds friction. The stray file is not committed, the
  anomaly is recorded in telemetry, and the loop proceeds. This is the **loop-not-halt** invariant
  (CLAUDE.md): in headless mode a tripwire that halts is worse than useless — no one is there to
  clear it.

The unifying principle: *a brand-new file that isn't in scope is rejected-and-retried on the steps
that commit real work, and logged-and-ignored on the steps that don't. Both are observable in
telemetry; only the first ever stops the loop.*

Rejected alternatives (from the brainstorm):
- **Drop undeclared new files silently** — violates "never drop a legit file"; a genuine unplanned
  new file would be lost, and verify would only catch it after a wasted loop (or wedge).
- **Scratch-name denylist / heuristic** — symptomatic (pattern-matches the specific astropy names),
  fragile, and layout-dependent.
- **Negative list (agent declares scratch, commit the rest)** — never drops, but lets an un-flagged
  scratch file slip to review; the operator preferred the airtight loud path.

## 3. Mechanism: per-step commit scope + named staging

### 3.1 The `commitScope` on `DispatchSpec`

Replace the existing single-purpose `commitGuard` with a **commit scope**: given the agent's output,
a predicate that classifies each pending path as in-scope (part of the deliverable) or an offender.

```ts
interface DispatchSpec {
  // ... existing fields ...
  /** Per-step commit scope. Given the agent's stdout, returns a predicate over each pending
   *  path: (path, isNew) => true means "in scope / part of the deliverable".
   *   - PRESENT  ⇒ the step commits real work. Offenders (predicate false) trigger
   *     reject-and-retry; in-scope new files are staged by name.
   *   - ABSENT   ⇒ read-only step. Tracked edits (if any) are staged; brand-new files are
   *     recorded in telemetry and left uncommitted; never gates.
   *  `isNew` is true iff the path is a brand-new (git-untracked) file, false for an edit or
   *  deletion of an already-tracked file. */
  commitScope?: (output: string) => (path: string, isNew: boolean) => boolean;
}
```

`commitScope` **replaces** `commitGuard` (docs:revise's existing guard is migrated — see §4). The
predicate subsumes what `commitGuard` did: a docs-only rule is `(path) => isDocPath(path)`, which
returns false for a tracked non-doc edit too, so out-of-scope *edits* (not just new files) are still
rejected where a step demands it.

### 3.2 The flow in `runAgentDispatch`

After the agent runs and before committing (replacing the current `commitGuard` block +
`commitWorktree` call, `run-dispatch.ts:158–174`):

```
entries = pendingEntries(worktree)        // [{ path, isNew }], NUL-safe, rename/quote-safe

if (spec.commitScope) {                    // ── write step ──
  inScope   = spec.commitScope(result.stdout)
  offenders = entries.filter(e => !inScope(e.path, e.isNew))
  if (offenders.length > 0) {
    revertWorktree(worktree)               // discard the whole attempt (fix + scratch)
    completeDispatch(..., "dispatch-failed", branchHeadSha = preHead)
    throw Error("commit rejected — out-of-scope files (declare in the fix or delete them): …")
    //   → failure-policy retries; Bug B retry-feedback prepends this message verbatim
  }
  newInScope = entries.filter(e => e.isNew).map(e => e.path)   // all survivors are in-scope
  { sha, changed } = commitWorktree(worktree, msg, newInScope)
} else {                                    // ── read-only step ──
  stray = entries.filter(e => e.isNew).map(e => e.path)
  if (stray.length > 0) recordStray(ctx, spec.handlerKey, stray)   // telemetry, NON-gating
  { sha, changed } = commitWorktree(worktree, msg, [])            // git add -u only
}
```

The reject path is byte-for-byte the existing `commitGuard` semantics (revert → `dispatch-failed`
with HEAD unchanged at `preHead` → rethrow → failure-policy). The only additions are (a) offender
computation from a scope predicate rather than a fixed guard, (b) named staging, and (c) the
read-only telemetry branch.

### 3.3 `commitWorktree` — named staging (no more `git add -A`)

```ts
export function commitWorktree(
  worktreePath: string,
  message: string,
  newPaths: string[],          // NEW: the in-scope brand-new files to stage by name
): { sha: string; changed: boolean } {
  git(["add", "-u"], worktreePath);                       // all tracked edits + deletions
  if (newPaths.length > 0) git(["add", "--", ...newPaths], worktreePath);  // named new files
  if (git(["status", "--porcelain"], worktreePath) === "") {
    return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: false };
  }
  git(["commit", "-m", message], worktreePath);
  return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: true };
}
```

`git add -u` stages every modification/deletion of an already-tracked file — always in scope, since a
scratch file is never a tracked file. `git add -- <newPaths>` stages exactly the declared new files.
Nothing else is staged, so even if a scope predicate is ever wrong, undeclared scratch is not
committed (defense-in-depth, in addition to the reject gate). Ignored files (the ephemeral SQLite
under XDG state, build artifacts) are invisible to both `git status --porcelain` and `git add`, so
they are excluded exactly as before.

> **Empty-diff note:** the `changed` return still means "this commit added a new HEAD". `git add -u`
> with no tracked edits and `newPaths = []` produces an empty index → `changed: false`, HEAD returned
> unchanged. Read-only steps therefore keep returning `changed: false`, preserving every existing
> postcondition.

### 3.4 `pendingEntries` helper (`worktree.ts`)

Extend the existing `pendingChanges` porcelain-`-z` parser (already NUL-delimited, `quotePath=false`,
rename/copy-aware — see `worktree.ts:125`) to also carry the status, and derive `isNew`:

```ts
export interface PendingEntry { path: string; isNew: boolean; }
/** isNew ⇔ git status is `??` (a brand-new untracked file). Edits (`M`), deletions (`D`),
 *  renames (`R`), copies (`C`), staged-adds (`A`) are all tracked changes ⇒ isNew=false. */
export function pendingEntries(worktreePath: string): PendingEntry[];
```

`pendingChanges` (paths-only) is kept as a thin wrapper (`pendingEntries(...).map(e => e.path)`) so
current callers are undisturbed.

## 4. Per-step scopes

| Step | `commitScope` predicate | Rationale |
|------|------------------------|-----------|
| `implement:dispatch` | `!isNew \|\| declaredNewFiles.has(path)` where `declaredNewFiles` = the agent's `new_files` (§5) | tracked edits always OK; a brand-new file must be declared as part of the fix |
| `checks:dispatch` | `!isNew \|\| declared.has(path)` where `declared` = `checksAuthored[].test_file` ∪ an optional `new_files` (§5) | same shape as implement; test files come from the existing `checksAuthored`, and `new_files` covers any legitimate non-test helper (a fixture/`conftest.py`) so it never wedges on one |
| `design:dispatch` | `isPlanPath(path)` (under `docs/plans/`) — applies to edits **and** new files | the planning step's only legitimate output is the plan document; reject any stray code, strictly |
| `docs:revise` | `isDocPath(path)` (under `docs/`) — edits **and** new files (migrated from `commitGuard`) | unchanged behavior: docs-only |
| read-only steps | *(no `commitScope`)* | produce no deliverable; stray file → telemetry + continue, never gate |

Notes:
- **implement / checks** restrict only *new* files; a tracked edit anywhere is legitimate work.
- **design:dispatch / docs:revise** are strict on *everything* (a planning/docs step editing product
  code is itself a defect worth catching).
- `checks:dispatch` already re-validates each `test_file` post-commit (identity check: added-only +
  contains `test_name`, `handlers.ts:578`). The scope gate and the identity check are complementary;
  neither is weakened.

## 5. Implement's new contract: `new_files`

`implement:dispatch` currently emits **no** structured output (its handler parses nothing). Add a
minimal sidecar, mirroring `checks-schema.ts`:

```ts
// src/dispatch/implement-schema.ts
export const ImplementOutputSchema = z.object({
  /** Repo-relative paths of every NEW file this attempt created as part of the fix. Omit / empty
   *  for a pure-edit fix. Throwaway/debug/reproduction files must NOT appear here — and must not be
   *  left in the repo (see prompt). */
  new_files: z.array(z.string()).default([]),
});
```

- **Parsing:** in the implement `commitScope`, `extractSidecar(output, ImplementOutputSchema)`. On
  `absent`/`malformed` → treat `new_files` as `[]` (lenient — NOT a transport failure). Consequence:
  a fix that created a new file but emitted no valid sidecar has an undeclared new file → the scope
  gate rejects it → the retry-feedback nudges the agent to emit `new_files`. A pure-edit fix with no
  sidecar has no new files → commits cleanly. This keeps implement's existing "no required sidecar"
  contract intact (we do not add a new transport-failure mode) while making the declaration
  self-correcting.
- **Prompt slot** (in `IMPLEMENT_TEMPLATE` + `implementVars`): instruct the agent to (a) never leave
  throwaway/debug/reproduction files in the repository — run them elsewhere or delete them before
  finishing; (b) list every genuine new file that is part of the fix in a `new_files` sidecar. This
  is *prevention* (first-try-clean); the reject gate is the backstop.
- **Path normalization:** `new_files` entries are matched against `pendingEntries` paths (git
  status output, repo-relative, forward-slash, `quotePath=false`). Normalize declared paths by
  stripping a leading `./` before set membership. Absolute paths / `..` escapes never match a
  pending path (they simply fail the scope check → treated as undeclared).
- **`checks:dispatch` reuse:** add the same optional `new_files` field to `ChecksOutputSchema`. The
  checks commit scope is `checksAuthored[].test_file` ∪ `new_files` — the authored test files are
  already declared (no redundant re-listing), and `new_files` exists only for the occasional non-test
  helper (fixture/`conftest.py`) so a legitimate helper is never wedged. Same lenient parsing (absent
  → the `checksAuthored` set alone).

## 6. Observability (non-gating)

Both anomaly paths are recorded so scratch frequency is visible without reading diffs:

- **Write-step reject:** already recorded as a `dispatch-failed` dispatch row (streamed as a
  `dispatch` telemetry event); the offender list rides in the thrown error → `workflow_step.error_json`
  → retry-feedback. No new channel needed.
- **Read-only stray (`recordStray`):** write one `event_log` row (per-ticket timeline; the telemetry
  projector already streams `event_log` as `event` NDJSON — `telemetry/events.ts` `EventEvent`), kind
  e.g. `"scratch-ignored"`, `reason` = the step key, `payload_json` = the stray paths. Non-gating: the
  dispatch still records `clean-success` and the loop proceeds. (Exact `event_log` writer confirmed in
  the plan; `ctx.db` is in scope in `runAgentDispatch`.) Surfacing in the PR body is available later if
  it ever proves necessary, but a should-never-fire tripwire does not warrant it now (YAGNI).

## 7. Error handling & edge cases

- **Revert discards the whole attempt.** On reject, `revertWorktree` (`git checkout -- .` +
  `git clean -fd`, no `-x`) throws away the fix *and* the scratch; the retry re-implements from the
  branch HEAD. This is the accepted "costs loops" price of the loud path. The prompt (prevention)
  keeps rejects rare, so a full-redo is the exception, not the rule.
- **Wedge → escalate (bounded).** If an agent both needs an unplanned file *and* refuses to declare
  it across `DEFAULT_MAX_ATTEMPTS` (3), attempt-exhaustion escalates — loud, never silent, and the
  same ceiling every dispatch already has. No new wedge class is introduced.
- **Renames/deletions.** A rename of a tracked file (`R`) is a tracked change (`isNew=false`) →
  always staged by `git add -u`, never treated as a stray new file. A deletion (`D`) likewise.
- **Ignored files.** Untouched — excluded from `git status --porcelain` and `git add` (see §3.3).
- **Absent implement sidecar.** Handled leniently (§5) — never a transport failure.
- **In-place vs worktree mode.** `commitWorktree` operates on `worktreePath`, unchanged; both modes
  behave identically.

## 8. What does NOT change

- Read-only allowlists (agents there still can't write; the stray branch is a tripwire, not expected
  behavior).
- Verify gates, the review verdict taxonomy, the projector, the MERGE gate — all unchanged.
- `checks:dispatch`'s post-commit identity/coverage checks — unchanged (complementary to the scope).
- The failure-policy, retry-feedback (Bug B), and park/resume paths — reused, not modified.

## 9. Testing

- **Scope classifier (pure, per step):** pure-edit fix → no offenders, clean commit; declared new
  file → committed; undeclared brand-new (scratch) → offender → reject; rename/delete of a tracked
  file → staged, never an offender; nested/normalized paths (`./x`, `a/b/c.py`); design/docs strict
  rejection of a stray code edit.
- **`commitWorktree` named staging:** stages tracked edits + named new files only; leaves an
  undeclared new file uncommitted; empty index → `changed:false`, HEAD unchanged; ignored file never
  staged.
- **`runAgentDispatch` wiring:** offender → `revertWorktree` called, `dispatch-failed` with
  `branchHeadSha=preHead`, error message names the offenders (→ becomes retry-feedback); in-scope →
  `clean-success`; read-only stray → `recordStray` emits an `event_log` row AND the dispatch still
  `clean-success` (non-gating).
- **implement `new_files`:** valid sidecar declaring a new file → committed; absent sidecar +
  new file → rejected; absent sidecar + pure edit → clean.
- **Regression:** the migrated `docs:revise` behavior (existing `worktree-guard`/`docs:revise` tests)
  stays green; a non-doc edit by docs:revise is still rejected.

## 10. Resolved sub-decisions

- **Planning step scope:** strict — `design:dispatch` commits only `docs/plans/**`; any stray file
  (code or otherwise) is rejected.
- **Read-only stray files:** non-gating — recorded in telemetry, not committed, never blocks the
  step (loop-not-halt).
