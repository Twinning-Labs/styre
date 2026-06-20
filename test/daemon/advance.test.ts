import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { getTicket, setTicketStage, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending, markRunning } from "../../src/db/repos/workflow-step.ts";
import { StepInFlightError } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

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
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
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
    insertWorkUnit(ctx.db, {
      ticketId: ctx.ticket.id,
      seq: 1,
      kind: "backend",
      verifyCheckTypes: ["test"],
    });
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

test("a running step propagates StepInFlightError instead of routing through failure-policy", async () => {
  const { db, ticketId } = makeTestDb();
  // Insert the design:dispatch step as pending, then mark it running (simulates crash-interrupted run).
  const pending = insertPending(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
  });
  markRunning(db, pending.id, { pid: 1 });

  const registry = new StepRegistry();
  // Handler must NOT be called — if it is, the test is wrong.
  registry.register("design:dispatch", () => {
    throw new Error("handler must not be called for a running step");
  });

  // advanceOneStep must propagate StepInFlightError, not swallow it into failure-policy.
  await expect(advanceOneStep(db, ticketId, registry)).rejects.toBeInstanceOf(StepInFlightError);

  // Step must still be 'running' — failure-policy did NOT reset it to pending.
  expect(getByKey(db, ticketId, "design:dispatch")?.status).toBe("running");
  db.close();
});
