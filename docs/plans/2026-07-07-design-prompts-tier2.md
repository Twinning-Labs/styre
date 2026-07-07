# Design & Design-Review Prompt Quality (Tier 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the `design` and `design:review` agent prompts so the plan is easier to review for completeness, the design agent grounds its plan in the repo, and blocking plan-review findings are actionable — all as prompt-only edits.

**Architecture:** Static-text edits to two prompt files (`prompts/design.md`, `prompts/design-review.md`), imported as text via `import … with { type: "text" }` and exported as `DESIGN_TEMPLATE` / `DESIGN_REVIEW_TEMPLATE` from `src/dispatch/prompt-vars.ts`. No new `{{placeholders}}` → no `prompt-vars.ts` change, no schema change. A presence test asserts each new section survives future edits. Spec: `docs/brainstorms/2026-07-07-design-prompts-tier2-design.md`.

**Tech Stack:** TypeScript, `bun test`, `biome`.

## Global Constraints

- **Branch:** feature → `feat/` prefix (e.g. `feat/design-prompts-tier2`).
- **Never commit to `main`; PR only; no auto-merge.** Operator merges personally. PR title must be Conventional Commits.
- **Prompt-only.** No `.ts` source changes except the new test file. No schema change, no `prompt-vars.ts` change. Do not introduce any `{{token}}` into the prompt text (it would become a required placeholder and break `renderPrompt`).
- **Edit only the blockquoted/section text specified below into the prompts.** Never paste this plan's explanatory prose (or `{{description}}`-style var mentions) into a prompt body.
- **(C) and (E) replace existing bullets in place** (inside `design-review.md`'s "For each finding provide" list) — do not add duplicate free-standing sections. **(A), (B), (D) are new sections.**

---

## File Structure

- **Modify** `prompts/design.md` — add (B) inspect-before-planning + (A) requirements-traceability section.
- **Modify** `prompts/design-review.md` — replace (C) severity bullet + (E) rationale bullet; add (D) "what to check" section.
- **Create** `test/dispatch/design-prompts-tier2.test.ts` — presence + render-safety assertions for both prompts.

---

### Task 1: `design.md` — inspect-before-planning (B) + requirements traceability (A)

**Files:**
- Modify: `prompts/design.md`
- Test: `test/dispatch/design-prompts-tier2.test.ts` (create)

**Interfaces:**
- Consumes: `DESIGN_TEMPLATE`, `designVars` from `src/dispatch/prompt-vars.ts`; `parseProfile` from `src/dispatch/profile.ts`; `renderPrompt` from `src/dispatch/render-prompt.ts`.

- [ ] **Step 1: Write the failing presence test**

Create `test/dispatch/design-prompts-tier2.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { DESIGN_TEMPLATE, designVars } from "../../src/dispatch/prompt-vars.ts";
import { renderPrompt } from "../../src/dispatch/render-prompt.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x" });

test("design.md tells the agent to inspect the repo before planning (B)", () => {
  expect(DESIGN_TEMPLATE).toContain("Before planning, read the files");
});

test("design.md requires a requirements-traceability block (A)", () => {
  expect(DESIGN_TEMPLATE).toContain("Requirements traceability");
});

test("design.md still renders with no unsatisfied placeholder (B/A added no new {{token}})", () => {
  const vars = designVars({ ident: "ENG-1", title: "T", description: "b" }, profile);
  const result = renderPrompt(DESIGN_TEMPLATE, vars);
  // renderPrompt returns ok:false with the offending names if a new {{token}} slipped in that
  // designVars doesn't supply — so ok:true is the guard against an accidental placeholder.
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/design-prompts-tier2.test.ts`
Expected: FAIL — the two `toContain` assertions fail (phrases not in the prompt yet). The render/placeholder test passes.

- [ ] **Step 3: Add (B) — inspect before planning**

In `prompts/design.md`, insert the (B) paragraph between the `{{review_feedback}}` line and the "Write a brainstorm" line. Replace:

```
{{review_feedback}}

Write a brainstorm + implementation plan as a committed markdown file under `docs/plans/`,
```

with:

```
{{review_feedback}}

Before planning, read the files, tests, config, and docs this ticket will touch. Do not guess
file paths, APIs, command names, or test strategy the repo can answer — ground the plan in what
you actually find.

Write a brainstorm + implementation plan as a committed markdown file under `docs/plans/`,
```

- [ ] **Step 4: Add (A) — requirements traceability**

In `prompts/design.md`, after the work-unit sentence that ends `— as prose.`, insert the traceability section. Replace:

```
is behavioral (and how it's tested), the verify check-types, and dependencies — as prose.

Project stack notes: {{stack}}
```

with:

```
is behavioral (and how it's tested), the verify check-types, and dependencies — as prose.

## Requirements traceability (include this in the plan)

List each acceptance criterion / explicit requirement from the ticket, and name the work unit(s)
that satisfy it. If a requirement is intentionally out of scope, say so and why. An unmapped
requirement is a completeness gap the reviewer will catch.

Project stack notes: {{stack}}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/dispatch/design-prompts-tier2.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 6: Commit**

```bash
git add prompts/design.md test/dispatch/design-prompts-tier2.test.ts
git commit -m "feat(prompts): design.md — inspect-before-planning + requirements traceability"
```

---

### Task 2: `design-review.md` — severity calibration (C) + judgment checklist (D) + structured rationale (E)

**Files:**
- Modify: `prompts/design-review.md`
- Test: `test/dispatch/design-prompts-tier2.test.ts` (append)

**Interfaces:**
- Consumes: `DESIGN_REVIEW_TEMPLATE`, `designReviewVars` from `src/dispatch/prompt-vars.ts` (both already exported).

- [ ] **Step 1: Write the failing presence test (append to the same file)**

Append to `test/dispatch/design-prompts-tier2.test.ts`:

```typescript
import { DESIGN_REVIEW_TEMPLATE, designReviewVars } from "../../src/dispatch/prompt-vars.ts";

test("design-review.md has calibrated critical severity (C)", () => {
  expect(DESIGN_REVIEW_TEMPLATE).toContain("impossible-to-execute step");
});

test("design-review.md has the non-gated judgment checklist (D)", () => {
  expect(DESIGN_REVIEW_TEMPLATE).toContain("What to check (judgment the automated gates can't do)");
  // the anti-over-claim wording the independent review required:
  expect(DESIGN_REVIEW_TEMPLATE).toContain("non-empty analysis string");
});

test("design-review.md requires structured rationale for blocking findings (E)", () => {
  expect(DESIGN_REVIEW_TEMPLATE).toContain("Required change");
  expect(DESIGN_REVIEW_TEMPLATE).toContain("Acceptance check");
});

test("design-review.md still renders with no new placeholders", () => {
  const vars = designReviewVars({ ident: "ENG-1", title: "T" }, profile);
  const result = renderPrompt(DESIGN_REVIEW_TEMPLATE, vars);
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/design-prompts-tier2.test.ts`
Expected: FAIL — the (C)/(D)/(E) `toContain` assertions fail; the render test passes.

- [ ] **Step 3: Replace (C) — the severity bullet**

In `prompts/design-review.md`, replace:

```
- **severity**: `critical` (the plan is broken/unsafe — must not be built), `major` (should not be
  built as-is), `minor` (worth fixing, non-blocking), `nit` (trivial). Do not inflate or deflate.
```

with:

```
- **severity** — calibrate; do not inflate or deflate:
  - `critical`: the plan would cause data loss, unsafe external behavior, an impossible-to-execute step, or violates a hard architectural invariant.
  - `major`: implementation should not start until this is fixed.
  - `minor`: implementation can proceed, but quality/maintainability suffers.
  - `nit`: wording/formatting only; no effect on implementation. Do not file style-only nits unless they affect extractability or implementation safety.
```

- [ ] **Step 4: Replace (E) — the rationale bullet**

In `prompts/design-review.md`, replace:

```
- **rationale**: one or two sentences on what is wrong and why it matters.
```

with:

```
- **rationale**: for `major`/`critical` findings, structure it so the designer can act without guessing — **Problem** (what is wrong), **Required change** (the specific fix), **Acceptance check** (how to tell the revised plan fixed it), **Evidence** (plan section, ticket line, or `file:line`). Keep the whole rationale a single valid JSON string: put the labels on separate lines using escaped newlines (`\n`), not literal line breaks. For `minor`/`nit`, one sentence is fine. File a `major`/`critical` finding only when grounded in evidence, not speculation.
```

- [ ] **Step 5: Add (D) — the judgment checklist**

In `prompts/design-review.md`, insert the (D) section between the `decomposition` dimension and the "For each finding provide:" line. Replace:

```
- **decomposition** — is the breakdown into work units sound (right boundaries, sane dependencies)?

For each finding provide:
```

with:

```
- **decomposition** — is the breakdown into work units sound (right boundaries, sane dependencies)?

## What to check (judgment the automated gates can't do)

These structural facts are already machine-enforced before you run — do NOT re-verify them: every
behavioral unit has a test_plan and a "test" check; each unit names at least one file; seqs are
contiguous (1..N) and every dependency points to an earlier unit; when the plan declares a schema
change, at least one migration unit is ordered before the first domain unit; and every flagged
data/caching/observability/config/docs section carries a non-empty analysis string. The gates check
that these are PRESENT, not that they are GOOD — judging substance is your job:
- Scope matches the ticket — cross-check the plan's Requirements-traceability block against the ticket (nothing extra, nothing missing).
- The CDOT analyses are substantive — real reasoning about this change's impact on each flagged concern, not empty filler or an "N/A" dodge on a concern that actually applies.
- Migration ordering is genuinely sound — every migration precedes the units that use it (the gate only checks the earliest migration vs the earliest domain unit, and only when a schema change is declared).
- Work-unit boundaries are sound — no two units must edit the same coupled files while blind to each other; dependency order is sane.
- Named file paths are specific and plausible (the gate only checks that ≥1 file is named, not that it exists or is the right one).
- Each behavioral unit's test plan is actually adequate to catch regressions, not merely present.

For each finding provide:
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/dispatch/design-prompts-tier2.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Commit**

```bash
git add prompts/design-review.md test/dispatch/design-prompts-tier2.test.ts
git commit -m "feat(prompts): design-review.md — severity calibration, judgment checklist, structured rationale"
```

---

## Verification

- [ ] `bun test` — full suite green (confirms no other prompt/render test broke).
- [ ] `bun run typecheck` (`tsc --noEmit`) — clean.
- [ ] `bunx biome check test/dispatch/design-prompts-tier2.test.ts` — clean (prompt `.md` files are not linted by biome).
- [ ] Sanity-read the two prompts end-to-end: (C) replaced the old severity wording (not appended), (E) replaced the old rationale line, and no `{{token}}` was introduced.
- [ ] Commit the spec + this plan if not already committed; open a **draft** PR into `main` via `gh pr create --draft` (HTTPS push: `git -c credential.helper='!gh auth git-credential' push`). Do **not** merge. Suggested PR title: `feat(prompts): sharpen design & design-review prompts (Tier 2)`.

## Self-Review (done while writing this plan)

1. **Spec coverage:** (A) Task 1 Step 4; (B) Task 1 Step 3; (C) Task 2 Step 3; (D) Task 2 Step 5; (E) Task 2 Step 4. All five spec edits map to a step, each with a presence assertion.
2. **Placeholder scan:** no TBD/TODO; every edit shows exact before/after text.
3. **Type/name consistency:** the presence test imports `DESIGN_TEMPLATE`/`DESIGN_REVIEW_TEMPLATE`/`designVars`/`designReviewVars` — all exported from `prompt-vars.ts`; `parseProfile({ slug, targetRepo })` and `designReviewVars({ ident, title })` match existing call shapes in `test/dispatch/design-vars.test.ts`. The placeholder-list assertion in Task 1 Step 1 is the *current* `DESIGN_TEMPLATE` placeholder set — if it drifts, that test (correctly) fails and the implementer re-confirms no new token was added.

## Out of scope

Schema/DB fields for findings; rigidifying `design.md` output (codex #2); re-checking gated invariants (excluded by D); the code-review→redesign feedback gap (separate `fix/`).
