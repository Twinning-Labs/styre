import { expect, test } from "bun:test";
import { completeDispatch, insertDispatch } from "../../src/db/repos/dispatch.ts";
import { listByTicket } from "../../src/db/repos/event-log.ts";
import { insertFinding } from "../../src/db/repos/review-finding.ts";
import { beginReviewContract, requiredCodeFindings } from "../../src/db/repos/review-round.ts";
import {
  insertPending,
  markFailed,
  markSucceeded,
  resetToPending,
} from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function legacyReviewHistory() {
  const fixture = makeTestDb();
  const { db, ticketId } = fixture;
  const step = insertPending(db, { ticketId, stepKey: "review", stepType: "dispatch" });
  const first = insertDispatch(db, {
    ticketId,
    stepId: step.id,
    dispatchId: "legacy-validated",
    seq: 1,
    stage: "review",
  });
  completeDispatch(db, first.id, { outcome: "clean-success", branchHeadSha: "old-head" });
  const finding = insertFinding(db, {
    ticketId,
    dispatchId: first.dispatch_id,
    reviewKind: "code",
    severity: "major",
    blocksShip: 1,
    rationale: "A synthetic defect requiring resolution",
  });
  markSucceeded(db, step.id, { findings: 1, blocking: 1 });
  resetToPending(db, step.id);
  const latest = insertDispatch(db, {
    ticketId,
    stepId: step.id,
    dispatchId: "legacy-latest",
    seq: 2,
    stage: "review",
  });
  // A successful agent transport does not prove its sidecar passed handler validation.
  completeDispatch(db, latest.id, { outcome: "clean-success", branchHeadSha: "new-head" });
  return { ...fixture, step, finding };
}

test("a failed legacy review cannot silently supersede a prior unresolved major", () => {
  const { db, ticketId, step, finding } = legacyReviewHistory();
  try {
    markFailed(db, step.id, new Error("review sidecar malformed"));
    expect(requiredCodeFindings(db, ticketId).map((f) => f.id)).toEqual([finding.id]);
    beginReviewContract(db, ticketId);
    expect(requiredCodeFindings(db, ticketId).map((f) => f.id)).toEqual([finding.id]);
    const migration = listByTicket(db, ticketId).find(
      (e) => e.reason === "review-contract-started",
    );
    expect(JSON.parse(migration?.payload_json ?? "null").superseded).toEqual([]);
  } finally {
    db.close();
  }
});

test("a succeeded step with an unmatched old result does not prove the latest review clean", () => {
  const { db, ticketId, step, finding } = legacyReviewHistory();
  try {
    // The retained summary says one finding, but this latest dispatch has no finding rows.
    markSucceeded(db, step.id, { findings: 1, blocking: 1 });
    beginReviewContract(db, ticketId);
    expect(requiredCodeFindings(db, ticketId).map((f) => f.id)).toEqual([finding.id]);
  } finally {
    db.close();
  }
});

test("a proven clean legacy final review keeps old superseded findings historical", () => {
  const { db, ticketId, step, finding } = legacyReviewHistory();
  try {
    markSucceeded(db, step.id, { findings: 0, blocking: 0 });
    expect(requiredCodeFindings(db, ticketId)).toEqual([]);
    beginReviewContract(db, ticketId);
    expect(requiredCodeFindings(db, ticketId)).toEqual([]);
    const migration = listByTicket(db, ticketId).find(
      (e) => e.reason === "review-contract-started",
    );
    expect(JSON.parse(migration?.payload_json ?? "null").superseded).toEqual([
      { id: finding.id, dispatchId: "legacy-validated" },
    ]);
  } finally {
    db.close();
  }
});
