import { expect, test } from "bun:test";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { insertFinding } from "../../src/db/repos/review-finding.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { reviewFeedback } from "../../src/dispatch/review-feedback.ts";
import { makeTestDb } from "../helpers/db.ts";

// Seed a succeeded `review` step + its dispatch, mirroring review-verdict.test.ts's seedReviewRound.
function seedReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  const s = insertPending(db, { ticketId, stepKey: "review", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  const did = "T-d0001";
  insertDispatch(db, { ticketId, dispatchId: did, seq: 1, stepId: s.id, stage: "review" });
  return { unit, did };
}

test("reviewFeedback is empty with no prior review round", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  expect(reviewFeedback(db, ticketId, unit.id)).toBe("");
  db.close();
});

test("reviewFeedback renders this unit's blocking findings from the latest review round", () => {
  const { db, ticketId } = makeTestDb();
  const { unit, did } = seedReview(db, ticketId);
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "major",
    category: "correctness",
    deferralCandidate: 0,
    blocksShip: 1,
    workUnitId: unit.id,
    location: "src/a.ts:12",
    rationale: "off-by-one in the loop bound",
  });
  const out = reviewFeedback(db, ticketId, unit.id);
  db.close();
  expect(out).toContain("src/a.ts:12");
  expect(out).toContain("off-by-one in the loop bound");
});

test("reviewFeedback excludes non-blocking and other-unit findings", () => {
  const { db, ticketId } = makeTestDb();
  const { unit, did } = seedReview(db, ticketId);
  const other = insertWorkUnit(db, { ticketId, seq: 2, kind: "backend", behavioral: 0 });
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "minor",
    category: "style",
    deferralCandidate: 0,
    blocksShip: 0,
    workUnitId: unit.id,
    location: "NONBLOCKING",
    rationale: "nit",
  });
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "major",
    category: "correctness",
    deferralCandidate: 0,
    blocksShip: 1,
    workUnitId: other.id,
    location: "OTHERUNIT",
    rationale: "x",
  });
  const out = reviewFeedback(db, ticketId, unit.id);
  db.close();
  expect(out).toBe("");
});

test("reviewFeedback includes a whole-ticket (null-unit) blocking finding", () => {
  const { db, ticketId } = makeTestDb();
  const { unit, did } = seedReview(db, ticketId);
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "major",
    category: "correctness",
    deferralCandidate: 0,
    blocksShip: 1,
    workUnitId: null,
    location: "WHOLETICKET",
    rationale: "cross-cutting",
  });
  const out = reviewFeedback(db, ticketId, unit.id);
  db.close();
  expect(out).toContain("WHOLETICKET");
});
