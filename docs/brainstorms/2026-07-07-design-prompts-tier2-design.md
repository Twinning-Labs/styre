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

**(C) Severity calibration.** Replace the terse severity bullet (currently "one or two sentences" style definitions) with calibrated definitions:

> - `critical`: the plan would cause data loss, unsafe external behavior, an impossible-to-execute step, or violates a hard architectural invariant.
> - `major`: implementation should not start until this is fixed.
> - `minor`: implementation can proceed, but quality/maintainability suffers.
> - `nit`: wording/formatting only; no effect on implementation. Do not file style-only nits unless they affect extractability or implementation safety.

Rationale: reduces noisy loopbacks by anchoring what actually blocks. `critical`/`major` drive the loopback (`blocks_ship`); calibration keeps them from being over/under-used.

**(D) Trimmed judgment checklist.** Add a section that focuses the reviewer on non-gated judgment and *explicitly forbids re-checking* the deterministically-gated invariants:

> `## What to check (judgment the automated gates can't do)`
>
> `These are already machine-enforced before you run — do NOT re-verify them: every behavioral unit has a test, migrations precede domain units, flagged data/caching/observability/config/docs concerns are addressed, each unit names ≥1 file, seqs/dependencies are well-formed. Instead judge:`
> - `Scope matches the ticket — cross-check the plan's Requirements-traceability block against the ticket (nothing extra, nothing missing).`
> - `Work-unit boundaries are sound — no two units must edit the same coupled files while blind to each other; dependency order is sane.`
> - `Named file paths are specific and plausible (the gate only checks a path exists, not that it's the right one).`
> - `Each behavioral unit's test plan is actually adequate to catch regressions, not merely present.`

Rationale: the reviewer's value is the judgment the gates can't compute. The "do NOT re-verify" list must match what the code actually enforces:
- `validateExtraction` (`src/dispatch/extract-schema.ts`): behavioral ⇒ has `test_plan` and `"test"` in `verify_check_types`; each unit has ≥1 `files_to_touch`; seqs are the contiguous set `1..N`; `depends_on` are strictly-earlier existing seqs.
- `validateCdotImpact` (same file): flagged (`present`/`unknown`) data/caching/observability/configSecrets/documentation sections have non-empty analysis; if `data.schemaChange`, a migration-kind unit exists and precedes all domain units.

These gates run at `design:extract` (S1b), *before* `design:review` (S1c), so at review time they are guaranteed. Any drift between the checklist's skip-list and the gate code is a bug — keep them in sync.

**(E) Structured rationale for blocking findings.** Change the `rationale` field instruction so blocking findings carry a repair-ready structure:

> For `major`/`critical` findings, structure the `rationale` so the designer can act without guessing:
> - **Problem:** what is wrong.
> - **Required change:** the specific change that resolves it.
> - **Acceptance check:** how to tell the revised plan fixed it.
> - **Evidence:** the plan section, ticket line, or `file:line` that grounds the finding.
>
> For `minor`/`nit`, a single sentence is fine. File a `major`/`critical` finding only when grounded in evidence, not speculation.

Rationale: the merged `designFeedback` (`src/dispatch/design-feedback.ts`, PR #56/#57) renders each blocking finding's `rationale` verbatim into the redesign prompt's `{{review_feedback}}` slot. Structuring the rationale is exactly what makes the redesign actionable — a direct payoff from the Tier 1 loop fix. The structure lives entirely inside the existing free-text `rationale` string, so no schema change.

## Design decisions (recorded)

1. **Prompt-only, structured-rationale (not schema fields).** Operator decision, 2026-07-07. The heavier option (real `required_change`/`acceptance_check`/`evidence` schema + DB fields) was considered and declined — it would touch the agent-output contract and need a migration. Structured rationale delivers the actionability at zero schema cost.
2. **(E) applies only to blocking (`major`/`critical`) findings.** `minor`/`nit` stay terse, to avoid turning trivia into noise.
3. **(D) skip-list must stay in sync with the gate code.** Documented above so an implementer can verify it against `extract-schema.ts`.

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
