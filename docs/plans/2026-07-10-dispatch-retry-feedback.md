# Dispatch Retry-Feedback Primitive — Bug B (general-class) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every agent-dispatch retry *informed* — when a dispatch step's prior attempt was rejected (postcondition/validation/sidecar throw), prepend that rejection into the retry prompt so the agent fixes the specific problem instead of blindly repeating it (the darkreader `design:extract` escalate, and the whole reject-then-blind-retry class).

**Architecture:** The rejection is already captured generically — any dispatch-handler throw is journaled to `workflow_step.error_json` by `markFailed`. Add a ~10-line prepend to `runAgentDispatch` (the shared flow) that reads `ctx.step.error_json` and prepends it, mirroring the existing `resumeContext` carryover; and clear `error_json` on `markSucceeded` (staleness). No per-step readers, no prompt slots, no schema/resolver/failure-policy change.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`. Tests are `bun test`. TDD throughout.

## Global Constraints

- **Prepend-all (operator-chosen).** No error taxonomy — prepend whatever the prior attempt threw. Gate/sidecar rejections are actionable; rare infra errors are harmless (agent-inert, escalate fast, no loop). (design §1/§3)
- **Compose both prepends off the SAME `prompt` variable.** The existing `resumeContext` carryover block rebuilds from `rendered.prompt`; it MUST be changed to chain off `prompt` (`${rendered.prompt}`→`${prompt}`), else it clobbers the retry-feedback prepend in a reachable fail→park→resume corner. (design §1, review Important)
- **`markSucceeded` clears `error_json`** — a success wipes the failure history so a later loopback re-run of the same `step_key` never prepends a pre-success rejection. Safe: the only `error_json` readers are `failureSignature` (just-failed steps) and the schema `json_valid` CHECK (NULL passes). (design §2.2/§3)
- **Never relax a gate / no false-pass.** The primitive only mutates the prompt string; `validateExtraction`, postconditions, sidecar validation all still run on every attempt. (design §3)
- **First attempt renders identically** — fresh `insertPending` has `error_json` null → no prepend. `rejectionFrom` fails safe to `""` on null/malformed. (design §3)
- **`design:extract` escalates on attempt-exhaustion, not "no-progress"** — step_type `"dispatch"` → default retry (`failure-policy.ts:257`) → `attempt>=3` escalate (`:70-86`). Feedback informs attempts 2 and 3. Do NOT assert a "no-progress" escalate. (design §0)
- Run `bun run lint` + `bun run format` + `bun run typecheck` (all exit 0) before every commit.

---

## File Structure

- **Modify** `src/db/repos/workflow-step.ts` — `markSucceeded` also sets `error_json = NULL` (Task 1).
- **Modify** `src/dispatch/run-dispatch.ts` — `RETRY_FEEDBACK_PREFIX`/`_SUFFIX` consts, `rejectionFrom` helper, the retry-feedback prepend, and the carryover-block chain fix (Task 2).
- **Tests:** `test/db/workflow-step-clear-error.test.ts` (T1), extend `test/dispatch/run-dispatch.test.ts` (T2), `test/dispatch/design-extract-retry-feedback.test.ts` (T3).

---

## Task 1: `markSucceeded` clears `error_json` (staleness fix)

**Files:**
- Modify: `src/db/repos/workflow-step.ts` (`markSucceeded`, ~line 109-118)
- Test: `test/db/workflow-step-clear-error.test.ts`

**Interfaces:**
- Consumes: existing `markFailed`, `markSucceeded`, `getById`.
- Produces: `markSucceeded` leaves `error_json` NULL.

- [ ] **Step 1: Write the failing test**

Create `test/db/workflow-step-clear-error.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  getById,
  insertPending,
  markFailed,
  markSucceeded,
} from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

test("markSucceeded clears a prior error_json (no stale carry after a success)", () => {
  const { db, ticketId } = makeTestDb();
  const step = insertPending(db, {
    ticketId,
    workUnitId: null,
    stepKey: "design:extract",
    stepType: "dispatch",
    input: null,
  });
  markFailed(db, step.id, new Error("design:extract completeness failed: unit seq 3 no files"));
  expect(getById(db, step.id)?.error_json).not.toBeNull();
  markSucceeded(db, step.id, { units: 2 });
  expect(getById(db, step.id)?.error_json).toBeNull(); // cleared
});
```

> Verify `insertPending`/`getById` param shapes in `src/db/repos/workflow-step.ts` before writing (they exist; `insertPending({ticketId, workUnitId, stepKey, stepType, input})`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/db/workflow-step-clear-error.test.ts`
Expected: FAIL — `error_json` is still non-null after `markSucceeded`.

- [ ] **Step 3: Implement**

In `src/db/repos/workflow-step.ts`, add `error_json = NULL` to the `markSucceeded` UPDATE:

```ts
export function markSucceeded(db: Database, id: number, result: unknown): void {
  const now = nowUtc();
  db.query(
    `UPDATE workflow_step
       SET status = 'succeeded', result_json = $r, error_json = NULL, pid = NULL, ended_at = $now, updated_at = $now
     WHERE id = $id`,
  ).run({ $r: JSON.stringify(result === undefined ? null : result), $now: now, $id: id });
}
```

(Only `error_json = NULL` is added; everything else is unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/db/workflow-step-clear-error.test.ts` then `bun test` (full suite — no reader depends on a succeeded row's error_json, so no regression).
Expected: PASS.

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/db/repos/workflow-step.ts test/db/workflow-step-clear-error.test.ts
git commit -m "fix(step-journal): markSucceeded clears error_json (no stale retry-feedback after success)"
```

---

## Task 2: retry-feedback prepend in `runAgentDispatch` (the primitive)

**Files:**
- Modify: `src/dispatch/run-dispatch.ts` (the consts near `CARRYOVER_*` ~line 51; the prompt block ~line 76-79)
- Test: extend `test/dispatch/run-dispatch.test.ts`

**Interfaces:**
- Consumes: `ctx.step.error_json` (already on `HandlerContext.step`).
- Produces: on a retry (`ctx.step.error_json` set), the agent's prompt is prefixed with the prior rejection; composes with the `resumeContext` carryover.

- [ ] **Step 1: Write the failing test**

Extend `test/dispatch/run-dispatch.test.ts` (it already has `ctxFor`/`depsFor` builders + a `FakeAgentRunner`; `FakeAgentRunner` records `inputs[]` with `.prompt`). Add:

```ts
// (uses the file's existing ctxFor/depsFor/tmpRepo/runner harness)

test("retry-feedback: a prior attempt's error_json is prepended to the retry prompt", async () => {
  const { db, ticketId } = makeTestDb();
  // Seed the step row with a prior failure (as markFailed would leave it after a retry reset).
  const ctx = ctxFor(db, ticketId); // builds ctx.step (a workflow_step row)
  markFailed(db, ctx.step.id, new Error("REJECTED: unit seq 3 declares no files_to_touch"));
  const fresh = getById(db, ctx.step.id);
  const ctx2 = { ...ctx, step: fresh }; // ctx.step now carries error_json
  const runner = /* a FakeAgentRunner returning {completed:true,...,stdout:"{}"} that records inputs */;
  const deps = depsFor(/* repo, wt */);
  await runAgentDispatch(ctx2, { ...deps, runner }, {
    handlerKey: "design:extract", template: "PLAN {{ident}}", vars: { ident: "ENG-1" },
    postcondition: () => {},
  });
  const promptSeen = runner.inputs[0].prompt;
  expect(promptSeen).toContain("REJECTED: unit seq 3 declares no files_to_touch");
  expect(promptSeen).toContain("previous attempt"); // RETRY_FEEDBACK_PREFIX
});

test("no retry-feedback on the first attempt (error_json null)", async () => {
  const { db, ticketId } = makeTestDb();
  const ctx = ctxFor(db, ticketId); // fresh step, error_json null
  const runner = /* recording FakeAgentRunner */;
  const deps = depsFor(/* ... */);
  await runAgentDispatch(ctx, { ...deps, runner }, {
    handlerKey: "design:extract", template: "PLAN {{ident}}", vars: { ident: "ENG-1" },
    postcondition: () => {},
  });
  expect(runner.inputs[0].prompt).not.toContain("previous attempt");
});
```

> NOTE: copy the exact `ctxFor`/`depsFor`/`FakeAgentRunner` construction from the existing tests in `test/dispatch/run-dispatch.test.ts` (they build the ctx.step row via `insertPending`, the deps with a temp git repo). Import `markFailed`/`getById` from `workflow-step.ts`. The two assertions are the contract: error_json set → prompt carries it + the prefix; null → no prefix.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: FAIL — the prompt has no retry-feedback prefix.

- [ ] **Step 3: Implement**

In `src/dispatch/run-dispatch.ts`, add the consts + helper near `CARRYOVER_SUFFIX` (~line 55):

```ts
const RETRY_FEEDBACK_PREFIX =
  "## Your previous attempt at this step was REJECTED\n\nFix exactly the problem described below " +
  "and produce a corrected result — do NOT repeat the output that caused it. (If a planned work " +
  "unit has no files to change, it is redundant: remove it. If your structured output was malformed, " +
  "emit valid output.)";
const RETRY_FEEDBACK_SUFFIX = "--- end of prior rejection (address it before anything else) ---";

/** The human-readable message of the prior attempt's rejection, from `workflow_step.error_json`
 *  (serializeError → {name, message}). "" when there was no prior failure / it can't be parsed —
 *  so the first attempt and any malformed record prepend nothing. General: any dispatch step's own
 *  thrown postcondition/validation/sidecar rejection is carried into its retry. */
function rejectionFrom(errorJson: string | null): string {
  if (!errorJson) return "";
  try {
    const msg = (JSON.parse(errorJson) as { message?: string }).message ?? "";
    return typeof msg === "string" ? msg.trim() : "";
  } catch {
    return "";
  }
}
```

Then replace the prompt/resumeContext block (~line 76-79) with (retry-feedback prepend added, and the carryover block chained off `prompt`):

```ts
  let prompt = rendered.prompt;
  // CL-RETRY: prepend the prior attempt's rejection so a retry is informed, not blind. error_json
  // is captured generically by markFailed for every dispatch throw and survives resetToPending.
  const priorRejection = rejectionFrom(ctx.step.error_json);
  if (priorRejection !== "") {
    prompt = `${RETRY_FEEDBACK_PREFIX}\n\n${priorRejection}\n\n${RETRY_FEEDBACK_SUFFIX}\n\n${prompt}`;
  }
  if (deps.resumeContext && deps.resumeContext.stepKey === ctx.step.step_key) {
    // chain off `prompt` (NOT rendered.prompt) so both prepends compose (design §1, review Important)
    prompt = `${CARRYOVER_PREFIX}\n\n${deps.resumeContext.transcript}\n\n${CARRYOVER_SUFFIX}\n\n${prompt}`;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/run-dispatch.test.ts` then `bun test` (full suite — existing dispatch tests have null error_json on first attempts → no prepend, no regression; the park/resume test still passes because the carryover now chains off `prompt` which equals `rendered.prompt` when there's no prior rejection).
Expected: PASS.

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/run-dispatch.ts test/dispatch/run-dispatch.test.ts
git commit -m "feat(loop): runAgentDispatch prepends the prior attempt's rejection (general retry-feedback, Bug B)"
```

---

## Task 3: e2e — informed retry recovers (darkreader) + a stuck agent still escalates + generality

**Files:**
- Test: `test/dispatch/design-extract-retry-feedback.test.ts`

**Interfaces:**
- Consumes: everything above, driven through the real resolver/tick loop.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/design-extract-retry-feedback.test.ts`. **Copy the harness from `test/dispatch/design-extract.test.ts`** (`readyForExtract(db, ticketId)` marks `design:dispatch` succeeded at `stage='design'` so the resolver routes to `design:extract`; an `advanceOneStep(db, ticketId, registry)` drive-loop; a `sidecar(json)` builder for `ExtractOutputSchema`; a prompt-branching `FakeAgentRunner((input) => …)`).

```ts
// Test A (the crux — reproduces & fixes darkreader, generically):
//   FakeAgentRunner for design:extract:
//     - if input.prompt contains "previous attempt" (RETRY_FEEDBACK_PREFIX) → emit a VALID extraction
//       (units seq 1..N, each files_to_touch non-empty).
//     - else → emit a VACUOUS extraction (last unit files_to_touch: []).
//   Drive advanceOneStep. ASSERT (tightened per review): the design:extract step succeeded
//   (work_unit rows exist / the step's status is 'succeeded'), NO 'escalated' event, and
//   runner.inputs[1].prompt contains the attempt-1 rejection text ("no files_to_touch"). This proves
//   the retry was informed by the generic primitive.
//
// Test B (a genuinely-stuck agent still escalates on exhaustion):
//   FakeAgentRunner emits the VACUOUS extraction on ALL attempts.
//   ASSERT: after DEFAULT_MAX_ATTEMPTS the ticket has an 'escalated' event with reason
//   "step 'design:extract' failed" (attempt-exhaustion) — do NOT assert a "no-progress" reason.
//
// Test C (generality spot-check — the primitive is not design:extract-specific):
//   A UNIT-level check: seed a workflow_step for a DIFFERENT dispatch step (e.g. "checks:dispatch")
//   with error_json set (markFailed), run runAgentDispatch for it, and assert its prompt also carries
//   the rejection. (Or fold this into Task 2's unit test with a second handlerKey — either location.)
```

- [ ] **Step 2: Run the test to verify it fails, then passes**

Run: `bun test test/dispatch/design-extract-retry-feedback.test.ts`
Expected: with Tasks 1-2 merged, Test A PASSES (the retry sees the rejection → valid plan → design:extract succeeds, no escalate) and Test B escalates on exhaustion. If Test A instead escalates (the rejection never reached the retry prompt), STOP and report BLOCKED — do not loosen the assertion.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: all green. Investigate any failure before proceeding.

- [ ] **Step 4: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add test/dispatch/design-extract-retry-feedback.test.ts
git commit -m "test(loop): design:extract informed retry recovers (Bug B); stuck agent escalates on exhaustion"
```

---

## Self-Review (completed by plan author)

**Spec coverage.** design §1 primitive → Task 2; §2.1 run-dispatch edit → T2; §2.2 markSucceeded clear → T1; §3 edge cases (first-attempt null, staleness, park/resume composition, no-false-pass) → T1/T2 tests + the carryover chain fix in T2; §4 tests → T1/T2/T3 (incl the generality spot-check and the exhaustion negative); the review Important (chain off `prompt`) → T2 Step 3; the review e2e minor (assert succeeded + no escalate, not "reaches implement") → T3 Test A.

**Placeholder scan.** T2/T3 test bodies name their copy sources (`run-dispatch.test.ts` for the ctx/deps/FakeAgentRunner; `design-extract.test.ts` for the drive-loop) and spell out every assertion; the leaf task (T1) carries complete code. The `/* recording FakeAgentRunner */` placeholders are explicitly "copy from the existing file" — flagged so the implementer reuses the real harness rather than inventing one.

**Type consistency.** `rejectionFrom(errorJson: string | null): string` (T2); `RETRY_FEEDBACK_PREFIX/SUFFIX` consts (T2); `markSucceeded(db, id, result)` unchanged signature, only the SQL gains `error_json = NULL` (T1); `ctx.step.error_json` is `string | null` per `WorkflowStepRow` (workflow-step.ts:16).

**Flagged verifications for the implementer:** (1) copy `ctxFor`/`depsFor`/the recording `FakeAgentRunner` from `test/dispatch/run-dispatch.test.ts` (T2) and `readyForExtract`+drive-loop from `test/dispatch/design-extract.test.ts` (T3); (2) confirm `insertPending`/`getById`/`markFailed` param shapes in `workflow-step.ts` before writing T1's seed; (3) after Task 2, confirm the existing park/resume test in `run-dispatch.test.ts` still passes (the carryover now chains off `prompt`, equal to `rendered.prompt` when there's no prior rejection).
