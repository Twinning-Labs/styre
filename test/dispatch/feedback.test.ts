import { expect, test } from "bun:test";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { implementFeedback } from "../../src/dispatch/feedback.ts";
import { makeTestDb } from "../helpers/db.ts";

function seedAttempt(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  unitId: number,
  sha: string,
) {
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: `ENG-1-d${sha}`,
    seq: nextSeq(db, ticketId),
    workUnitId: unitId,
  });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: sha });
}

test("empty feedback when the unit has no prior failures", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  expect(implementFeedback(db, u.id)).toBe("");
  db.close();
});

test("behavioral-no-test failure yields an add-a-test instruction", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  seedAttempt(db, ticketId, u.id, "sha1");
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "test",
    result: "fail",
    branchHeadSha: "sha1",
    detail: { reason: "behavioral-no-test" },
  });
  const fb = implementFeedback(db, u.id);
  db.close();
  expect(fb.toLowerCase()).toContain("add a test");
});

test("a failing check yields a what-failed instruction", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  seedAttempt(db, ticketId, u.id, "sha1");
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "build",
    result: "fail",
    branchHeadSha: "sha1",
    detail: { stderr: "boom" },
  });
  const fb = implementFeedback(db, u.id);
  db.close();
  expect(fb).toContain("build");
});

test("advisory scope_diff failure is excluded from re-coding feedback; real gating failures still surface", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  seedAttempt(db, ticketId, u.id, "sha1");
  // Advisory signal — must NOT appear in feedback
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "scope_diff",
    result: "fail",
    branchHeadSha: "sha1",
    detail: { out_of_scope: ["x.ts"] },
  });
  // Gating signal — MUST appear in feedback
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "build",
    result: "fail",
    branchHeadSha: "sha1",
    detail: { stderr: "type error" },
  });
  const fb = implementFeedback(db, u.id);
  db.close();
  expect(fb).not.toContain("scope_diff");
  expect(fb).toContain("build");
});

test("advisory ran-all-unowned (untouched-stack red) is excluded from re-coding feedback", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  seedAttempt(db, ticketId, u.id, "sha1");
  // A precautionary sweep of an UNTOUCHED stack failed — the agent must not be told to fix it.
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "ran-all-unowned",
    result: "fail",
    branchHeadSha: "sha1",
    detail: { component: "go", checkType: "test" },
  });
  const fb = implementFeedback(db, u.id);
  db.close();
  expect(fb).toBe(""); // the only signal is advisory → no corrective feedback
});
