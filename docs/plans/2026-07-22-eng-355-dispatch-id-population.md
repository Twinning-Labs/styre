# Populate `event_log.dispatch_id` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `event_log.dispatch_id` with the causing dispatch for `loopback` and `escalated` events, so an NDJSON consumer can join those events to the dispatch that caused them.

**Architecture:** Widen `appendEvent` to accept and write a `dispatchId`. At each verdict/escalation entrypoint, re-derive the causing dispatch from the step being judged via the existing `latestDispatchForStep(db, ticketId, stepKey)` helper, then thread that value into the `appendEvent` calls (directly and through the `escalate`/`gateOriginLoopback`/`codeLoopback`/`redesignLoopback` helpers). No wire-shape change: the emitter already passes the column through, so populating the column is enough.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, `bun test`.

## Global Constraints

- **No `SCHEMA_VERSION` bump.** The `event.dispatch_id` wire field already exists (shipped by ENG-349); this change only supplies its value.
- **No emitter change.** `toEvent` (`src/telemetry/emitter.ts:47`) already maps `dispatch_id: r.dispatch_id`; do not touch it.
- **No schema change expected.** `event_log.dispatch_id TEXT` already exists in both `schema.sql` and `src/db/schema.sql` (byte-identical copies per CLAUDE.md — if either is ever touched, keep them identical).
- **`latestDispatchForStep` stays in `src/db/repos/review-finding.ts`** (already imported by daemon + dispatch code). Do not move it.
- **Events with no causing dispatch stay `null`:** `transition`, `note`, `resumed`, and `projector.escalateProjection`. Do not thread a dispatch into those.
- **Verdicts run inside `db.transaction(...)`.** Derive `dispatchId` with a plain read at the top of the entrypoint (before/around the transaction); reads of the `dispatch` table are unaffected by the verdict's writes.
- Test runner: `bun test <path>`. Full suite: `bun test`.

---

### Task 1: Widen `appendEvent` to write `dispatch_id`

**Files:**
- Modify: `src/db/repos/event-log.ts:52-86`
- Test: `test/db/row-widen.test.ts:19-26` (flip), `test/db/repos/event-log.test.ts` (add positive case)

**Interfaces:**
- Produces: `appendEvent(db, { ticketId, kind, ..., dispatchId?: string })` — new optional `dispatchId` field on the params object; when present, written to `event_log.dispatch_id`; when absent, the column is `NULL`.

- [ ] **Step 1: Update the failing test in `test/db/row-widen.test.ts`**

Replace the existing `"EventLogRow carries dispatch_id (null until populated)"` test (lines 19-26) with:

```ts
  test("appendEvent writes dispatch_id when given, null otherwise", () => {
    const { db, ticketId } = makeTestDb();
    appendEvent(db, { ticketId, kind: "note", reason: "no-dispatch" });
    appendEvent(db, { ticketId, kind: "loopback", dispatchId: "ENG-1-d0001" });
    const evs = listEvents(db, ticketId);
    expect(evs[0].dispatch_id).toBeNull();
    expect(evs[1].dispatch_id).toBe("ENG-1-d0001");
    db.close();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/db/row-widen.test.ts`
Expected: FAIL — second row's `dispatch_id` is `null` (writer ignores the field), so `expect(evs[1].dispatch_id).toBe("ENG-1-d0001")` fails.

- [ ] **Step 3: Add `dispatchId` to the params type**

In `src/db/repos/event-log.ts`, add `dispatchId?: string;` to the `appendEvent` params object (after `ticketId: number;`, line 55):

```ts
  e: {
    ticketId: number;
    dispatchId?: string;
    kind: EventKind;
    actor?: string;
```

- [ ] **Step 4: Add the column to the INSERT and bind it**

Change the INSERT statement (lines 69-71) to include `dispatch_id`:

```ts
      `INSERT INTO event_log
         (ticket_id, dispatch_id, seq, kind, actor, from_stage, to_stage, loop, route_to, signature, reason, payload_json, created_at)
       VALUES ($t, $did, $seq, $kind, $actor, $from, $to, $loop, $route, $sig, $reason, $payload, $now)`,
```

And add the bind in the `.run({...})` object (after `$t: e.ticketId,`, line 74):

```ts
      $t: e.ticketId,
      $did: e.dispatchId ?? null,
```

- [ ] **Step 5: Run the row-widen test to verify it passes**

Run: `bun test test/db/row-widen.test.ts`
Expected: PASS

- [ ] **Step 6: Add positive writer coverage in `test/db/repos/event-log.test.ts`**

Append this test (uses the file's existing `makeTestDb` import; add it if missing):

```ts
test("appendEvent round-trips dispatch_id", () => {
  const { db, ticketId } = makeTestDb();
  const row = appendEvent(db, { ticketId, kind: "escalated", dispatchId: "ENG-9-d0007" });
  expect(row.dispatch_id).toBe("ENG-9-d0007");
  db.close();
});
```

- [ ] **Step 7: Run the event-log test and verify it passes**

Run: `bun test test/db/repos/event-log.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/db/repos/event-log.ts test/db/row-widen.test.ts test/db/repos/event-log.test.ts
git commit -m "feat(eng-355): appendEvent writes event_log.dispatch_id"
```

---

### Task 2: Thread `dispatchId` through `review-verdict.ts`

**Files:**
- Modify: `src/daemon/review-verdict.ts:66-72` (`escalate`), `:74-123` (`codeLoopback`), `:125-175` (`redesignLoopback`), and their call sites (`:203, :206, :217, :226, :229, :238, :243`)
- Test: `test/daemon/review-verdict.test.ts`

**Interfaces:**
- Consumes: `appendEvent({ ..., dispatchId })` (Task 1); `latestDispatchForStep` (already imported at `:6`, already called at `:187`).

`applyReviewVerdict` already computes `const dispatchId = latestDispatchForStep(db, ticketId, opts.stepKey);` at line 187 (and returns `clean` when it is `null`). We only pass that local into the three helpers.

- [ ] **Step 1: Add an assertion to an existing loopback test**

In `test/daemon/review-verdict.test.ts`, in the `"blocking code finding → loopback to implement..."` test, `seedReviewRound` returns `{ unit, did }` with `did = "T-d0001"` (the dispatch owned by the `review` step). Add before `db.close()`:

```ts
  const loopback = events.find((e) => e.kind === "loopback");
  expect(loopback?.dispatch_id).toBe(did);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/review-verdict.test.ts -t "blocking code finding"`
Expected: FAIL — `loopback.dispatch_id` is `null` (helper doesn't thread it yet).

- [ ] **Step 3: Add a `dispatchId` param to the three helpers**

`escalate` (line 66):

```ts
function escalate(
  db: Database,
  ticketId: number,
  reason: string,
  signature: string,
  dispatchId: string | null,
): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, dispatchId: dispatchId ?? undefined, kind: "escalated", reason, signature });
  })();
}
```

`codeLoopback` (line 74) — add `dispatchId: string | null` as the last param, and set it on the `appendEvent` at line 109:

```ts
    appendEvent(db, {
      ticketId,
      dispatchId: dispatchId ?? undefined,
      kind: "loopback",
      loop: "implement",
      routeTo: "review",
      signature,
    });
```

`redesignLoopback` (line 125) — add `dispatchId: string | null` as the last param, and set it on the `appendEvent` at line 160:

```ts
    appendEvent(db, {
      ticketId,
      dispatchId: dispatchId ?? undefined,
      kind: "loopback",
      loop: "design",
      routeTo: "review",
      signature,
      payload: { findings },
    });
```

- [ ] **Step 4: Pass `dispatchId` at every call site in `applyReviewVerdict`**

Add `dispatchId` as the trailing argument at each call (the local is in scope from line 187):
- `escalate(db, ticketId, "no progress: identical plan-review findings", signature, dispatchId)` (`:203`)
- `redesignLoopback(db, ticketId, signature, blocking, dispatchId)` (`:206`)
- `escalate(db, ticketId, "no progress: identical review findings", signature, dispatchId)` (`:217`)
- `redesignLoopback(db, ticketId, signature, blocking, dispatchId)` (`:226`)
- `escalate(db, ticketId, "blocking plan-defect found in code review; operator policy is escalate", signature, dispatchId)` (`:229`)
- `codeLoopback(db, ticketId, blocking, signature, dispatchId)` (`:238`)
- `escalate(db, ticketId, "deferrable major finding requires a human deferral decision", findingsSignature(deferred), dispatchId)` (`:243`)

- [ ] **Step 5: Run the file's tests to verify they pass**

Run: `bun test test/daemon/review-verdict.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/review-verdict.ts test/daemon/review-verdict.test.ts
git commit -m "feat(eng-355): thread dispatch_id through review-verdict emits"
```

---

### Task 3: Thread `dispatchId` through `checks-verdict.ts`

**Files:**
- Modify: `src/daemon/checks-verdict.ts:74-124`
- Test: `test/daemon/checks-verdict.test.ts`

**Interfaces:**
- Consumes: `appendEvent({ ..., dispatchId })` (Task 1); `latestDispatchForStep`.

Two in-scope emits: `escalated` (`:100-105`) and `loopback` (`:114-121`). The entrypoint `applyChecksVerdict(db, ticketId, _opts)` currently ignores `_opts`; use its `stepKey`.

- [ ] **Step 1: Add a self-contained test**

`checks-verdict.test.ts` does **not** seed a dispatch today, so it must be added. Add these imports (they are not yet in the file):

```ts
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
```

Add this test (it reuses the existing loopback scenario — one flagged AC-check drives a `checks` loopback — and seeds a `checks:classify` dispatch so `latestDispatchForStep` resolves):

```ts
test("checks loopback carries the checks:classify dispatch_id", () => {
  const { db, ticketId } = makeTestDb();
  const cls = insertPending(db, { ticketId, stepKey: "checks:classify", stepType: "dispatch" });
  insertDispatch(db, { ticketId, dispatchId: "T-d0002", seq: 1, stepId: cls.id });
  insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: 1, selector: "s", testPath: "p" });
  const r = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  const loopback = listEvents(db, ticketId).find((e) => e.kind === "loopback");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(loopback?.dispatch_id).toBe("T-d0002");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/checks-verdict.test.ts`
Expected: FAIL — `dispatch_id` is `null`.

- [ ] **Step 3: Import the helper and derive the dispatch id**

Add the import (top of `src/daemon/checks-verdict.ts`, alongside the other repo imports):

```ts
import { latestDispatchForStep } from "../db/repos/review-finding.ts";
```

Rename `_opts` to `opts` in the signature (line 77) and derive the id at the top of `applyChecksVerdict` (before `db.transaction`):

```ts
export function applyChecksVerdict(
  db: Database,
  ticketId: number,
  opts: { stepKey: string },
): ChecksVerdictResult {
  const dispatchId = latestDispatchForStep(db, ticketId, opts.stepKey) ?? undefined;
  const flagged = reauthorFindings(db, ticketId);
```

- [ ] **Step 4: Set `dispatchId` on both emits**

Escalated (line 100):

```ts
      appendEvent(db, {
        ticketId,
        dispatchId,
        kind: "escalated",
        reason: "no progress: repeated re-author of the same AC-check",
        signature: `checks:${exhausted.join(",")}`,
      });
```

Loopback (line 114):

```ts
    appendEvent(db, {
      ticketId,
      dispatchId,
      kind: "loopback",
      loop: "checks",
      routeTo: "checks:classify",
      signature: `checks:${flagged.join(",")}`,
      payload: { acIds: flagged, findings },
    });
```

- [ ] **Step 5: Run the file's tests to verify they pass**

Run: `bun test test/daemon/checks-verdict.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/checks-verdict.ts test/daemon/checks-verdict.test.ts
git commit -m "feat(eng-355): thread dispatch_id through checks-verdict emits"
```

---

### Task 4: Thread `dispatchId` through `checks-gate-verdict.ts` (shared helpers) + the `advance.ts` escalate site

**Files:**
- Modify: `src/daemon/checks-gate-verdict.ts:34-50` (`escalate`), `:54-78` (`gateOriginLoopback`), `:103-133` (`applyAcCheckGateVerdict`); `src/daemon/advance.ts:94`
- Test: `test/daemon/checks-gate-verdict.test.ts`

**Interfaces:**
- Produces: `escalate(db, ticketId, reason, signature?, dispatchId?)` and `gateOriginLoopback(db, ticketId, routeTo, payload, dispatchId?)` — both gain a **trailing optional** `dispatchId?: string | null` so the arbiter's existing calls (updated in Task 5) still compile in the interim.
- Consumes: `appendEvent({ ..., dispatchId })` (Task 1); `latestDispatchForStep`.

- [ ] **Step 1: Add a self-contained test**

`checks-gate-verdict.test.ts` seeds a `verify:checks-gate` step (via `seedUnitAndGateStep`) but **no dispatch**. Add the dispatch import:

```ts
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
```

Add this test (modeled on the existing `"integrity-only still-red loopbacks under the cap"` test, which drives `gateOriginLoopback`). It seeds a dispatch owned by the gate step so `latestDispatchForStep("verify:checks-gate")` resolves:

```ts
test("gate loopback carries the verify:checks-gate dispatch_id", () => {
  const { db, ticketId } = makeTestDb();
  const { gateStep } = seedUnitAndGateStep(db, ticketId, GATE_ROUND_CAP - 1);
  insertDispatch(db, { ticketId, dispatchId: "T-d0003", seq: 1, stepId: gateStep.id });
  gateSignal(db, ticketId, { stillRed: [7], tampered: [7], sha: "S1" });
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const loopback = listEvents(db, ticketId).find((e) => e.kind === "loopback");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(loopback?.dispatch_id).toBe("T-d0003");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/checks-gate-verdict.test.ts`
Expected: FAIL — `dispatch_id` is `null`.

- [ ] **Step 3: Add the optional param to `escalate` and `gateOriginLoopback`**

`escalate` (line 34):

```ts
export function escalate(
  db: Database,
  ticketId: number,
  reason: string,
  signature = `gate-cap:${GATE_ROUND_CAP}`,
  dispatchId?: string | null,
): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, dispatchId: dispatchId ?? undefined, kind: "escalated", reason, signature });
  })();
}
```

`gateOriginLoopback` (line 54) — add `dispatchId?: string | null` as the last param and set it on the `appendEvent` at line 69:

```ts
    appendEvent(db, {
      ticketId,
      dispatchId: dispatchId ?? undefined,
      kind: "loopback",
      loop: "implement",
      routeTo,
      signature: `gate:${routeTo}`,
      payload,
    });
```

- [ ] **Step 4: Derive and pass `dispatchId` inside `applyAcCheckGateVerdict`**

Add the import if not present:

```ts
import { latestDispatchForStep } from "../db/repos/review-finding.ts";
```

Rename `_opts`→`opts` (line 106), derive at the top of the function, and pass to the three helper calls (`:113`, `:124`, `:131`):

```ts
export function applyAcCheckGateVerdict(
  db: Database,
  ticketId: number,
  opts: { stepKey: string },
): GateVerdictResult {
  const dispatchId = latestDispatchForStep(db, ticketId, opts.stepKey);
  const { stillRed, sha } = latestGate(db, ticketId);
  // ...
  //   escalate(db, ticketId, `gate: ... arbitrated rounds`, undefined, dispatchId);   // :113
  //   escalate(db, ticketId, `gate: ... tampered ...`,       undefined, dispatchId);   // :124
  //   gateOriginLoopback(db, ticketId, "verify:checks-gate", { tampered: stillRed }, dispatchId); // :131
```

(Pass `undefined` for `signature` at the two `escalate` calls so the default `gate-cap:` signature is preserved, then `dispatchId` as the final arg.)

- [ ] **Step 5: Update the resolver escalate site in `advance.ts:94`**

Derive the causing dispatch for the stuck-head escalate (its `stepKey` is `verify:checks-gate`). Ensure `advance.ts` imports `latestDispatchForStep` from `../db/repos/review-finding.ts`, then:

```ts
    if (d.kind === "escalate") {
      const stuckDispatchId = latestDispatchForStep(db, ticketId, "verify:checks-gate");
      escalate(db, ticketId, d.reason, "gate-stuck-head", stuckDispatchId);
      return { kind: "escalated", stepKey: "verify:checks-gate" };
    }
```

- [ ] **Step 6: Run the gate tests + a typecheck to verify they pass**

Run: `bun test test/daemon/checks-gate-verdict.test.ts`
Expected: PASS

Run: `bunx tsc --noEmit` (or the repo's typecheck script)
Expected: no errors (arbiter's un-updated `gateOriginLoopback` calls still compile because the new param is optional).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/checks-gate-verdict.ts src/daemon/advance.ts test/daemon/checks-gate-verdict.test.ts
git commit -m "feat(eng-355): thread dispatch_id through gate escalate/loopback helpers"
```

---

### Task 5: Thread `dispatchId` through `arbiter-verdict.ts`

**Files:**
- Modify: `src/daemon/arbiter-verdict.ts:40-104` (`applyArbiterVerdict`), `:134-207` (`applyReauthorVerdict`)
- Test: `test/daemon/arbiter-verdict.test.ts`

**Interfaces:**
- Consumes: `appendEvent({ ..., dispatchId })` (Task 1); `gateOriginLoopback(..., dispatchId?)` (Task 4); `latestDispatchForStep`.

In-scope emits: inline `escalated` (`:57`), inline `loopback` (`:87`), `gateOriginLoopback` (`:100`); inline `escalated` (`:157`), inline `loopback` (`:196`), `gateOriginLoopback` (`:175`). Both entrypoints take `_opts: { stepKey }`.

- [ ] **Step 1: Add a self-contained test**

Note: the file's existing `seedLatestDispatchSha` helper inserts a dispatch **with no `step_id`**, so `latestDispatchForStep("checks:arbitrate")` will not resolve to it — a dispatch owned by the arbitrate step must be seeded. `insertDispatch`, `insertPending`, `insertWorkUnit`, `insertSignal`, and `listEvents` are already imported in this file. Add this test (modeled on the existing `"code-wrong under the cap loops implement"` test, which drives a `gateOriginLoopback`):

```ts
test("arbiter loopback carries the checks:arbitrate dispatch_id", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, 1); // attempt=1 < CAP=3
  seedLatestDispatchSha(db, ticketId, "S1");
  const arb = insertPending(db, { ticketId, stepKey: "checks:arbitrate", stepType: "dispatch" });
  insertDispatch(db, { ticketId, dispatchId: "T-d0004", seq: nextSeq(db, ticketId), stepId: arb.id });
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verified" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "code-wrong", reason: "r" },
  });
  const v = applyArbiterVerdict(db, ticketId, { stepKey: "checks:arbitrate" });
  const loopback = listEvents(db, ticketId).find((e) => e.kind === "loopback");
  db.close();
  expect(v.decision).toBe("loopback");
  expect(loopback?.dispatch_id).toBe("T-d0004");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/arbiter-verdict.test.ts`
Expected: FAIL — `dispatch_id` is `null`.

- [ ] **Step 3: Import the helper and derive in both entrypoints**

Add the import:

```ts
import { latestDispatchForStep } from "../db/repos/review-finding.ts";
```

Rename `_opts`→`opts` in both `applyArbiterVerdict` (`:43`) and `applyReauthorVerdict` (`:137`), and add at the top of each:

```ts
  const dispatchId = latestDispatchForStep(db, ticketId, opts.stepKey);
```

- [ ] **Step 4: Set `dispatchId` on the inline emits and pass to `gateOriginLoopback`**

`applyArbiterVerdict`:
- inline `escalated` (`:57`): add `dispatchId: dispatchId ?? undefined,` to the `appendEvent` object.
- inline `loopback` (`:87`): add `dispatchId: dispatchId ?? undefined,`.
- `gateOriginLoopback(db, ticketId, "checks:arbitrate", { blame: ... }, dispatchId)` (`:100`).

`applyReauthorVerdict`:
- inline `escalated` (`:157`): add `dispatchId: dispatchId ?? undefined,`.
- `gateOriginLoopback(db, ticketId, "checks:reauthor", { codeWrong, rejected }, dispatchId)` (`:175`).
- inline `loopback` (`:196`): add `dispatchId: dispatchId ?? undefined,`.

Example for the inline `escalated` at `:57`:

```ts
      appendEvent(db, {
        ticketId,
        dispatchId: dispatchId ?? undefined,
        kind: "escalated",
        reason: "gate-round cap",
        signature: `gate-cap:${GATE_ROUND_CAP}`,
      });
```

- [ ] **Step 5: Run the file's tests to verify they pass**

Run: `bun test test/daemon/arbiter-verdict.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/arbiter-verdict.ts test/daemon/arbiter-verdict.test.ts
git commit -m "feat(eng-355): thread dispatch_id through arbiter-verdict emits"
```

---

### Task 6: Thread `dispatchId` through `failure-policy.ts`

**Files:**
- Modify: `src/daemon/failure-policy.ts:62-259`
- Test: `test/daemon/failure-policy.test.ts`

**Interfaces:**
- Consumes: `appendEvent({ ..., dispatchId })` (Task 1); `latestDispatchForStep`.

In-scope emits (all inside `applyFailurePolicy`, which holds the failed `step`): `escalated` at `:78, :99, :121, :155, :237`; `loopback` at `:167, :205, :246`. Derive once from `step.step_key`. **Note:** where the failed step is not itself an agent dispatch (some `verify`/`completeness` steps run in-process), `latestDispatchForStep` returns `null` and `dispatch_id` correctly stays `null` — assert actual behavior, don't force non-null.

- [ ] **Step 1: Add a self-contained test**

`failure-policy.test.ts` does **not** seed a dispatch today. Add the dispatch import if missing:

```ts
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
```

Add this test (it uses the file's existing `failedStep` helper — a `design:dispatch` step failed 3× with `maxAttempts: 3` escalates at the top-of-function budget guard — and seeds a dispatch owned by that step):

```ts
test("escalated event carries the failed step's dispatch_id", () => {
  const { db, ticketId } = makeTestDb();
  const step = failedStep(db, ticketId, {
    stepKey: "design:dispatch",
    stepType: "dispatch",
    attempts: 3,
  });
  insertDispatch(db, { ticketId, dispatchId: "T-d0001", seq: 1, stepId: step.id });
  const r = applyFailurePolicy(db, ticketId, step, { maxAttempts: 3 });
  const esc = listEvents(db, ticketId).find((e) => e.kind === "escalated");
  db.close();
  expect(r.decision).toBe("escalated");
  expect(esc?.dispatch_id).toBe("T-d0001");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/failure-policy.test.ts`
Expected: FAIL — `dispatch_id` is `null`.

- [ ] **Step 3: Import the helper and derive at the top of `applyFailurePolicy`**

Add the import:

```ts
import { latestDispatchForStep } from "../db/repos/review-finding.ts";
```

Add after `const maxAttempts = ...` (line 68):

```ts
  const dispatchId = latestDispatchForStep(db, ticketId, step.step_key) ?? undefined;
```

- [ ] **Step 4: Set `dispatchId` on all eight emits**

Add `dispatchId,` to each `appendEvent({ ticketId, ... })` object at lines `:78, :99, :121, :155, :167, :205, :237, :246`. Example for `:167`:

```ts
      appendEvent(db, {
        ticketId,
        dispatchId,
        kind: "loopback",
        loop: "implement",
        routeTo: step.step_key,
        signature,
      });
```

- [ ] **Step 5: Run the file's tests to verify they pass**

Run: `bun test test/daemon/failure-policy.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/failure-policy.ts test/daemon/failure-policy.test.ts
git commit -m "feat(eng-355): thread dispatch_id through failure-policy emits"
```

---

### Task 7: Update the wire spec + full-suite verification

**Files:**
- Modify: `docs/architecture/telemetry-export.md:83` (§3.1 field row), `:238-246` (§5)
- Test: none new; run the full suite.

- [ ] **Step 1: Rewrite the §3.1 field-table row (line 83)**

Replace:

```
| `dispatch_id` | string \| null | **yes — reserved** | `event_log.dispatch_id`; see §5, currently always `null` |
```

with:

```
| `dispatch_id` | string \| null | yes | `event_log.dispatch_id` — the dispatch that caused this event; populated for `loopback`/`escalated`, `null` for `transition`/`resumed`/`note` and projection-transport escalations (§5) |
```

- [ ] **Step 2: Rewrite §5 (lines 238-246)**

Replace the section body with a "populated" description:

```markdown
## 5. `dispatch_id` on `event` rows

`event.dispatch_id` (§3.1) carries the dispatch that caused the event. It is **populated for
`loopback` and `escalated` events** — the verdict/escalation is derived from the dispatch being
judged, and that dispatch's id is written to `event_log.dispatch_id` at emit time — so a consumer
can join a loopback/escalation back to its causing dispatch.

It is `null` for events with no causing dispatch: `transition` (stage advance), `resumed` (operator
resume), `note` (housekeeping), and the projection-transport escalation raised during outbox drain.

This field shipped in the `SCHEMA_VERSION 1→2` bump (originally reserved/always-null); populating it
was a non-breaking change and required no further version bump.
```

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS (all existing + new tests green — final acceptance criterion).

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/telemetry-export.md
git commit -m "docs(eng-355): event.dispatch_id is now populated for loopback/escalated"
```

---

## Acceptance criteria mapping

- `event_log.dispatch_id` populated for `loopback`/`escalated` → Tasks 2–6.
- Events with no causing dispatch remain `null` → Global Constraints + Task 6 note (projector/transition/resumed/note untouched).
- `event.dispatch_id` on the v2 wire carries the value, no `SCHEMA_VERSION` bump → Task 1 (writer) + unchanged emitter; Global Constraints.
- `docs/architecture/telemetry-export.md` updated → Task 7.
- Existing suite green → Task 7 Step 3.
