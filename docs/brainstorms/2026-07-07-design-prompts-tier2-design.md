# Design & Design-Review Prompt Quality (Tier 2) — Design Spec

**Date:** 2026-07-07
**Status:** Approved (brainstorming) → next: implementation plan
**Branch (worktree):** `feat/design-prompts-tier2`

## Goal

Improve the quality of the `design` and `design:review` agent prompts so that (1) the design plan is easier to review for completeness, (2) the design agent grounds its plan in the repo rather than guessing, and (3) blocking plan-review findings are *actionable* — specific enough that the redesign can repair them. This is the "Tier 2" follow-up to the codex prompt review (see [[styre-redesign-feedback-tiers]]); Tier 1 (the redesign-feedback cascade fix) shipped as PR #57.

## Scope & shape

**Prompt-only.** The entire change is static-text edits to two files:

- `prompts/design.md`
- `prompts/design-review.md`

No new `{{placeholders}}` are introduced, so **no `src/dispatch/prompt-vars.ts` changes** and nothing that can affect `renderPrompt` (which only fails on unfilled placeholders). No schema change, no DB migration, no change to `FiledFindingSchema` or the `review_finding` table. One PR.

**Approach:** minimal, targeted additions that match each prompt's existing voice — not a rewrite.

## The five edits

### `design.md`

**(A) Requirements traceability.** Append a section instructing the design agent to include a traceability block in the committed plan:

> `## Requirements traceability (include this in the plan)`
>
> `List each acceptance criterion / explicit requirement from the ticket, and name the work unit(s) that satisfy it. If a requirement is intentionally out of scope, say so and why. An unmapped requirement is a completeness gap the reviewer will catch.`

Rationale: gives the reviewer a concrete completeness anchor (see edit D) instead of reconstructing intent. The agent already receives the ticket acceptance criteria via `{{description}}`.

**(B) Inspect before planning.** Add near the top of the prompt (after the ticket description, before the "write a plan" instruction):

> `Before planning, read the files, tests, config, and docs this ticket will touch. Do not guess file paths, APIs, command names, or test strategy the repo can answer — ground the plan in what you actually find.`

Rationale: reduces hallucinated paths/APIs; makes downstream `design:extract` file lists and `design:review` feasibility judgments more reliable.

### `design-review.md`

**(C) Severity calibration.** **Replace (not append to)** the existing severity definitions in the `severity` bullet — currently at `design-review.md:18-20`, inside the "For each finding provide" list — with calibrated definitions. Merging old + new would bloat the bullet, so the current `critical` wording ("broken/unsafe — must not be built") is replaced, not kept alongside:

> - `critical`: the plan would cause data loss, unsafe external behavior, an impossible-to-execute step, or violates a hard architectural invariant.
> - `major`: implementation should not start until this is fixed.
> - `minor`: implementation can proceed, but quality/maintainability suffers.
> - `nit`: wording/formatting only; no effect on implementation. Do not file style-only nits unless they affect extractability or implementation safety.

Rationale: reduces noisy loopbacks by anchoring what actually blocks. `critical`/`major` drive the loopback (`blocks_ship`); calibration keeps them from being over/under-used.

**(D) Trimmed judgment checklist.** Add a section that focuses the reviewer on non-gated judgment. The skip-list must describe *exactly* what the gates enforce — no more — because the gates check **form, not substance**, and over-claiming would tell the reviewer to skip the very judgment they exist for:

> `## What to check (judgment the automated gates can't do)`
>
> `These structural facts are already machine-enforced before you run — do NOT re-verify them: every behavioral unit has a test_plan and a "test" check; each unit names at least one file; seqs are contiguous (1..N) and every dependency points to an earlier unit; when the plan declares a schema change, at least one migration unit is ordered before the first domain unit; and every flagged data/caching/observability/config/docs section carries a non-empty analysis string. The gates check that these are PRESENT, not that they are GOOD — judging substance is your job:`
> - `Scope matches the ticket — cross-check the plan's Requirements-traceability block against the ticket (nothing extra, nothing missing).`
> - `The CDOT analyses are substantive — real reasoning about this change's impact on each flagged concern, not empty filler or an "N/A" dodge on a concern that actually applies.`
> - `Migration ordering is genuinely sound — every migration precedes the units that use it (the gate only checks the earliest migration vs the earliest domain unit, and only when a schema change is declared).`
> - `Work-unit boundaries are sound — no two units must edit the same coupled files while blind to each other; dependency order is sane.`
> - `Named file paths are specific and plausible (the gate only checks that ≥1 file is named, not that it exists or is the right one).`
> - `Each behavioral unit's test plan is actually adequate to catch regressions, not merely present.`

Rationale: the reviewer's value is the judgment the gates can't compute. The skip-list above is worded to match what the code enforces **and its limits** (both surfaced by the Tier 2 independent review):
- `validateExtraction` (`src/dispatch/extract-schema.ts`): behavioral ⇒ non-empty `test_plan` **and** `"test"` in `verify_check_types`; each unit has ≥1 `files_to_touch` entry (a count check — it never touches the filesystem, so it does **not** verify a path exists); seqs are the contiguous set `1..N`; each `depends_on` is a strictly-earlier existing seq.
- `validateCdotImpact` (same file; header: *"Never grades analysis quality"*): each flagged (`present`/`unknown`) section has a **non-empty analysis string** (any non-empty text passes, including `"N/A — …"`); **and only if** `data.schemaChange` is true, a migration-kind unit exists and its lowest seq precedes the lowest domain-unit seq (so a *second*, later migration can still be misordered, and nothing is checked when `schemaChange` was not set).

These gates run in the `design:extract` handler, which throws on failure *before* any work unit is persisted, and the resolver only reaches `design:review` once units exist — so at review time the gates have not just run but **passed**. Any drift between the skip-list and the gate code is a bug — keep them in sync (the three judgment bullets above exist precisely because the gates stop at "present", not "good"/"correctly ordered"/"real path").

**(E) Structured rationale for blocking findings.** Change the `rationale` field instruction (the `rationale` bullet currently at `design-review.md:22`, inside the same "For each finding provide" list — edit it in place, do **not** add a duplicate free-standing section) so blocking findings carry a repair-ready structure:

> For `major`/`critical` findings, structure the `rationale` so the designer can act without guessing:
> - **Problem:** what is wrong.
> - **Required change:** the specific change that resolves it.
> - **Acceptance check:** how to tell the revised plan fixed it.
> - **Evidence:** the plan section, ticket line, or `file:line` that grounds the finding.
>
> Keep the whole `rationale` a single valid JSON string in the sidecar — put the four labels on separate lines using escaped newlines (`\n`), not literal line breaks that would break the sidecar's JSON parse. For `minor`/`nit`, a single sentence is fine. File a `major`/`critical` finding only when grounded in evidence, not speculation.

Rationale: the merged `designFeedback` (`src/dispatch/design-feedback.ts`, PR #56/#57) renders each blocking finding's `rationale` verbatim into the redesign prompt's `{{review_feedback}}` slot (as `- [category] location: <rationale>`). Structuring the rationale is exactly what makes the redesign actionable — a direct payoff from the Tier 1 loop fix. The structure lives entirely inside the existing free-text `rationale` string (`z.string()`, unconstrained), so no schema change and nothing downstream breaks; the continuation lines render un-indented under the feedback bullet, which is fine for an LLM reader. The JSON-validity note above is the one real risk (E) raises — the sidecar is `JSON.parse`d, so a literal newline in the string is a parse failure (a transport error → re-dispatch).

## Design decisions (recorded)

1. **Prompt-only, structured-rationale (not schema fields).** Operator decision, 2026-07-07. The heavier option (real `required_change`/`acceptance_check`/`evidence` schema + DB fields) was considered and declined — it would touch the agent-output contract and need a migration. Structured rationale delivers the actionability at zero schema cost.
2. **(E) applies only to blocking (`major`/`critical`) findings.** `minor`/`nit` stay terse, to avoid turning trivia into noise.
3. **(D) skip-list describes the gates' *form* checks, not substance, and must stay in sync with `extract-schema.ts`.** The three judgment bullets (CDOT substance, migration ordering, path plausibility) exist because the gates stop at "present". Verified against the code by the Tier 2 independent review.

## Implementer notes (from the independent review)

- Edit **only the blockquoted section text** into the prompts. Prose in this spec that names template vars (e.g. the `{{description}}` mention in (A)'s rationale) is *explanation*, not prompt text — never paste it into a prompt body, or `renderPrompt` will try to resolve it.
- (C) edits `design-review.md:18-20`; (E) edits `design-review.md:22`. Both are existing bullets inside the "For each finding provide" list (lines 17-25) — edit in place; do not add duplicate free-standing sections. (A), (B), (D) are genuinely new sections.
- (A) belongs in `design.md`; (B) goes near the top of `design.md` after the ticket description; (C)/(D)/(E) are `design-review.md`. None introduce a `{{placeholder}}`, so `prompt-vars.ts` is untouched.
- Pick presence-test anchor phrases from *stable* wording so a later reword doesn't rot the test.

## Testing / verification

Static prompt edits — no runtime behavior to drive. Verification:
- Full suite stays green (`bun test`) — confirms no placeholder regression and no prompt-loading test breaks.
- `tsc --noEmit` and `biome check` clean.
- A light presence test (or extend an existing prompt test) asserting each new section's anchor phrase exists in the rendered/imported prompt text, so the guidance can't be silently deleted later. Exact test shape to be decided in the implementation plan.

## Out of scope

- Schema/DB fields for findings (the heavy actionability option).
- Codex #2 (rigidifying `design.md` output into a fixed markdown schema) — rejected; the separate `design:extract` step already converts prose to structured units.
- The gated half of codex #7 (re-checking invariants the gates enforce) — explicitly excluded by edit D.
- The code-review → plan-defect → redesign feedback gap (a separate `fix/` item; only Option A of Tier 1 would have covered it) — tracked independently.
