import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { GATE_ROUND_CAP, applyArbiterVerdict } from "../../src/daemon/arbiter-verdict.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending, markRunning } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function seedGateStepWithAttempt(db: Database, ticketId: number, attempt: number) {
  const gateStep = insertPending(db, {
    ticketId,
    stepKey: "verify:checks-gate",
    stepType: "verify",
  });
  for (let i = 0; i < attempt; i++) markRunning(db, gateStep.id, {});
  return gateStep;
}

function seedLatestDispatchSha(db: Database, ticketId: number, sha: string) {
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: `ENG-1-d${sha}`,
    seq: nextSeq(db, ticketId),
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: sha });
  return disp;
}

test("arbiter verdict: code-wrong under the cap loops implement (attempt preserved)", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, 1); // attempt=1 < CAP=3
  seedLatestDispatchSha(db, ticketId, "S1");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "code-wrong", reason: "r" },
  });

  const v = applyArbiterVerdict(db, ticketId, { stepKey: "checks:arbitrate" });
  const unitAfter = getUnit(db, unit.id);
  const gateAfter = getByKey(db, ticketId, "verify:checks-gate");
  const events = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement",
  );
  db.close();

  expect(v.decision).toBe("loopback");
  expect(unitAfter?.status).toBe("pending");
  expect(gateAfter?.status).toBe("pending");
  expect(gateAfter?.attempt).toBe(1); // preserved
  expect(events.length).toBe(1);
  expect(events[0]?.route_to).toBe("checks:arbitrate");
});

test("arbiter verdict: check-wrong under the cap ALSO loops implement (Task 5 green intermediate — re-author is Task 6)", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, 0);
  seedLatestDispatchSha(db, ticketId, "S1");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "check-wrong", reason: "positive AC contradiction" },
  });

  const v = applyArbiterVerdict(db, ticketId, { stepKey: "checks:arbitrate" });
  const unitAfter = getUnit(db, unit.id);
  db.close();

  expect(v.decision).toBe("loopback");
  expect(unitAfter?.status).toBe("pending");
});

test("arbiter verdict: any code-wrong at the gate-round cap → escalated", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, GATE_ROUND_CAP);
  seedLatestDispatchSha(db, ticketId, "S1");
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "code-wrong", reason: "r" },
  });

  const v = applyArbiterVerdict(db, ticketId, { stepKey: "checks:arbitrate" });
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  db.close();

  expect(v.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
});

test("arbiter verdict: no blame recorded at the current sha → clean (no-op guard)", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, 0);
  seedLatestDispatchSha(db, ticketId, "S1");
  const v = applyArbiterVerdict(db, ticketId, { stepKey: "checks:arbitrate" });
  db.close();
  expect(v.decision).toBe("clean");
});
