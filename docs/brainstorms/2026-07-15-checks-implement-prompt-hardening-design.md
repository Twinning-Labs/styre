# ENG-297 — checks/implement prompt hardening + resolver-norm Minor

**Status:** design approved 2026-07-15, ready for implementation plan.
**Ticket:** ENG-297 (Linear). **Branch/worktree:** `fix/eng-296-checks-path-divergence` (`fix+checks-red-first`) — stacked on the merged-path ENG-296 fix it complements.

## Problem

Two nondeterministic checks-agent slips, observed in the 2026-07-13 SMOKE=2 astropy run, degrade the `checks:dispatch` step:

1. **Path mis-declaration.** The agent *wrote* its RED-first test to `…/styre_checks/ENG-294_ac1_test.py` (the templated location) but *declared* `checksAuthored[].test_file` without the `styre_checks/` segment. ENG-296 made this non-fatal at the runner (trust what was committed), but the prompt still invites the slip: `prompts/checks.md:15` gives the canonical path only as a soft `e.g.` and never requires *declared == written*.

2. **Scratch-file spree.** The agent created 8 throwaway repros (`test_bug.py`, `reproduce_bug.py`, `run_*.py`, `BUG_ANALYSIS.md`) and, to avoid the "commit REJECTED if it contains any NEW file you did not declare" rule, dumped them into `new_files` instead of deleting them. The current wording (`checks.md:32–36`, added PR #72) forbids leftover scratch but simultaneously offers `new_files` as a declaration escape hatch — so the perverse move is to declare the scratch. **`implement.md:20–23` carries the identical leak** (same "REJECTED if undeclared" phrasing, same loose `new_files` definition).

Separately, one **code Minor** was deferred from the ENG-296 PR #79 review: `resolveAuthoredTestPath`'s fallback compares `addedPaths.includes(declaredTestFile)` on raw strings, while the scope guard normalizes with `norm()`. A declared `./api/foo.py` vs git's `api/foo.py` misses the fallback and returns `null` (spurious "uncovered").

**This work is complementary hardening** — it lowers slip *frequency* at the prompt source. ENG-296 already makes a slip *non-fatal*. Neither part is load-bearing alone; together they make `checks:dispatch` robust.

## Scope

**IN**
- `prompts/checks.md` — pin the canonical RED-first path (declared == written, byte-identical) + redirect scratch out of tree + narrow `new_files`.
- `prompts/implement.md` — the scratch half only (redirect scratch out of tree + narrow `new_files`).
- `src/dispatch/check-path.ts` — normalize the resolver fallback comparison (the deferred Minor), hoisting a single `norm` shared with `commit-scope.ts`.
- The two prompt-assertion tests that encode the old stance.

**OUT**
- No change to RED-first semantics, the gate order, or the scope-guard *behavior* (the guard still rejects undeclared new files — only the prompt's framing of how to avoid that changes).
- No in-tree scratch directory / guard-skip mechanism (considered and rejected — see below).

## Design

### Part A — `prompts/checks.md` (wording)

1. **Pin the path (currently line 15).** Replace the soft `e.g.` with a firm requirement:
   - The RED-first test **MUST** be written at `…/styre_checks/{{ident}}_ac<id>_test.<ext>` under the component's test root (Go/Rust keep their own package/module dir).
   - The `test_file` you declare in `checksAuthored` **MUST be the byte-identical path you wrote** — the same string, with no dropped or added path segment and no `./` prefix.
2. **Redirect scratch out of tree (currently lines 32–36).** Do all repro/debug/scratch work **outside the worktree** (`$TMPDIR` or `/tmp`), never in-tree — so there is nothing to delete and nothing for the guard to catch.
3. **Narrow `new_files`.** Redefine it as *only* genuine test infrastructure a check needs to run (a fixture / `conftest.py`) — **explicitly not** repros, debug scripts, or reproduction files. This removes the "declare-your-scratch" incentive. The commit-rejection sentence stays (it is the guard's real enforcement), but `new_files` is no longer framed as the place to park scratch.

### Part B — `prompts/implement.md` (wording)

Apply A2 + A3 only:
- Redirect scratch/repro/debug work to `$TMPDIR`/`/tmp`, firming the existing "keep it outside the repository."
- Narrow `new_files` to genuine parts of the fix, explicitly excluding repros/debug/scratch.
- **No path-pinning clause** — implement has no canonical-path convention (`new_files` paths are wherever the fix legitimately lands).

### Part C — `src/dispatch/check-path.ts` (the Minor)

- Add and **export** `normPath(p)` in `check-path.ts` (the low-level pure module): `p.replace(/\\/g, "/").replace(/^\.\//, "")` — identical to `commit-scope.ts`'s current local `norm`.
- In `resolveAuthoredTestPath`, normalize both sides of the fallback: compare `normPath(declaredTestFile)` against `addedPaths.map(normPath)`. Return the matching *added* path (git's form), not the raw declared string, so downstream freeze/replay uses the real committed path.
- Refactor `commit-scope.ts` to **import `normPath`** and delete its duplicate local `norm` — single source of truth (also removes the exact duplication a reviewer would flag).

## Alternatives considered

- **In-tree ignored scratch dir** (e.g. `.styre_scratch/` the guard skips). Rejected: forgiving of the bad habit but requires a scope-guard code change (widens beyond wording), leaves scratch on the branch, and doesn't teach the agent the right behavior. Redirecting to `/tmp` is prompt-only and `/tmp` is already outside what the guard scans.
- **Prompt-only Minor deferral** (keep ENG-297 wording-only per the ticket's literal OUT). Rejected by operator — bundling the one-line resolver fix here avoids a trivial standalone PR and matches the session framing. The ticket's OUT boundary is relaxed deliberately for this single Minor.

## Testing

- **Part C (unit):** extend `test/dispatch/check-path.test.ts` — `resolveAuthoredTestPath` with declared `./api/tests/foo.py` and added `api/tests/foo.py` now returns `api/tests/foo.py` (was `null`). Confirm `test/dispatch/commit-scope.ts` tests stay green after the `norm → normPath` import swap.
- **Parts A/B (prompt assertions):**
  - **Rewrite** `test/dispatch/checks-prompt.test.ts:18` — its current title/assertion encodes the *old* stance ("new_files as a scratch escape hatch"). New assertions: prompt requires declared == written / byte-identical / canonical `styre_checks/` path; redirects scratch out of the worktree (`/tmp`/`$TMPDIR`); still mentions `reject` (guard enforcement) and `new_files` (now scoped to genuine fixtures).
  - **Strengthen** `test/dispatch/prompt-vars.test.ts:244` (implement) — keep `new_files` / `do not leave` / `styre-sidecar` assertions; add one asserting scratch is redirected out of tree.
  - The "fewer stray files / no path-mismatch escalation" AC is a live-bench signal (SMOKE run), not a unit test — noted, not automated here.

## Acceptance criteria (from ticket, mapped)

- [ ] `checks.md` requires declaring `test_file` as the byte-identical written path at the canonical `styre_checks/` location. → Part A1
- [ ] `checks.md` redirects scratch/debug files out of the work tree. → Part A2/A3
- [ ] (bundled) `implement.md` gets the same scratch redirect + narrowed `new_files`. → Part B
- [ ] (bundled Minor) resolver fallback normalizes path comparison. → Part C
- [ ] Prompt-assertion tests updated to the new stance; unit test for Part C. → Testing
