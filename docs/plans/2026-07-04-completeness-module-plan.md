# Completeness Module (plan layer) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `completeness` step between `implement` and `verify` that fixes the empty-diff false-block (darkreader) and catches single-unit-declared under-delivery, per `docs/brainstorms/2026-07-04-completeness-module-design.md` (v3).

**Architecture:** A new pure module `src/dispatch/completeness.ts` (scope reconciliation) + a `completeness` handler that runs per-unit after `implement:wuN` and before `verify:wuN`. Under-delivery hard-gates (loopback to implement); a redundant unit whose declared files a sibling already touched is a no-op (`covered-by-sibling`); over-delivery stays advisory (`scope_diff`). Empty tasks are prevented upstream at the plan gate (`validateExtraction`), so `implement` never receives a unit with no declared files.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck`, `bun run lint`), embedded SQLite (`bun:sqlite`), zod.

## Global Constraints

- **Never override the detected verify command.** Completeness is deterministic scope arithmetic; it runs no build/test.
- **Only the runner writes the SoT** (B2). Signals/state changes go through the existing repos inside the handler/failure-policy, never the agent.
- **Ground truth over self-report.** The plan layer compares `files_to_touch` (facts) against the git diff (facts). No agent judgment.
- **Deterministic + recomputable.** The `completeness` step carries no exactly-once effect; it may re-run on replay/loopback (like `provision`/`verify`).
- **Two base refs (load-bearing):** `under` uses the **cumulative** diff from the *lowest-seq* unit's `base_sha`; `over` and "did this unit change anything" use the unit's **own** diff. Never use the processed unit's `base_sha` for the cumulative set (it excludes siblings → re-breaks darkreader).
- **Honest loopback bound:** `attempt` is per-`workflow_step`; the `completeness` and `verify` steps escalate independently at `maxAttempts` (3) each. Do not claim a shared per-unit budget.
- Commit after each task. Run `bun test`, `bun run typecheck`, `bun run lint` green before committing.

---

## File Structure

- **Create** `src/dispatch/completeness.ts` — pure core: `reconcileScope`, `classifyDisposition`, the `CompletenessDisposition` type.
- **Create** `test/dispatch/completeness.test.ts` — unit tests for the pure core.
- **Modify** `src/dispatch/extract-schema.ts` — `validateExtraction` floor (every unit ≥1 `files_to_touch`).
- **Modify** `src/dispatch/handlers.ts` — register the `completeness` handler; remove the `implement:dispatch` empty-diff postcondition; remove the `scope_diff` block from `verify:check`.
- **Modify** `src/daemon/resolver.ts` — gate `completeness:wuN` between the provision gate and `nextUnrunCheck`.
- **Modify** `src/daemon/failure-policy.ts` — a `completeness` branch (under-delivery → loopback implement).
- **Modify** `docs/architecture/control-loop.md` + `docs/architecture/minimal-loop.md` — step-catalog + Loopback Atlas.
- **Modify** existing tests broken by the new gate / floor (`test/dispatch/extract-schema.test.ts`, the resolver/e2e suites, `implement-allowlist` fixture).

---

## Task 1: Pure scope-reconciliation core

**Files:**
- Create: `src/dispatch/completeness.ts`
- Test: `test/dispatch/completeness.test.ts`

**Interfaces — Produces:**
- `type CompletenessDisposition = "under-delivered" | "covered-by-sibling" | "completed-by-self"`
- `reconcileScope(declared: string[], cumulativeTouched: string[], ownTouched: string[]): { under: string[]; over: string[] }`
- `classifyDisposition(under: string[], ownTouched: string[]): CompletenessDisposition`

- [ ] **Step 1: Write the failing test**

```ts
// test/dispatch/completeness.test.ts
import { describe, expect, test } from "bun:test";
import {
  classifyDisposition,
  reconcileScope,
} from "../../src/dispatch/completeness.ts";

describe("reconcileScope", () => {
  test("under = declared not in cumulative; over = own not in declared", () => {
    const r = reconcileScope(["a.ts", "b.ts"], ["a.ts", "c.ts"], ["c.ts"]);
    expect(r.under).toEqual(["b.ts"]); // b declared, touched by no one
    expect(r.over).toEqual(["c.ts"]); // c touched by this unit, not declared
  });

  test("declared file touched by a sibling only ⇒ not under-delivered", () => {
    // this unit's own diff is empty, but a sibling touched the declared file
    const r = reconcileScope(["parse.ts"], ["parse.ts", "other.ts"], []);
    expect(r.under).toEqual([]);
    expect(r.over).toEqual([]);
  });
});

describe("classifyDisposition", () => {
  test("any under ⇒ under-delivered", () => {
    expect(classifyDisposition(["x.ts"], ["y.ts"])).toBe("under-delivered");
  });
  test("no under + empty own diff ⇒ covered-by-sibling", () => {
    expect(classifyDisposition([], [])).toBe("covered-by-sibling");
  });
  test("no under + non-empty own diff ⇒ completed-by-self", () => {
    expect(classifyDisposition([], ["a.ts"])).toBe("completed-by-self");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/completeness.test.ts`
Expected: FAIL — cannot resolve `../../src/dispatch/completeness.ts`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/dispatch/completeness.ts

/** Disposition of a unit's deterministic, file-granular completeness check. */
export type CompletenessDisposition =
  | "under-delivered" // a declared file was touched by no one → the unit's work is missing
  | "covered-by-sibling" // this unit changed nothing, but siblings already touched its declared files
  | "completed-by-self"; // this unit made changes and all its declared files are covered

export interface ScopeReconciliation {
  under: string[]; // declared − cumulativeTouched
  over: string[]; // ownTouched − declared
}

/** Deterministic scope reconciliation. `under` asks "did ANYONE touch the declared file?"
 *  (cumulative, so a redundant unit whose sibling did the work is not flagged — the darkreader
 *  fix); `over` asks "did THIS unit touch a file it didn't declare?" (own diff — a cumulative
 *  `over` would flag every prior unit's files as this unit's over-reach). */
export function reconcileScope(
  declared: string[],
  cumulativeTouched: string[],
  ownTouched: string[],
): ScopeReconciliation {
  const cum = new Set(cumulativeTouched);
  const decl = new Set(declared);
  return {
    under: declared.filter((f) => !cum.has(f)),
    over: ownTouched.filter((f) => !decl.has(f)),
  };
}

/** Classify completeness from the reconciliation + whether the unit changed anything itself. */
export function classifyDisposition(
  under: string[],
  ownTouched: string[],
): CompletenessDisposition {
  if (under.length > 0) return "under-delivered";
  if (ownTouched.length === 0) return "covered-by-sibling";
  return "completed-by-self";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/completeness.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/completeness.ts test/dispatch/completeness.test.ts
git commit -m "feat(completeness): pure scope-reconciliation core"
```

---

## Task 2: Plan gate — every planned unit must declare ≥1 file

Closes A6 (vacuous unit) at the stage that owns it: `validateExtraction` rejects a unit with empty `files_to_touch`, so `design:extract` re-dispatches and `implement` never receives an empty task.

**Files:**
- Modify: `src/dispatch/extract-schema.ts:117-133` (the per-unit loop in `validateExtraction`)
- Test: `test/dispatch/extract-schema.test.ts`
- Also fix: any fixture that constructs a valid extraction with an empty `files_to_touch`.

**Interfaces — Consumes:** `ExtractedWorkUnit.files_to_touch: string[]` (already present).

- [ ] **Step 1: Write the failing test**

```ts
// add to test/dispatch/extract-schema.test.ts
import { validateExtraction } from "../../src/dispatch/extract-schema.ts";

test("validateExtraction rejects a unit with no files_to_touch", () => {
  const errors = validateExtraction([
    {
      seq: 1,
      kind: "backend",
      title: "t",
      description: "d",
      behavioral: false,
      test_plan: null,
      files_to_touch: [], // vacuous
      verify_check_types: [],
      depends_on: [],
    },
  ]);
  expect(errors.some((e) => e.includes("no files_to_touch"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/extract-schema.test.ts -t "no files_to_touch"`
Expected: FAIL — `errors` is empty, assertion false.

- [ ] **Step 3: Implement the floor**

In `src/dispatch/extract-schema.ts`, inside the `for (const u of units)` loop in `validateExtraction` (currently starting at line 117), add at the top of the loop body:

```ts
    if (u.files_to_touch.length === 0) {
      errors.push(
        `unit seq ${u.seq} declares no files_to_touch (every planned unit must name ≥1 file)`,
      );
    }
```

- [ ] **Step 4: Run test to verify it passes; preserve a CDOT test's intent**

Run: `bun test test/dispatch/extract-schema.test.ts` then `bun test 2>&1 | grep -i fail`.

No `validateExtraction` fixture actually breaks — every empty-`files_to_touch` fixture in `extract-schema.test.ts` feeds `validateCdotImpact`, not `validateExtraction`. **But** one handler-level test silently loses its purpose: `test/dispatch/design-extract.test.ts:142` builds a unit with `files_to_touch: []` to exercise the **CDOT gate**, and would now short-circuit at the new floor *before* reaching CDOT (its assertions — step not succeeded, `units.length === 0` — still pass either way, hiding the erosion). Give that fixture's unit a non-empty `files_to_touch` (e.g. `["src/x.ts"]`) so it keeps testing what it was written to test. Do **not** weaken the new rule. Expected end state: 0 fail.

> Note: the direct-insert fixture at `test/dispatch/implement-allowlist.test.ts:110` bypasses `validateExtraction` (it inserts a `work_unit` row directly), so it is unaffected here.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/extract-schema.ts test/
git commit -m "feat(completeness): plan gate — every planned unit must declare >=1 file"
```

---

## Task 3: The `completeness` handler

**Files:**
- Modify: `src/dispatch/handlers.ts` (register a new `completeness` handler; it needs `reconcileScope`/`classifyDisposition` imports and the already-imported `changedFilesBetween`, `changedFilesAt`, `getLatestByWorkUnit`, `getUnit`, `listUnits`/`listByTicket`, `parseFilesToTouch`, `insertSignal`, `listByUnit`, `worktreeFor`, `ensureWorktree`).
- Test: covered by Task 7 (needs the dispatch/db harness).

**Interfaces — Consumes:** Task 1's `reconcileScope`, `classifyDisposition`. **Produces:** a handler registered under key `"completeness"` that returns `{ disposition, under, over }` and throws on `under-delivered`.

- [ ] **Step 1: Add the import**

At the top of `src/dispatch/handlers.ts`, add:

```ts
import { classifyDisposition, reconcileScope } from "./completeness.ts";
```

Confirm `listByTicket` from the work-unit repo is imported (it is used elsewhere as `listUnits`/`getUnit`; if only `getUnit` is imported, add `listByTicket as listUnits`).

- [ ] **Step 2: Register the handler**

Add, alongside the other `registry.register(...)` calls (e.g. right after the `provision` handler):

```ts
  registry.register("completeness", async (ctx: HandlerContext) => {
    if (ctx.workUnitId === null) throw new Error("completeness: missing workUnitId");
    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (!unit) throw new Error(`completeness: work_unit ${ctx.workUnitId} not found`);
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);

    const latestSha = getLatestByWorkUnit(ctx.db, ctx.workUnitId)?.branch_head_sha ?? undefined;
    const declared = parseFilesToTouch(unit);

    // The unit's OWN diff (per-unit base) — for over-delivery + "did this unit change anything".
    // Unlike verify:check, base==head means "this unit committed NOTHING": ownTouched is [] (NOT
    // changedFilesAt, which would wrongly attribute a sibling's commit at that sha as this unit's).
    const ownTouched =
      unit.base_sha && latestSha && unit.base_sha !== latestSha
        ? changedFilesBetween(unit.base_sha, latestSha, worktreePath)
        : [];

    // The CUMULATIVE ticket diff — base = the lowest-seq unit's base_sha (the ticket fork point),
    // so a redundant unit whose declared files a sibling already touched is not flagged (darkreader).
    const minSeqUnit = listUnits(ctx.db, ctx.ticket.id)[0];
    const cumulativeBase = minSeqUnit?.base_sha ?? null;
    const cumulativeTouched =
      cumulativeBase && latestSha && cumulativeBase !== latestSha
        ? changedFilesBetween(cumulativeBase, latestSha, worktreePath)
        : ownTouched;

    const { under, over } = reconcileScope(declared, cumulativeTouched, ownTouched);
    const disposition = classifyDisposition(under, ownTouched);

    // Over-delivery — advisory scope_diff, OWN-diff based, once per (unit, sha).
    if (latestSha !== undefined && declared.length > 0) {
      const already = listByUnit(ctx.db, ctx.workUnitId).some(
        (s) => s.signal_type === "scope_diff" && s.branch_head_sha === latestSha,
      );
      if (!already) {
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: "scope_diff",
          result: over.length === 0 ? "pass" : "fail",
          branchHeadSha: latestSha,
          detail: { changed: ownTouched, out_of_scope: over },
        });
      }
    }

    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: "completeness",
      result: disposition === "under-delivered" ? "fail" : "pass",
      branchHeadSha: latestSha,
      detail: { disposition, under, declared },
    });

    if (disposition === "under-delivered") {
      throw new Error(`completeness:wu${unit.seq}: under-delivered [${under.join(", ")}]`);
    }
    return { disposition, under: under.length, over: over.length };
  });
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean (0 errors). Fix any missing import (`listUnits`/`listByUnit`).

- [ ] **Step 4: Commit**

```bash
git add src/dispatch/handlers.ts
git commit -m "feat(completeness): completeness handler (two-diff reconcile + advisory scope_diff)"
```

---

## Task 4: Resolver gate

**Files:**
- Modify: `src/daemon/resolver.ts:112-116` (the `verifying` branch of the `implement` case)
- Test: `test/daemon/resolver.test.ts`

**Interfaces — Consumes:** the `done`/`step` helpers already in `resolver.ts`.

- [ ] **Step 1: Write the failing test**

Add this to `test/daemon/resolver.test.ts`. It mirrors the existing test "implement: a verifying unit with an unrun check asks for the verify step" (currently at `:88`); `makeTestDb`, `nextStepKey`, `setTicketStage`, `insertWorkUnit`, and the top-of-file `succeed(db, ticketId, stepKey)` helper are all already imported/defined there.

```ts
test("implement: a verifying unit routes to completeness after provision, before verify", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  await succeed(db, ticketId, "provision");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "completeness:wu1",
    stepType: "completeness",
    handlerKey: "completeness",
    workUnitId: u.id,
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/daemon/resolver.test.ts -t "routes to completeness"`
Expected: FAIL — currently routes to `verify:wu1:test`.

- [ ] **Step 3: Insert the gate**

In `src/daemon/resolver.ts`, in the `// verifying` block, between the provision gate and the `nextUnrunCheck` call:

```ts
        // verifying
        if (!done(db, ticketId, "provision")) {
          return step("provision", "provision", "provision", null);
        }
        if (!done(db, ticketId, `completeness:wu${u.seq}`)) {
          return step(`completeness:wu${u.seq}`, "completeness", "completeness", u.id);
        }
        const check = nextUnrunCheck(db, u);
```

- [ ] **Step 4: Run to verify it passes; fix the collateral resolver tests**

Run: `bun test test/daemon/resolver.test.ts`
**Three** existing tests seed a `verifying` unit + `succeed(db, ticketId, "provision")` and then expect the verify step / mark-verified: "a verifying unit with an unrun check…" (`:88`), "…all checks have signals asks to mark-verified" (`:110`), and "provision runs once before the first unit verify" (`:247`). Each now stops one step earlier at completeness. (Note: "all units verified + no docs…" at `:142` seeds the unit with `status: "verified"`, so `nextActionableUnit` skips it and it never enters the `verifying` branch where the gate lives — it does **not** break and needs no change.) Fix the three by inserting, right after each `await succeed(db, ticketId, "provision");` line:

```ts
  await succeed(db, ticketId, "completeness:wu1");
```

(`succeed` marks the step `succeeded`, which is what the resolver's `done()` gate checks — the `stepType: "dispatch"` it journals is irrelevant to the gate.) Do not weaken any assertion. Expected end state: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/resolver.ts test/daemon/resolver.test.ts
git commit -m "feat(completeness): resolver gates completeness:wuN between provision and verify"
```

---

## Task 5: Failure-policy branch (under-delivery → loopback implement)

**Files:**
- Modify: `src/daemon/failure-policy.ts` (add a `completeness` branch before the terminal default at line 164)
- Test: `test/daemon/failure-policy.test.ts`

**Interfaces — Consumes:** `isRepeatedFailure`, `failureSignature`, `setUnitStatus`, `listStepsForUnit`, `resetToPending`, `appendEvent`, `insertSignal`, `setTicketStatus` (all already imported in the file).

- [ ] **Step 1: Write the failing test**

Add to `test/daemon/failure-policy.test.ts`. The file already defines the `failedStep(db, ticketId, { stepKey, stepType, workUnitId, attempts })` helper (it `insertPending`s a step, calls `markRunning` `attempts` times to bump the attempt counter, then `markFailed`s it) and imports `makeTestDb`, `setTicketStage`, `insertWorkUnit`, `getById as getUnit`, `listByTicket as listEvents`, `getById as getStep`. Mirror the existing "a verify step on a unit loops back" test:

```ts
test("completeness under-delivery loops the unit back to implement", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  const step = failedStep(db, ticketId, {
    stepKey: "completeness:wu1",
    stepType: "completeness",
    workUnitId: unit.id,
    attempts: 1,
  });
  const result = applyFailurePolicy(db, ticketId, step);
  const afterUnit = getUnit(db, unit.id);
  const loopbacks = listEvents(db, ticketId).filter((e) => e.kind === "loopback");
  db.close();
  expect(result.decision).toBe("loopback");
  expect(afterUnit?.status).toBe("pending");
  expect(loopbacks.length).toBe(1);
  expect(loopbacks[0]?.loop).toBe("implement");
});

test("completeness under-delivery escalates at the attempt ceiling", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  const step = failedStep(db, ticketId, {
    stepKey: "completeness:wu1",
    stepType: "completeness",
    workUnitId: unit.id,
    attempts: 3,
  });
  const result = applyFailurePolicy(db, ticketId, step, { maxAttempts: 3 });
  db.close();
  expect(result.decision).toBe("escalated");
});

// The design's most-insisted-on property (§4): a re-coded-but-still-under-delivering unit must
// escalate at the SECOND identical failure (isRepeatedFailure), not burn all 3 attempts.
test("completeness escalates at the second identical under-delivery, not the third", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  // A genuine under-delivery signal must exist so the branch takes the loopback path (F1 guard).
  // (insertSignal here is the ground-truth-signal repo import already at the top of the file.)
  const recordFail = () =>
    insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "completeness", result: "fail" });

  recordFail();
  const first = failedStep(db, ticketId, {
    stepKey: "completeness:wu1",
    stepType: "completeness",
    workUnitId: unit.id,
    attempts: 1,
  });
  expect(applyFailurePolicy(db, ticketId, first).decision).toBe("loopback");

  // Second identical failure: same step_key + same "boom" message ⇒ same failureSignature as the
  // loopback just recorded, at attempt 2 (< maxAttempts, so NOT the ceiling guard).
  recordFail();
  const second = failedStep(db, ticketId, {
    stepKey: "completeness:wu1",
    stepType: "completeness",
    workUnitId: unit.id,
    attempts: 2,
  });
  const res = applyFailurePolicy(db, ticketId, second);
  db.close();
  expect(res.decision).toBe("escalated");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/daemon/failure-policy.test.ts -t "completeness"`
Expected: the loopback test FAILS (a `completeness` step currently falls through to the default `retry`, so `decision` is `"retry"` and no loopback event is written); the ceiling test passes via the top-of-function `maxAttempts` guard even without the branch.

- [ ] **Step 3: Add the branch**

First add a helper next to `latestVerifyResult` (near the top of `src/daemon/failure-policy.ts`) — the completeness handler inserts its `completeness` signal **before** it throws on under-delivery, so a genuine under-delivery leaves a `"fail"` signal, whereas an infra/git crash (`ensureWorktree`/`changedFilesBetween` throwing) leaves none:

```ts
/** The most recent `completeness` result for this unit's step. "fail" = a genuine under-delivery
 *  (the handler recorded it before throwing); null = the handler crashed before any signal
 *  (infra/git fault — e.g. a wiped worktree, design §3.1 caveat 2). Mirrors latestVerifyResult. */
function latestCompletenessResult(db: Database, workUnitId: number): string | null {
  const rows = listByUnit(db, workUnitId).filter((s) => s.signal_type === "completeness");
  return rows.length === 0 ? null : (rows[rows.length - 1]?.result ?? null);
}
```

Then, immediately **before** the final two lines (`resetToPending(db, step.id); return { decision: "retry" };`):

```ts
  // Under-delivery (deterministic completeness) → bounce the unit back to coding to touch its
  // missing declared files. Same shape as the verify loopback; escalates on no-progress or when
  // this step's own attempt budget is exhausted (the top-of-function maxAttempts guard). NOTE:
  // completeness and verify carry independent per-step attempt counters (~maxAttempts each).
  if (step.step_type === "completeness" && step.work_unit_id !== null) {
    const workUnitId = step.work_unit_id;
    // Infra/git crash (no "fail" signal recorded) → retry the check, don't re-code the agent for
    // an environment fault. Mirrors the verify branch's latestVerifyResult === "error" retry.
    if (latestCompletenessResult(db, workUnitId) !== "fail") {
      resetToPending(db, step.id);
      return { decision: "retry" };
    }
    const signature = failureSignature(step);
    if (isRepeatedFailure(db, ticketId, signature)) {
      db.transaction(() => {
        setTicketStatus(db, ticketId, "waiting");
        insertSignal(db, {
          ticketId,
          signalType: "human_resume",
          reason: `no progress: '${step.step_key}' under-delivered identically twice`,
        });
        appendEvent(db, { ticketId, kind: "escalated", reason: "no progress", signature });
      })();
      return { decision: "escalated" };
    }
    db.transaction(() => {
      setUnitStatus(db, workUnitId, "pending");
      for (const s of listStepsForUnit(db, ticketId, workUnitId)) {
        resetToPending(db, s.id);
      }
      appendEvent(db, {
        ticketId,
        kind: "loopback",
        loop: "implement",
        routeTo: step.step_key,
        signature,
      });
    })();
    return { decision: "loopback" };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/daemon/failure-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/failure-policy.ts test/daemon/failure-policy.test.ts
git commit -m "feat(completeness): failure-policy loops under-delivery back to implement"
```

---

## Task 6: Remove the subsumed checks

The empty-diff postcondition (now handled by the plan gate + under-delivery) and the `scope_diff` block in `verify:check` (moved to the completeness handler) are removed.

**Files:**
- Modify: `src/dispatch/handlers.ts` (implement:dispatch postcondition ~353-357; verify:check scope_diff ~744-761)
- Test: existing tests that assert the empty-diff postcondition / scope_diff-in-verify behavior.

- [ ] **Step 1: Remove the empty-diff postcondition**

In `implement:dispatch`, delete the `postcondition` from the `runAgentDispatch` options:

```ts
        // DELETE these lines:
        postcondition: ({ changed }) => {
          if (!changed) {
            throw new Error("implement:dispatch postcondition: empty diff");
          }
        },
```

Leave the rest of the dispatch (including `setUnitStatus(..., "verifying")` and the manifest-touch re-provision hook) unchanged.

- [ ] **Step 2: Remove the `scope_diff` block from `verify:check`**

Delete the block at `handlers.ts:744-761` (the `// scope_diff (A3) — advisory ...` comment through its closing brace). Over-delivery is now emitted by the completeness handler (Task 3).

- [ ] **Step 3: Update / migrate affected tests**

Run: `bun test 2>&1 | grep -iE "fail|empty diff|scope_diff"`
- Tests asserting `"implement:dispatch postcondition: empty diff"` → re-express against completeness dispositions (moved to Task 7).
- Tests asserting `scope_diff` is emitted by `verify:check` → assert it is emitted by `completeness` instead.
Do not weaken assertions; move them to the correct producer. Expected end state: 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/dispatch/handlers.ts test/
git commit -m "refactor(completeness): remove empty-diff postcondition + scope_diff from verify (subsumed)"
```

---

## Task 7: End-to-end behavior tests

The load-bearing scenarios. Use the existing dispatch/daemon e2e harness (see `test/dispatch/verify-routing.test.ts` and `test/dispatch/provision.test.ts` for the real-git-worktree + registry + db patterns).

**Files:**
- Create/extend: `test/dispatch/completeness-e2e.test.ts`

- [ ] **Step 1: Write the harness + the two load-bearing scenarios**

Create `test/dispatch/completeness-e2e.test.ts`. The top matches `verify-routing.test.ts` (which is the canonical driver-loop harness — copy its `gitRepo`/`rig`/`buildDispatchRegistry`/`advanceOneStep` usage verbatim). `writers` lets a single `FakeAgentRunner` write different files on each successive `implement` dispatch (call 1 = wu1, call 2 = wu2, …).

```ts
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByUnit } from "../../src/db/repos/ground-truth-signal.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ce-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

// A FakeAgentRunner whose Nth implement dispatch runs writers[N-1](cwd). A no-op writer ⇒ empty diff.
function sequencedRunner(writers: Array<(cwd: string) => void>): FakeAgentRunner {
  let call = 0;
  return new FakeAgentRunner((input) => {
    writers[call]?.(input.cwd);
    call++;
    return {
      completed: true, exitCode: 0, stdout: "{}", stderr: "",
      timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
    };
  });
}

async function driveUntilCompleteness(
  db: Database,
  ticketId: number,
  registry: ReturnType<typeof buildDispatchRegistry>,
  unitId: number,
) {
  for (let i = 0; i < 14; i++) {
    if (listByUnit(db, unitId).some((s) => s.signal_type === "completeness")) return;
    await advanceOneStep(db, ticketId, registry);
  }
}

const disposition = (db: Database, unitId: number): string | undefined =>
  JSON.parse(
    listByUnit(db, unitId).find((s) => s.signal_type === "completeness")?.detail_json ?? "{}",
  ).disposition;

test("A1 darkreader: a redundant unit whose declared file a sibling touched is covered-by-sibling (no block)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  // wu1 declares+touches parse.ts (the real fix); wu2 declares parse.ts but produces an empty diff.
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["parse.ts"] });
  const wu2 = insertWorkUnit(db, { ticketId, seq: 2, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["parse.ts"], dependsOn: [1] });
  const runner = sequencedRunner([
    (cwd) => writeFileSync(join(cwd, "parse.ts"), "export const x = 1;\n"), // wu1
    () => {}, // wu2 → empty diff
  ]);
  const profile = parseProfile({ slug: "demo", targetRepo: repo, components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }] });
  const registry = buildDispatchRegistry({ runner, agentConfig: DEFAULT_AGENT_CONFIG, profile, worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")) });

  await driveUntilCompleteness(db, ticketId, registry, wu2.id);
  const events = listEvents(db, ticketId);
  db.close();
  expect(disposition(db, wu2.id)).toBe("covered-by-sibling");
  expect(events.filter((e) => e.kind === "loopback").length).toBe(0);
});

test("A2 under-delivered: a unit that touches a file it did NOT declare loops back to implement", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const wu1 = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["src/x.ts"] });
  const runner = sequencedRunner([(cwd) => { // touches y.ts, never the declared x.ts
    Bun.spawnSync(["mkdir", "-p", join(cwd, "src")]);
    writeFileSync(join(cwd, "src", "y.ts"), "export const y = 1;\n");
  }]);
  const profile = parseProfile({ slug: "demo", targetRepo: repo, components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }] });
  const registry = buildDispatchRegistry({ runner, agentConfig: DEFAULT_AGENT_CONFIG, profile, worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")) });

  await driveUntilCompleteness(db, ticketId, registry, wu1.id);
  const sig = listByUnit(db, wu1.id).find((s) => s.signal_type === "completeness");
  db.close();
  expect(sig?.result).toBe("fail");
  expect(JSON.parse(sig?.detail_json ?? "{}").disposition).toBe("under-delivered");
  expect(JSON.parse(sig?.detail_json ?? "{}").under).toEqual(["src/x.ts"]);
});
```

- [ ] **Step 2: Add the base-ref + honest-limit regression tests**

Add to the same file, using the same `gitRepo`/`sequencedRunner`/`driveUntilCompleteness`/`disposition` helpers. The first two are **real regression guards**; write them as concrete code (not prose), because they lock the two-base split and the §7 honest limit that the whole design rests on.

```ts
test("over-delivery uses the unit's OWN diff, not the cumulative (guards the two-base split)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["a.ts"] });
  insertWorkUnit(db, { ticketId, seq: 2, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["b.ts"], dependsOn: [1] });
  const wu3 = insertWorkUnit(db, { ticketId, seq: 3, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["c.ts"], dependsOn: [2] });
  const runner = sequencedRunner([
    (cwd) => writeFileSync(join(cwd, "a.ts"), "1"),
    (cwd) => writeFileSync(join(cwd, "b.ts"), "1"),
    (cwd) => writeFileSync(join(cwd, "c.ts"), "1"), // wu3 touches only its declared c.ts
  ]);
  const profile = parseProfile({ slug: "demo", targetRepo: repo, components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }] });
  const registry = buildDispatchRegistry({ runner, agentConfig: DEFAULT_AGENT_CONFIG, profile, worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")) });

  await driveUntilCompleteness(db, ticketId, registry, wu3.id);
  const scope = listByUnit(db, wu3.id).find((s) => s.signal_type === "scope_diff");
  db.close();
  // If `over` used the CUMULATIVE diff it would wrongly be [a.ts, b.ts]; the own-diff makes it [].
  expect(JSON.parse(scope?.detail_json ?? "{}").out_of_scope).toEqual([]);
});

test("A3' honest limit: unrelated work on a sibling-covered declared file is NOT caught (documents §7)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["auth.ts"] });
  const wu2 = insertWorkUnit(db, { ticketId, seq: 2, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["auth.ts"], dependsOn: [1] });
  const runner = sequencedRunner([
    (cwd) => writeFileSync(join(cwd, "auth.ts"), "1"),   // wu1 touches auth.ts
    (cwd) => writeFileSync(join(cwd, "helpers.ts"), "1"), // wu2 does UNRELATED work; auth.ts sibling-covered
  ]);
  const profile = parseProfile({ slug: "demo", targetRepo: repo, components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }] });
  const registry = buildDispatchRegistry({ runner, agentConfig: DEFAULT_AGENT_CONFIG, profile, worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")) });

  await driveUntilCompleteness(db, ticketId, registry, wu2.id);
  db.close();
  // Documents the known limit (design §7): file-granularity + sibling coverage cannot see that
  // wu2's real auth.ts work was never done → under=∅, ownTouched≠∅ → completed-by-self → advances.
  // If this ever flips to "under-delivered", §7 must be revisited (it would mean the limit closed).
  expect(disposition(db, wu2.id)).toBe("completed-by-self");
});
```

Plus two edge tests in the same style: **min-seq base** — the A1 darkreader test already IS this guard (reverting the handler to `unit.base_sha` flips wu2 from `covered-by-sibling` to `under-delivered`, failing A1); add a comment on A1 saying so. **Reconcile exemption** — drive a single-unit ticket to `verified`, then `insertWorkUnit(db, { ticketId, seq: 2, kind: "reconcile", verifyCheckTypes: [], dependsOn: [1] })` (no `filesToTouch` ⇒ declared=∅), drive to its completeness signal, and assert `disposition` ∈ {`covered-by-sibling`, `completed-by-self`}, never `under-delivered`.

- [ ] **Step 3: Add the plan-gate (A6) test + confirm the re-dispatch wiring**

The `design:extract` handler already throws on any non-empty `validateExtraction(...)` result *before* its insert loop (`handlers.ts:221-224,230`), and that throw routes through `applyFailurePolicy`'s default `retry` (design:extract is `step_type:"dispatch"`, `work_unit_id:null` → no branch matches → `resetToPending` + retry), i.e. a re-dispatch — no new wiring needed. Add a test that runs `design:extract` (via the harness) on a fake-agent extraction whose units include one with `files_to_touch: []`, and asserts the step is **not** succeeded and `listByTicket(db, ticketId).length === 0` (no work units persisted → it re-dispatched), mirroring `design-extract.test.ts:142-181`.

- [ ] **Step 4: Run to verify all pass**

Run: `bun test test/dispatch/completeness-e2e.test.ts`
Expected: PASS for every scenario.

- [ ] **Step 5: Commit**

```bash
git add test/dispatch/completeness-e2e.test.ts src/
git commit -m "test(completeness): e2e — darkreader no-op, under-delivery loopback, base-ref regressions, plan gate"
```

---

## Task 8: Step catalog + Loopback Atlas docs

**Files:**
- Modify: `docs/architecture/control-loop.md` (the S-step catalog + §8 Loopback Atlas)
- Modify: `docs/architecture/minimal-loop.md` (the `next_step_key` state machine section)

- [ ] **Step 1: Add the step-catalog entry**

In `control-loop.md`, add a `completeness:wuN` entry near the verify steps (mirror the `provision` entry added earlier): a deterministic, runner-computed step between `implement:wuN` and `verify:wuN`; inputs = `files_to_touch` + the cumulative (min-seq base) and own diffs; outputs = a `completeness` signal + advisory `scope_diff`; guard = under-delivery hard-gates; recomputable (no exactly-once effect).

- [ ] **Step 2: Add the Loopback Atlas row**

In `control-loop.md` §8 and `minimal-loop.md`, add the under-delivery route: `completeness:wuN` under-delivered → loopback `implement:wuN` (feedback = missing declared files), bounded per-step at `maxAttempts`, escalate on no-progress/exhaustion. Note the plan-gate precondition (no vacuous units reach implement) and that the semantic AC-completeness layer is a deferred follow-up (S5).

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/control-loop.md docs/architecture/minimal-loop.md
git commit -m "docs(control-loop): completeness:wuN step catalog + loopback atlas"
```

---

## Self-review checklist (run before handing off)

- Full suite green: `bun test` (0 fail), `bun run typecheck` (0 errors), `bun run lint` (clean).
- Grep for leftover references to the removed pieces: `grep -rn "postcondition: empty diff\|empty diff" src/` and confirm `scope_diff` is emitted only by `completeness`, not `verify:check`.
- Confirm the two-base-ref invariant is exercised by the min-seq regression test (Task 7) and that reverting the completeness handler to use `unit.base_sha` for the cumulative set makes it fail.
- Confirm `implement` never sees a vacuous unit (Task 2 + Task 7 Step 2).
