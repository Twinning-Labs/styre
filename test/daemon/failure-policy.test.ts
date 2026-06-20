import { expect, test } from "bun:test";
import { applyFailurePolicy } from "../../src/daemon/failure-policy.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import {
  getById as getStep,
  insertPending,
  markFailed,
  markRunning,
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
