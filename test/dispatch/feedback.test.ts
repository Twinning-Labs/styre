import { expect, test } from "bun:test";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { gateFeedback, implementFeedback } from "../../src/dispatch/feedback.ts";
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

test("completeness under-delivery yields a missing-files instruction naming the declared files", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  seedAttempt(db, ticketId, u.id, "sha1");
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "completeness",
    result: "fail",
    branchHeadSha: "sha1",
    detail: { disposition: "under-delivered", under: ["src/x.ts"], declared: ["src/x.ts"] },
  });
  const fb = implementFeedback(db, u.id);
  db.close();
  expect(fb).toContain("src/x.ts");
  expect(fb).not.toContain("completeness check");
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

test("advisory verify:check suite failure (M4 demotion) is excluded from re-coding feedback", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  seedAttempt(db, ticketId, u.id, "sha1");
  // A demoted per-unit suite verdict — advisory:true in detail, never gates.
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "test",
    result: "fail",
    branchHeadSha: "sha1",
    detail: { ran: [{ component: "app", exitCode: 1, timedOut: false }], advisory: true },
  });
  const fb = implementFeedback(db, u.id);
  db.close();
  expect(fb).toBe(""); // the only signal is advisory → no corrective feedback
});

test("gateFeedback lists the still-red ACs + their check paths from the ac-check-gate signal", () => {
  const { db, ticketId } = makeTestDb();
  const ac = insertAc(db, {
    ticketId,
    seq: 1,
    text: "returns the created record",
    source: "checklist",
  });
  insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "api/tests/styre_checks/ENG-1_ac7_test.py::test_ac",
    testPath: "api/tests/styre_checks/ENG-1_ac7_test.py",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-gate",
    result: "fail",
    detail: { stillRed: [ac.id], tampered: [], advisory: [] },
  });
  const fb = gateFeedback(db, ticketId);
  db.close();
  expect(fb).toContain(`AC ${ac.id}`);
  expect(fb).toContain("ENG-1_ac7_test.py");
  expect(fb.toLowerCase()).toContain("do not edit");
});

test("gateFeedback is empty when the latest gate passed (stillRed=[])", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-gate",
    result: "pass",
    detail: { stillRed: [], tampered: [], advisory: [] },
  });
  const fb = gateFeedback(db, ticketId);
  db.close();
  expect(fb).toBe("");
});

test("gateFeedback is empty when no gate signal exists", () => {
  const { db, ticketId } = makeTestDb();
  const fb = gateFeedback(db, ticketId);
  db.close();
  expect(fb).toBe("");
});

test("gateFeedback appends the arbiter's code-wrong blame reason when one was recorded at the gate sha", () => {
  const { db, ticketId } = makeTestDb();
  const ac = insertAc(db, {
    ticketId,
    seq: 1,
    text: "returns the created record",
    source: "checklist",
  });
  const check = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "api/tests/styre_checks/ENG-1_ac7_test.py::test_ac",
    testPath: "api/tests/styre_checks/ENG-1_ac7_test.py",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-gate",
    result: "fail",
    branchHeadSha: "S1",
    detail: { stillRed: [ac.id], tampered: [], advisory: [] },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: {
      acId: ac.id,
      acCheckId: check.id,
      blame: "code-wrong",
      reason: "returns 201 not 200",
    },
  });
  const fb = gateFeedback(db, ticketId);
  db.close();
  expect(fb).toContain("Arbiter blame");
  expect(fb).toContain("returns 201 not 200");
});
