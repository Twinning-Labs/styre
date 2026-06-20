import { expect, test } from "bun:test";
import * as steps from "../../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertPending creates a pending step with seq 1 and attempt 0", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
  });
  db.close();
  expect(step.status).toBe("pending");
  expect(step.seq).toBe(1);
  expect(step.attempt).toBe(0);
  expect(step.idempotency_key).toBeNull();
});

test("nextSeq increments per ticket", () => {
  const { db, ticketId } = makeTestDb();
  steps.insertPending(db, { ticketId, stepKey: "a", stepType: "dispatch" });
  steps.insertPending(db, { ticketId, stepKey: "b", stepType: "dispatch" });
  const seq = steps.nextSeq(db, ticketId);
  db.close();
  expect(seq).toBe(3);
});

test("getByKey returns the step; unknown key returns null", () => {
  const { db, ticketId } = makeTestDb();
  steps.insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  const found = steps.getByKey(db, ticketId, "design:dispatch");
  const missing = steps.getByKey(db, ticketId, "nope");
  db.close();
  expect(found?.step_key).toBe("design:dispatch");
  expect(missing).toBeNull();
});

test("markRunning sets running, bumps attempt, records key + pid", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "merge:push", stepType: "project" });
  steps.markRunning(db, step.id, { idempotencyKey: "ENG-1-d1-push", pid: 4242 });
  const after = steps.getById(db, step.id);
  db.close();
  expect(after?.status).toBe("running");
  expect(after?.attempt).toBe(1);
  expect(after?.idempotency_key).toBe("ENG-1-d1-push");
  expect(after?.pid).toBe(4242);
});

test("markSucceeded records a JSON result", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, {
    ticketId,
    stepKey: "design:extract",
    stepType: "dispatch",
  });
  steps.markSucceeded(db, step.id, { units: 2 });
  const after = steps.getById(db, step.id);
  db.close();
  expect(after?.status).toBe("succeeded");
  expect(JSON.parse(after?.result_json ?? "null")).toEqual({ units: 2 });
});

test("markFailed records a serialized error; resetToPending clears running state", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "x", stepType: "dispatch" });
  steps.markRunning(db, step.id, { pid: 99 });
  steps.markFailed(db, step.id, new Error("boom"));
  const failed = steps.getById(db, step.id);
  steps.resetToPending(db, step.id);
  const reset = steps.getById(db, step.id);
  db.close();
  expect(failed?.status).toBe("failed");
  expect(JSON.parse(failed?.error_json ?? "{}").message).toBe("boom");
  expect(reset?.status).toBe("pending");
  expect(reset?.pid).toBeNull();
});

test("listByStatus filters by status", () => {
  const { db, ticketId } = makeTestDb();
  const a = steps.insertPending(db, { ticketId, stepKey: "a", stepType: "dispatch" });
  steps.insertPending(db, { ticketId, stepKey: "b", stepType: "dispatch" });
  steps.markRunning(db, a.id, { pid: 1 });
  const running = steps.listByStatus(db, "running");
  db.close();
  expect(running.length).toBe(1);
  expect(running[0]?.step_key).toBe("a");
});
