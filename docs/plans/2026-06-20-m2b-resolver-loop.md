# M2b — Resolver Execution Loop + Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the resolver run — interpret M2a's `StepDescriptor`s in `advance_one_step`, add a failure-policy/atlas *shape* (retry/loopback/escalate), an event-loop `tick()`, and prove it all with a walking-skeleton e2e that drives one fast-track ticket `design → released` (mocked handlers) plus a crash-resume test.

**Architecture:** `advance_one_step(db, ticketId, registry)` calls M2a's pure `nextStepKey`, then *interprets* the descriptor: `advance`→`setTicketStage`+`event_log` transition; `mark-verified`→`work_unit.setStatus`; `step`→run via M1's `runStep` with the registry's handler; `wait`→`awaitSignal` (park); `done`→`ticket.status='done'`; `blocked`→hand to failure-policy. Pure transitions collapse within one call until a real step runs or the ticket parks/finishes. A failed step routes through `applyFailurePolicy` (bounded retry → loopback for verify → escalate). `tick()` selects `v_ready_tickets` and advances up to K=2. The skeleton uses **mock handlers** (no real dispatch/verify/projector — those are M3/M4/M6); crash-resume reuses M1's `recover()`. This is **M2b** (the second half of the M2 split; M2a delivered the data layer + pure state machine).

**Tech Stack:** Bun, `bun:sqlite`, `bun test`, Biome. No new dependencies.

## Global Constraints

- **Runtime is Bun**; SQLite via built-in `bun:sqlite`; `bun test`. No new deps (YAGNI).
- **Single-writer SoT (B2 / CL-INV-7):** all mutation goes through the daemon code here (the repos). Mock handlers in tests run *inside* `runStep`'s `execute` and write via repos — that is the daemon persisting a worker's result, which is the model. No worker writes the DB outside `execute`.
- **The resolver stays pure (M2a):** `nextStepKey` is read-only; **all mutation lives in `advance_one_step` / `applyFailurePolicy`** here. Do not add writes to `resolver.ts`.
- **Per-ticket serialization (the M2a-documented invariant):** the loop advances one step per ticket per tick; K-concurrency is across **tickets**. No two workers share a `step_key`. The `StepInFlightError` guard + `recover()` cover crash-resume.
- **Exactly-once + replay (M1):** run steps via `runStep` (succeeded → recorded result, never re-run; effectful → write-ahead `running`). Steps dispatched by `advance_one_step` are **effectful** (they represent work) → pass `effectful: true`.
- **Loop-not-halt (P1):** a failed step never dead-halts — it retries (bounded), loops back, or escalates to a resumable `waiting` + `human_resume` signal. `blocked` escalates.
- **Timestamps stored UTC (DS-1)** via `nowUtc()` (already used by the repos); never local time.
- **Conventions (match M0/M1/M2a exactly):** `.ts` import extensions; `verbatimModuleSyntax` → type-only imports use `import type`; import repo/engine modules by named or namespace import consistent with M2a (reference repo row types via `import type`); Biome import grouping external → `node:` → relative, alphabetical (run `bun run lint`, apply organizeImports); Biome `noNonNullAssertion` (use `if (!x) throw` or a narrowed local, not `!`); double quotes; semicolons; 2-space/100-col; `noUnusedLocals`/`noUnusedParameters`.
- **Before committing each task:** `bun test && bun run lint && bun run typecheck` all clean (full suite — M0 + M1 + M2a + prior M2b tasks must stay green).
- **Dev workflow:** branch-only (`feat/m2b-resolver-loop`); no commits to `main`; Conventional Commits; no auto-merge. TDD throughout; files small + single-responsibility.

### Interfaces you build on (delivered in M0/M1/M2a — exact signatures)

- `runStep(db, { ticketId, workUnitId?, stepKey, stepType, input?, effectful?, idempotencyKey?, execute }): Promise<{ step, result, replayed }>` (`src/engine/step-journal.ts`); `class StepInFlightError`.
- `nextStepKey(db, ticketId): StepDescriptor` (`src/daemon/resolver.ts`), where `StepDescriptor` is the union: `{kind:"step", stepKey, stepType, handlerKey, workUnitId}` | `{kind:"advance", from, to}` | `{kind:"mark-verified", workUnitId}` | `{kind:"wait", signalType}` | `{kind:"blocked", reason}` | `{kind:"done"}`.
- `class StepRegistry { register(handlerKey, handler); resolve(handlerKey): StepHandler | undefined; has(handlerKey) }`; `type StepHandler = (ctx: HandlerContext) => unknown | Promise<unknown>`; `interface HandlerContext { db, ticket, step, workUnitId }` (`src/daemon/step-registry.ts`).
- `awaitSignal(db, { ticketId, signalType, reason?, idempotencyKey? }): SignalRow`; `deliverSignal(db, signalId, payload?): SignalRow`; `consumeSignal(db, signalId): SignalRow` (`src/engine/signals.ts`).
- `recover(db, deps: { isAlive, kill }): { reset, killed }` (`src/daemon/recover.ts`).
- Repos: `ticket` (`getTicket`, `setTicketStage`, `setTicketStatus`, `setTicketTrack`); `work-unit` (`insertWorkUnit`, `setStatus`, `listByTicket`); `workflow-step` (`getByKey`, `getById`, `resetToPending`, `markRunning`, `insertPending`, `listByStatus`); `event-log` (`appendEvent`); `signal` (`insertPending`, `listPending`, `markDelivered`, `hasDelivered`); `ground-truth-signal` (`insertSignal`). `makeTestDb()` (`test/helpers/db.ts`).

---

### Task 1: failure-policy + budgets (the atlas *shape*)

**Files:**
- Create: `src/daemon/failure-policy.ts`
- Test: `test/daemon/failure-policy.test.ts`

**Interfaces:**
- Consumes: `appendEvent` (event-log); `insertPending` (signal, aliased `insertSignal`); `setTicketStatus` (ticket); `setStatus` (work-unit, aliased `setUnitStatus`); `resetToPending` + `WorkflowStepRow` (workflow-step).
- Produces: `type FailureDecision = "retry" | "loopback" | "escalated"`; `interface FailurePolicyResult { decision: FailureDecision }`; `applyFailurePolicy(db, ticketId: number, step: WorkflowStepRow, opts?: { maxAttempts?: number }): FailurePolicyResult`.

Behavior (minimal-loop §2 / control-loop §8 *shape*, not the full atlas):
- `step.attempt >= maxAttempts` (default 3) → **escalate**: in one tx set `ticket.status='waiting'`, insert a pending `human_resume` signal (with a reason), append an `escalated` event. Return `{decision:"escalated"}`.
- else if the step is a verify step on a unit (`step_type==='verify'` and `work_unit_id !== null`) → **loopback**: in one tx reset the unit to `pending` (re-implement) and reset the step to `pending`, append a `loopback` event (`loop:"implement"`). Return `{decision:"loopback"}`.
- else → **retry**: reset the step to `pending` (no loopback event — minimal-loop §2: a retry is not a loopback). Return `{decision:"retry"}`.

- [ ] **Step 1: Write the failing test** — `test/daemon/failure-policy.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../helpers/db.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, getById as getUnit } from "../../src/db/repos/work-unit.ts";
import { getById as getStep, insertPending, markFailed, markRunning } from "../../src/db/repos/workflow-step.ts";
import { applyFailurePolicy } from "../../src/daemon/failure-policy.ts";

// Build a failed step with a given attempt count (markRunning bumps attempt each call).
function failedStep(db: Parameters<typeof insertPending>[0], ticketId: number, opts: { stepKey: string; stepType: string; workUnitId?: number; attempts: number }) {
  const step = insertPending(db, { ticketId, workUnitId: opts.workUnitId ?? null, stepKey: opts.stepKey, stepType: opts.stepType });
  for (let i = 0; i < opts.attempts; i++) {
    markRunning(db, step.id, { pid: 1 });
  }
  markFailed(db, step.id, new Error("boom"));
  return getStep(db, step.id);
}

test("under budget, a non-verify step is retried (reset to pending, no loopback event)", () => {
  const { db, ticketId } = makeTestDb();
  const step = failedStep(db, ticketId, { stepKey: "design:dispatch", stepType: "dispatch", attempts: 1 });
  const result = applyFailurePolicy(db, ticketId, step);
  const after = getStep(db, step.id);
  const events = listEvents(db, ticketId);
  db.close();
  expect(result.decision).toBe("retry");
  expect(after?.status).toBe("pending");
  expect(events.filter((e) => e.kind === "loopback").length).toBe(0);
});

test("under budget, a verify step on a unit loops back (unit + step reset to pending, loopback event)", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verifying" });
  const step = failedStep(db, ticketId, { stepKey: "verify:wu1:test", stepType: "verify", workUnitId: unit.id, attempts: 1 });
  const result = applyFailurePolicy(db, ticketId, step);
  const afterUnit = getUnit(db, unit.id);
  const afterStep = getStep(db, step.id);
  const loopbacks = listEvents(db, ticketId).filter((e) => e.kind === "loopback");
  db.close();
  expect(result.decision).toBe("loopback");
  expect(afterUnit?.status).toBe("pending");
  expect(afterStep?.status).toBe("pending");
  expect(loopbacks.length).toBe(1);
  expect(loopbacks[0]?.loop).toBe("implement");
});

test("at the attempt ceiling, the ticket escalates (waiting + human_resume signal + escalated event)", () => {
  const { db, ticketId } = makeTestDb();
  const step = failedStep(db, ticketId, { stepKey: "design:dispatch", stepType: "dispatch", attempts: 3 });
  const result = applyFailurePolicy(db, ticketId, step, { maxAttempts: 3 });
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  const escalations = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  db.close();
  expect(result.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
  expect(escalations.length).toBe(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/failure-policy.test.ts`
Expected: FAIL — `Cannot find module '../../src/daemon/failure-policy.ts'`.

- [ ] **Step 3: Create `src/daemon/failure-policy.ts`**

```ts
import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { resetToPending } from "../db/repos/workflow-step.ts";
import type { WorkflowStepRow } from "../db/repos/workflow-step.ts";

export type FailureDecision = "retry" | "loopback" | "escalated";

export interface FailurePolicyResult {
  decision: FailureDecision;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function failureSignature(step: WorkflowStepRow): string {
  const message = step.error_json === null ? "" : (JSON.parse(step.error_json).message ?? "");
  return `${step.step_key}:${message}`;
}

/** Failure-policy SHAPE (minimal-loop §2 / control-loop §8): bounded retry → loopback
 *  for verify failures → escalate to a resumable wait. The full atlas (signature-based
 *  distinct counting, B2/B3 budgets, the per-route table) is a later milestone. */
export function applyFailurePolicy(
  db: Database,
  ticketId: number,
  step: WorkflowStepRow,
  opts?: { maxAttempts?: number },
): FailurePolicyResult {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (step.attempt >= maxAttempts) {
    db.transaction(() => {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, {
        ticketId,
        signalType: "human_resume",
        reason: `step '${step.step_key}' exhausted after ${step.attempt} attempts`,
      });
      appendEvent(db, {
        ticketId,
        kind: "escalated",
        reason: `step '${step.step_key}' failed`,
        signature: failureSignature(step),
      });
    })();
    return { decision: "escalated" };
  }

  if (step.step_type === "verify" && step.work_unit_id !== null) {
    const workUnitId = step.work_unit_id;
    db.transaction(() => {
      setUnitStatus(db, workUnitId, "pending");
      resetToPending(db, step.id);
      appendEvent(db, {
        ticketId,
        kind: "loopback",
        loop: "implement",
        routeTo: step.step_key,
        signature: failureSignature(step),
      });
    })();
    return { decision: "loopback" };
  }

  resetToPending(db, step.id);
  return { decision: "retry" };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/daemon/failure-policy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/failure-policy.ts test/daemon/failure-policy.test.ts
git commit -m "feat(m2b): failure-policy shape (bounded retry / verify loopback / escalate)"
```

---

### Task 2: `advance_one_step` — the descriptor interpreter

**Files:**
- Create: `src/daemon/advance.ts`
- Test: `test/daemon/advance.test.ts`

**Interfaces:**
- Consumes: `nextStepKey` + `StepDescriptor` (resolver); `runStep` (step-journal); `StepRegistry` (step-registry); `awaitSignal` (signals); `applyFailurePolicy` (Task 1); `appendEvent` (event-log); `getTicket`/`setTicketStage`/`setTicketStatus` (ticket); `setStatus` as `setUnitStatus` (work-unit); `getByKey` (workflow-step).
- Produces: `type AdvanceOutcome = { kind: "stepped"; stepKey: string } | { kind: "waiting"; signalType: string } | { kind: "done" } | { kind: "blocked"; reason: string } | { kind: "retry"; stepKey: string } | { kind: "loopback"; stepKey: string } | { kind: "escalated"; stepKey: string }`; `advanceOneStep(db, ticketId: number, registry: StepRegistry): Promise<AdvanceOutcome>`.

Behavior: loop — resolve the descriptor; collapse pure transitions (`advance` → `setTicketStage` + transition event, in one tx; `mark-verified` → `setUnitStatus(verified)`) and continue; on a `step` run it via `runStep` (effectful) with the registered handler and return `stepped` (or, on failure, the failure-policy decision); on `wait` park via `awaitSignal` and return `waiting`; on `done` set `ticket.status='done'` and return `done`; on `blocked` return `blocked`. A bound (`MAX_TRANSITIONS`) guards against a non-progressing loop.

- [ ] **Step 1: Write the failing test** — `test/daemon/advance.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../helpers/db.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { getTicket, setTicketStage, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";

test("a step descriptor runs the registered handler and journals success", async () => {
  const { db, ticketId } = makeTestDb();
  const registry = new StepRegistry();
  let ran = false;
  registry.register("design:dispatch", () => {
    ran = true;
    return { plan: "ok" };
  });
  const outcome = await advanceOneStep(db, ticketId, registry);
  const step = getByKey(db, ticketId, "design:dispatch");
  db.close();
  expect(ran).toBe(true);
  expect(outcome).toEqual({ kind: "stepped", stepKey: "design:dispatch" });
  expect(step?.status).toBe("succeeded");
});

test("advance + mark-verified transitions collapse, then the next real step runs", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verifying" });
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "pass" });
  // resolver: unit verifying, all checks have signals → mark-verified (collapses), then
  // allUnitsVerified → verify:integration step runs.
  const registry = new StepRegistry();
  registry.register("verify:integration", () => ({ ok: true }));
  const outcome = await advanceOneStep(db, ticketId, registry);
  const afterUnit = getUnit(db, unit.id);
  db.close();
  expect(afterUnit?.status).toBe("verified"); // mark-verified was applied inline
  expect(outcome).toEqual({ kind: "stepped", stepKey: "verify:integration" });
});

test("an advance descriptor sets the stage and writes a transition event", async () => {
  const { db, ticketId } = makeTestDb();
  // design done (dispatch succeeded) + a unit + fast track → resolver returns advance design→implement,
  // which collapses; then implement:wu1:dispatch runs.
  const registry = new StepRegistry();
  registry.register("design:dispatch", () => ({}));
  registry.register("design:extract", (ctx) => {
    insertWorkUnit(ctx.db, { ticketId: ctx.ticket.id, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
    return { units: 1 };
  });
  registry.register("implement:dispatch", () => ({}));
  // run design:dispatch
  await advanceOneStep(db, ticketId, registry);
  // run design:extract (creates the unit)
  await advanceOneStep(db, ticketId, registry);
  // mark the track fast so design advances rather than asking for review
  setTicketTrack(db, ticketId, "fast");
  // next advance: collapse design→implement, then run implement:wu1:dispatch
  const outcome = await advanceOneStep(db, ticketId, registry);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.stage).toBe("implement");
  expect(outcome).toEqual({ kind: "stepped", stepKey: "implement:wu1:dispatch" });
});

test("a wait descriptor parks the ticket on a signal", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "merge");
  const registry = new StepRegistry();
  registry.register("merge:push", () => ({ sha: "a" }));
  registry.register("merge:pr-ensure", () => ({ pr: 1 }));
  await advanceOneStep(db, ticketId, registry); // merge:push
  await advanceOneStep(db, ticketId, registry); // merge:pr-ensure
  const outcome = await advanceOneStep(db, ticketId, registry); // wait external_checks
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(outcome).toEqual({ kind: "waiting", signalType: "external_checks" });
  expect(ticket?.status).toBe("waiting");
});

test("a done descriptor marks the ticket done", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "released");
  const registry = new StepRegistry();
  registry.register("released:project", () => ({ done: true }));
  await advanceOneStep(db, ticketId, registry); // released:project
  const outcome = await advanceOneStep(db, ticketId, registry); // done
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(outcome).toEqual({ kind: "done" });
  expect(ticket?.status).toBe("done");
});

test("a failing handler routes through failure-policy (retry)", async () => {
  const { db, ticketId } = makeTestDb();
  const registry = new StepRegistry();
  registry.register("design:dispatch", () => {
    throw new Error("agent died");
  });
  const outcome = await advanceOneStep(db, ticketId, registry);
  const step = getByKey(db, ticketId, "design:dispatch");
  db.close();
  expect(outcome).toEqual({ kind: "retry", stepKey: "design:dispatch" });
  expect(step?.status).toBe("pending"); // reset for retry by failure-policy
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/advance.test.ts`
Expected: FAIL — `Cannot find module '../../src/daemon/advance.ts'`.

- [ ] **Step 3: Create `src/daemon/advance.ts`**

```ts
import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { getTicket, setTicketStage, setTicketStatus } from "../db/repos/ticket.ts";
import { setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { getByKey } from "../db/repos/workflow-step.ts";
import { awaitSignal } from "../engine/signals.ts";
import { runStep } from "../engine/step-journal.ts";
import { applyFailurePolicy } from "./failure-policy.ts";
import { nextStepKey } from "./resolver.ts";
import type { StepRegistry } from "./step-registry.ts";

const MAX_TRANSITIONS = 100;

export type AdvanceOutcome =
  | { kind: "stepped"; stepKey: string }
  | { kind: "waiting"; signalType: string }
  | { kind: "done" }
  | { kind: "blocked"; reason: string }
  | { kind: "retry"; stepKey: string }
  | { kind: "loopback"; stepKey: string }
  | { kind: "escalated"; stepKey: string };

/** Interpret M2a's pure descriptors, advancing one ticket by one real step per call.
 *  Pure transitions (advance / mark-verified) collapse inline; a step runs via runStep
 *  with the registered handler; wait parks; done finalizes; a failed step routes through
 *  failure-policy. (control-loop §2.3; minimal-loop §1/§2.) */
export async function advanceOneStep(
  db: Database,
  ticketId: number,
  registry: StepRegistry,
): Promise<AdvanceOutcome> {
  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    const d = nextStepKey(db, ticketId);

    if (d.kind === "advance") {
      db.transaction(() => {
        setTicketStage(db, ticketId, d.to);
        appendEvent(db, { ticketId, kind: "transition", fromStage: d.from, toStage: d.to });
      })();
      continue;
    }

    if (d.kind === "mark-verified") {
      setUnitStatus(db, d.workUnitId, "verified");
      continue;
    }

    if (d.kind === "wait") {
      awaitSignal(db, { ticketId, signalType: d.signalType });
      return { kind: "waiting", signalType: d.signalType };
    }

    if (d.kind === "done") {
      setTicketStatus(db, ticketId, "done");
      return { kind: "done" };
    }

    if (d.kind === "blocked") {
      return { kind: "blocked", reason: d.reason };
    }

    // d.kind === "step"
    const ticket = getTicket(db, ticketId);
    if (!ticket) {
      throw new Error(`advanceOneStep: ticket ${ticketId} not found`);
    }
    const handler = registry.resolve(d.handlerKey);
    if (!handler) {
      throw new Error(`advanceOneStep: no handler registered for '${d.handlerKey}'`);
    }
    try {
      await runStep(db, {
        ticketId,
        workUnitId: d.workUnitId,
        stepKey: d.stepKey,
        stepType: d.stepType,
        effectful: true,
        execute: (step) => handler({ db, ticket, step, workUnitId: d.workUnitId }),
      });
      return { kind: "stepped", stepKey: d.stepKey };
    } catch {
      const failed = getByKey(db, ticketId, d.stepKey);
      if (!failed) {
        throw new Error(`advanceOneStep: failed step '${d.stepKey}' missing after failure`);
      }
      const { decision } = applyFailurePolicy(db, ticketId, failed);
      return { kind: decision, stepKey: d.stepKey };
    }
  }
  throw new Error(`advanceOneStep: exceeded ${MAX_TRANSITIONS} transitions for ticket ${ticketId}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/daemon/advance.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/advance.ts test/daemon/advance.test.ts
git commit -m "feat(m2b): advance_one_step — interpret resolver descriptors"
```

---

### Task 3: `loop()` event-loop tick

**Files:**
- Create: `src/daemon/loop.ts`
- Test: `test/daemon/loop.test.ts`

**Interfaces:**
- Consumes: `advanceOneStep` (Task 2); `StepRegistry`; `Database`.
- Produces:
  - `readyTicketIds(db): number[]` — ids from the `v_ready_tickets` view (active, project not paused, no pending signal).
  - `tick(db, registry: StepRegistry, opts?: { maxConcurrent?: number }): Promise<{ advanced: number }>` — advance up to `maxConcurrent` (default 2 = K) ready tickets by one step each; returns how many were advanced.

Note: the continuous supervised daemon loop (poll interval, outbox drain, checks-system polling) is a later milestone (the `daemon` command, M8). M2b delivers the testable `tick()` primitive; `drain_outbox`/`poll_external_signals` are deferred (no outbox/adapters until M6).

- [ ] **Step 1: Write the failing test** — `test/daemon/loop.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../helpers/db.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { awaitSignal } from "../../src/engine/signals.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { readyTicketIds, tick } from "../../src/daemon/loop.ts";

function registry(): StepRegistry {
  const r = new StepRegistry();
  r.register("design:dispatch", () => ({}));
  return r;
}

test("tick advances a ready ticket by one step", async () => {
  const { db, ticketId } = makeTestDb();
  const summary = await tick(db, registry());
  const step = getByKey(db, ticketId, "design:dispatch");
  db.close();
  expect(summary.advanced).toBe(1);
  expect(step?.status).toBe("succeeded");
});

test("readyTicketIds excludes a ticket parked on a pending signal", () => {
  const { db, ticketId } = makeTestDb();
  expect(readyTicketIds(db)).toContain(ticketId);
  awaitSignal(db, { ticketId, signalType: "human_merge_approval" }); // parks (status=waiting + pending signal)
  const ready = readyTicketIds(db);
  db.close();
  expect(ready).not.toContain(ticketId);
});

test("tick respects the maxConcurrent (K) cap", async () => {
  const { db, projectId } = makeTestDb();
  // makeTestDb already created one ticket; add two more → 3 ready, K=2 processes 2.
  insertTicket(db, { projectId, ident: "ENG-2" });
  insertTicket(db, { projectId, ident: "ENG-3" });
  const summary = await tick(db, registry(), { maxConcurrent: 2 });
  db.close();
  expect(summary.advanced).toBe(2);
});

test("tick advances nothing when there are no ready tickets", async () => {
  const { db, ticketId } = makeTestDb();
  awaitSignal(db, { ticketId, signalType: "human_merge_approval" }); // the only ticket is parked
  const summary = await tick(db, registry());
  db.close();
  expect(summary.advanced).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/loop.test.ts`
Expected: FAIL — `Cannot find module '../../src/daemon/loop.ts'`.

- [ ] **Step 3: Create `src/daemon/loop.ts`**

```ts
import type { Database } from "bun:sqlite";
import { advanceOneStep } from "./advance.ts";
import type { StepRegistry } from "./step-registry.ts";

const DEFAULT_MAX_CONCURRENT = 2; // K (control-loop §2.2)

/** Ticket ids the daemon may pick this tick — active, project not paused, not parked
 *  on a pending signal (the v_ready_tickets view). */
export function readyTicketIds(db: Database): number[] {
  return db
    .query<{ id: number }, []>("SELECT id FROM v_ready_tickets")
    .all()
    .map((r) => r.id);
}

/** One pass of the event loop: advance up to K ready tickets by one step each.
 *  (The continuous supervised loop + outbox drain + checks polling are later milestones.) */
export async function tick(
  db: Database,
  registry: StepRegistry,
  opts?: { maxConcurrent?: number },
): Promise<{ advanced: number }> {
  const max = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const ids = readyTicketIds(db).slice(0, max);
  let advanced = 0;
  for (const id of ids) {
    await advanceOneStep(db, id, registry);
    advanced++;
  }
  return { advanced };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/daemon/loop.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/loop.ts test/daemon/loop.test.ts
git commit -m "feat(m2b): loop tick() — v_ready_tickets selection + K concurrency"
```

---

### Task 4: walking-skeleton e2e + crash-resume

**Files:**
- Test: `test/daemon/walking-skeleton.test.ts`

**Interfaces:**
- Consumes: everything above — `tick` (loop); `advanceOneStep` (advance); `StepRegistry`; `recover` (recover); signals (`listPending`, `deliverSignal`); repos (`getTicket`, `setTicketTrack`, `insertWorkUnit`, `setStatus`, `insertSignal`, `insertPending`/`markRunning` for the crash sim); `makeTestDb`.
- Produces: no production code — this task is the end-to-end proof that M2a + M2b drive a fast-track ticket `design → released` with mocked handlers, plus crash-resume.

This task adds NO source files. If a test reveals a real bug in `advance.ts`/`loop.ts`/`failure-policy.ts`/`resolver.ts`, STOP and report it (it should be fixed in the owning task, then this e2e re-run) — do not patch around it in the test.

- [ ] **Step 1: Write the e2e test** — `test/daemon/walking-skeleton.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../helpers/db.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, setStatus as setUnitStatus } from "../../src/db/repos/work-unit.ts";
import { insertPending, markRunning } from "../../src/db/repos/workflow-step.ts";
import { deliverSignal } from "../../src/engine/signals.ts";
import { recover } from "../../src/daemon/recover.ts";
import { tick } from "../../src/daemon/loop.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";

/** Mock handlers that write exactly the state a real handler would, so the resolver
 *  can route a fast-track ticket design→released. No real dispatch/verify/projector. */
function skeletonRegistry(): StepRegistry {
  const r = new StepRegistry();
  r.register("design:dispatch", () => ({ plan: "ok" }));
  r.register("design:extract", (ctx: HandlerContext) => {
    insertWorkUnit(ctx.db, { ticketId: ctx.ticket.id, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
    setTicketTrack(ctx.db, ctx.ticket.id, "fast");
    return { units: 1 };
  });
  r.register("implement:dispatch", (ctx: HandlerContext) => {
    if (ctx.workUnitId !== null) {
      setUnitStatus(ctx.db, ctx.workUnitId, "verifying");
    }
    return { code: "ok" };
  });
  r.register("verify:check", (ctx: HandlerContext) => {
    const check = ctx.step.step_key.split(":").pop() ?? "test";
    insertSignal(ctx.db, { ticketId: ctx.ticket.id, workUnitId: ctx.workUnitId, signalType: check, result: "pass" });
    return { check };
  });
  r.register("verify:integration", (ctx: HandlerContext) => {
    insertSignal(ctx.db, { ticketId: ctx.ticket.id, signalType: "integration", result: "pass" });
    return { integration: "pass" };
  });
  r.register("review", () => ({ findings: 0 }));
  r.register("merge:push", () => ({ sha: "abc123" }));
  r.register("merge:pr-ensure", () => ({ pr: 1 }));
  r.register("released:project", () => ({ released: true }));
  return r;
}

// Drive via the loop: tick until the ticket is done; when the loop goes idle (the ticket
// parked on a signal, so it left v_ready_tickets), deliver the pending signal via the
// signals engine — simulating the checks poll + human merge. deliverSignal sets the signal
// 'delivered' AND the ticket back to 'active', so v_ready_tickets re-includes it next tick.
async function driveToDone(db: Parameters<typeof tick>[0], registry: StepRegistry, ticketId: number, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (getTicket(db, ticketId)?.status === "done") {
      return;
    }
    const summary = await tick(db, registry, { maxConcurrent: 2 });
    if (summary.advanced === 0) {
      const pending = listPending(db, ticketId);
      const first = pending[0];
      if (!first) {
        throw new Error(`stuck: ticket idle at stage ${getTicket(db, ticketId)?.stage}, no pending signal`);
      }
      deliverSignal(db, first.id); // un-park: signal delivered + ticket active
    }
  }
  throw new Error("driveToDone: exceeded maxTicks");
}

test("walking skeleton: a fast-track ticket flows design → released", async () => {
  const { db, ticketId } = makeTestDb();
  await driveToDone(db, skeletonRegistry(), ticketId);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.stage).toBe("released");
  expect(ticket?.status).toBe("done");
});

test("crash-resume: a step left running is recovered and the ticket still completes", async () => {
  const { db, ticketId } = makeTestDb();
  // Simulate a crash mid-first-step: design:dispatch left 'running' with a dead pid.
  const crashed = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  markRunning(db, crashed.id, { pid: 999999 });
  // Recovery (M1) resets running → pending after killing the orphan.
  const result = recover(db, { isAlive: () => false, kill: () => {} });
  expect(result.reset).toBe(1);
  // The loop now drives the recovered ticket to completion.
  await driveToDone(db, skeletonRegistry(), ticketId);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.status).toBe("done");
});
```

Why `deliverSignal` (not `markDelivered`): `awaitSignal` parks the ticket by setting `ticket.status='waiting'` + inserting a pending signal, so it leaves `v_ready_tickets` (which requires `status='active'` AND no pending signal). `markDelivered` alone would clear the *pending* signal but leave the ticket `waiting` — still excluded — so the loop would stall. `deliverSignal` sets the signal `delivered` **and** the ticket back to `active`, re-including it. This mirrors the real daemon, which delivers external facts via the signals engine.

- [ ] **Step 2: Run the e2e**

Run: `bun test test/daemon/walking-skeleton.test.ts`
Expected: both tests PASS — the ticket reaches `stage='released'`, `status='done'`; the crash-resume test recovers the running step (`reset === 1`) and still completes.

- [ ] **Step 3: Run the FULL suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all M0 + M1 + M2a + M2b tests pass; Biome clean; `tsc --noEmit` exits 0.

- [ ] **Step 4: Commit**

```bash
git add test/daemon/walking-skeleton.test.ts
git commit -m "test(m2b): walking-skeleton e2e (design→released) + crash-resume"
```

---

## M2b acceptance criteria

- [ ] `advance_one_step` interprets every descriptor kind (step/advance/mark-verified/wait/done/blocked) and a step failure routes through failure-policy — unit-tested.
- [ ] failure-policy gives the retry / verify-loopback / escalate *shape* (bounded by attempts), escalation parks the ticket `waiting` + raises `human_resume` + logs an `escalated` event — unit-tested.
- [ ] `tick()` selects `v_ready_tickets`, advances up to K=2, and excludes parked tickets — unit-tested.
- [ ] **Walking skeleton:** a fast-track ticket flows `design → released` (`stage='released'`, `status='done'`) driven by the loop with mock handlers, exercising the resolver, journal, signals (park/deliver), and stage transitions end-to-end.
- [ ] **Crash-resume:** a step left `running` is recovered (M1 `recover()`) and the ticket still completes.
- [ ] `bun test` green; `bun run lint && bun run typecheck` clean; the compiled binary still builds + runs (`migrate`).

## Out of scope (later milestones)

- **Real dispatch** (`claude -p`, worktrees, render-prompt, sidecar), **real verify** (profile commands, checks-system), **real projector/outbox** (Linear/GitHub) — M3 / M4 / M6. M2b uses mock handlers only.
- **The continuous supervised daemon loop** (poll interval, `drain_outbox`, `poll_external_signals`, the `styre daemon` command) — M8.
- **The full Loopback Atlas + budgets** (signature-based distinct counting, B2/B3 spend/wall-clock ceilings, the per-route table, `completeness_failed`/D2, rebase) — a later failure-policy deepening.
- **Full-track design:review** path beyond what the resolver already routes; **`blocked` carrying `workUnitId`** (review note — deferred; the current `blocked` case has no single offending unit).

## Done / handoff

When M2b is delivered and merged, the walking skeleton is complete — the substrate's deterministic spine runs end-to-end on mocks. The next milestone is **M3 — Dispatch real** (worktrees, render-prompt + CL-PROFILE gate, tool allowlists, models, the `claude -p` spawn, sidecar zod), replacing the `design:dispatch`/`implement:dispatch` mock handlers with real agent dispatch.
