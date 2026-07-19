# Scope-disposition smoke matrix

Adversarial end-to-end coverage of the scope guard under the declare-or-discard change. Every cell is a
smoke test that drives a **real dispatch through the registry** (`FakeAgentRunner` + real SQLite + real
git worktree, the `handlers.test.ts` full-loop harness) and asserts the observable outcome: what got
**committed**, what got **discarded**, what got **rejected/re-dispatched**, and what got **surfaced**.

Legend for expected outcome: **COMMIT** (file in the dispatch commit) · **DISCARD** (deleted from
worktree, not committed, `scope-discarded` note) · **REJECT** (dispatch-failed + throw + revert, no
commit) · **RE-DISPATCH** (transport failure → step back to pending) · **SWEEP** (removed by
`sweepScratch` before the guard) · **SPARE** (pre-existing cruft left untouched) · **SURFACE** (named in
the failure feedback).

Each **negative/guard** cell (marked ⚔) must be shown **non-vacuous**: with the guard/disposition
reverted, the test must fail. The builder demonstrates this for the ⚔ rows (mutate → red → restore).

---

## Plain-language summary — what these tests check

"Junk" = a file the agent left behind without declaring it. "Kept" = saved into the change.

**Writing the tests** (styre now deletes junk here instead of getting stuck):
- Agent writes a proper test and declares it → kept
- Test's filename differs slightly from what was declared → still recognized, kept
- Small required support file next to the test → kept
- Agent leaves loose junk → junk deleted, test kept, no getting stuck *(the original bug)*
- Agent edits an existing file → kept
- Agent adds a new file **and** deletes one (looks like a move) → styre refuses to delete, to avoid losing a moved file
- Agent properly renames a file → both sides kept safely
- Agent uses the official scratch folder → wiped, test kept
- Pre-existing files styre didn't create → left untouched
- Agent's file-list note comes back garbled → styre undoes everything and re-runs (no half-save)
- Test needs a helper the agent forgot to declare (so it got deleted) → styre notices the test can't run, stops, and names the deleted file *(the silent-bad-merge fix)*
- Agent tries to sneak a passing test via an undeclared file → file deleted so it can't cheat; declaring it properly keeps it
- Test legitimately fails because the feature isn't built yet, with unrelated junk deleted → styre correctly keeps it (doesn't confuse "feature missing" with "I deleted your helper")

**Rewriting a test that was wrong:**
- Agent rewrites and declares it → kept
- Agent leaves junk during the rewrite → deleted, no getting stuck

**Writing the code** (default: styre still rejects junk here — unchanged):
- New code file, declared → kept
- Undeclared junk → rejected (old safe behavior)
- Edit to existing code → kept
- Only edits, no file-list note → fine, kept
- New file but no file-list note → rejected
- File-list note garbled → rejected / re-run
- Uses the scratch folder → wiped, fix kept

**Writing the code with the optional "delete junk" switch turned ON:**
- Declares its real file, leaves junk → real file kept, junk deleted
- Adds an undeclared file with no note → styre re-runs (won't silently delete it), pre-existing files untouched
- Note garbled → undo and re-run
- New file + a deletion (a move) → refused, no data loss
- Only edits, no note → fine, kept

**Writing the plan** (only plan files allowed):
- Plan file → kept
- File somewhere it shouldn't be → rejected
- Editing source code from the plan step → rejected

**Editing docs** (only doc files allowed):
- Doc file → kept
- File outside docs → rejected
- Editing source from the docs step → rejected

**General safety checks:**
- Any step that didn't opt into "delete junk" → still rejects junk (safe default)
- A look-only step that leaves a stray file → noted, not deleted, not blocked
- When styre deletes junk, its record lists exactly which files it deleted
- Leftover scratch is swept away before the full test run
- The "files out of scope" message states facts only — no bossy instructions

---

## A. `checks:dispatch` (disposition = discard)

| # | Agent produces | Sidecar | Expected | Notes |
|---|---|---|---|---|
| A1 | declared test (`test_file` in `checksAuthored`) | valid | **COMMIT** | happy path |
| A2 | canonical `{ident}_ac{id}_test.py` at a path ≠ declared | valid | **COMMIT** | ENG-296 basename recognition |
| A3 | `styre_checks/__init__.py` co-located w/ canonical test | valid | **COMMIT** | ENG-323 support admission (retained) |
| A4 ⚔ | undeclared loose `scratch.py` (+ a valid declared test) | valid | test **COMMIT**, scratch **DISCARD** + note | the live-bug fix; no reject, dispatch proceeds |
| A5 | in-scope tracked edit (edits a committed file) | valid | **COMMIT** | `checksScopeFor` allows `!isNew` |
| A6 ⚔ | undeclared new `moved.py` + `git rm` of a tracked file | valid | **REJECT** (rename-safety) | unpaired deletion+new → never discard |
| A7 | `git mv tracked.py renamed.py` (git-detected rename) | valid | **COMMIT** both halves | paired → `isNew=false`, not discarded |
| A8 | `styre_scratch/probe.py` (+ valid declared test) | valid | scratch **SWEEP**, test **COMMIT** | primary sweep still runs before the guard |
| A9 | nothing new; pre-existing `*.egg-info` present | valid | egg-info **SPARE** | untrackedBefore excluded from judgment/discard |
| A10 ⚔ | malformed sidecar block | malformed | **RE-DISPATCH**, rollback to preHead, no commit | `checksScopeFor` defers → handler re-parses → throws |
| A11 ⚔ | canonical test that imports an undeclared loose helper (helper outside `styre_checks/`) | valid | helper **DISCARD** → import-error **RED** (pytest exit 2) → discard-poison guard → uncovered → **SURFACE** helper in feedback, no covered check persisted | a whole-missing-module RED buckets coarse-`red`, not `selected-none`; `importErrorImplicatesDiscarded` routes it to the uncovered path so no permanently-broken check installs (silent-bad-merge fix) |
| A12 ⚔ | undeclared NEW source file that would fake a green (`import smuggle`) | valid | source **DISCARD** → `import` becomes import-error **RED** naming the discarded file → discard-poison guard → uncovered → **REJECT** + **SURFACE** | a green smuggled via an undeclared new file can't happen — discard makes it RED; contrast: **declaring** the file keeps it → real green → **COMMIT** (classify judges it). An in-scope tracked-edit green is out of scope here, handled by classify |
| A13 ⚔ | canonical test whose fail-first RED names the FEATURE module (`newfeature` absent) + an UNRELATED throwaway discarded | valid | throwaway **DISCARD**, RED check **COMMIT**, AC **COVERED** | true-negative: the discard-poison guard must NOT reject a legitimate fail-first test just because unrelated throwaway was discarded (import error names the feature, not a discarded file) |

> **Coverage boundary for A11–A13 (documented residual — ENG-343).** The discard-poison guard
> (`importErrorImplicatesDiscarded`) recognizes **Python and Node** import-error phrasings only. On
> Go/Rust/JVM/Ruby/PHP a discarded imported helper produces a compile/collection error the matcher does
> not recognize, so on those stacks the poisoned-red → environmental → non-gating-advisory silent bad
> merge **is still reachable**. A11–A13 are pytest cases; the guard is not yet general. Extension tracked
> in ENG-343.

## B. `checks` re-author (`reauthorCheckWrong`, disposition = discard)

| # | Agent produces | Expected | Notes |
|---|---|---|---|
| B1 | declared canonical test for the flagged AC | **COMMIT** | scoped to flagged ACs |
| B2 ⚔ | undeclared loose `scratch.py` | **DISCARD** + note, no reject | re-author has disposition=discard too |

## C. `implement:dispatch` (default: disposition = reject)

| # | Agent produces | Sidecar | Expected | Notes |
|---|---|---|---|---|
| C1 | new file listed in `new_files` | valid | **COMMIT** | declared new file kept |
| C2 ⚔ | undeclared loose `junk.py` | valid | **REJECT** (out-of-scope files) | today's behavior preserved |
| C3 | in-scope tracked edit | valid/absent | **COMMIT** | edits are the deliverable |
| C4 | pure edit, no new files | absent | **COMMIT** | absent sidecar is legit for implement |
| C5 ⚔ | undeclared new file `x.ts` | absent | **REJECT** | declared empty → offender (reject mode) |
| C6 ⚔ | edit + a new file, malformed block | malformed | **REJECT** → re-dispatch | transport failure, unchanged |
| C7 | `styre_scratch/dbg.py` (+ declared fix) | valid | scratch **SWEEP**, fix **COMMIT** | implement keeps the drawer |

## D. `implement:dispatch` (flag: `implementDisposition = "discard"`)

| # | Agent produces | Sidecar | Expected | Notes |
|---|---|---|---|---|
| D1 | declared new + undeclared loose `junk.py` | valid | declared **COMMIT**, junk **DISCARD** + note | valid sidecar → discard throwaway (intended) |
| D2 ⚔ | undeclared `x.ts`, no sidecar | absent | **RE-DISPATCH** (reset guarded on sha; row not falsely reverted; egg-info spared) | absent-with-discard guard |
| D3 ⚔ | edit committed + malformed block | malformed | **RE-DISPATCH**, row re-marked `reverted`, HEAD reset to preHead | malformed always |
| D4 ⚔ | undeclared new `moved.ts` + tracked deletion | valid | **REJECT** (rename-safety) | applies in discard mode |
| D5 | pure edit, no new files, no sidecar | absent | **COMMIT**, no re-dispatch | absent + no discard → proceed |

## E. `design:dispatch` (plan; disposition unset → reject; scope = `docs/plans/**`)

| # | Agent produces | Expected | Notes |
|---|---|---|---|
| E1 | file under `docs/plans/` | **COMMIT** | in-scope |
| E2 ⚔ | new file outside `docs/plans/` (e.g. `src/x.ts`) | **REJECT** | disposition defaults to reject |
| E3 ⚔ | tracked edit to `src/` (out-of-scope tracked edit) | **REJECT** (out-of-scope tracked edit) | path-scoped step gates edits |

## F. `docs:revise` (disposition unset → reject; scope = `docs/**`)

| # | Agent produces | Expected | Notes |
|---|---|---|---|
| F1 | file under `docs/` | **COMMIT** | in-scope |
| F2 ⚔ | new file outside `docs/` | **REJECT** | default reject |
| F3 ⚔ | out-of-scope tracked edit | **REJECT** (out-of-scope tracked edit) | |

## G. Cross-cutting invariants

| # | Scenario | Expected |
|---|---|---|
| G1 ⚔ | any dispatch with `disposition` omitted | behaves as **reject** (default) |
| G2 | read-only dispatch (no `commitScope`) leaves a stray | stray **noted** (`scratch-ignored`), NOT deleted, NOT rejected |
| G3 | `scope-discarded` note payload | lists exactly the discarded paths |
| G4 ⚔ | pre-verify sweep still runs at `verify:check` | a `styre_scratch/` present at verify is removed before the suite |
| G5 | reject message text | contains `out-of-scope files`, diagnosis-only, no "declare/delete" instruction, no "new_files" for path scopes |

---

**Coverage rule:** every row is one or more tests in `test/dispatch/scope-disposition-smoke.test.ts`.
⚔ rows additionally carry a non-vacuousness note in the smoke report (what was mutated to make them
red). Positive rows assert the file IS in the commit; negative rows assert the wrong file is NOT in the
commit AND the guard outcome (reject/re-dispatch/discard) fired.
