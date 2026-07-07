# Design Redesign-Feedback Cascade Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the **plan-review** (`design:review`) → redesign loopback, stop per-unit blocking findings from being silently dropped from the redesign feedback, so that redesign sees *every* `design:review` finding that forced it — not just the plan-wide ones.

**Explicitly NOT a goal (see "Known gap" below):** the *code-review* → plan-defect → redesign path (`review-verdict.ts:158`). `designFeedback` reads only `design:review` findings, so a redesign triggered by a code-review plan-defect carries no plan feedback today — cascade or not. That is a separate pre-existing gap, out of the "cascade-fix only" scope, and this plan does **not** fix it.

**Architecture:** PR #56 built the redesign feedback loop (`designFeedback` renders the latest `design:review` blocking findings into the `{{review_feedback}}` slot of the design prompt). But `redesignLoopback` calls `deleteByTicket` first, and `review_finding.work_unit_id` is `ON DELETE CASCADE` with `PRAGMA foreign_keys = ON` — so every **per-unit** finding (the whole `decomposition` dimension, per-unit feasibility/testability) is cascade-deleted *before* `designFeedback` reads it. The fix detaches the triggering blocking findings from their work units (`work_unit_id = NULL`) inside the same transaction, *before* the delete, so the cascade spares them. `designFeedback` and its read path are untouched.

**Tech Stack:** TypeScript, `bun:sqlite`, `bun test`. Repos under `src/db/repos/`, control logic under `src/daemon/`.

## Global Constraints

- **Branch:** this is a bug fix → `fix/` prefix (e.g. `fix/redesign-feedback-cascade-drop`). Not `feat/`.
- **Never commit to `main`; PR only; no auto-merge.** Operator merges personally.
- **Only the runner writes the SoT**; all changes here run inside the existing `db.transaction(...)` in `redesignLoopback`.
- **No schema change.** `work_unit_id` is already nullable (`REFERENCES work_unit(id) ON DELETE CASCADE`, NULL = plan/ticket-level). Detaching to NULL is a legal, already-modeled state. Because there is no schema change, the dual-schema-file rule (edit both `src/db/` and `docs/architecture/` copies) does **not** apply here.
- **Scope is cascade-fix only** (operator decision, 2026-07-07). Making findings *actionable* (structured `required_change`/`acceptance_check`/`evidence`, codex #3) is **explicitly deferred to Tier 2** — do not add it here.

### Design decision (recorded for the reviewer — not silently chosen)

Two approaches were considered:

- **Option A — snapshot findings into the loopback event `payload_json` at verdict time; `designFeedback` reads the snapshot.** Fully decouples feedback from the mutable findings table. **Strictly more capable:** because the snapshot is keyed to the loopback event (not to the `design:review` dispatch), it would *also* carry feedback on the code-review → plan-defect → redesign path — closing the "Known gap" below. Rejected for *this* fix only because (a) the operator scoped this to the cascade bug, and (b) it rewrites `designFeedback`'s source of truth **and** its existing tests (`test/dispatch/design-feedback.test.ts`) — more churn than a "cascade-fix only" warrants. **If the operator wants the code-review→redesign path fixed too, switch to Option A — Option B cannot cover it.**
- **Option B — detach the triggering blocking findings from their units before `deleteByTicket`, so the cascade spares them (chosen, for the `design:review` path only).** `designFeedback` and its tests stay byte-for-byte unchanged; the diff is one repo helper + one loop in `redesignLoopback` + two call-site edits. Minimal blast radius. Semantic costs, both acceptable:
  1. Preserved findings lose their `work_unit_id` link (they become plan-wide). Correct-by-construction — the unit they pointed at is being deleted in the same transaction, and `designFeedback` never rendered `work_unit_id` anyway (it renders `[category] location: rationale`, and `location` still carries the file:line).
  2. Preserved findings stay `status='open'` forever (nothing flips them to `fixed`), so across N redesign rounds dead `work_unit_id=NULL` rows accumulate. Verified **harmless to control flow**: every live reader is dispatch-scoped — `listByDispatch` in `applyReviewVerdict` (review-verdict.ts:126) and `designFeedback` (design-feedback.ts:11) both filter by the *current* round's `dispatch_id`; the only ticket-wide reader `listOpenByTicket` is used **only in tests**, never in `src/`. The residue is telemetry/forensic noise, not a correctness bug.

---

## File Structure

- **Modify** `src/db/repos/review-finding.ts` — add `detachFromWorkUnit(db, id)`.
- **Modify** `src/daemon/review-verdict.ts` — `redesignLoopback` takes the blocking findings and detaches them before the delete; both call sites pass `blocking`.
- **Modify** `test/db/repos/review-finding.test.ts` — unit-test the new helper.
- **Modify** `test/daemon/review-verdict.test.ts` — integration test: a per-unit blocking finding survives a plan-review redesign and shows up in `designFeedback`.

No production read-path files change. `src/dispatch/design-feedback.ts` and `prompts/design.md` are **not** touched.

---

### Task 1: `detachFromWorkUnit` repo helper

**Files:**
- Modify: `src/db/repos/review-finding.ts` (add one function near `setStatus`, ~line 123)
- Test: `test/db/repos/review-finding.test.ts`

**Interfaces:**
- Produces: `detachFromWorkUnit(db: Database, id: number): void` — sets `review_finding.work_unit_id = NULL` for the given finding id. Idempotent; a no-op if the row is already detached or absent.

- [ ] **Step 1: Write the failing test**

Add to `test/db/repos/review-finding.test.ts`. Note: `insertFinding` is **already imported** in this file — do not re-import it. Add only the missing names: `detachFromWorkUnit` and `getById` to the existing `review-finding.ts` import, and a new `work-unit.ts` import for `insertWorkUnit`/`deleteByTicket`:

```typescript
// existing review-finding.ts import — add detachFromWorkUnit, getById to it:
import { detachFromWorkUnit, getById, insertFinding /* …existing… */ } from "../../../src/db/repos/review-finding.ts";
// new import:
import { deleteByTicket, insertWorkUnit } from "../../../src/db/repos/work-unit.ts";

test("detachFromWorkUnit nulls work_unit_id so the finding survives its unit's deletion", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", filesToTouch: ["a.ts"] });
  const f = insertFinding(db, {
    ticketId,
    reviewKind: "plan",
    severity: "major",
    category: "decomposition",
    location: "plan.md:10",
    rationale: "unit boundary is wrong",
    blocksShip: 1,
    workUnitId: unit.id,
  });

  detachFromWorkUnit(db, f.id);
  expect(getById(db, f.id)?.work_unit_id).toBeNull();

  // With work_unit_id NULL, deleting the unit no longer cascades the finding away.
  deleteByTicket(db, ticketId);
  expect(getById(db, f.id)).not.toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/repos/review-finding.test.ts -t "detachFromWorkUnit"`
Expected: FAIL — the module fails to load because the named import `detachFromWorkUnit` does not resolve (link-time error), so the test cannot run.

- [ ] **Step 3: Write minimal implementation**

In `src/db/repos/review-finding.ts`, add immediately below `setStatus` (matching its named-param style):

```typescript
/** Sever a finding from its work unit (work_unit_id → NULL). Used before a redesign deletes the
 *  ticket's work units, so a per-unit finding is not cascade-deleted with the unit it referenced —
 *  it survives as a plan-level finding the redesign feedback can still carry. */
export function detachFromWorkUnit(db: Database, id: number): void {
  db.query("UPDATE review_finding SET work_unit_id = NULL WHERE id = $id").run({ $id: id });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db/repos/review-finding.test.ts -t "detachFromWorkUnit"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/review-finding.ts test/db/repos/review-finding.test.ts
git commit -m "fix(review-finding): add detachFromWorkUnit to sever a finding from its unit"
```

---

### Task 2: Preserve blocking findings across the redesign delete

**Files:**
- Modify: `src/daemon/review-verdict.ts:91` (`redesignLoopback` signature + body) and the two call sites at `:140` and `:158`
- Test: `test/daemon/review-verdict.test.ts`

**Interfaces:**
- Consumes: `detachFromWorkUnit` (Task 1); `ReviewFindingRow` (already imported at the top of `review-verdict.ts`); `designFeedback` from `src/dispatch/design-feedback.ts`; `insertDesignReviewDispatch` from `test/helpers/dispatch-fixtures.ts`.
- Changes: `redesignLoopback(db, ticketId, signature, blocking: ReviewFindingRow[])` — new 4th parameter.

- [ ] **Step 1: Write the failing test**

Add to `test/daemon/review-verdict.test.ts` (add `import { designFeedback } from "../../src/dispatch/design-feedback.ts";` and `import { insertDesignReviewDispatch } from "../helpers/dispatch-fixtures.ts";` to the import block):

```typescript
test("plan-review redesign preserves a per-unit blocking finding for the redesign feedback", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", filesToTouch: ["a.ts"] });
  const did = insertDesignReviewDispatch(db, ticketId); // design:review step + dispatch

  insertFinding(db, {
    ticketId,
    dispatchId: did,
    reviewKind: "plan",
    severity: "major",
    category: "decomposition",
    location: "plan.md:10",
    rationale: "PER-UNIT-DECOMP-ISSUE",
    blocksShip: 1,
    workUnitId: unit.id,
  });
  insertFinding(db, {
    ticketId,
    dispatchId: did,
    reviewKind: "plan",
    severity: "major",
    category: "completeness",
    location: "plan.md:2",
    rationale: "PLAN-WIDE-ISSUE",
    blocksShip: 1,
    workUnitId: null,
  });

  const r = applyReviewVerdict(db, ticketId, DEFAULT_RUNTIME_CONFIG, { stepKey: "design:review" });
  const units = listUnits(db, ticketId);
  const feedback = designFeedback(db, ticketId);
  db.close();

  expect(r.decision).toBe("loopback");
  expect(units.length).toBe(0); // redesign still clears the decomposition
  expect(feedback).toContain("PER-UNIT-DECOMP-ISSUE"); // survives the cascade now
  expect(feedback).toContain("PLAN-WIDE-ISSUE"); // still there
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/review-verdict.test.ts -t "preserves a per-unit blocking finding"`
Expected: FAIL — `feedback` is missing `PER-UNIT-DECOMP-ISSUE` (cascade-deleted with the unit).

- [ ] **Step 3: Add the `detachFromWorkUnit` import in `review-verdict.ts`**

Extend the existing `review-finding.ts` import block (currently `type ReviewFindingRow, latestDispatchForStep, listByDispatch`):

```typescript
import {
  type ReviewFindingRow,
  detachFromWorkUnit,
  latestDispatchForStep,
  listByDispatch,
} from "../db/repos/review-finding.ts";
```

- [ ] **Step 4: Change `redesignLoopback` to detach before deleting**

Replace the current `redesignLoopback` (`src/daemon/review-verdict.ts:91`):

```typescript
function redesignLoopback(
  db: Database,
  ticketId: number,
  signature: string,
  blocking: ReviewFindingRow[],
): void {
  db.transaction(() => {
    // Preserve the findings that forced this redesign: detach any per-unit finding from its unit
    // BEFORE deleteByTicket, so the ON DELETE CASCADE does not take it. designFeedback then reads
    // the full blocking set (plan-wide + formerly-per-unit) for the re-dispatch.
    for (const f of blocking) {
      if (f.work_unit_id !== null) {
        detachFromWorkUnit(db, f.id);
      }
    }
    deleteByTicket(db, ticketId);
    for (const key of ["design:dispatch", "design:extract", "design:review", "review"]) {
      const step = getByKey(db, ticketId, key);
      if (step) {
        resetToPending(db, step.id);
      }
    }
    setTicketStage(db, ticketId, "design");
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "design",
      routeTo: "review",
      signature,
    });
  })();
}
```

- [ ] **Step 5: Update both call sites**

At `src/daemon/review-verdict.ts:140` (plan-review path) — pass the `design:review` `blocking` set, which `designFeedback` reads:

```typescript
    redesignLoopback(db, ticketId, signature, blocking);
```

At `src/daemon/review-verdict.ts:158` (code-review plan-defect → redesign path) — pass **`[]`**, not `blocking`. These are `review_kind='code'` findings on the `"review"` dispatch; `designFeedback` only reads `design:review` findings, so preserving them would render nothing and merely accumulate orphan rows. Detaching nothing here keeps this path's behavior exactly as it is today (see "Known gap"):

```typescript
        // Code-review-triggered redesign carries no plan feedback today (designFeedback reads only
        // design:review findings). Nothing to preserve here — pass []. See the Known-gap note.
        redesignLoopback(db, ticketId, signature, []);
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `bun test test/daemon/review-verdict.test.ts -t "preserves a per-unit blocking finding"`
Expected: PASS.

- [ ] **Step 7: Run the full affected suites (no regressions)**

Run: `bun test test/daemon/review-verdict.test.ts test/dispatch/design-feedback.test.ts test/dispatch/design-review-e2e.test.ts test/db/repos/review-finding.test.ts`
Expected: all PASS — existing redesign, feedback, and e2e tests unchanged and green.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/review-verdict.ts test/daemon/review-verdict.test.ts
git commit -m "fix(design-loop): preserve per-unit blocking findings across the redesign delete"
```

---

## Verification

- [ ] `bun test` — full suite green.
- [ ] Manually confirm the two commits are on a `fix/` branch, not `main`.
- [ ] Open a **draft** PR into `main` (`gh pr create --draft`). Conventional-Commits title, e.g. `fix(design-loop): carry per-unit plan-review findings into the redesign`. Do **not** merge.

## Self-Review (done while writing this plan)

1. **Coverage:** The one behavior in scope — per-unit blocking findings reaching the redesign — is proven failing (Task 2 Step 2) and fixed (Step 6). Plan-wide findings (already working) are asserted to still work.
2. **Placeholders:** none — every step carries exact code/commands.
3. **Type consistency:** `detachFromWorkUnit(db, id)` is defined in Task 1 and consumed by the same signature in Task 2; `ReviewFindingRow.work_unit_id` (`number | null`) and `.id` (`number`) match the repo interface; `redesignLoopback`'s new `blocking: ReviewFindingRow[]` matches the type of the `blocking` array already computed in `applyReviewVerdict`.

## Known gap — code-review → plan-defect → redesign carries no feedback (surfaced by independent review; NOT fixed here)

`designFeedback` (design-feedback.ts:9) reads only `latestDispatchForStep(db, ticketId, "design:review")`. The `redesignLoopback` caller at `review-verdict.ts:158` is reached from **code** review (`opts.stepKey === "review"`) when a blocking `plan-defect` is found after implementation and `onPlanDefect: "redesign"` is configured. Those findings are `review_kind='code'`, tagged with the `"review"` dispatch — so `designFeedback` never renders them, and that redesign gets an **empty** `{{review_feedback}}` slot. This is **not** a cascade bug (even plan-wide code findings wouldn't render), so it is outside this "cascade-fix only" scope and is deliberately left unfixed here — Step 5 passes `[]` at that call site to keep today's behavior exactly.

**Decision for the operator:** if the code-review-triggered redesign should also carry its defect feedback, this fix must use **Option A** (snapshot into the loopback event payload), which covers both paths. Option B (this plan) covers only the `design:review` path. Recommend tracking the code-review→redesign feedback gap as its own `fix/` ticket rather than expanding this one.

## Out of scope (Tier 2 — do not build here)

- Actionable findings: structured `required_change` / `acceptance_check` / `evidence` (codex #3).
- Requirements traceability in `design.md`, "inspect before planning", expanded severity calibration, the trimmed reviewer judgment checklist (codex #4/#5/#6/#7).
