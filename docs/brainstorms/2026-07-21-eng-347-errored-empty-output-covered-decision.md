# ENG-347 — An errored check with no output must not mark its criterion covered

**Status:** decided (2026-07-21).
**Ticket:** ENG-347 · **Branch:** `fix/checks-errored-empty-output-covered-eng-347`
**Builds on:** `2026-07-20-checks-discard-poison-matcher-langs-design.md` (ENG-343). That doc is
append-only history; this note records ENG-347's resolution rather than editing it. It closes **residual 6
(§5)** / the **§8 "`error` bucket"** deferral of the ENG-343 design.

---

## 1. The defect

At the `checks:dispatch` call site (`src/dispatch/handlers.ts`), a RED-first check whose coarse result is
`error` **and whose `rawOutput` is empty** was recorded as covering its acceptance criterion
(`records.push` + `covered.add`). Downstream the chain is deterministic — no agent judgement anywhere:

1. `handlers.ts` — no impacted component / no framework detected, pytest with no resolvable interpreter, or
   a timeout, all yield `coarse = "error"` with `rawOutput = ""`.
2. The discard-poison guard (`importErrorImplicatesDiscarded`) returns `[]` immediately on empty output, so
   it cannot fire — it is text-based and there is no text.
3. The check is recorded as covering; `classify-prior.ts:23` stamps `error → environmental`;
   `post-implement-rerun.ts:84-86` downgrades `environmental → advisory-red` (non-gating).

Net effect: the acceptance criterion ships reported-covered and verified when **nothing ever ran**. This is
the same silent bad merge PR #91's discard guard exists to prevent, reached by a door that guard cannot see.

Newly reachable after ENG-343 added Ruby: a `ruby` component whose test command names neither rspec nor
minitest (`frameworkFor` → `null`) — e.g. a `bin/test` wrapper or a non-matching `rake` task — produces
exactly this `framework = null → error → empty output → covered → environmental → advisory`.

## 2. The decision: breadth (ENG-347 acceptance criterion 4)

The ticket left one decision open: does the fix reject an errored-empty check **only when files were
discarded this attempt** (the cautious starting point the ENG-343 review recommended), or **for every
errored check with no output**?

**Decided: every errored check with no output**, gated only on `coarse === "error" && rawOutput.trim() === ""`
— independent of whether anything was discarded.

**Rationale.**

- **AC #3 forces it.** The Ruby `framework = null` case the ticket names as a must-fix is
  *discard-independent*: the framework simply cannot be detected, whether or not this attempt discarded a
  file. A discard-gated fix would leave that criterion shipping covered-then-advisory in the common
  no-discard case, failing AC #3.
- **The ticket's rule is already unconditional.** Its "What" states: *"a check that demonstrably could not be
  attempted must never mark its criterion covered."* Empty-output `error` means the check could not be
  attempted (no framework, no interpreter, or a timeout that produced nothing) — regardless of discards.
- **The cost the ENG-343 review worried about is bounded and correct.** The wider form adds retries only on
  the flaky-timeout subcase (a deterministic `framework = null` / no-interpreter error re-errors on retry and
  escalates — the intended loud failure, not a loop). Bounded-retry-then-escalate on an unverifiable check is
  strictly better than silently shipping it as a non-gating advisory. This aligns with the substrate
  invariants *loop-not-halt* and *ground-truth-over-self-report*.

**What "no output" means.** `rawOutput.trim() === ""`. A timeout that produced *truncated but non-empty*
output is deliberately out of scope (it stays in the existing `error → environmental` path): the primary
reachable cases (no component/framework, no interpreter) produce genuinely empty output, and keeping the
predicate a simple emptiness check keeps it deterministic.

## 3. Scope held (unchanged from the ticket)

- **IN:** the covered decision only, at the existing guard call site. Route an empty-output `error` to the
  same uncovered path (`missReason.set` + `continue`) that `selected-none` and the discard-poison guard use —
  a loud retry with a legible reason naming *why* the check could not be attempted. Diagnosis-only (INV-B):
  no instruction, just the fact.
- **OUT:** the coarse bucketing (`interpretRunOutput`); the downstream `environmental → advisory` rule in
  `post-implement-rerun.ts` (this ticket stops the bad input reaching it, it does not change the rule); the
  discard-poison matcher vocabulary and the language registry (ENG-343 / ENG-348).

## 4. Residual reclassification

ENG-343 §5 residual 6 ("the `error` bucket with empty output — ENG-347, out of scope here") is **closed** by
this change for the empty-output case. The non-empty `error` bucket (a framework that ran and emitted a real
diagnostic, e.g. a genuine compile error) remains classified `environmental` by design — that is not a
"could-not-be-attempted" case and is untouched here.

## 5. Known residual — a launch failure that emits a diagnostic (non-empty `error`)

Surfaced by the whole-branch review. `interpretRunOutput` buckets a **shell exit 127** (command not found)
as `coarse = "error"` (`check-selector.ts:185`), and likewise pytest exit 3/4 and Go/Cargo internal-error
codes. Only pytest gets a *pre-run* interpreter/binary check (`handlers.ts`, the `fw === "pytest"` branch);
for go/cargo/rspec/minitest/jest/phpunit a **missing test binary** runs through `runCheckForRed`, returns
exit 127, and carries a non-empty stderr ("command not found"). That non-empty output means this guard does
**not** fire, so the check is still recorded → `environmental` → advisory.

This is the *same* silent-bad-merge class ENG-347 targets — a check that could not be attempted marking its
criterion covered — reached through a launch failure that prints a shell diagnostic rather than nothing.
It is **out of ENG-347's stated scope** (empty output only; the non-empty `error` bucket and the downstream
`environmental` rule are explicitly OUT), and closing it cleanly requires distinguishing a launch-failure
diagnostic ("command not found") from a genuine test diagnostic — i.e. output recognition, which is
ENG-343/348 matcher territory, not a call-site emptiness check. **Recommended as a follow-up ticket**, not
folded in here: the wide-breadth principle ("demonstrably could not be attempted must never mark covered")
is realized for the empty-output door this ticket owns, but is not yet fully realized for the exit-127 door.
