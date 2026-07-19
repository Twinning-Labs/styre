import { expect, test } from "bun:test";
import { readyTicketIds, tick } from "../../src/daemon/loop.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { insertTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, setStatus as setUnitStatus } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { awaitSignal } from "../../src/engine/signals.ts";
import { makeTestDb } from "../helpers/db.ts";

function registry(): StepRegistry {
  const r = new StepRegistry();
  r.register("provision", () => ({}));
  r.register("design:dispatch", () => ({}));
  return r;
}

test("tick advances a ready ticket by one step", async () => {
  const { db, ticketId } = makeTestDb();
  const summary = await tick(db, registry());
  const step = getByKey(db, ticketId, "provision");
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

test("tick surfaces a resolver dead-end as blocked, not as progress", async () => {
  const { db, ticketId } = makeTestDb();
  // implement stage with a unit that is neither actionable nor verified → resolver returns 'blocked'
  // (control-loop §8-P1). It must be reported as blocked, NOT counted as an advance — otherwise the
  // driver's stall guard never fires and it spins to the iteration cap.
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  setUnitStatus(db, u.id, "blocked");
  const summary = await tick(db, registry());
  db.close();
  expect(summary.blocked).toBe(true);
  expect(summary.advanced).toBe(0);
});
