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
| A11 ⚔ | canonical test that imports an undeclared loose helper (helper outside `styre_checks/`) | valid | helper **DISCARD** → `selected-none` → uncovered → **SURFACE** helper in feedback | blocker-3 recovery path |
| A12 ⚔ | a test that is not genuinely RED (source-smuggle makes it pass) | valid | **REJECT** (identity, not-RED) | checks cannot smuggle a green |

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
