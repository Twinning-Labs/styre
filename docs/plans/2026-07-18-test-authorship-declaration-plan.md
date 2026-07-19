# Test-authorship declaration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Design doc:** `docs/brainstorms/2026-07-17-test-authorship-declaration-design.md` (status: design approved 2026-07-17, scope **(i)**). Read it first — this plan implements it and does not re-argue it.

**Goal:** Stop `design:extract` from erasing an implement-authored test that also proves an acceptance criterion (the STYRE-7 wedge), and stop `implement` from being gated by `completeness` against a file list it is never shown. Two independent, self-reinforcing fixes:

- **Fix A** — restate the `files_to_touch` declaration rule in `prompts/design-extract.md` by **authorship** ("who writes this file?") instead of **purpose** ("does this test prove an AC?"). A file `implement` writes is declared; a file `checks:dispatch` writes (the canonical `styre_checks/{ident}_ac<id>_test.<ext>`) is never declared.
- **Fix B** — surface each unit's declared **`files_to_touch`** and **`test_plan`** to `implement` as new prompt-vars, tell it the declared test files are **its** obligation (distinct from the frozen `styre_checks/` checks), and tell it the AC checks will read **red in its own `{{test_command}}` runs** until the feature is built.

**Architecture:** Prompt-and-prompt-var changes only. Fix A edits one prompt. Fix B adds two rendered vars to `implementVars` (`src/dispatch/prompt-vars.ts`) — both sourced from the `WorkUnitRow` the function *already receives* — and renders them in `prompts/implement.md`. **No schema change. No gate added, removed, or reweighted. No change to `handlers.ts`, the resolver, `completeness.ts`, `checks:dispatch`, `check-integrity`, or the implement-sees-checks seam.**

**Tech Stack:** TypeScript, Bun (`bun test`). Tests live under `test/` and run with `bun test`. Prompts are plain Markdown templates rendered by `renderPrompt` with `{{var}}` substitution.

---

## Global Constraints

- **Approved scope is exactly Fix A + Fix B option (i): `files_to_touch` + `test_plan`.** Do **not** also surface `description` or any other unit field — it was considered and is an explicit non-goal (§ Out of scope). Surfacing more without sign-off is the scope-creep this project forbids.
- **Fix B is prerequisite-then-dependent, in order.** Step B1 (the prompt-vars) must land before B2 (the prompt wording), because the placeholder-resolution test (`test/dispatch/prompt-vars.test.ts:44`) fails if `implement.md` references a `{{var}}` that `implementVars` does not return. Add the var first, reference it second.
- **`implementVars`' signature does not change.** It already takes `(ticket, unit, profile, feedback, authoredChecks, gateFeedbackText, reviewFeedbackText)` and already holds the full `unit` row. The new vars are derived inside it; no new argument, no call-site change at `handlers.ts:919`.
- **Mirror the `authored_checks` pattern for the new section vars.** `authored_checks` (`prompt-vars.ts:118-121`) is a *self-contained section string* — header + body built in TS, empty string when there is nothing to say. Build `files_to_touch` and `test_plan` the same way, so `implement.md` carries a bare `{{slot}}` with no orphan header when a section is empty (e.g. a non-behavioral unit has no `test_plan`).
- **`files_to_touch` is a floor, not a cage.** Its rendered wording MUST say "produce at least these; you may touch other files if the work needs it — scope is reviewed, not enforced here." Completeness hard-gates only **under**-delivery; **over**-delivery is advisory and reviewer-judged (brainstorm A3). Wording it as an allowlist ("touch only these") would re-import the exact hard scope-gate A3 deleted — turning this fix into a fresh instance of the bug class it is meant to close. This is the single most important wording constraint in the plan.
- **Preserve everything Fix A is not changing** in `design-extract.md`: the `<token>` placeholder grammar (astropy), the `behavioral ⇒ test_plan + verify_check_types` rules, and seq contiguity. Fix A touches only the `files_to_touch` bullet.
- **No behavioral change to the checks/implement seam.** Point B2's expected-red note is *informational* — it tells implement what it will see; it does not change what runs, what is committed, or what is gated. `check-integrity` still freezes the checks; editing them still fails the gate.
- The attempt-budget reset (`redesignLoopback` → `resetAttempt`) is **out of scope** — it ships separately on `fix/design-loopback-attempt-reset` (PR #86). See § Out of scope.

---

### Task 1: Fix A — restate the `files_to_touch` rule by authorship

**Files:**
- Modify: `prompts/design-extract.md` (the `files_to_touch` bullet only)
- Test (guardrail): `test/dispatch/extract-schema.test.ts` (pin the "third shape")

**Interfaces:** none — prompt-only. `ExtractedWorkUnitSchema` and `validateExtraction` are unchanged.

- [ ] **Step 1: Rewrite the `files_to_touch` bullet.** Replace the current purpose-based bullet (the one that says *"Do NOT list the behavioral regression/verification test that proves an acceptance criterion"* and carries the *"when the ticket's deliverable is tests"* carve-out) with the authorship rule from design §3:

  - **Declare** every file this unit's `implement` step will create or change — production code, docs, **and its tests, including tests that overlap an acceptance criterion.**
  - **Never declare** a file `checks:dispatch` authors: the per-AC RED-first checks at `<test-root>/styre_checks/{{ident}}_ac<id>_test.<ext>`. Their need is carried by `verify_check_types: ["test"]`; they are gated by RED-first + `verify:checks-gate`, never declared here.
  - **Keep** the `<token>` placeholder sentence verbatim (astropy changelog case).
  - **Drop** the "when the ticket's deliverable *is* tests (e.g. a test-coverage ticket)" carve-out — authorship makes it redundant.
  - Name the canonical `styre_checks/` path explicitly (a checkable landmark) rather than describing the category "proves an AC" (a judgment) — design §8.4.

- [ ] **Step 2: Guardrail test for the third shape.** In `test/dispatch/extract-schema.test.ts`, add a case asserting a unit whose only `files_to_touch` entry is a product-test path (e.g. `tests/Unit/IcsTest.php`), marked `behavioral: true` with a `test_plan`, **passes `validateExtraction`**. This does not test the prompt (agent behavior is not unit-testable) — it pins the schema side so no future change re-introduces a rule that rejects the shape STYRE-7 hit. Reference the ticket in the test name (`"STYRE-7"`).

- [ ] **Step 3 (optional guardrail):** if the repo has any prompt-content assertion test, add one asserting `design-extract.md` no longer contains the phrase "proves an acceptance criterion" as a *declaration ban* and does contain `styre_checks/`. Skip if no such test pattern exists — do not invent a new test harness for it.

---

### Task 2: Fix B1 — surface `files_to_touch` + `test_plan` from `implementVars`

**Files:**
- Modify: `src/dispatch/prompt-vars.ts` (`implementVars`, lines ~102-136)
- Test: `test/dispatch/prompt-vars.test.ts`

**Interfaces:**
- Consumes: the `unit: WorkUnitRow` already passed in — `unit.files_to_touch` (JSON string; `parseFilesToTouch` exists) and `unit.test_plan` (nullable string).
- Produces: two new keys on the returned `Record<string, string>`: `files_to_touch` and `test_plan`. Signature unchanged.

- [ ] **Step 1: Write the failing tests.** In `test/dispatch/prompt-vars.test.ts`:
  - A behavioral unit with `files_to_touch: ["src/ical.php","tests/Unit/IcsTest.php"]` and a `test_plan` → `implementVars(...).files_to_touch` contains both paths and the floor-not-cage phrasing ("at least", "may touch"); `.test_plan` contains the plan text.
  - A non-behavioral unit with `test_plan: null` → `.test_plan === ""` (no orphan header), `.files_to_touch` still lists its file(s).
  - Keep the existing "resolves every placeholder" test green (it will, once B2 adds the slots and these keys exist).

- [ ] **Step 2: Implement.** In `implementVars`:
  - The declared list is already parsed at line 111 (`const files = ...`). Build a self-contained section string:
    - `files_to_touch` = `## Files this unit produces (your obligation)\n\nCreate or change **at least** these files — this is what "done" is checked against. Any product or regression tests listed here are **yours to write** (they are distinct from the frozen `styre_checks/` acceptance checks). You may touch other files if the work genuinely needs it — scope is reviewed, not enforced here.\n\n` + the `- path` list. (Post-Fix-A every unit has ≥1 file; if the list is somehow empty, emit `""`.)
  - `test_plan` = `unit.test_plan` and it is non-empty ? `## How this unit is tested\n\n${unit.test_plan}` : `""`.
  - Add `files_to_touch` and `test_plan` to the returned object. Leave `test_command` derivation (line 111-116) exactly as is — it still reads the same `files`.

---

### Task 3: Fix B2 — render Channel A in `implement.md` + the expected-red note

**Files:**
- Modify: `prompts/implement.md`
- Modify: `src/dispatch/prompt-vars.ts` (extend the `authored_checks` section string only)

**Interfaces:** no new keys beyond Task 2. Task 3 only *references* `{{files_to_touch}}` / `{{test_plan}}` and enriches the existing `{{authored_checks}}` text.

- [ ] **Step 1: Place the new slots in `implement.md`.** After the `Work-unit: {{unit_title}}` line and before the "Write the code AND its tests" instruction, insert `{{files_to_touch}}` and `{{test_plan}}` (each on its own line, blank-line separated). Because these vars are self-contained sections (Task 2), an empty `test_plan` renders nothing. Do not add a `{{description}}` slot (out of scope).

- [ ] **Step 2: Fold the two-channel clarifier + expected-red note into `authored_checks`.** In `implementVars`, extend the existing `authored_checks` section string (only built when `paths.length > 0`) to add, after the current "make these pass — do NOT edit the check files" text:
  > These acceptance checks are authored separately and will read **red** when you run `{{test_command}}` until you build the feature — that red is expected and is not a bug you introduced. Turn them green by implementing the work, never by editing, weakening, or deleting the check files (the runner freezes them and fails the gate on any change). They are **not** the tests listed under "Files this unit produces" — those are yours to write.

  Keep this inside the conditional so a unit with no AC checks gets no orphan note. (Do not hard-code `{{test_command}}` as a literal — either reference the already-rendered command value or word it as "your project test command"; the string is built in TS where the template var is not substituted.)

- [ ] **Step 3: Verify placeholder completeness.** Run `bun test test/dispatch/prompt-vars.test.ts`. The "resolves every placeholder in the implement template" test must pass — proving every `{{var}}` now in `implement.md` (`files_to_touch`, `test_plan`, plus the pre-existing set) is returned by `implementVars`.

---

### Task 4: Full suite + scoped verification

- [ ] **Step 1: `bun test`** — the whole suite green. Pay attention to `prompt-vars.test.ts`, `extract-schema.test.ts`, and any `completeness`/`e2e` suites (they must be untouched by this change — if one moves, the change leaked past its intended blast radius).
- [ ] **Step 2: Render-inspection (no agent).** Add or run a small test/scratch that renders `implement.md` for (a) a behavioral unit with a declared product test and AC checks, (b) a non-behavioral unit with no `test_plan` and no AC checks. Confirm by eye: Channel A lists the files with floor-not-cage wording; the expected-red note appears only in case (a); no orphan headers in case (b).
- [ ] **Step 3: Acceptance smoke (operator / bench, out-of-repo).** Re-run STYRE-7 (`styre-events`, per-event iCal export) through `design → design:extract`. Expected: WU2 declares `tests/Unit/IcsTest.php`, `validateExtraction` passes, the ticket reaches `implement` (no `unit seq 2 declares no files_to_touch` wedge), and implement is shown the declared test as its own. This is the design doc's §5 STYRE-7 outcome and is the real proof; the unit tests are guardrails, not the proof.

---

## Acceptance criteria

- [ ] A work unit whose only deliverable is an implement-authored, AC-overlapping test (`tests/Unit/IcsTest.php`) declares that file and passes `validateExtraction` (Task 1 guardrail).
- [ ] `design-extract.md` states the rule by authorship, names the canonical `styre_checks/` path, and no longer carries the "when the deliverable is tests" carve-out.
- [ ] `implementVars` returns `files_to_touch` and `test_plan`; the `implement.md` placeholder-resolution test passes.
- [ ] `implement.md` shows implement its declared files as a **floor** (not a cage), distinguishes them from the frozen `styre_checks/` checks, and states the AC checks will read red until the feature is built.
- [ ] `description` is **not** surfaced (scope discipline).
- [ ] No schema change; no change to `handlers.ts`, the resolver, `completeness.ts`, or the checks/implement seam. Existing completeness/e2e suites unchanged.
- [ ] Full `bun test` green.
- [ ] STYRE-7 reaches `implement` on the acceptance smoke (operator/bench).

---

## Out of scope (do not do here)

1. **The attempt-budget leak.** `redesignLoopback` (`review-verdict.ts:145-150`) resets the design steps' `status` but not their `attempt`. Independent bug, independent fix — ships on `fix/design-loopback-attempt-reset` (PR #86). It is what turned this failure from a wasted cycle into a dead ticket, but it is not this change.
2. **The vacuous-unit routing gap** (design §7.6). A genuinely empty unit re-dispatches `design:extract` against an unchanged plan doc — extract can delete but not re-plan. Fix A removes *this ticket's* trigger; the routing seam (a loopback to `design:dispatch`) is a separate change.
3. **Surfacing `description` or any other unit field to implement.** Beyond approved scope (i).
4. **Proportionality gating.** Whether design plans a *disproportionate* product test (the darkreader shape) is held by `design:review`, deliberately not by a gate (design §2). Do not add a gate for it.
5. **Any change to `checks:dispatch`, `check-integrity`, RED-first, the arbiter, or the implement-sees-checks seam** (design §4 "What Fix B does not touch").

## Branch note

The plan doc lands on `docs/test-authorship-declaration` alongside the design doc (PR #87), keeping the design + plan for this work together. The **code implementation** (Fix A + Fix B) is prompt+TS, so per the repo's branch convention it should land on a `fix/` branch (e.g. `fix/test-authorship-declaration`) with a Conventional-Commits PR title, not on this `docs/` branch. Cut that branch from `main` when implementing.
