import { expect, test } from "bun:test";
import { applyAcCheckGateVerdict } from "../../src/daemon/checks-gate-verdict.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import {
  getByKey,
  insertPending,
  markRunning,
  markSucceeded,
} from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function gateSignal(db: Parameters<typeof insertSignal>[0], ticketId: number, stillRed: number[]) {
  return insertSignal(db, {
    ticketId,
    signalType: "ac-check-gate",
    result: stillRed.length === 0 ? "pass" : "fail",
    detail: { stillRed, tampered: [], advisory: [] },
  });
}

test("a passing ac-check-gate signal (stillRed=[]) → clean", () => {
  const { db, ticketId } = makeTestDb();
  gateSignal(db, ticketId, []);
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  db.close();
  expect(r.decision).toBe("clean");
});

test("stillRed=[1,2] first time → loopback; units + gate step reset to pending; loop:implement event", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const unitStep = insertPending(db, {
    ticketId,
    workUnitId: unit.id,
    stepKey: "verify:wu1:test",
    stepType: "verify",
  });
  markRunning(db, unitStep.id, {});
  markSucceeded(db, unitStep.id, { ok: true });
  const gateStep = insertPending(db, {
    ticketId,
    stepKey: "verify:checks-gate",
    stepType: "verify",
  });
  markRunning(db, gateStep.id, {});
  markSucceeded(db, gateStep.id, { gated: 2, stillRed: 2 });
  gateSignal(db, ticketId, [1, 2]);

  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const unitAfter = getUnit(db, unit.id);
  const unitStepAfter = getByKey(db, ticketId, "verify:wu1:test");
  const gateAfter = getByKey(db, ticketId, "verify:checks-gate");
  const events = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement",
  );
  db.close();

  expect(r.decision).toBe("loopback");
  expect(unitAfter?.status).toBe("pending");
  expect(unitStepAfter?.status).toBe("pending"); // the unit's previously-succeeded verify step re-opens too
  expect(gateAfter?.status).toBe("pending");
  expect(events.length).toBe(1);
  expect(events[0]?.route_to).toBe("verify:checks-gate");
  expect(events[0]?.signature).toBe("gate:1,2");
  expect(JSON.parse(events[0]?.payload_json ?? "{}").acIds).toEqual([1, 2]);
});

test("the SAME stillRed set as the immediately-prior gate loopback → escalated", () => {
  const { db, ticketId } = makeTestDb();
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  gateSignal(db, ticketId, [1, 2]);
  const first = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  expect(first.decision).toBe("loopback");

  // Re-implement produced the SAME still-red AC-id set — no progress.
  gateSignal(db, ticketId, [1, 2]);
  const second = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  db.close();

  expect(second.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
});
