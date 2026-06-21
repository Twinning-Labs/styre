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
