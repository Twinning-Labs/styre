# ENG-357 — A launch failure that prints a diagnostic (exit 127/126) must not mark its criterion covered

**Status:** decided (2026-07-22).
**Ticket:** ENG-357 · **Branch:** `rajatgoyal/eng-357-a-launch-failure-that-prints-a-diagnostic-exit-127-is-marked`
**Builds on:** `2026-07-21-eng-347-errored-empty-output-covered-decision.md` (ENG-347). That doc is
append-only history; this note records ENG-357's resolution rather than editing it. It closes the
**§5 residual** ("a launch failure that emits a diagnostic (non-empty `error`)") that the ENG-347
whole-branch review (PR #101) recorded as an explicit follow-up.

---

## 1. The defect

At the `checks:dispatch` call site (`src/dispatch/handlers.ts`), a RED-first check whose **test launcher
is missing** — the framework's runner isn't installed / not on `PATH` — runs, the shell exits `127`
("command not found"), and the run carries a non-empty stderr (`… : command not found`). The chain is
deterministic — no agent judgement anywhere in it:

1. Only pytest gets a *pre-run* interpreter/binary check at the call site (`handlers.ts`, the
   `fw === "pytest"` → `resolvePythonInterpreter()` branch). For go, cargo, rspec, minitest, jest,
   phpunit, junit-maven and junit-gradle a missing test binary is **not** caught before running.
2. The check runs and the launcher is absent → shell exit `127`.
3. `interpretRunOutput` maps `code === 127` → `error` for every framework (`check-selector.ts:185`).
   The run carries a **non-empty** stderr.
4. ENG-347's guard (`handlers.ts`, `coarse === "error" && rawOutput.trim() === ""`) is deliberately gated
   on **empty** output, so a `command not found` on stderr sails straight past it. The check is
   `records.push`ed and the criterion `covered.add`ed.
5. `classify-prior.ts:23` — `error` → `{ redClass: "environmental" }`.
6. `post-implement-rerun.ts:84-86` — `environmental` → `advisory-red` (non-gating).

**Net effect:** the acceptance criterion is reported covered and verified when the test framework never
even launched. This is the **same silent bad merge** ENG-347 closes for the empty-output door, reached
through a different door: a launch failure that prints a shell diagnostic rather than nothing.

The wide-breadth principle ENG-347 adopted — *a check that demonstrably could not be attempted must never
mark its criterion covered* — is realized for the empty-output door but not yet for this one.

## 2. The decisions

Three decisions the ticket left open, each recorded here with rationale.

### 2.1 Structural, not textual, not a pre-run probe (AC #3)

**Decided: a structural exit-code guard.** Extend ENG-347's existing guard so it also fires when the run's
exit code is a shell **launch failure** — the launcher never started — independent of what the output says.

Three approaches were weighed:

- **Structural (chosen).** Exit `127`/`126` is an unambiguous, language-agnostic launch-failure signal
  already carried by the run (`exitCode` is a live local at the guard site). One integer comparison; no
  output vocabulary; nothing to maintain per language. Because the guard keys off the exit code **directly**
  (see §3 — *not* off the coarse bucket, which buckets the two launch codes inconsistently), it covers
  **every** framework for **both** launch codes — including junit-maven, junit-gradle and vitest, which the
  ticket's prose list omits, and pytest itself (belt and suspenders over its existing pre-check).
- **Per-framework pre-run binary probe (rejected).** Mirror pytest's `resolvePythonInterpreter()` for every
  framework: probe the binary on `PATH` before running. More code, duplicates work the run already does,
  and adds a per-framework surface to keep current. Its only edge — a tailored message *before* attempting
  the run — is not worth the maintenance for this bug. Reconsider only if a future need for
  earlier/richer per-tool preflight arises (it would then belong with the toolchain-preflight design, not
  here).
- **Textual `command not found` matcher (rejected).** Locale-, shell- and OS-dependent, and a genuine test
  could legitimately print those words in its own output — the exact false-positive class ENG-348 spent a
  ticket anchoring away. This is ENG-343/348 matcher territory and the ticket names it least preferred.

**Principle made explicit:** the signal for *"could not be attempted"* is precisely *"the shell could not
launch the runner"* — a structural fact — not *"the output looks like a launch failure"* — a textual guess.

### 2.2 Which codes are launch failures: `{127, 126}` (AC #1)

**Decided: exit `127` and `126`** route to the uncovered path.

- **`127` = command not found.** The launcher is not installed or not on `PATH`. The primary reachable case.
- **`126` = found but not executable.** The launcher file exists but the OS refuses to run it — permission
  bit stripped, path resolves to a directory, or a broken interpreter line. Rarer, but the **same
  could-not-be-attempted class**: the runner never started, so nothing was tested. Catching it is one extra
  member of a set at zero added complexity, and it closes a second small door to the identical bug.

Both are POSIX shell conventions for "the command could not be executed", distinct from any exit code a
framework chooses for its own run results. No test framework returns `126`/`127` to report a *test* outcome
— those codes come from the shell/loader failing to start the process — so keying on them cannot swallow a
genuine red.

### 2.3 The other `error`-bucket codes stay `environmental` (AC #2)

The coarse `error` bucket (`check-selector.ts`) also absorbs:

- a **timeout / null exit** (`:183`) — already handled: an empty-output timeout is routed uncovered by the
  ENG-347 guard; a *truncated-but-non-empty* timeout stays `environmental` by ENG-347's explicit decision
  (unchanged here);
- **pytest exit 3 (internal) / 4 (usage)** (`:192`);
- **Go / Cargo internal-error codes** — Go codes other than 0/1/2, Cargo codes other than 0/101
  (`:211`, `:215`).

**Decided: these remain `error` → `environmental`, untouched.**

**Rationale — the boundary is "did the runner launch?"** In every one of these cases the launcher *was*
found and *did* execute; the failure happened **during** the run (an internal crash, a malformed command
line, a compile/vet stumble). That is a genuine attempt — a different, narrower problem — not a
could-not-be-attempted case. Pulling pytest-4 ("usage") or a Go internal code into "uncovered" would mean
re-deciding the coarse bucketing itself, which the ticket names OUT ("...unless the design concludes the
127 mapping is wrong" — it is not). Keeping the line exactly at *the shell could not launch the process*
gives one crisp, defensible rule and leaves the bucketing and the downstream `environmental → advisory`
rule (`post-implement-rerun.ts`) entirely alone.

## 3. Implementation sketch (diagnosis-only, INV-B)

One guard site, one message, no new data path.

**a. A tiny structural predicate** (co-located with the coarse bucketing, e.g. `check-selector.ts`):

```ts
/** POSIX shell "could not execute the command" codes: 127 = not found, 126 = found but not
 *  executable. Distinct from any code a framework returns for a test result — these come from the
 *  shell/loader failing to *start* the process, so they mean the check could not be attempted. */
export const LAUNCH_FAILURE_EXIT_CODES = new Set([126, 127]);
export const isLaunchFailure = (exitCode: number | null): boolean =>
  exitCode !== null && LAUNCH_FAILURE_EXIT_CODES.has(exitCode);
```

**b. Set a launcher-naming `errorReason` keyed on the launch failure — not on `coarse === "error"`.**
Today `handlers.ts:681-682` sets a single generic reason ("timed out or could not be launched and produced
no output") only inside an `if (coarse === "error")`. Two changes: (i) when `isLaunchFailure(exitCode)`, set
a reason that **names the missing launcher** via the existing `binaryFor(fw, { interp })` helper
(`"cargo test"`, `"go test"`, `"rspec"`, `"ruby -Itest"`, `"phpunit"`, `"mvn"`, `"gradle"`, `"jest"`,
`"vitest"`); (ii) key that assignment on `isLaunchFailure(exitCode)`, **not** on `coarse === "error"` —
because a `126` launch failure surfaces as `coarse === "red"` on seven of ten frameworks (§3c), where the
old `coarse === "error"` gate would leave `errorReason` unset and the guard would fall through to the wrong
"produced no output" wording. Keep the existing timeout wording for the non-launch `coarse === "error"`
case. Example message:

> the test launcher `cargo test` for `crates/foo/tests/bar.rs` could not be executed (exit 127) — the
> check could not be attempted

Diagnosis-only: it states the fact and names the launcher; it gives no instruction (no "install X").

**c. Extend the ENG-347 guard so the launch-failure clause is NOT gated on `coarse === "error"`:**

```ts
if (isLaunchFailure(exitCode) || (coarse === "error" && rawOutput.trim() === "")) {
  missReason.set(c.ac_id, errorReason ?? /* existing empty-output fallback */);
  continue; // uncovered → loud retry path, no unverified check recorded as covering
}
```

**Why the launch clause must stand alone** (not `&&`-ed under `coarse === "error"`). `interpretRunOutput`
maps exit **127** → `error` uniformly (`check-selector.ts:185`, before the per-framework switch), but it
does **not** map exit **126** — 126 falls through into the switch, where the frameworks whose non-zero
default is `red` (jest, vitest, junit-maven, junit-gradle, rspec, minitest, phpunit) return
`coarse === "red"`; only pytest, go and cargo route 126 to `error`. A guard gated on `coarse === "error"`
would therefore **miss a 126 launch failure on seven of ten frameworks**, recording it as a genuine covered
red — the exact bug this ticket closes. Keying the launch clause directly on `exitCode` closes 126
everywhere. This is safe — it cannot over-reject a real red — precisely by the §2.2 argument: no framework
returns 126/127 as a *test* verdict (those codes come only from the shell failing to start the process), so
firing on a `red` coarse whose code is 126/127 can never swallow a genuine test failure. `exitCode === 0`
(green) never satisfies `isLaunchFailure`, `selected-none` has already `continue`d before this site, and
`isLaunchFailure(null)` is false — so the empty-output/timeout and green paths keep their existing behavior.

Nothing downstream of the guard changes: `classify-prior.ts` and `post-implement-rerun.ts` are untouched.
`interpretRunOutput` is likewise left **unchanged** — the guard, not the coarse bucketer, owns launch-failure
recognition (see §4). The fix stops the bad input from reaching the classify/downgrade chain, exactly as
ENG-347 did.

## 4. Scope held

**IN**

- The covered decision only, at the existing guard call site: route a launch-failure `error` to the same
  uncovered path (`missReason.set` + `continue`) that `selected-none`, the discard-poison guard, and the
  ENG-347 empty-output guard use — a loud retry with a legible reason naming the missing launcher.
- The `{127, 126}` structural signal and the `binaryFor`-based message.

**OUT**

- The empty-output case (ENG-347, done).
- The coarse bucketing itself (`interpretRunOutput`) is left **unchanged**. We deliberately do **not** add a
  `126 → error` mapping to it (that would be a broader bucketing change, and other consumers read `coarse`);
  the guard recognizes launch failures structurally from `exitCode` instead (§3c), so the fix does not
  depend on the coarse bucket. The existing `127 → error` mapping stays; the other `error` codes (pytest
  3/4, Go/Cargo internal, timeout) stay `environmental` (§2.3).
- The downstream `environmental → advisory` rule (`post-implement-rerun.ts`) — stop the bad input reaching
  it; don't change the rule (same posture as ENG-347).
- The discard-poison matcher vocabulary / language registry (ENG-343 / ENG-348).

## 5. Tests

- **Unit, per affected non-pytest framework** (go, cargo, rspec, minitest, jest, phpunit; junit-maven /
  junit-gradle / vitest covered by the same structural path): inject a run returning
  `{ exitCode: 127, stdout: "", stderr: "<launcher>: command not found", timedOut: false }` → the AC is
  **not** recorded as covering; the step's uncovered reason names the missing launcher. One `126` case must
  target a framework whose non-zero default is `red` (e.g. rspec or jest) — where a `126` run surfaces as
  `coarse === "red"`, not `error` — so it proves the guard fires on the **exit code alone**, not because the
  coarse bucket happened to be `error`. (A `126` test written only against pytest/go/cargo would be vacuous:
  it would pass via the `coarse === "error"` branch and prove nothing about the seven `red`-default
  frameworks — the exact hole the earlier coarse-gated guard left open.)
- **Non-vacuous contrast pair** (mirrors `scope-disposition-smoke`): a missing-binary check (exit 127) →
  **uncovered**, versus a genuine non-zero red (exit 1 with real failure output) → **still covered**. This
  is realized as **two separate single-AC dispatches**, not one mixed dispatch: an uncovered AC throws the
  `checks:dispatch` postcondition *before* the persist transaction (`handlers.ts:757` precedes `:762`), so
  a mixed dispatch would persist nothing and the "covered" half would be unobservable. The contrast makes
  the negative non-vacuous: it proves the guard rejects the launch failure *without* over-rejecting a
  legitimate red.
- Full suite green (`bun test`), lint clean (`bun run lint`).

## 6. Residual / boundary notes

- The truncated-but-non-empty **timeout** subcase stays `environmental` (inherited from ENG-347 §2). A
  timeout is not a launch failure — the process *did* start — so it is correctly outside this guard. (In
  production `runCommand` returns empty output on timeout — `run-command.ts` — so this subcase is reachable
  only via an injected test runner; harmless either way.)
- If a future need arises to fail *earlier* with a per-tool preflight message (the pre-run-probe edge in
  §2.1), that belongs with the toolchain-preflight design, not a widening of this guard.
- No change to the `environmental → advisory` rule or the coarse bucketing means this ticket is composable
  with any later revisit of those (none planned).
