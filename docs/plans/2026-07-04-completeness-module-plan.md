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

- [ ] **Step 4: Run test to verify it passes; fix collateral fixtures**

Run: `bun test test/dispatch/extract-schema.test.ts`
Then run the whole suite to find fixtures that now fail because they built a *valid* extraction with empty `files_to_touch`:

Run: `bun test 2>&1 | grep -i fail`
For each failing fixture that legitimately should be valid, give its units a non-empty `files_to_touch` (e.g. `["src/x.ts"]`). Do **not** weaken the new rule. Expected end state: 0 fail.

> Note: the direct-insert fixture at `test/dispatch/implement-allowlist.test.ts:110` bypasses `validateExtraction` (it inserts a `work_unit` row directly), so it does **not** fail here — it is handled in Task 7's runtime behavior. Update it only if Task 7 requires.

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

```ts
// add to test/daemon/resolver.test.ts — a unit in "verifying" with provision done but no
// completeness step yet must resolve to the completeness step BEFORE any verify check.
test("verifying unit routes to completeness after provision, before verify", () => {
  // Build a ticket in stage implement with one unit status=verifying, provision succeeded,
  // completeness:wu1 not yet done. (Use the same fixtures as the existing provision-gate test.)
  // Expect nextStepKey → step with stepKey "completeness:wu1", stepType "completeness".
  const d = /* existing helper that seeds ticket+unit(verifying)+provision succeeded */;
  const s = nextStepKey(d.db, d.ticketId);
  expect(s).toMatchObject({ kind: "step", stepKey: "completeness:wu1", stepType: "completeness" });
});
```

> Model this on the existing test that asserts the provision gate fires (search `test/daemon/resolver.test.ts` for `"provision"`), reusing its seed helper and adding a succeeded `provision` step.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/daemon/resolver.test.ts -t "completeness"`
Expected: FAIL — currently routes to `verify:wu1:...`.

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

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/daemon/resolver.test.ts`
Expected: PASS. Fix any sibling resolver test that now expects `verify:` immediately after provision — insert the completeness step in its expected sequence (do not weaken assertions).

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

```ts
// add to test/daemon/failure-policy.test.ts
test("completeness under-delivery loops the unit back to implement", () => {
  // seed a failed completeness step (step_type "completeness", work_unit_id set, attempt 1)
  const d = /* helper seeding ticket + unit + failed completeness step */;
  const res = applyFailurePolicy(d.db, d.ticketId, d.completenessStep);
  expect(res.decision).toBe("loopback");
  // unit is back to pending; a loopback event was recorded
  expect(getUnit(d.db, d.unitId)?.status).toBe("pending");
});

test("completeness exhausts to escalate at maxAttempts", () => {
  const d = /* same, but completeness step attempt = 3 */;
  const res = applyFailurePolicy(d.db, d.ticketId, d.completenessStepAt3);
  expect(res.decision).toBe("escalated");
});
```

> Model the seed on the existing `provision`/`verify` failure-policy tests in the same file.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/daemon/failure-policy.test.ts -t "completeness"`
Expected: FAIL — a `completeness` step currently falls through to the default `retry`.

- [ ] **Step 3: Add the branch**

In `src/daemon/failure-policy.ts`, immediately **before** the final two lines (`resetToPending(db, step.id); return { decision: "retry" };`):

```ts
  // Under-delivery (deterministic completeness) → bounce the unit back to coding to touch its
  // missing declared files. Same shape as the verify loopback; escalates on no-progress or when
  // this step's own attempt budget is exhausted (the top-of-function maxAttempts guard). NOTE:
  // completeness and verify carry independent per-step attempt counters (~maxAttempts each).
  if (step.step_type === "completeness" && step.work_unit_id !== null) {
    const workUnitId = step.work_unit_id;
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

- [ ] **Step 1: Write the scenarios (each an independent test)**

```ts
// test/dispatch/completeness-e2e.test.ts — sketch; wire to the existing harness helpers.
// A1 darkreader: wu1 touches parse.ts (the fix); wu2 declares parse.ts, produces empty diff.
//   completeness:wu2 ⇒ ownTouched=[], under=∅ (parse.ts in cumulative) ⇒ covered-by-sibling ⇒
//   handler returns (no throw); resolver advances wu2 to verify. ASSERT no under-delivered signal,
//   no loopback event.
//
// A2 skipped: single unit declares src/x.ts, produces empty diff (nobody touched x.ts).
//   completeness ⇒ under=[x.ts] ⇒ throws; applyFailurePolicy ⇒ loopback; after 3 attempts ⇒ escalate.
//
// A3 single-unit missed file: unit declares [a.ts,b.ts], touches only a.ts.
//   completeness ⇒ under=[b.ts] ⇒ under-delivered ⇒ loopback BEFORE any verify runs.
//
// Over-delivery own-base regression: 3-unit ticket; wu3 declares ui.ts and touches ui.ts; wu1/wu2
//   touched other files. completeness:wu3 ⇒ over MUST be [] (own diff = {ui.ts}), NOT the prior
//   units' files. ASSERT scope_diff signal for wu3 has out_of_scope=[].
//
// Min-seq base regression: 2-unit ticket where using wu2's OWN base for the cumulative set would
//   exclude wu1's change to the declared file. ASSERT wu2 is covered-by-sibling (uses min-seq base),
//   not under-delivered.
//
// Reconcile exemption: an appended reconcile unit (declared=∅) is not under-delivered.
//
// A6 plan gate: an extraction with a unit files_to_touch=[] ⇒ validateExtraction returns an error
//   ⇒ (assert the extract handler re-dispatches design:extract rather than inserting units — see
//   Step 2).
```

Implement each as a real test using the harness (seed profile with a matching component + a real git worktree so `changedFilesBetween` returns real files, exactly as `provision.test.ts` / `verify-routing.test.ts` do).

- [ ] **Step 2: Confirm the plan-gate re-dispatch wiring**

Read the `design:extract` handler in `src/dispatch/handlers.ts` and confirm a non-empty `validateExtraction(...)` result causes a re-dispatch (transport failure / no unit insertion), consistent with §3a. If it currently swallows errors, add a test + fix so a vacuous-unit extraction re-dispatches `design:extract` rather than persisting the bad plan.

- [ ] **Step 3: Run to verify all pass**

Run: `bun test test/dispatch/completeness-e2e.test.ts`
Expected: PASS for every scenario.

- [ ] **Step 4: Commit**

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
