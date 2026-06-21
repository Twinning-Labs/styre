import { expect, test } from "bun:test";
import { applyFailurePolicy } from "../../src/daemon/failure-policy.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
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
