# review→implement loopback carries the blocking findings (feedback parity) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a code review bounces work back to the implement agent, hand that agent the specific blocking review findings on the FIRST loopback — so it fixes the actual complaint instead of re-coding blind and hitting the same finding again (the darkreader SMOKE=2 "no progress: identical review findings" deadlock).

**Architecture:** The code-review→implement loopback (`codeLoopback` in `src/daemon/review-verdict.ts`) resets the units and re-dispatches implement, but — unlike the design path's `redesignLoopback`, whose findings `designFeedback` reads — it carries no findings to the re-code. The implement re-dispatch (`handlers.ts:882`) only renders verify feedback (`implementFeedback`) and still-red-AC feedback (`gateFeedback`); the review findings, though persisted in the `review_finding` table, are read only by the verdict logic, never by the re-code prompt. This plan adds the missing reader — `reviewFeedback(db, ticketId, workUnitId)` — and wires it into the implement prompt, exactly mirroring the `gateFeedback`/`{{gate_feedback}}` pattern. No loopback, schema, or resolver change.

**Tech Stack:** TypeScript + Bun + embedded SQLite. Corrective-feedback readers live in `src/dispatch/*-feedback.ts`, are rendered into prompt slots by `src/dispatch/prompt-vars.ts`, and are called from the dispatch handler in `src/dispatch/handlers.ts`. Tests run with `bun test`.

## Global Constraints

- **Ground truth over self-report:** `reviewFeedback` reads the persisted `review_finding` ledger, never an agent verdict — consistent with `applyReviewVerdict`.
- **Scope to the round that bounced:** read only the latest `review`-step dispatch's findings (`latestDispatchForStep(db, ticketId, "review")` → `listByDispatch`), filtered to `status === "open"` AND `blocks_ship === 1`. This matches exactly the set `applyReviewVerdict` used to decide the loopback, and auto-scopes to the newest round on each subsequent bounce (never leaks a prior round's findings).
- **Per-unit precision:** the implement dispatch is per-`work_unit`. `reviewFeedback` takes the unit id and renders only findings whose `work_unit_id` equals that unit OR is `null` (a whole-ticket finding — `codeLoopback` re-codes every unit in that case).
- **Backward compatibility:** add the new parameter to `implementVars` as the LAST, defaulted (`= ""`) parameter, and the `{{review_feedback}}` slot to `implement.md`. Existing `implementVars` callers (which pass ≤6 args) and the pre-existing render tests must stay green.
- Full suite (`bun test`), `bun run typecheck`, `bun run lint` must stay green.

---

### Task 1: `reviewFeedback(db, ticketId, workUnitId)` reader

**Files:**
- Create: `src/dispatch/review-feedback.ts`
- Test: `test/dispatch/review-feedback.test.ts`

**Interfaces:**
- Consumes: `latestDispatchForStep(db, ticketId, stepKey)`, `listByDispatch(db, ticketId, dispatchId)`, and `ReviewFindingRow` — all from `src/db/repos/review-finding.ts` (`ReviewFindingRow` fields used: `status: string`, `blocks_ship: number | null`, `work_unit_id: number | null`, `severity: string`, `location: string | null`, `rationale: string | null`).
- Produces: `export function reviewFeedback(db: Database, ticketId: number, workUnitId: number): string` — a rendered must-fix block, or `""` when there is no prior review round / no blocking finding for this unit. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch/review-feedback.test.ts`:

```ts
import { expect, test } from "bun:test";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { insertFinding } from "../../src/db/repos/review-finding.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { reviewFeedback } from "../../src/dispatch/review-feedback.ts";
import { makeTestDb } from "../helpers/db.ts";

// Seed a succeeded `review` step + its dispatch, mirroring review-verdict.test.ts's seedReviewRound.
function seedReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  const s = insertPending(db, { ticketId, stepKey: "review", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  const did = "T-d0001";
  insertDispatch(db, { ticketId, dispatchId: did, seq: 1, stepId: s.id, stage: "review" });
  return { unit, did };
}

test("reviewFeedback is empty with no prior review round", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  expect(reviewFeedback(db, ticketId, unit.id)).toBe("");
  db.close();
});

test("reviewFeedback renders this unit's blocking findings from the latest review round", () => {
  const { db, ticketId } = makeTestDb();
  const { unit, did } = seedReview(db, ticketId);
  insertFinding(db, {
    ticketId, reviewKind: "code", dispatchId: did, severity: "major", category: "correctness",
    deferralCandidate: 0, blocksShip: 1, workUnitId: unit.id,
    location: "src/a.ts:12", rationale: "off-by-one in the loop bound",
  });
  const out = reviewFeedback(db, ticketId, unit.id);
  db.close();
  expect(out).toContain("src/a.ts:12");
  expect(out).toContain("off-by-one in the loop bound");
});

test("reviewFeedback excludes non-blocking and other-unit findings", () => {
  const { db, ticketId } = makeTestDb();
  const { unit, did } = seedReview(db, ticketId);
  const other = insertWorkUnit(db, { ticketId, seq: 2, kind: "backend", behavioral: 0 });
  insertFinding(db, {
    ticketId, reviewKind: "code", dispatchId: did, severity: "minor", category: "style",
    deferralCandidate: 0, blocksShip: 0, workUnitId: unit.id, location: "NONBLOCKING", rationale: "nit",
  });
  insertFinding(db, {
    ticketId, reviewKind: "code", dispatchId: did, severity: "major", category: "correctness",
    deferralCandidate: 0, blocksShip: 1, workUnitId: other.id, location: "OTHERUNIT", rationale: "x",
  });
  const out = reviewFeedback(db, ticketId, unit.id);
  db.close();
  expect(out).toBe("");
});

test("reviewFeedback includes a whole-ticket (null-unit) blocking finding", () => {
  const { db, ticketId } = makeTestDb();
  const { unit, did } = seedReview(db, ticketId);
  insertFinding(db, {
    ticketId, reviewKind: "code", dispatchId: did, severity: "major", category: "correctness",
    deferralCandidate: 0, blocksShip: 1, workUnitId: null, location: "WHOLETICKET", rationale: "cross-cutting",
  });
  const out = reviewFeedback(db, ticketId, unit.id);
  db.close();
  expect(out).toContain("WHOLETICKET");
});
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `bun test test/dispatch/review-feedback.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/review-feedback.ts'` (module not created yet).

- [ ] **Step 3: Implement `reviewFeedback`**

Create `src/dispatch/review-feedback.ts`:

```ts
import type { Database } from "bun:sqlite";
import { latestDispatchForStep, listByDispatch } from "../db/repos/review-finding.ts";

/** Corrective feedback for an implement re-code after a code-review→implement loopback: the blocking
 *  findings from the latest `review` round that pertain to THIS unit (its own findings, plus any
 *  finding not tied to a unit — those re-code the whole ticket). Empty when there is no prior review
 *  round, or none of its blocking findings touch this unit — so a first implement dispatch renders a
 *  blank `{{review_feedback}}`. Ground truth: reads the persisted finding ledger scoped to the round
 *  that forced the bounce (same set `applyReviewVerdict` used), never an agent verdict. Mirrors
 *  `implementFeedback`/`gateFeedback` (feedback.ts) and `designFeedback`. */
export function reviewFeedback(db: Database, ticketId: number, workUnitId: number): string {
  const dispatchId = latestDispatchForStep(db, ticketId, "review");
  if (dispatchId === null) return "";
  const blocking = listByDispatch(db, ticketId, dispatchId).filter(
    (f) =>
      f.status === "open" &&
      f.blocks_ship === 1 &&
      (f.work_unit_id === workUnitId || f.work_unit_id === null),
  );
  if (blocking.length === 0) return "";
  const lines = blocking.map(
    (f) => `- [${f.severity}] ${f.location ?? "unit-wide"}: ${f.rationale ?? ""}`,
  );
  return `## Code-review findings to fix (a prior review blocked shipping on these)\n\nThe last code review of your work raised the following blocking findings. Fix EACH before you finish — do NOT weaken or delete tests to hide them:\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run the tests — verify they PASS**

Run: `bun test test/dispatch/review-feedback.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/review-feedback.ts test/dispatch/review-feedback.test.ts
git commit -m "feat(dispatch): reviewFeedback reader — latest review round's blocking findings per unit"
```

---

### Task 2: Wire `reviewFeedback` into the implement re-dispatch

**Files:**
- Modify: `prompts/implement.md` (add `{{review_feedback}}` slot after `{{gate_feedback}}`, line 14)
- Modify: `src/dispatch/prompt-vars.ts` (`implementVars`: add trailing `reviewFeedbackText = ""` param + `review_feedback` var)
- Modify: `src/dispatch/handlers.ts` (import `reviewFeedback`; pass it at the implement dispatch site, ~line 882)
- Test: `test/dispatch/prompt-vars.test.ts` (add wiring assertions)

**Interfaces:**
- Consumes: `reviewFeedback(db, ticketId, workUnitId)` from Task 1.
- Produces: `implementVars(ticket, unit, profile, feedback?, authoredChecks?, gateFeedbackText?, reviewFeedbackText?)` now returns a `review_feedback` var; the implement prompt renders it.

- [ ] **Step 1: Write the failing wiring tests**

Append to `test/dispatch/prompt-vars.test.ts` (it already imports `implementVars` and constructs a `unit`/`profile` — reuse the same `ticket`/`unit`/`profile` shapes already used at line ~45/150 of that file):

```ts
test("implementVars threads review_feedback into the review_feedback var", () => {
  const unit = { seq: 1, kind: "backend", title: "t", files_to_touch: null } as never;
  const profile = { slug: "s", components: [], promptVars: {} } as never;
  const vars = implementVars({ ident: "ENG-1", title: "t" }, unit, profile, "", [], "", "REVIEWMARKER");
  expect(vars.review_feedback).toBe("REVIEWMARKER");
});

test("implementVars review_feedback defaults to empty", () => {
  const unit = { seq: 1, kind: "backend", title: "t", files_to_touch: null } as never;
  const profile = { slug: "s", components: [], promptVars: {} } as never;
  expect(implementVars({ ident: "ENG-1", title: "t" }, unit, profile).review_feedback).toBe("");
});

test("implement prompt has a review_feedback slot", () => {
  expect(IMPLEMENT_TEMPLATE).toContain("{{review_feedback}}");
});
```

If `IMPLEMENT_TEMPLATE` is not already imported at the top of the test file, add it to the existing `prompt-vars.ts` import:
```ts
import { IMPLEMENT_TEMPLATE, implementVars /* …existing… */ } from "../../src/dispatch/prompt-vars.ts";
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: FAIL — `vars.review_feedback` is `undefined` (not yet a var) and `IMPLEMENT_TEMPLATE` lacks the slot.

- [ ] **Step 3: Add the prompt slot**

In `prompts/implement.md`, change lines 14–16 from:
```markdown
{{gate_feedback}}

## Reporting the files you created (required whenever you add a file)
```
to:
```markdown
{{gate_feedback}}

{{review_feedback}}

## Reporting the files you created (required whenever you add a file)
```

- [ ] **Step 4: Add the `implementVars` param + var**

In `src/dispatch/prompt-vars.ts`, change the `implementVars` signature to add a trailing parameter:
```ts
export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: WorkUnitRow,
  profile: Profile,
  feedback = "",
  authoredChecks: { test_path: string | null }[] = [],
  gateFeedbackText = "",
  reviewFeedbackText = "",
): Record<string, string> {
```
and add the var to the returned object, next to `gate_feedback`:
```ts
    gate_feedback: gateFeedbackText,
    review_feedback: reviewFeedbackText,
```

- [ ] **Step 5: Wire the handler call site**

In `src/dispatch/handlers.ts`, add the import (next to the existing `feedback.ts` import at line ~76):
```ts
import { reviewFeedback } from "./review-feedback.ts";
```
Then at the implement dispatch site (~line 882), add the 7th argument to the `implementVars(...)` call:
```ts
        vars: implementVars(
          ctx.ticket,
          unit,
          deps.profile,
          implementFeedback(ctx.db, unit.id),
          listAcChecks(ctx.db, ctx.ticket.id),
          gateFeedback(ctx.db, ctx.ticket.id),
          reviewFeedback(ctx.db, ctx.ticket.id, unit.id),
        ),
```

- [ ] **Step 6: Run the wiring tests — verify they PASS**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: all pass (including the pre-existing implementVars tests).

- [ ] **Step 7: Full green check**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass. In particular the implement-prompt render tests still pass (the new `{{review_feedback}}` slot is balanced by the new `review_feedback` var, which existing callers fill with `""`).

- [ ] **Step 8: Commit**

```bash
git add prompts/implement.md src/dispatch/prompt-vars.ts src/dispatch/handlers.ts test/dispatch/prompt-vars.test.ts
git commit -m "fix(loop): carry blocking code-review findings into the implement re-code (first loopback)"
```

---

## Self-Review

**1. Spec coverage:** The gap — the review→implement loopback hands the implement agent no review findings on the first bounce — is closed by Task 1 (the reader, scoped to the bouncing round, per unit, blocking-only) and Task 2 (rendering it into the implement prompt at the existing corrective-feedback location). The darkreader deadlock resolves because the very first re-code now names the exact finding (`debug_ENG279.tests.ts` test-quality) as must-fix.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code and test block is complete; every command has an expected result.

**3. Type consistency:** `reviewFeedback(db, ticketId, workUnitId)` is defined in Task 1 and called with exactly those three args in Task 2. The `implementVars` new trailing param `reviewFeedbackText = ""` maps to `review_feedback`, matched by the `{{review_feedback}}` slot. `ReviewFindingRow` fields (`status`, `blocks_ship`, `work_unit_id`, `severity`, `location`, `rationale`) match `src/db/repos/review-finding.ts`. Seeding helpers (`insertWorkUnit`, `insertPending`, `insertDispatch`, `insertFinding`) use the exact argument shapes from `test/daemon/review-verdict.test.ts`.
