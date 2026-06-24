# Task 8 Report: Document the CLI seam (exit codes + resume) + full-suite gate

## Status: DONE

## Commit
- `f80b730` docs: document the parked/resume CLI seam + control-loop atlas note (ENG-164)

## Changes Made

### CLAUDE.md
- Under "## Intended commands (once code exists)", appended a sub-bullet to the `styre run <ticket>` line.
- Added the exact text from the brief: park-on-session-limit behaviour, exit `75` (EX_TEMPFAIL), state dir path, `--resume` flag, `--accept-head` (exit `65` on HEAD moved), `--inspect` (exit `0`).
- Did not touch the OVERRIDE block or any other section.

### docs/architecture/control-loop.md
- After the V4 row (`reviewer death / transport`) in the Loopback Atlas table, inserted a blank line and the blockquote note from the brief:
  > ENG-164: a transport death is now classified by cause. session-limit / out-of-credits →
  > `parked` (resumable, attempt NOT consumed); crash / timeout / unknown → `transient` retry as
  > before. The `parked` dispatch outcome + `event_log.kind='parked'` make a quota pause countable
  > separately from a real failure.

## Gate Results

### 1. `bun test`
```
402 pass
0 fail
1019 expect() calls
Ran 402 tests across 99 files. [15.00s]
```
PASS

### 2. `bun run typecheck`
```
$ tsc --noEmit
(no output — clean)
```
PASS

### 3. `bun run lint`
```
$ biome check .
Checked 188 files in 37ms. No fixes applied.
```
PASS — zero findings

### 4. `bun run build`
```
$ sh scripts/build.sh
  [32ms]  bundle  193 modules
  [80ms] compile  dist/styre
dist/styre: replacing existing signature
```
PASS — binary built and ad-hoc re-signed (macOS codesign, expected)

## Self-Review

- Spec coverage: both doc steps (Step 1 + Step 2) fully implemented with exact text from the brief.
- No other files touched; no test cycle needed for prose-only changes.
- OVERRIDE block in CLAUDE.md is intact and undisturbed.
- Commit message matches the brief's prescribed message, with required trailers appended.
- Branch: `feat/eng-164-transport-failure-classification` (never touched main).

## Concerns
None.

---

## Fix Note: stale `accept-head` baseline (final-review coherence gap, ENG-164)

**Commit:** TBD (appended after commit in this session)

### Bug
`headBaseline` gave `accept-head:<sha>` events unconditional precedence over the latest committed
dispatch sha.  After `--accept-head` records `accept-head:shaA`, the resumed dispatch commits and
advances the branch to shaB.  A subsequent plain `--resume` compared against the stale shaA while
HEAD was shaB (moved only by Styre's own commit) → guard falsely reported HEAD moved → exit 65
forced a redundant `--accept-head`.

### Fix (src/cli/park.ts)
`headBaseline` now picks the most-recent of {latest `accept-head:` event, latest dispatch row with
a non-null `branch_head_sha`} by `created_at`.  If both exist, whichever row has the later
`created_at` wins.  `headBaseline` is now exported so it can be unit-tested independently.

### Additional changes
- `test/cli/head-baseline.test.ts` (new): 5 unit tests for `headBaseline` covering both-exist
  (dispatch newer → dispatch sha wins; event newer → accepted sha wins) plus degenerate cases.
  Test 1 ("committed sha wins") was confirmed to FAIL against the old code by `git stash` + run
  (the old function was not exported → `SyntaxError: Export named 'headBaseline' not found` on
  import → test file errored out entirely; the fix makes the export available and the correct sha
  is returned).
- `test/dispatch/park-routing.test.ts`: added `out-of-credits` routing test (symmetric to the
  existing `session-limit` test): `FakeAgentRunner` returning `cause: "out-of-credits"` → asserts
  `ParkSignal` thrown with `info.cause === "out-of-credits"` and dispatch `outcome === "parked"`.
- `src/daemon/loop.ts`: one-line comment noting `styre run` is single-ticket so at most one park
  per drive is possible; multi-ticket daemon park handling is future work.
- `src/db/repos/dispatch.ts` `getLatestWorktreePath`: comment noting it orders by `id DESC`
  intentionally, distinct from `getLatestForTicket`'s `seq DESC` + non-null sha filter.

### Gate results
- `bun test`: 408 pass, 0 fail (100 files)
- `bun run typecheck`: clean
- `bun run lint` (after `bun run format`): clean
