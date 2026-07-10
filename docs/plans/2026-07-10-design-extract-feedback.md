> ⚠️ **SUPERSEDED** (2026-07-10) by the general-class fix in `docs/brainstorms/2026-07-10-dispatch-retry-feedback-design.md` — the per-step `extractFeedback` was symptomatic; the general `runAgentDispatch` retry-feedback primitive replaces it. Kept for history.

# `design:extract` Validation Feedback-Carry — Bug B Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `design:extract` re-dispatch *informed* — carry the `validateExtraction`/`validateCdotImpact` errors from a failed attempt into the retry prompt so the agent corrects the specific problem (e.g. a vacuous zero-files work unit) instead of blindly repeating it and escalating.

**Architecture:** On a validation failure, the handler records a sha-keyed `extract-validation` `ground_truth_signal` (before throwing). A new `extractFeedback(db, ticketId)` reads the latest such signal at the current plan sha and formats it into a corrective block, which `extractVars` renders in a new `{{extract_feedback}}` prompt slot. Mirrors `implementFeedback` (sha-keyed read) + `designFeedback` (formatting). No schema/resolver/failure-policy change.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`. Tests are `bun test`. TDD throughout.

## Global Constraints

- **`design:extract` escalates on attempt-exhaustion, not "no-progress".** It is step_type `"dispatch"` (resolver.ts:99) → the default retry path (`failure-policy.ts:257-258`) → up to `DEFAULT_MAX_ATTEMPTS` (3), then escalate on exhaustion (`failure-policy.ts:70-86`). So the feedback informs attempts **2 and 3**. Do NOT touch the failure-policy or assert a "no-progress" escalate anywhere. (design §0/§1)
- **`extractFeedback` reads the LATEST matching signal via `.at(-1)`** — `listByTicket` is `ORDER BY measured_at, id` ascending; a `.find()` would return attempt-1's stale errors. (design §2.1, review M-1)
- **Sha-keying:** record + read the `extract-validation` signal at `getLatestForTicket(db, ticketId)?.branch_head_sha` (the plan-commit sha). A new design round has a new plan sha, so prior-round feedback is never read. Null sha → `""` (degrade to today's blind retry, never worse). (design §1/§3)
- **The prompt slot and the `extractVars` param must land in the SAME task** (Task 2) — `renderPrompt` fails closed on an unresolved `{{extract_feedback}}`, so a template-only edit would break *every* `design:extract`. (design §2, review M-2)
- **The feedback never relaxes the gate** — `validateExtraction`/`validateCdotImpact` still run deterministically on every attempt; feedback only informs. No false-pass. (design §5)
- **`extract-validation` is a new open-vocab `signal_type`** (the column has no CHECK; additive). `result: "fail"`. Read only by `extractFeedback`. (design §3)
- Run `bun run lint` + `bun run format` + `bun run typecheck` (all exit 0) before every commit — CI enforces them.

---

## File Structure

- **Create** `src/dispatch/extract-feedback.ts` — `extractFeedback(db, ticketId): string` (Task 1).
- **Modify** `src/dispatch/prompt-vars.ts` — `extractVars` gains an `extractFeedback` param + `extract_feedback` slot; **Modify** `prompts/design-extract.md` — add `{{extract_feedback}}` (Task 2, together).
- **Modify** `src/dispatch/handlers.ts` (`design:extract` handler, ~lines 392, 403-409) — record the signal on both failure branches + pass `extractFeedback` into `extractVars` (Task 3).
- **Tests:** `test/dispatch/extract-feedback.test.ts` (T1), `test/dispatch/extract-vars.test.ts` (T2), `test/dispatch/design-extract-feedback.test.ts` (T3), `test/daemon/design-extract-feedback-e2e.test.ts` (T4).

---

## Task 1: `extractFeedback` reader

**Files:**
- Create: `src/dispatch/extract-feedback.ts`
- Test: `test/dispatch/extract-feedback.test.ts`

**Interfaces:**
- Consumes: `getLatestForTicket` (`db/repos/dispatch.ts`), `listByTicket` (`db/repos/ground-truth-signal.ts`).
- Produces: `extractFeedback(db: Database, ticketId: number): string` — the corrective block for the latest `extract-validation` fail signal at the current plan sha, or `""`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/extract-feedback.test.ts`:

```ts
import { expect, test } from "bun:test";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { extractFeedback } from "../../src/dispatch/extract-feedback.ts";
import { makeTestDb } from "../helpers/db.ts";

function seedPlanSha(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, sha: string) {
  const d = insertDispatch(db, { ticketId, dispatchId: "des-d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: sha });
}

test("no signal → empty string", () => {
  const { db, ticketId } = makeTestDb();
  seedPlanSha(db, ticketId, "PLAN");
  expect(extractFeedback(db, ticketId)).toBe("");
});

test("a fail signal at the current plan sha → a corrective block containing the errors", () => {
  const { db, ticketId } = makeTestDb();
  seedPlanSha(db, ticketId, "PLAN");
  insertSignal(db, {
    ticketId,
    signalType: "extract-validation",
    result: "fail",
    branchHeadSha: "PLAN",
    detail: { errors: ["unit seq 3 declares no files_to_touch (every planned unit must name ≥1 file)"] },
  });
  const fb = extractFeedback(db, ticketId);
  expect(fb).toContain("unit seq 3 declares no files_to_touch");
  expect(fb).toContain("Prior extraction was rejected");
  expect(fb).toContain("remove it"); // the over-decomposition guidance
});

test("uses the LATEST fail signal (.at(-1)), not the earliest", () => {
  const { db, ticketId } = makeTestDb();
  seedPlanSha(db, ticketId, "PLAN");
  insertSignal(db, { ticketId, signalType: "extract-validation", result: "fail",
    branchHeadSha: "PLAN", detail: { errors: ["OLD attempt-1 error"] } });
  insertSignal(db, { ticketId, signalType: "extract-validation", result: "fail",
    branchHeadSha: "PLAN", detail: { errors: ["NEW attempt-2 error"] } });
  const fb = extractFeedback(db, ticketId);
  expect(fb).toContain("NEW attempt-2 error");
  expect(fb).not.toContain("OLD attempt-1 error");
});

test("a fail signal at a DIFFERENT (stale prior-round) sha is ignored", () => {
  const { db, ticketId } = makeTestDb();
  seedPlanSha(db, ticketId, "PLAN2"); // current round's plan sha
  insertSignal(db, { ticketId, signalType: "extract-validation", result: "fail",
    branchHeadSha: "PLAN1", detail: { errors: ["stale round-1 error"] } });
  expect(extractFeedback(db, ticketId)).toBe("");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/extract-feedback.test.ts`
Expected: FAIL — `extract-feedback.ts` / `extractFeedback` does not exist.

- [ ] **Step 3: Implement**

Create `src/dispatch/extract-feedback.ts`:

```ts
import type { Database } from "bun:sqlite";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import { listByTicket } from "../db/repos/ground-truth-signal.ts";

/** Corrective feedback for a `design:extract` re-dispatch: the errors that rejected the previous
 *  extraction (`validateExtraction`/`validateCdotImpact`), so the agent fixes the specific problem
 *  instead of blindly repeating it. Sha-keyed to the current plan sha (`getLatestForTicket`), so a
 *  new design round's fresh plan sha never reads a prior round's stale feedback. Empty string on the
 *  first attempt (no prior failure). Mirrors `implementFeedback` (sha-keyed) + `designFeedback`
 *  (formatting). */
export function extractFeedback(db: Database, ticketId: number): string {
  const sha = getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
  if (sha === null) return "";
  const sig = listByTicket(db, ticketId)
    .filter(
      (s) =>
        s.signal_type === "extract-validation" && s.result === "fail" && s.branch_head_sha === sha,
    )
    .at(-1); // listByTicket is measured_at,id ASC → last = newest (attempt N, not attempt 1)
  if (!sig) return "";
  const errors = (JSON.parse(sig.detail_json ?? "{}") as { errors?: string[] }).errors ?? [];
  if (errors.length === 0) return "";
  const lines = errors.map((e) => `- ${e}`);
  return `## Prior extraction was rejected — fix before re-emitting

Your previous work-unit plan failed these checks. Fix each, then re-emit the FULL plan:
${lines.join("\n")}

In particular, if a unit has no files to change it is redundant — remove it (or merge it into the unit that does the work) and renumber the remaining units so their seqs are the contiguous set 1..N with no gaps. Do not over-decompose a small change (a 1-line fix is one unit).`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/extract-feedback.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/extract-feedback.ts test/dispatch/extract-feedback.test.ts
git commit -m "feat(loop): extractFeedback — sha-keyed corrective feedback for design:extract retries"
```

---

## Task 2: `extractVars` param + `{{extract_feedback}}` prompt slot (together)

**Files:**
- Modify: `src/dispatch/prompt-vars.ts` (`extractVars`)
- Modify: `prompts/design-extract.md`
- Test: `test/dispatch/extract-vars.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `extractVars(ticket, profile, extractFeedback = ""): Record<string,string>` with an `extract_feedback` key; the prompt template references `{{extract_feedback}}`.

> Both edits MUST land in this one task/commit. `renderPrompt` fails closed on an unresolved `{{extract_feedback}}` (throws `CL-PROFILE`), so the template edit without the var would break every `design:extract`. Adding the var with a default `""` is backward-compatible (the handler still calls the 2-arg form until Task 3), rendering a blank slot.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/extract-vars.test.ts`:

```ts
import { expect, test } from "bun:test";
import { EXTRACT_TEMPLATE, extractVars } from "../../src/dispatch/prompt-vars.ts";
import { renderPrompt } from "../../src/dispatch/render-prompt.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main" });

test("extractVars carries the extractFeedback into extract_feedback (default empty)", () => {
  const v0 = extractVars({ ident: "ENG-1", title: "t" }, profile);
  expect(v0.extract_feedback).toBe("");
  const v1 = extractVars({ ident: "ENG-1", title: "t" }, profile, "SOME FEEDBACK");
  expect(v1.extract_feedback).toBe("SOME FEEDBACK");
});

test("the extract template renders with and without feedback (no missing var)", () => {
  const blank = renderPrompt(EXTRACT_TEMPLATE, extractVars({ ident: "ENG-1", title: "t" }, profile));
  expect(blank.ok).toBe(true);
  const withFb = renderPrompt(
    EXTRACT_TEMPLATE,
    extractVars({ ident: "ENG-1", title: "t" }, profile, "## Prior extraction was rejected\n- x"),
  );
  expect(withFb.ok).toBe(true);
  if (withFb.ok) expect(withFb.prompt).toContain("Prior extraction was rejected");
});
```

> NOTE: confirm `EXTRACT_TEMPLATE` is exported from `prompt-vars.ts` (it is — `export const EXTRACT_TEMPLATE = designExtractTemplate;`). If the import name differs, adjust.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/extract-vars.test.ts`
Expected: FAIL — `extract_feedback` undefined / template lacks the slot.

- [ ] **Step 3: Implement**

In `src/dispatch/prompt-vars.ts`, change `extractVars`:

```ts
export function extractVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  extractFeedback = "",
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    detected_stacks: detectedStacksVar(profile),
    extract_feedback: extractFeedback,
    ...profile.promptVars,
    ...runtimeVars(profile),
  };
}
```

In `prompts/design-extract.md`, add the slot right after the second intro paragraph, **before** `## Detected stacks` (so the agent addresses corrective feedback first). Insert:

```markdown
{{extract_feedback}}
```

so the file reads:

```markdown
A design plan has already been written and committed under `docs/plans/`. Read it (and any
files it references) and decompose it into an ordered list of work units the build system will
implement and verify one at a time. Do NOT write or edit any files — your only output is the
sidecar block described below.

{{extract_feedback}}

## Detected stacks (from `styre setup` — ground truth)
```

(On the first attempt `{{extract_feedback}}` renders as an empty line — harmless; on a retry it renders the corrective block.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/extract-vars.test.ts`
Expected: PASS (2 tests). Then `bun test` (full suite) — the existing `design:extract` still renders (blank slot), no regression.

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/prompt-vars.ts prompts/design-extract.md test/dispatch/extract-vars.test.ts
git commit -m "feat(loop): design-extract prompt gains {{extract_feedback}} slot + extractVars param"
```

---

## Task 3: wire the `design:extract` handler (record signal + pass feedback)

**Files:**
- Modify: `src/dispatch/handlers.ts` (`design:extract` handler — the `vars:` line ~392 and the two failure branches ~403-409; imports)
- Test: `test/dispatch/design-extract-feedback.test.ts`

**Interfaces:**
- Consumes: `extractFeedback` (Task 1), `extractVars` with the new param (Task 2), existing `insertSignal`, `getLatestForTicket`, `validateExtraction`, `validateCdotImpact`.
- Produces: the `design:extract` handler records an `extract-validation` fail signal on either validation failure (before throwing) and renders `extractFeedback` into the prompt.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/design-extract-feedback.test.ts` — drive the registered `design:extract` handler via a FakeAgentRunner whose sidecar emits a chosen extraction. **Copy the ctx/registry/deps harness from `test/dispatch/checks-classify-handler.test.ts`** (a registered-handler unit test); seed a `stage='design'` ticket with a prior dispatch that recorded a plan sha (so `getLatestForTicket` resolves). The FakeAgentRunner returns a sidecar JSON matching `ExtractOutputSchema`.

```ts
// Test A: an extraction with a vacuous unit (files_to_touch: []) → the handler THROWS
//   (design:extract completeness failed) AND an `extract-validation` fail signal now exists at the
//   plan sha, whose detail.errors contains "unit seq ... no files_to_touch".
//   (Search test/ for how ExtractOutputSchema sidecars are built; a valid extraction has units with
//    seq 1..N contiguous; the vacuous one sets files_to_touch: [] on the last unit.)
//
// Test B: a fully valid extraction → the handler succeeds (work units inserted) and NO
//   `extract-validation` signal is recorded (happy path unchanged).
//
// Test C: a `validateCdotImpact` failure (a runtimeContext flags e.g. documentation present but the
//   sidecar's cdotImpact.documentation.analysis is empty) → the handler throws (CDOT gate) AND
//   records an `extract-validation` fail signal with the cdot errors.
```

> The three assertions are the contract. Keep them focused on: (A) vacuous → throws + signal-with-errors recorded at the plan sha; (B) valid → no signal, units inserted; (C) cdot-fail → throws + signal recorded. Use `listByTicket`/`listSignals` to read the recorded signal; assert `signal_type==="extract-validation"`, `result==="fail"`, `branch_head_sha===<plan sha>`, and `JSON.parse(detail_json).errors` non-empty.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/design-extract-feedback.test.ts`
Expected: FAIL — no `extract-validation` signal is recorded (the handler only throws today).

- [ ] **Step 3: Implement**

In `src/dispatch/handlers.ts`:

Add the import (near the other `./` imports; `extract-schema` is already imported at :75):

```ts
import { extractFeedback } from "./extract-feedback.ts";
```

Confirm `insertSignal` is already imported in this file (it is — used widely). Change the `vars:` line (~392) to pass the feedback:

```ts
        vars: extractVars(ctx.ticket, deps.profile, extractFeedback(ctx.db, ctx.ticket.id)),
```

Replace the two failure branches (~403-409) to record the signal before throwing:

```ts
    const planSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha ?? undefined;
    const errors = validateExtraction(parsed.value.units);
    if (errors.length > 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        signalType: "extract-validation",
        result: "fail",
        branchHeadSha: planSha,
        detail: { errors },
      });
      throw new Error(`design:extract completeness failed: ${errors.join("; ")}`);
    }
    const cdotErrors = validateCdotImpact(parsed.value, deps.profile);
    if (cdotErrors.length > 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        signalType: "extract-validation",
        result: "fail",
        branchHeadSha: planSha,
        detail: { errors: cdotErrors },
      });
      throw new Error(`design:extract CDOT gate failed: ${cdotErrors.join("; ")}`);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/design-extract-feedback.test.ts` then `bun test` (full suite).
Expected: PASS.

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/handlers.ts test/dispatch/design-extract-feedback.test.ts
git commit -m "feat(loop): design:extract records + carries validation feedback (Bug B fix)"
```

---

## Task 4: e2e — an informed retry recovers; a stuck agent still escalates

**Files:**
- Test: `test/daemon/design-extract-feedback-e2e.test.ts`

**Interfaces:**
- Consumes: everything above, driven through the real resolver/tick loop.

- [ ] **Step 1: Write the failing test**

Create `test/daemon/design-extract-feedback-e2e.test.ts`. **Copy the full-loop harness from `test/helpers/run-harness.ts`** (real git repo + `FakeAgentRunner` + fake ports; see `test/daemon/run-ticket.test.ts`). Seed a ticket at `stage='design'` past `design:dispatch` (a plan committed at a sha) so the next step is `design:extract`.

```ts
// Test A (the crux — reproduces & fixes darkreader):
//   FakeAgentRunner for design:extract:
//     - attempt 1: emit a sidecar with a vacuous unit (files_to_touch: []) → validation fails.
//     - attempt 2+: emit a VALID extraction (drop the vacuous unit) — BUT only do so if the prompt
//       it received contained the feedback text ("Prior extraction was rejected"); otherwise emit
//       the vacuous one again. (Assert the feedback actually reached the agent by branching on
//       input.prompt.)
//   ASSERT: the ticket advances past design:extract (design→implement transition, or a work_unit
//   exists), WITHOUT escalating. This proves the retry was informed.
//
// Test B (a genuinely-stuck agent still escalates on exhaustion):
//   FakeAgentRunner emits the identical vacuous unit on ALL attempts.
//   ASSERT: after DEFAULT_MAX_ATTEMPTS the ticket escalates with reason/ signature
//   'design:extract' (exhaustion) — NOT advanced. (Do NOT assert a "no-progress" reason; this step
//   uses the attempt-exhaustion path.)
```

- [ ] **Step 2: Run the test to verify it fails, then passes**

Run: `bun test test/daemon/design-extract-feedback-e2e.test.ts`
Expected: with Tasks 1-3 merged, Test A PASSES (the retry sees feedback and produces a valid plan → advances) and Test B escalates on exhaustion. If Test A instead escalates (the feedback never reached the agent or the retry wasn't attempted), STOP and report BLOCKED — do not loosen the assertion.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: all green. Investigate any failure before proceeding.

- [ ] **Step 4: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add test/daemon/design-extract-feedback-e2e.test.ts
git commit -m "test(loop): design:extract informed retry recovers (Bug B); stuck agent still escalates"
```

---

## Self-Review (completed by plan author)

**Spec coverage.** design §1 mechanism → Tasks 1 (reader) + 3 (record+wire); §2.1 extractFeedback → T1; §2.2 handler record + pass → T3; §2.3 extractVars → T2; §2.4 prompt slot → T2; §3 edge cases (first-attempt blank, staleness sha-keying, cdot failures, null sha, .at(-1)) → T1/T3 tests; §4 tests → T1-T4; the failure-policy correction (attempt-exhaustion, not no-progress) → Global Constraints + T4 Test B. review M-1 (.at(-1)) → T1; M-2 (template+vars together) → T2 note; M-3 (renumber nudge) → T1 block text.

**Placeholder scan.** T3/T4 test bodies are described (assertions spelled out) because they must copy an existing registered-handler / full-loop harness that varies; the leaf tasks (T1/T2) carry complete code. Flagged explicitly so the implementer copies `checks-classify-handler.test.ts` (T3) and `run-harness.ts` (T4).

**Type consistency.** `extractFeedback(db, ticketId): string` (T1) consumed in T3; `extractVars(ticket, profile, extractFeedback="")` (T2) called with 3 args in T3; `extract-validation` signal_type + `detail: { errors: string[] }` identical in T1 (read), T3 (write); `getLatestForTicket(...)?.branch_head_sha` used in T1 and T3.

**One flagged verification for the implementer:** confirm `insertSignal` and `getLatestForTicket` are already imported in `handlers.ts` (they are — `getLatestForTicket` at :22, `insertSignal` used widely) and that `EXTRACT_TEMPLATE` is exported from `prompt-vars.ts` (it is). Copy the T3 harness from `checks-classify-handler.test.ts` and the T4 harness from `run-harness.ts`.
