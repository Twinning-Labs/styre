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

**Scope only judges files THIS dispatch created** (review M5). The worktree is reused across every
step of a ticket, so untracked cruft can pre-exist a dispatch: a stray left by an earlier read-only
step, or build artifacts from `provision` (`pip install -e .` → `*.egg-info`, if not git-ignored).
If the scope judged *all* untracked files, that pre-existing cruft would be flagged as an offender
and make a later write step revert its own legitimate work. So we **snapshot the untracked set
before running the agent** and judge only the delta — files this dispatch actually produced.
Pre-existing untracked cruft is neither committed (named staging never stages it) nor rejected (it
isn't this dispatch's offense); it lingers harmlessly and is simply never part of the branch.

After `ensureWorktree`, before running the agent:
```
untrackedBefore = set(pendingEntries(worktree).filter(e => e.isNew).map(e => e.path))
```

After the agent runs and before committing (replacing the current `commitGuard` block +
`commitWorktree` call, `run-dispatch.ts:158–174`):

```
preHead = worktreeHead(worktree)          // capture BEFORE any undo, for dispatch-failed
entries = pendingEntries(worktree)        // [{ path, isNew }], NUL-safe, rename/quote-safe

// Only untracked files created during THIS dispatch are in the scope's jurisdiction (see the
// "attempt cleanup" invariant below — a failed prior attempt leaves NO residue, so a `??` file
// present now that isn't in untrackedBefore was created by THIS attempt).
judged = entries.filter(e => !(e.isNew && untrackedBefore.has(e.path)))

if (spec.commitScope) {                    // ── write step ──
  inScope   = spec.commitScope(result.stdout)
  offenders = judged.filter(e => !inScope(e.path, e.isNew))
  if (offenders.length > 0) {
    undoAttempt(worktree, untrackedBefore) // surgically discard THIS attempt (see below)
    completeDispatch(..., "dispatch-failed", branchHeadSha = preHead)
    throw Error("commit rejected — out-of-scope files (declare in the fix or delete them): …")
    //   → failure-policy retries; Bug B retry-feedback prepends this message verbatim
  }
  newInScope = judged.filter(e => e.isNew).map(e => e.path)   // dispatch-created, in-scope
  { sha, changed } = commitWorktree(worktree, msg, newInScope)
} else {                                    // ── read-only step ──
  stray = judged.filter(e => e.isNew).map(e => e.path)         // dispatch-created only
  if (stray.length > 0) recordStray(ctx, spec.handlerKey, stray)   // telemetry, NON-gating
  { sha, changed } = commitWorktree(worktree, msg, [])            // git add -u only
}
```

`preHead` is captured before any undo (the reject path records `branchHeadSha = preHead`; the agent
never commits, so HEAD is in fact unchanged, but the capture must precede the undo exactly as the
current block does at `run-dispatch.ts:159/166–169`).

#### Attempt cleanup — the invariant that makes `untrackedBefore` correct (review B1, the round-2 Blocker)

The per-attempt `untrackedBefore` snapshot is only sound if **a failed attempt leaves the worktree in
the same state its retry will start from** — otherwise a file created in attempt *N* lingers, attempt
*N+1*'s snapshot treats it as pre-existing cruft, and it is silently dropped *and* wedged forever.
Today, only the reject path reverts; transport-failure (`run-dispatch.ts:152`) and park (`:143`) throw
**without** cleaning up, and no retry/loopback path cleans the worktree. So the fix has two parts:

1. **`undoAttempt(worktree, untrackedBefore)`** — surgically undo the current attempt, *sparing
   pre-existing cruft*:
   ```
   git checkout -- .                                  // restore all tracked files to HEAD
   strays = pendingEntries(worktree).filter(e => e.isNew && !untrackedBefore.has(e.path))
   if (strays) git clean -fd -- <strays>              // remove ONLY this attempt's new files
   ```
   This returns the worktree to exactly its state at the top of the attempt (HEAD + `untrackedBefore`),
   so `provision`'s `*.egg-info` and any earlier read-only stray survive — a **blanket**
   `revertWorktree`/`git clean` would delete `egg-info` and break the editable install, which is why
   `undoAttempt` is scoped to the delta.
2. **Call `undoAttempt` on every PRE-commit failure exit:** the scope-reject path (above), the
   **transport-failure** path (`:152`), and the **park** path (`:143`). (Postcondition failure
   `:185` happens *after* the commit, so this attempt's files are already tracked — no untracked
   residue, no snapshot corruption; it is left as-is.) `undoAttempt` **replaces** the reject path's
   current blanket `revertWorktree` call.

With this, every attempt of a step starts from the identical baseline, so a genuine new file created
by *any* attempt is always judged (committed if declared, rejected if not) and never mistaken for
cruft — the "never drop a legit file" guarantee holds across transport failures, park/resume, and
loopbacks.

> **Park/resume:** `undoAttempt` on park discards the parked attempt's *uncommitted worktree edits*,
> not its carried context. Resume re-runs the interrupted step with the transcript hint (advisory);
> per CLAUDE.md the repository + journal are the source of truth, and resume already re-checks the
> branch HEAD — so a clean worktree on resume is correct, not lossy.

### 3.3 `commitWorktree` — named staging (no more `git add -A`)

```ts
export function commitWorktree(
  worktreePath: string,
  message: string,
  newPaths: string[],          // NEW: the in-scope brand-new files to stage by name
): { sha: string; changed: boolean } {
  git(["add", "-u"], worktreePath);                       // all tracked edits + deletions
  if (newPaths.length > 0) git(["add", "--", ...newPaths], worktreePath);  // named new files
  // Emptiness is decided by the STAGED INDEX, not the working tree (review B1): `git status
  // --porcelain` also reports untracked strays, so a read-only step with an undeclared stray and
  // no tracked edit would (wrongly) look dirty here and try to `git commit` an empty index → git
  // exits 1 → throw → gates a step that must never gate. `git diff --cached --quiet` exits 0 iff
  // nothing is staged. (Uses a non-throwing spawn: exit 1 is the expected "has staged changes"
  // signal, not an error — the module-private `git()` wrapper throws on any non-zero.)
  if (stagedIndexEmpty(worktreePath)) {
    return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: false };
  }
  git(["commit", "-m", message], worktreePath);
  return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: true };
}
```

`stagedIndexEmpty` runs `git diff --cached --quiet` via a **non-throwing** spawn and maps the exit
code explicitly (review MINOR 5): **`0` → empty** (nothing staged), **`1` → non-empty** (has staged
changes), **anything else (≥128) → a real git error → throw** (never silently treated as "has
changes", which would `git commit` a possibly-broken index).

`git add -u` stages every modification/deletion of an already-tracked file. `git add -- <newPaths>`
stages exactly the declared new files (`git add -u` alone does **not** stage new files — the named add
is what commits legitimate new work). Nothing else is staged, so even if a scope predicate is wrong,
undeclared *untracked* scratch is not committed (defense-in-depth alongside the reject gate). Ignored
files (the ephemeral SQLite under XDG state, git-ignored build artifacts) are invisible to `git add`,
so they are excluded exactly as before.

> **Scope of the guarantee (review M3 — honest bound):** this fix eliminates the observed bug —
> **undeclared *untracked* scratch** (the astropy repo-root scripts). It does **not** police *tracked*
> mutations: `git add -u` stages every tracked edit in the worktree, so if a *successful* prior step's
> test run wrote back to a tracked file (a regenerated snapshot/golden file, a tracked `.coverage`)
> and left it uncommitted, the next write step's `git add -u` still sweeps it in. That is a distinct,
> pre-existing leak class (`git add -A` did it too), rarer than untracked scratch, and out of scope
> here — `undoAttempt` covers a *failed* attempt's tracked edits, but not a *succeeded* upstream
> step's. If it ever bites, the follow-up is a symmetric `dirtyBefore` tracked snapshot + selective
> `git add -- <this dispatch's tracked mods>`; deferred under YAGNI, noted so the claim isn't oversold.

> **Empty-diff note:** `changed` means "this commit added a new HEAD". Emptiness is measured on the
> **staged index** (`git diff --cached --quiet`), not the working tree. So `git add -u` with no
> tracked edits and `newPaths = []` → empty index → `changed: false`, HEAD unchanged — *even if an
> undeclared untracked stray sits in the worktree* (it is not staged, so it does not force a commit).
> Read-only steps therefore keep returning `changed: false`, preserving every existing postcondition.

### 3.4 `pendingEntries` helper (`worktree.ts`)

Extend the existing `pendingChanges` porcelain-`-z` parser (already NUL-delimited, `quotePath=false`,
rename/copy-aware — see `worktree.ts:125`) to also carry the status, and derive `isNew`:

```ts
export interface PendingEntry { path: string; isNew: boolean; }
/** isNew ⇔ the porcelain status is `??` (a brand-new untracked file). Everything else is a change
 *  to an already-tracked file ⇒ isNew=false: modifications (`M`/` M`/`MM`), deletions (`D`/` D`),
 *  the tracked half of an unstaged rename (see §7). Agents cannot stage, so in the real flow an
 *  agent-created file is always `??`, never a staged-add `A ` — the classifier keys purely on the
 *  leading `?` of the XY status. */
export function pendingEntries(worktreePath: string): PendingEntry[];
```

**Rename second-token caution (review MINOR 4):** the existing `-z` parser (`worktree.ts:136–145`)
emits a staged rename/copy's **original path as a bare second token with no XY status prefix**.
`pendingEntries` must assign that second token `isNew=false` (it is the deletion half) — **not**
status-parse its first two characters (which would misread path bytes as a status). Only a staged
rename (`R`) produces this two-token record and agents cannot stage, so it is low-probability, but the
helper must handle it explicitly. Add a `git mv`-shaped porcelain record to the helper's tests.

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

**Wire per CALL SITE, not per step name (review M3).** Scope is attached to each `runAgentDispatch`
*call*, and some handlers have more than one. The authoritative enumeration of the 12 call sites in
`handlers.ts` (verified):

| Call site | Kind | `commitScope` |
|-----------|------|---------------|
| `implement:dispatch` (~843) | write | implement (new_files) |
| `checks:dispatch` register (~542) | write | checks (test_file ∪ new_files) |
| `checks:dispatch` in `reauthorCheckWrong` (~234) | write | checks (same predicate — shared helper) |
| `design:dispatch` (~371) | write | `docs/plans/**` strict |
| `docs:revise` (~506) | write | `docs/**` strict |
| `checks:classify` (~201, ~729), `design:extract` (~386), `design:size` (~440), `design:review` (~460), `checks:arbitrate` (~1483), `review` (~1570) | read-only | *(none)* |

The **second checks call site (`reauthorCheckWrong`, ~234) is load-bearing**: it authors a new test
file and its `reauthorSha` feeds the identity check (`handlers.ts:250`). Miss it and the reauthor's
test file never stages → identity fails → the re-author path silently always rejects. The two checks
call sites must share one scope helper.

Non-`runAgentDispatch` registered steps (`provision` ~877, `completeness` ~995, `verify:*`,
`merge:*`, `released:project`) never reach `commitWorktree` and are untouched. `provision`'s untracked
artifacts are handled by the untracked-before snapshot of the *next* dispatch (§3.2), not here.

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
- **`checks:dispatch` reuse:** add the same optional `new_files` field to `ChecksOutputSchema`. When
  the sidecar **parses**, the checks commit scope is `checksAuthored[].test_file` ∪ `new_files` — the
  authored test files are already declared (no redundant re-listing), and `new_files` exists only for
  the occasional non-test helper (fixture/`conftest.py`) so a legitimate helper is never wedged.
- **Checks scope must NOT gate on an *unparseable* sidecar (review M2).** Both checks call sites — the
  register (`handlers.ts:542`) and `reauthorCheckWrong` (`:234`) — parse the sidecar *after* commit and
  have established semantics for an absent/malformed one: the main handler treats it as a transport
  failure (re-dispatch), `reauthorCheckWrong` returns a clean `"rejected"` (`:244–245`). If the
  pre-commit scope instead treated a malformed sidecar as `declared = ∅`, the freshly-authored test
  file would become an offender → the scope would throw, converting `reauthorCheckWrong`'s clean
  `return "rejected"` into an uncaught throw that propagates through `checks:arbitrate` and burns its
  attempts — a control-flow change on an error path. So the checks scope predicate **defers on an
  unparseable sidecar**: if `extractSidecar` returns `absent`/`malformed`, the scope allows everything
  (no scope rejection) and lets the handler's existing post-commit logic decide. Scope enforcement
  applies only when the declaration is actually readable. (This preserves the pre-existing behavior
  that a malformed-sidecar checks attempt commits then fails downstream — `git add -A` did the same.)

## 6. Observability (non-gating)

Both anomaly paths are recorded so scratch frequency is visible without reading diffs:

- **Write-step reject:** already recorded as a `dispatch-failed` dispatch row (streamed as a
  `dispatch` telemetry event); the offender list rides in the thrown error → `workflow_step.error_json`
  → retry-feedback. No new channel needed.
- **Read-only stray (`recordStray`):** write one `event_log` row via `appendEvent` (`event-log.ts`;
  the telemetry emitter already streams `event_log` as `event` NDJSON — `telemetry/events.ts`
  `EventEvent`). **`kind` must be `"note"`** — `event_log.kind` has a hard CHECK constraint
  `IN ('transition','loopback','escalated','resumed','note','parked')` (`schema.sql:289`, mirrored by
  the `EventKind` union), so a novel kind like `"scratch-ignored"` would throw on INSERT and *gate*
  the step — the opposite of the intent (review B2). Use `kind:"note"`, `reason` = the step/handler
  key, and pass the stray paths **as an object** — `appendEvent`'s `payload?: Record<string, unknown>`
  is `JSON.stringify`'d (`event-log.ts:63,83`), so the call is `payload: { stray }`, not the bare
  `string[]` (review NIT 6). Non-gating: the dispatch still records `clean-success` and the loop
  proceeds. `ctx.db` is in scope in `runAgentDispatch`. Surfacing in the PR body is available later if
  it ever proves necessary, but a should-never-fire tripwire does not warrant it now (YAGNI).

## 7. Error handling & edge cases

- **`undoAttempt` discards the whole attempt (surgically).** On reject — and on transport-failure and
  park (§3.2) — `undoAttempt` restores tracked files to HEAD and removes *only this attempt's* new
  untracked files, sparing pre-existing cruft (`egg-info`). The retry re-implements from the branch
  HEAD. This is the accepted "costs loops" price of the loud path. The prompt (prevention) keeps
  rejects rare, so a full-redo is the exception, not the rule.
- **Wedge → escalate (bounded).** If an agent both needs an unplanned file *and* refuses to declare
  it across `DEFAULT_MAX_ATTEMPTS` (3), attempt-exhaustion escalates — loud, never silent, and the
  same ceiling every dispatch already has. No new wedge class is introduced.
- **Renames (review M4).** Only a *staged* rename (`git mv`) shows as a single `R` entry. An agent
  using Write/Edit tools produces an **unstaged** rename, which git reports as **two** entries — a
  deletion (` D old`, `isNew=false`) and a brand-new file (`?? new`, `isNew=true`). So the new half
  is judged like any new file: for `implement` it must appear in `new_files` (a rename *is* the agent
  creating a file, so declaring it is correct); for `design:dispatch`/`docs:revise` it must fall under
  the doc path. This is loud, never data-loss, but it means "a rename is always in scope" is **false**
  — a rename's new half needs the same declaration as any new file.
- **Deletions.** A deletion of a tracked file (` D`) is `isNew=false` → staged by `git add -u`.
- **Ignored files.** Untouched — git-ignored artifacts are invisible to `git add` and to the
  porcelain snapshot (see §3.3), so they are never staged, never an offender, never a stray.
- **Pre-existing untracked cruft (review M5).** A stray left by an earlier read-only step, or
  `provision`'s `*.egg-info`, is captured in `untrackedBefore` (§3.2) → excluded from the current
  dispatch's judgment: not committed, not an offender. It lingers in the reused worktree but never
  enters the branch and never makes a downstream write step revert its own work.
- **Absent implement sidecar.** Handled leniently (§5) — never a transport failure.
- **In-place vs worktree mode.** `commitWorktree` operates on `worktreePath`, unchanged; both modes
  behave identically.

## 8. What does NOT change

- Read-only allowlists (agents there still can't write; the stray branch is a tripwire, not expected
  behavior).
- Verify gates, the review verdict taxonomy, the projector, the MERGE gate — all unchanged.
- `checks:dispatch`'s post-commit identity/coverage checks — unchanged (complementary to the scope).
- The failure-policy and retry-feedback (Bug B) — reused, not modified.
- **Changed (small):** the transport-failure and park exits in `runAgentDispatch` gain an
  `undoAttempt(worktree, untrackedBefore)` call before they throw (§3.2). This only cleans the failed
  attempt's *uncommitted* worktree delta; it changes no journal/outbox/resume-HEAD logic. Park's
  carried context (the transcript) and resume's HEAD re-check are untouched.

## 9. Testing

- **Scope classifier (pure, per step):** pure-edit fix → no offenders, clean commit; declared new
  file → committed; undeclared brand-new (scratch) → offender → reject; rename/delete of a tracked
  file → staged, never an offender; nested/normalized paths (`./x`, `a/b/c.py`); design/docs strict
  rejection of a stray code edit.
- **`commitWorktree` named staging:** stages tracked edits + named new files only; leaves an
  undeclared new file uncommitted; empty index → `changed:false`, HEAD unchanged; ignored file never
  staged.
- **`commitWorktree` named staging:** additionally — a read-only step with an undeclared untracked
  stray and no tracked edit → **empty staged index → `changed:false`, no commit, no throw** (the B1
  regression guard: proves emptiness is measured on the index, not `git status --porcelain`).
- **`runAgentDispatch` wiring:** offender → `undoAttempt` called, `dispatch-failed` with
  `branchHeadSha=preHead`, error message names the offenders (→ becomes retry-feedback); in-scope →
  `clean-success`; read-only stray → `recordStray` emits an `event_log` row (`kind:"note"`, `payload:
  { stray }`) AND the dispatch still `clean-success` (non-gating).
- **Pre-existing untracked (M5):** a stray present *before* the dispatch (seed an untracked file, then
  run) is neither committed nor an offender — a write step whose agent makes a clean in-scope edit
  still `clean-success` despite the pre-existing stray; the stray never enters the commit.
- **No-drop across a transport-failure retry (review B1 — the round-2 regression guard):** attempt 1
  creates a new file then transport-fails → assert `undoAttempt` removed it (worktree back to HEAD +
  pre-existing cruft); attempt 2 re-creates the same path + declares it → it **commits** (never
  silently dropped). And a paired case: attempt 1 leaves an undeclared scratch file + transport-fails
  → `undoAttempt` removes it, so attempt 2's snapshot is clean.
- **`undoAttempt` spares cruft:** seed a git-ignored/pre-existing untracked `pkg.egg-info` before the
  dispatch; on reject/transport-failure `undoAttempt` removes the attempt's new files but **leaves
  `pkg.egg-info` intact**.
- **`stagedIndexEmpty` exit-code mapping:** pure deletion → `changed:true`; nothing staged →
  `changed:false`; a forced git error → throws (not silently "has changes").
- **Unstaged rename (M4):** an agent delete+add pair → the new half is an offender for `implement`
  unless declared in `new_files` (not silently swept, not silently dropped); `pendingEntries` on a
  `git mv`-shaped `-z` record assigns the second (original-path) token `isNew=false`.
- **checks unparseable-sidecar deferral (M2):** `reauthorCheckWrong` with an absent/malformed sidecar
  → the scope does **not** reject (defers) → the handler's existing `return "rejected"` path runs, not
  an uncaught throw; a *parseable* sidecar with an undeclared scratch file → reject.
- **implement `new_files`:** valid sidecar declaring a new file → committed; absent sidecar +
  new file → rejected; absent sidecar + pure edit → clean.
- **Test migration (review MINOR 6 — explicit):** `test/dispatch/worktree-guard.test.ts` currently
  exercises `commitGuard` as a generic mechanism (specs with a `commitGuard:` field). Since
  `commitScope` **replaces** `commitGuard`, those tests are **rewritten** to `commitScope`, preserving
  the reject-path assertions (`dispatch-failed`, `branch_head_sha===preHead`, worktree undone via
  `undoAttempt`). `docs-revise-handler.test.ts` (non-doc edit rejected) must stay green under the migrated
  predicate — assert `(path)=>isDocPath(path)` yields an offender for a **tracked** non-doc edit
  (`isNew=false`, `isDocPath` false → `!inScope` true), not only for a new file. Any `commitWorktree`
  caller/test updates for the new `newPaths` argument are part of this.

## 10. Resolved sub-decisions

- **Planning step scope:** strict — `design:dispatch` commits only `docs/plans/**`; any stray file
  (code or otherwise) is rejected.
- **Read-only stray files:** non-gating — recorded in telemetry, not committed, never blocks the
  step (loop-not-halt).
