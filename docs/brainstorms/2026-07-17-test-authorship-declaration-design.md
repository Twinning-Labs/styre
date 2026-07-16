# Test-authorship declaration — design

**Status:** design approved 2026-07-17 (operator; scope **(i)** — see §8.1), ready for implementation plan. Converged after operator review + git archaeology + live-plan grounding.
**Author:** derived from the 2026-07-16 STYRE-7 run (`styre-events` WordPress plugin, per-event iCal export) — ended `blocked`, stage `design`, 6 dispatches, 1 cycle
**Scope of change:** two prompt stance edits (`prompts/design-extract.md`, `prompts/implement.md`) + one prompt-var addition (`src/dispatch/prompt-vars.ts`). **No schema change. No gate added or removed. No change to the checks/implement seam.**
**Supersedes:** the `files_to_touch` wording introduced by PR #78 (`2026-07-13-completeness-name-reconciliation-design.md` §2/§3), whose principle this doc keeps and whose *phrasing* it corrects. **Resolves** that doc's §7.3 residual, which mispredicted this failure as soft.
**Not in scope:** the attempt-budget leak that turned this failure into a dead ticket (see §7.4).

---

## 1. Problem

STYRE-7 (a feature ticket: add a per-event iCalendar export endpoint) ran `design → design:review → redesign → design:extract` and ended **`blocked`**, having never reached implement. The terminal error:

```
design:extract completeness failed: unit seq 2 declares no files_to_touch
(every planned unit must name ≥1 file)
```

The design agent's plan (`docs/plans/STYRE-7-ical-export.md`, cycle 2) decomposed the work into five units. WU2 read, verbatim:

```markdown
### WU2 — Lock down serializer interoperability
- **kind** — wordpress plugin (php)
- **files** — `tests/Unit/IcsTest.php` (new)
- **behavioral** — yes; `./vendor/bin/phpunit` uses fixed timestamps and site URLs to assert
  exact calendar properties and edge cases
- **verify** — focused PHPUnit test; full PHPUnit regression suite; byte-length, UTF-8
  validity, continuation syntax, and unfolding assertions
- **depends on** — WU1
```

**WU2 declared a file.** `tests/Unit/IcsTest.php` is a PHPUnit unit test for the RFC 5545 serializer, written by `implement`, landing in the plugin's existing framework-free suite — the plan grounds this deliberately at lines 26-32 ("Pure iCal and markup behavior belongs in that fast suite").

`design:extract` then **erased it**. WU2's assertions demonstrably prove acceptance criteria — the plan's own traceability block says so ("WU2 checks exact fields, syntax, escaping, folding"; "WU2 tests same-site stability and cross-site/cross-event separation"). So the extract agent applied `prompts/design-extract.md` as written —

> Do **NOT** list the behavioral regression/verification test that proves an acceptance criterion — `checks:dispatch` authors and names that test

— nulled WU2's only file, and handed `validateExtraction` a unit with `files_to_touch: []`. The gate (`extract-schema.ts:117`) rejected it.

**The rule manufactured the vacuity the gate then rejected.** WU2 is not a vacuous unit; it has a real implement deliverable. Nothing in the system was wrong except the sentence.

### Why it wedged rather than recovered

The retry-feedback loop *does* recover from this: the rejection is persisted (`markFailed` → `error_json`), preserved across reset (`resetToPending`), and prepended to the next attempt (`run-dispatch.ts:104`) with a preamble that says "If a planned work unit has no files to change, it is redundant: remove it." Cycle 1's extract failed on attempt 1 and passed on attempt 2 — by **deleting WU2**, i.e. by discarding the serializer's unit-test suite. That is the "success" path today: the correct plan is rejected and the recovery is to plan less testing.

That "recovery" is itself a routing defect. `2026-07-04-completeness-module-design.md:71` assigns the correction to the stage that owns it — "a vacuous unit fails plan validation → transport-failure re-dispatch of `design/extract` → **the design agent re-plans** … correction assigned to the responsible stage." But re-dispatching `design:extract` re-reads the **same, fixed** plan doc; extract cannot re-plan. The only correction available to it is to delete the unit, which is what the retry preamble instructs. The gate's intent (send it back to design) and its wiring (re-run extract) diverge, so a plan defect is silently absorbed by extract instead of being routed to the agent that could fix it. Fix A removes the trigger; the routing gap is noted here, not addressed (§7.6).

The ticket died because a second, independent bug (§7.4) denied cycle 2 the same retry.

---

## 2. Root cause — the rule states *purpose*; the principle is *authorship*

PR #78's design doc states the principle as authorship (`2026-07-13-completeness-name-reconciliation-design.md:36`):

> The resolution declares in `files_to_touch` **exactly what the unit's `implement` dispatch produces, and nothing else**

and (`:39`):

> **The verification test** … is authored and named by `checks:dispatch`. It is **not** an implement output and is **not** declared in `files_to_touch`.

The principle is **"who writes this file?"**. The prompt that implements it asks **"does this test prove an acceptance criterion?"**. Those two questions coincide for the case #78 was built on (darkreader-7241, a one-line bugfix where the only candidate test *was* the AC proof) and **diverge** wherever a file is implement-authored *and* AC-proving. `tests/Unit/IcsTest.php` is exactly that file. The rule sees only the second half and erases it.

The ticket-scoped carve-out is the same error's other half:

> …and, **when the ticket's deliverable *is* tests** (e.g. a test-coverage ticket), the product test files.

This exists only *because* the rule is purpose-based and therefore needed an escape hatch for coverage tickets. Stated by authorship, no carve-out is needed and no ticket-level/unit-level disambiguation arises: implement writes it → declare it; `checks:dispatch` writes it → never declare it.

### The two channels (established, not proposed)

| | Channel A — the work unit | Channel B — the acceptance check |
|---|---|---|
| Driven by | `files_to_touch`, per WU | the ticket's ACs, per AC |
| Authored by | `implement:dispatch` | `checks:dispatch` (**plan-blind**) |
| Lands at | paths the plan declares | `<test-root>/styre_checks/{ident}_ac<id>_test.<ext>` |
| Gated by | `completeness:wuN` (existence) → `verify:wuN:{check}` | RED-first → `verify:checks-gate` |
| Selected by | `verify_check_types` | *(nothing — ACs exist or they don't)* |

Verified in code: `checksVars(ticket, profile, acs, feedback)` takes no work unit; `checks-schema.ts` has zero references to work units. `verify_check_types` drives `nextUnrunCheck` → `verify:wu{seq}:{check}` (`resolver.ts:67-79`) and has **no relationship to `checks:dispatch`**.

**The discriminator between the channels is mechanical and already exists**: the canonical `styre_checks/` path, required by `prompts/checks.md:14`, one new file per AC, byte-frozen by `check-integrity.ts` against its authoring sha. Anything not at that path is implement-authored. The prompt simply doesn't use it.

### What #78 predicted, and what actually happened

`2026-07-13-completeness-name-reconciliation-design.md:111` (§7.3) anticipated this seam and got the severity backwards:

> **Product-test vs verification-test at design time.** … If design wrongly declares a bug-fix regression test as a product path, it degrades to pre-change behavior for that entry (exact-match; implement must create it) — **a soft failure, not a wedge.** Handled by the design-prompt wording, not code.

It reasoned about one direction (design declares a *verification* test as product → soft, self-correcting). The observed failure is the **reverse**: extract classifies a *product* test as verification → erases it → the unit goes vacuous → **the plan gate wedges the ticket**. Not soft. The direction that was never modelled is the fatal one.

The same doc's compatibility check (`docs/plans/2026-07-13-completeness-name-reconciliation-plan.md:176`) carried a stop clause that should have caught this:

> Expected observation: … A behavioral code unit still names its code file, and a product-test unit still names its test files, **so both satisfy "≥1 file"** … **If this observation does not hold, STOP and escalate — the stance change would need a schema adjustment not in this plan.**

It enumerated two unit shapes. A unit whose only deliverable is an implement-authored, AC-overlapping test is a **third** shape, fitting neither: the rule forbids listing its file, the gate demands ≥1 file, and it has no code file to fall back on. The premise silently didn't hold, so the stop clause never fired.

### Overlap is normal — the position taken

A product unit-test suite and an acceptance-check suite covering the same behavior is **ordinary engineering, not duplication**. The plugin already ships `DateFormatterTest` alongside whatever checks a ticket authors. A channel-A test **cannot weaken the gate**: the AC check is plan-blind, RED-first, and integrity-frozen, and it decides regardless of what implement writes.

So darkreader's "duplicate test" was never a *category* error (planning a channel-A test); it was a **proportionality** error (planning a channel-A test not worth writing, for a one-line fix). Proportionality is a judgment — it has no deterministic answer and cannot be gated. #78 encoded it as a category ban, and the ban over-fired on the first ticket where a product test suite was genuinely warranted.

**Authorship is mechanical → hard rule (the prompt). Proportionality is judgment → `design:review`.**

---

## 3. Fix A — restate the extract declaration rule by authorship

`prompts/design-extract.md`, the `files_to_touch` bullet. Replace the purpose test and the ticket-scoped carve-out with the authorship test:

- **Declare** every file this unit's `implement` step will create or change — production code, docs, and **its tests**, including tests that overlap an acceptance criterion.
- **Never declare** a file `checks:dispatch` authors: the per-AC RED-first checks at `<test-root>/styre_checks/{ident}_ac<id>_test.<ext>`. Their need is carried by `verify_check_types: ["test"]`, and they are gated by RED-first + `verify:checks-gate`.
- Retain unchanged: the `<token>` placeholder grammar (astropy), the behavioral ⇒ `test_plan` + `verify_check_types` rules, seq contiguity.
- Drop entirely: "when the ticket's deliverable *is* tests" — authorship makes it redundant.

Under this rule WU2 declares `tests/Unit/IcsTest.php`, `validateExtraction` passes, and the `#49` gate returns to its actual job: catching units that genuinely declare nothing.

**This restores the gate rather than weakening it.** `2026-07-04-completeness-module-design.md:74` states the gate's purpose as making the loopback coherent — "a unit that does nothing has declared files → `under-delivered` → a *coherent* 'touch these files' loopback that converges." Today the erasure makes WU2 invisible to completeness; a unit with `declared: []` can never be `under-delivered` (`reconcileScope` returns `under = []`) and emits no scope_diff signal (`handlers.ts:1098` guards on `declared.length > 0`). Declaring the file is what makes the unit gateable.

---

## 4. Fix B — implement is blind to Channel A, and told only about Channel B

The approved intent was "tell implement its declared test files are its own to write." Investigating the wording surfaced a larger, load-bearing gap that the fix depends on. **This expands the approved scope and needs sign-off (§8.1).**

`implementVars` (`prompt-vars.ts:102-136`) returns: `ident, slug, unit_seq, unit_kind, unit_title, test_command, stack, feedback, authored_checks, gate_feedback, review_feedback`.

**`files_to_touch` is never given to implement.** It is read at line 111 solely to derive `test_command` via `impactedComponents`. Neither is `description` nor `test_plan`. Implement receives its unit as a **title**.

So today:

- **Completeness gates implement against a file list implement was never shown.** It passes only when the agent independently writes files at paths design independently guessed. For code files those converge (the plan's structure is obvious from the ticket); for test files, path conventions vary, so the miss rate is structurally higher.
- Implement learns its declared files **only by failing** — `feedback.ts:40-42`: *"Your previous attempt did not modify these declared files, which the plan required you to change: …"*. That arrives on the under-delivery loopback, never on attempt 1.
- Meanwhile implement **is** told about Channel B (`authored_checks`: "make these pass — do NOT edit the check files"). It is told about the tests it must not write, and nothing about the tests it must.

Fix A alone would land on this. WU2 declares `tests/Unit/IcsTest.php`; implement is never told; it reads `authored_checks`, sees the ACs are covered by the frozen checks, reasonably writes no separate unit test → `under-delivered` → loopback → converges on attempt 2 (coherent, unlike today's wedge, but a wasted cycle on the ticket's happy path).

**Proposed change** — surface Channel A, then distinguish it from Channel B:

1. New `implementVars` var (`files_to_touch`, and a `test_plan` slot for behavioral units), rendered in `implement.md` as the unit's declared scope. This is the prerequisite that makes the rest meaningful.
2. `implement.md`: your declared files are your obligation — including declared test files, which are **yours to write** and are distinct from the frozen `styre_checks/` files.
3. `implement.md`: the AC checks will appear **red in your own `{{test_command}}` runs** until the feature is built. That is expected and is not your bug; do not edit them.

Point 3 closes a real gap in the record. `checks:dispatch` runs in the `design` stage (`resolver.ts:114`), before implement. Its files are RED-first by construction and required to live where "this component's test command **already discovers**" them (`prompts/checks.md:14-18` — load-bearing for RED-first replay). `implement.md:6` tells implement to run that same test command. Therefore implement's first test run reports failures it did not cause — **and no design, plan, prompt, or commit says so.** The M4 doc frames the seam as *"the files are already in the worktree (runner-committed), so implement Reads + codes against them (TDD)"* — presence and Read access, never "your suite run will report them red." `implement.md` keeps line 6 (`{{test_command}}`) and line 12 (`{{authored_checks}}`) as unconnected slots.

### What Fix B does *not* touch

The implement-sees-checks seam stays exactly as designed. It was a review-driven v2 revision with recorded rationale (`2026-07-07-change-scoped-verify-ac-checks-design.md:98`): it resolves "a check needing a helper implement adds" and "the interface-mismatch churn (author guesses `/preferences`, implement builds `/prefs`)", and without it "the gate blocks every time" (`m4-verify-gate-design.md:28`). Plan-blindness at the author is what makes the check trustworthy and is *also* what makes the seam mandatory — they are a matched pair. The anti-gaming property lives at the **author** (`ac-checks-design.md:51`), not at implement's ignorance; check tampering is held by `check-integrity.ts` + R5 (never arbitrated), and weak-check conformance is the named, review-bounded residual at `ac-checks-design.md:98`.

---

## 5. Scoped outcomes

- **STYRE-7 (product test on a feature ticket — the wedge):** WU2 declares `tests/Unit/IcsTest.php`; extract passes; implement is told the file is its own to write; completeness gates its existence; the AC checks gate the ACs independently. The serializer keeps its unit-test suite instead of having it planned away.
- **darkreader-7241 (verification test = checks-owned):** unchanged from #78. `styre_checks/` paths are mechanically non-declarable, so the name-alignment impossibility that wedged it cannot recur. Its redundant regression test is now a proportionality question for `design:review`, not a category ban — for a one-line fix, the AC check is the whole test story and design should plan no product test.
- **astropy-12907 (placeholder changelog):** untouched. `<token>` grammar and wildcard matching are unchanged.
- **Coverage ticket (tests are the deliverable):** unchanged in behavior, simpler in rule. Implement writes the tests → they are declared. No carve-out needed to reach that answer.

---

## 6. Blast radius — what stays intact

| Requirement | Gated by | Effect of this change |
|---|---|---|
| Code (behavioral) | completeness (exact) + verify | none |
| Changelog / docs | completeness (wildcard) | none |
| Product test (coverage deliverable) | completeness + verify (suite) | none — reached by authorship instead of carve-out |
| **Product test (feature ticket)** | completeness + verify (suite) | **newly declarable — was erased → vacuous → wedge** |
| Verification test (AC proof) | RED-first + `verify:checks-gate` + integrity freeze | none — still never declared |
| Vacuous unit (declares nothing) | `validateExtraction` | none — gate kept, and made reachable again |

`checks:dispatch`, `check-integrity.ts`, `verify:check`, RED-first, the arbiter, `reconcileScope`'s matcher, and the implement-sees-checks seam are all untouched. No gate is removed; `#49`'s gate is *restored* to its stated purpose.

---

## 7. Non-goals

1. **Not the over-decomposition question.** Whether WU2 should be a separate unit from WU1 (rather than folding its tests into WU1) is orthogonal — under Fix A either decomposition declares files and gates coherently. #78 §6 parked this explicitly; it stays parked.
2. **Not the checks/implement seam.** See §4 "What Fix B does not touch".
3. **Not a schema change.** `files_to_touch` stays a JSON array of strings.
4. **Not the attempt-budget leak.** `redesignLoopback` (`review-verdict.ts:145-150`) resets the design steps' `status` but not their `attempt`, so a redesign inherits the prior cycle's spent retry budget — which is why STYRE-7 *escalated* rather than retrying. That is an independent bug with an independent fix (`resetAttempt`, mirroring `resetTicketVerifySteps`'s existing §6 reset of the gate counter) and belongs in its own change. Note it is what made this failure *visible*: with the budget intact, extract would have "recovered" every cycle by deleting the test unit, silently.
5. **Not `verify:check`'s advisory demotion.** That `verify:wuN:test` runs a suite containing still-red AC checks from other units is pre-existing and absorbed by M4 §8b.
6. **Not the vacuous-unit routing gap** (§1). `validateExtraction` failure re-dispatches `design:extract` against an unchanged plan doc, so a genuine plan defect can only be absorbed (unit deleted) rather than re-planned as `2026-07-04-completeness-module-design.md:71` intends. Fix A removes the trigger this ticket hit; a real vacuous unit would still route to the stage that cannot correct it. Separate change — it needs a loopback to `design:dispatch`, not a prompt edit.

---

## 8. Open questions / residual risks

1. **Scope of Fix B — DECIDED (i), operator, 2026-07-17.** Surfacing `files_to_touch` (+ `test_plan`) to implement is a prompt-var addition, not a wording edit — larger than the originally approved "tell implement its declared tests are its own", so it was raised for sign-off. Options weighed: **(i)** both, as specified; **(ii)** Fix A + the §4.2/§4.3 wording only, accepting the loopback; **(iii)** Fix A now, Fix B as its own ticket. **Chosen: (i)** — implement being gated on files it is never shown is a defect independent of this ticket, and it is the mechanism by which Fix A would otherwise cost a cycle.
2. **Design may still plan a disproportionate product test.** Authorship framing permits the darkreader shape (a redundant regression test on a trivial fix). Cost is tokens and suite time, never correctness — the frozen AC check still decides. Held by `design:review`, deliberately not by a gate (§2).
3. **A declared test path implement writes elsewhere.** If implement writes its unit test at a path other than the declared one, completeness flags `under-delivered` → loopback names the file → converges. Same soft-failure shape #78 §7.3 predicted; surfacing `files_to_touch` (§8.1 option i) largely closes it.
4. **Extract's classification is still a judgment.** The `styre_checks/{ident}_ac<id>_test.<ext>` path makes the boundary mechanical, but the extract agent must still recognise it. Mitigation: name the canonical path in the prompt rather than describing the category — a path is checkable, "does this prove an AC" is not.
5. **No test covers the third shape.** `test/dispatch/extract-schema.test.ts` should gain a case pinning that a unit declaring only a product test file passes `validateExtraction`, so the erasure cannot silently return.
