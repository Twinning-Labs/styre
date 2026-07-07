import { expect, test } from "bun:test";
import { insertDispatch } from "../../../src/db/repos/dispatch.ts";
import {
  detachFromWorkUnit,
  getById,
  insertFinding,
  latestDispatchForStep,
  listByDispatch,
  listOpenByTicket,
  setStatus,
} from "../../../src/db/repos/review-finding.ts";
import { deleteByTicket, insertWorkUnit } from "../../../src/db/repos/work-unit.ts";
import { insertPending } from "../../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("detachFromWorkUnit nulls work_unit_id so the finding survives its unit's deletion", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", filesToTouch: ["a.ts"] });
  const f = insertFinding(db, {
    ticketId,
    reviewKind: "plan",
    severity: "major",
    category: "decomposition",
    location: "plan.md:10",
    rationale: "unit boundary is wrong",
    blocksShip: 1,
    workUnitId: unit.id,
  });

  detachFromWorkUnit(db, f.id);
  expect(getById(db, f.id)?.work_unit_id).toBeNull();

  // With work_unit_id NULL, deleting the unit no longer cascades the finding away.
  deleteByTicket(db, ticketId);
  expect(getById(db, f.id)).not.toBeNull();
  db.close();
});

test("insertFinding persists fields and round-trips by dispatch", () => {
  const { db, ticketId } = makeTestDb();
  const f = insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: "ENG-1-d0005",
    severity: "major",
    category: "correctness",
    deferralCandidate: 0,
    blocksShip: 1,
    location: "src/a.ts:12",
    rationale: "off-by-one",
  });
  const byDispatch = listByDispatch(db, ticketId, "ENG-1-d0005");
  db.close();
  expect(byDispatch.length).toBe(1);
  expect(byDispatch[0]?.severity).toBe("major");
  expect(byDispatch[0]?.blocks_ship).toBe(1);
  expect(byDispatch[0]?.review_kind).toBe("code");
  expect(f.status).toBe("open");
});

test("listOpenByTicket returns only open; setStatus flips it", () => {
  const { db, ticketId } = makeTestDb();
  const f = insertFinding(db, { ticketId, reviewKind: "code", severity: "nit" });
  expect(listOpenByTicket(db, ticketId).length).toBe(1);
  setStatus(db, f.id, "fixed");
  const open = listOpenByTicket(db, ticketId);
  db.close();
  expect(open.length).toBe(0);
});

test("latestDispatchForStep returns the newest dispatch owned by that step_key", () => {
  const { db, ticketId } = makeTestDb();
  // a design:review step + two dispatches owned by it; and a 'review' step + dispatch (must NOT match)
  const drStep = insertPending(db, { ticketId, stepKey: "design:review", stepType: "dispatch" });
  insertDispatch(db, {
    ticketId,
    dispatchId: "T-d0001",
    seq: 1,
    stepId: drStep.id,
    stage: "design",
  });
  insertDispatch(db, {
    ticketId,
    dispatchId: "T-d0002",
    seq: 2,
    stepId: drStep.id,
    stage: "design",
  });
  const crStep = insertPending(db, { ticketId, stepKey: "review", stepType: "dispatch" });
  insertDispatch(db, {
    ticketId,
    dispatchId: "T-d0003",
    seq: 3,
    stepId: crStep.id,
    stage: "review",
  });
  const dr = latestDispatchForStep(db, ticketId, "design:review");
  const cr = latestDispatchForStep(db, ticketId, "review");
  const none = latestDispatchForStep(db, ticketId, "merge:push");
  db.close();
  expect(dr).toBe("T-d0002"); // newest design:review dispatch, not the 'review' one
  expect(cr).toBe("T-d0003");
  expect(none).toBeNull();
});
