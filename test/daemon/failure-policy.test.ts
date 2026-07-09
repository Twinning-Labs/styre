import { expect, test } from "bun:test";
import { applyFailurePolicy } from "../../src/daemon/failure-policy.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import {
  getById as getUnit,
  insertWorkUnit,
  listByTicket,
  parseDependsOn,
} from "../../src/db/repos/work-unit.ts";
import {
  getById as getStep,
  getByKey as getStepByKey,
  insertPending,
  markFailed,
  markRunning,
  markSucceeded,
} from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

// Build a failed step with a given attempt count (markRunning bumps attempt each call).
function failedStep(
  db: Parameters<typeof insertPending>[0],
  ticketId: number,
  opts: { stepKey: string; stepType: string; workUnitId?: number; attempts: number },
) {
  const step = insertPending(db, {
    ticketId,
    workUnitId: opts.workUnitId ?? null,
    stepKey: opts.stepKey,
    stepType: opts.stepType,
  });
  for (let i = 0; i < opts.attempts; i++) {
    markRunning(db, step.id, { pid: 1 });
  }
  markFailed(db, step.id, new Error("boom"));
  const failed = getStep(db, step.id);
  if (failed === null) throw new Error("failedStep: step missing after markFailed");
  return failed;
}

test("under budget, a non-verify step is retried (reset to pending, no loopback event)", () => {
  const { db, ticketId } = makeTestDb();
  const step = failedStep(db, ticketId, {
    stepKey: "design:dispatch",
    stepType: "dispatch",
    attempts: 1,
  });
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
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  const step = failedStep(db, ticketId, {
    stepKey: "verify:wu1:test",
    stepType: "verify",
    workUnitId: unit.id,
    attempts: 1,
  });
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
  const step = failedStep(db, ticketId, {
    stepKey: "design:dispatch",
    stepType: "dispatch",
    attempts: 3,
  });
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

test("verify bounce-back re-opens ALL of the unit's verify steps", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["build", "test"],
  });
  const buildStep = insertPending(db, {
    ticketId,
    workUnitId: unit.id,
    stepKey: "verify:wu1:build",
    stepType: "verify",
  });
  markRunning(db, buildStep.id, {});
  markSucceeded(db, buildStep.id, { ok: true }); // build already passed
  const testStep = insertPending(db, {
    ticketId,
    workUnitId: unit.id,
    stepKey: "verify:wu1:test",
    stepType: "verify",
  });
  markRunning(db, testStep.id, {});
  markFailed(db, testStep.id, new Error("tests red"));
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "fail" });

  const failed = getStep(db, testStep.id);
  if (!failed) throw new Error("no step");
  const r = applyFailurePolicy(db, ticketId, failed);
  const buildAfter = getStep(db, buildStep.id);
  db.close();
  expect(r.decision).toBe("loopback");
  expect(buildAfter?.status).toBe("pending"); // the previously-passed check was re-opened too
});

test("a could-not-run verify failure retries instead of bouncing back", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  const step = insertPending(db, {
    ticketId,
    workUnitId: unit.id,
    stepKey: "verify:wu1:test",
    stepType: "verify",
  });
  markRunning(db, step.id, {});
  markFailed(db, step.id, new Error("spawn error"));
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "error" });
  const s = getStep(db, step.id);
  if (!s) throw new Error("no step");
  const r = applyFailurePolicy(db, ticketId, s);
  db.close();
  expect(r.decision).toBe("retry"); // infrastructure error, not a code failure
});

test("same verify failure twice in a row escalates (no-progress backstop, attempt < cap)", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  // Insert the step once — failure-policy resets it to pending on loopback, so we reuse
  // the same step_key by re-fetching with getStepByKey after the reset.
  const step = insertPending(db, {
    ticketId,
    workUnitId: unit.id,
    stepKey: "verify:wu1:test",
    stepType: "verify",
  });

  // First failure: attempt=1 (< maxAttempts=3 default).
  markRunning(db, step.id, { pid: 1 });
  markFailed(db, step.id, new Error("tests red"));
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "fail" });
  const firstFailed = getStep(db, step.id);
  if (!firstFailed) throw new Error("step missing after first markFailed");
  const r1 = applyFailurePolicy(db, ticketId, firstFailed);
  expect(r1.decision).toBe("loopback"); // first failure bounces back, writes loopback event

  // After loopback, failure-policy reset the step to pending. Re-fetch it.
  const resetStep = getStepByKey(db, ticketId, "verify:wu1:test");
  if (!resetStep) throw new Error("step missing after loopback reset");

  // Second identical failure: same step_key, same error message → same signature; attempt=2 (< 3).
  markRunning(db, resetStep.id, { pid: 1 });
  markFailed(db, resetStep.id, new Error("tests red"));
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "fail" });
  const secondFailed = getStep(db, resetStep.id);
  if (!secondFailed) throw new Error("step missing after second markFailed");

  // Confirm attempt is 2, well below the 3-attempt cap, so escalation can only come from
  // the repeated-signature path — not attempt exhaustion.
  expect(secondFailed.attempt).toBe(2);

  const r2 = applyFailurePolicy(db, ticketId, secondFailed);

  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  const escalations = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  db.close();

  expect(r2.decision).toBe("escalated");
  if (!ticket) throw new Error("ticket missing");
  expect(ticket.status).toBe("waiting");
  expect(escalations.length).toBe(1);
  expect(escalations[0]?.reason).toBe("no progress");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
});

test("bounce-back resets the implement dispatch step so re-coding actually runs", () => {
  // Regression: the old code only reset verify steps, leaving the dispatch step succeeded.
  // The durable journal would replay it (return cached result), setUnitStatus never re-fires,
  // and the unit gets stuck "pending" forever.
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });

  // Seed the implement dispatch step as succeeded (as it would be after the first coding pass).
  const dispatchStep = insertPending(db, {
    ticketId,
    workUnitId: unit.id,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  markRunning(db, dispatchStep.id, { pid: 1 });
  markSucceeded(db, dispatchStep.id, { ok: true });

  // Seed the verify step as failed with a "fail" ground-truth signal.
  const verifyStep = insertPending(db, {
    ticketId,
    workUnitId: unit.id,
    stepKey: "verify:wu1:test",
    stepType: "verify",
  });
  markRunning(db, verifyStep.id, { pid: 1 });
  markFailed(db, verifyStep.id, new Error("tests red"));
  // Insert a "fail" ground-truth signal so latestVerifyResult returns "fail" (not "error").
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "fail" });

  const failed = getStep(db, verifyStep.id);
  if (!failed) throw new Error("verify step missing");
  const result = applyFailurePolicy(db, ticketId, failed);
  const dispatchAfter = getStep(db, dispatchStep.id);
  db.close();

  expect(result.decision).toBe("loopback");
  // The implement dispatch step MUST be reset so the next tick re-runs the handler.
  expect(dispatchAfter?.status).toBe("pending");
});

test("a provision failure escalates immediately and never loops back (even under attempt budget)", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  const step = failedStep(db, ticketId, {
    stepKey: "provision",
    stepType: "provision",
    attempts: 1,
  });
  const result = applyFailurePolicy(db, ticketId, step);
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  const escalations = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  const loopbacks = listEvents(db, ticketId).filter((e) => e.kind === "loopback");
  const afterUnit = getUnit(db, unit.id);
  db.close();
  expect(result.decision).toBe("escalated");
  if (!ticket) throw new Error("ticket missing");
  expect(ticket.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
  expect(escalations.length).toBe(1);
  expect(loopbacks.length).toBe(0);
  expect(afterUnit?.status).toBe("verifying"); // never bounced to pending
});

test("a failed verify:checks-gate step escalates cleanly (never an integration-reconcile unit/event)", () => {
  const { db, ticketId } = makeTestDb();
  const step = failedStep(db, ticketId, {
    stepKey: "verify:checks-gate",
    stepType: "verify",
    attempts: 1,
  });
  const result = applyFailurePolicy(db, ticketId, step);
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  const escalations = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  const loopbacks = listEvents(db, ticketId).filter((e) => e.kind === "loopback");
  const reconcile = listByTicket(db, ticketId).find((u) => u.kind === "reconcile");
  db.close();
  expect(result.decision).toBe("escalated");
  if (!ticket) throw new Error("ticket missing");
  expect(ticket.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
  expect(escalations.length).toBe(1);
  expect(loopbacks.length).toBe(0); // never integration-reconcile
  expect(reconcile).toBeUndefined();
});

test("whole-project failure also resets the sibling verify:checks-gate (M4 §8d, reconcile unit moves HEAD)", () => {
  const { db, ticketId } = makeTestDb();
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const intStep = insertPending(db, {
    ticketId,
    stepKey: "verify:integration",
    stepType: "verify",
  });
  markRunning(db, intStep.id, {});
  markFailed(db, intStep.id, new Error("integration red"));
  // The AC-check gate had already passed before this infra crash — it must re-run once the
  // reconcile unit moves HEAD, or its stale success replays at the new HEAD (MAX_TRANSITIONS).
  const gateStep = insertPending(db, {
    ticketId,
    stepKey: "verify:checks-gate",
    stepType: "verify",
  });
  markRunning(db, gateStep.id, {});
  markSucceeded(db, gateStep.id, { gated: 1, stillRed: 0 });
  const s = getStep(db, intStep.id);
  if (!s) throw new Error("no step");
  const r = applyFailurePolicy(db, ticketId, s);
  const gateAfter = getStepByKey(db, ticketId, "verify:checks-gate");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(gateAfter?.status).toBe("pending");
});

test("whole-project failure resets the gate-round counter + checks:arbitrate/checks:reauthor (§6: integration re-entry is not a gate-origin round)", () => {
  const { db, ticketId } = makeTestDb();
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const intStep = insertPending(db, {
    ticketId,
    stepKey: "verify:integration",
    stepType: "verify",
  });
  markRunning(db, intStep.id, {});
  markFailed(db, intStep.id, new Error("integration red"));
  // The gate had already run a couple of gate-round arbitrations (attempt=2) before this infra crash.
  const gateStep = insertPending(db, {
    ticketId,
    stepKey: "verify:checks-gate",
    stepType: "verify",
  });
  markRunning(db, gateStep.id, {});
  markRunning(db, gateStep.id, {});
  markSucceeded(db, gateStep.id, { gated: 1, stillRed: 0 });
  for (const key of ["checks:arbitrate", "checks:reauthor"]) {
    const s = insertPending(db, { ticketId, stepKey: key, stepType: "dispatch" });
    db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  }
  const s = getStep(db, intStep.id);
  if (!s) throw new Error("no step");
  const r = applyFailurePolicy(db, ticketId, s);
  const gateAfter = getStepByKey(db, ticketId, "verify:checks-gate");
  const arbitrateAfter = getStepByKey(db, ticketId, "checks:arbitrate");
  const reauthorAfter = getStepByKey(db, ticketId, "checks:reauthor");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(gateAfter?.status).toBe("pending");
  expect(gateAfter?.attempt).toBe(0); // fresh count for the new verify pass
  expect(arbitrateAfter?.status).toBe("pending");
  expect(reauthorAfter?.status).toBe("pending");
});

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
  // A genuine under-delivery signal must exist so the branch takes the loopback path, not the
  // F1 infra-crash retry guard (latestCompletenessResult !== "fail" -> retry). Without this the
  // handler crashing before recording anything (a wiped worktree, etc.) looks identical to a
  // clean-run non-failure, and correctly defaults to retry, not loopback.
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "completeness", result: "fail" });
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
  // loopback just recorded, at attempt 2 (< maxAttempts, so NOT the ceiling guard). The loopback
  // above reset the step to pending (not deleted, per resetToPending) — re-fetch and re-fail the
  // SAME row rather than inserting a new one, or the ticket_id+step_key UNIQUE constraint fires
  // (mirrors the "same verify failure twice in a row escalates" test's pattern).
  recordFail();
  const resetStep = getStepByKey(db, ticketId, "completeness:wu1");
  if (!resetStep) throw new Error("step missing after loopback reset");
  markRunning(db, resetStep.id, { pid: 1 });
  markFailed(db, resetStep.id, new Error("boom"));
  const second = getStep(db, resetStep.id);
  if (!second) throw new Error("step missing after second markFailed");
  expect(second.attempt).toBe(2);
  const res = applyFailurePolicy(db, ticketId, second);
  db.close();
  expect(res.decision).toBe("escalated");
});

test("whole-project failure spawns a reconcile unit and re-opens integration", () => {
  const { db, ticketId } = makeTestDb();
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const intStep = insertPending(db, {
    ticketId,
    stepKey: "verify:integration",
    stepType: "verify",
  });
  markRunning(db, intStep.id, {});
  markFailed(db, intStep.id, new Error("integration red"));
  const s = getStep(db, intStep.id);
  if (!s) throw new Error("no step");
  const r = applyFailurePolicy(db, ticketId, s);
  const units = listByTicket(db, ticketId);
  const reconcile = units.find((u) => u.kind === "reconcile");
  const intAfter = getStep(db, intStep.id);
  db.close();
  expect(r.decision).toBe("loopback");
  expect(reconcile).toBeDefined();
  expect(reconcile?.status).toBe("pending");
  expect(intAfter?.status).toBe("pending");
  // Regression guard: computed fields on the new reconcile unit
  if (!reconcile) throw new Error("no reconcile unit");
  expect(reconcile.seq).toBe(2); // max(existing seq)+1; seeded one unit at seq 1
  expect(parseDependsOn(reconcile)).toEqual([1]); // depends on the single existing unit
});
