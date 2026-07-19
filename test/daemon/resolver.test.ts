import { expect, test } from "bun:test";
import { nextActionableUnit, nextStepKey, nextUnrunCheck } from "../../src/daemon/resolver.ts";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { insertPending, markDelivered } from "../../src/db/repos/signal.ts";
import { setNeedsDocs, setTicketStage, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { getById, insertWorkUnit, setStatus } from "../../src/db/repos/work-unit.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

// helper: journal a step straight to succeeded (simulates a completed step for the resolver to read)
async function succeed(db: Parameters<typeof runStep>[0], ticketId: number, stepKey: string) {
  await runStep(db, { ticketId, stepKey, stepType: "dispatch", execute: () => ({ ok: true }) });
}

test("design: first asks for provision (hoisted before the design dispatches)", async () => {
  const { db, ticketId } = makeTestDb();
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
  await succeed(db, ticketId, "provision");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "design:dispatch",
    stepType: "dispatch",
    handlerKey: "design:dispatch",
    workUnitId: null,
  });
});

test("design: after provision + dispatch with no work units, asks for design:extract", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "design:dispatch");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("design:extract");
});

test("design: provision + units present + track unset → routes to design:size", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "design:dispatch");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "design:size",
    stepType: "dispatch",
    handlerKey: "design:size",
    workUnitId: null,
  });
});

test("design fast-track: units + track=fast → provision, then checks:dispatch, then advance", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "design:dispatch");
  setTicketTrack(db, ticketId, "fast");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
  await succeed(db, ticketId, "provision");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "checks:dispatch" });
  await succeed(db, ticketId, "checks:dispatch");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "checks:classify" });
  await succeed(db, ticketId, "checks:classify");
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "advance", from: "design", to: "implement" });
  db.close();
});

test("design full-track: after design:review, still routes through provision → checks:dispatch → advance", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "design:dispatch");
  setTicketTrack(db, ticketId, "full");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  await succeed(db, ticketId, "design:review");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
  await succeed(db, ticketId, "provision");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "checks:dispatch" });
  await succeed(db, ticketId, "checks:dispatch");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "checks:classify" });
  await succeed(db, ticketId, "checks:classify");
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "advance", from: "design", to: "implement" });
  db.close();
});

test("design full-track: provision + units + track=full, asks for design:review before advancing", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "design:dispatch");
  setTicketTrack(db, ticketId, "full");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("design:review");
});

test("implement: a pending unit asks for its dispatch step", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
    handlerKey: "implement:dispatch",
    workUnitId: expect.any(Number),
  });
});

test("implement: a verifying unit with an unrun check asks for the verify step", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "completeness:wu1");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "verify:wu1:test",
    stepType: "verify",
    handlerKey: "verify:check",
    workUnitId: u.id,
  });
});

test("implement: a verifying unit routes to completeness after provision, before verify", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  await succeed(db, ticketId, "provision");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "completeness:wu1",
    stepType: "completeness",
    handlerKey: "completeness",
    workUnitId: u.id,
  });
});

test("implement: a verifying unit whose checks all have signals asks to mark-verified", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  // Record the coding attempt at a known commit, then stamp the PASS signal at that same SHA
  // (realistic shape: commit-keyed verification requires a dispatch with branch_head_sha)
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
    workUnitId: u.id,
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: "sha-abc" });
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "test",
    result: "pass",
    branchHeadSha: "sha-abc",
  });
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "completeness:wu1");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "mark-verified", workUnitId: u.id });
});

test("implement: all units verified + no docs → verify:integration then advance to review", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  expect(u.status).toBe("verified");
  await succeed(db, ticketId, "provision");
  const beforeIntegration = nextStepKey(db, ticketId);
  expect(beforeIntegration.kind === "step" && beforeIntegration.handlerKey).toBe(
    "verify:integration",
  );
  // Simulate the integration verify handler completing: record a dispatch with branch_head_sha
  // and stamp a ticket-level PASS integration signal at that SHA (content-keyed integration gate).
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: "sha-abc" });
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "integration",
    result: "pass",
    branchHeadSha: "sha-abc",
  });
  const afterIntegration = nextStepKey(db, ticketId);
  db.close();
  expect(afterIntegration).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("implement: a FAILED integration signal at HEAD still advances past verify:integration (ran-at-sha, M4 §8c)", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  expect(u.status).toBe("verified");
  await succeed(db, ticketId, "provision");
  const beforeIntegration = nextStepKey(db, ticketId);
  expect(beforeIntegration.kind === "step" && beforeIntegration.handlerKey).toBe(
    "verify:integration",
  );
  // Simulate the demoted integration handler: an advisory FAIL (not a pass) recorded at HEAD.
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: "sha-abc" });
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "integration",
    result: "fail",
    branchHeadSha: "sha-abc",
    detail: { advisory: true },
  });
  const afterIntegration = nextStepKey(db, ticketId);
  db.close();
  // Advanced past integration — NOT re-emitted (would be a MAX_TRANSITIONS-class deadlock under
  // the old passingShasFor gate, since this signal is a fail, never a pass).
  expect(afterIntegration).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("implement: all units verified + an active ac_check + no gate pass at HEAD → verify:checks-gate (after provision)", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const ac = insertAc(db, { ticketId, seq: 1, text: "does the thing", source: "checklist" });
  insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "tests/test_x.py::test_thing",
    testPath: "tests/test_x.py",
  });
  // Provision gates the gate step too (mirrors the integration gate's provision hoist).
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
  await succeed(db, ticketId, "provision");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "verify:checks-gate",
    stepType: "verify",
    handlerKey: "verify:checks-gate",
    workUnitId: null,
  });
});

test("resolver serves checks:arbitrate when the gate failed with behavioral still-red and no blame yet", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const ac = insertAc(db, { ticketId, seq: 1, text: "does the thing", source: "checklist" });
  insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "tests/test_x.py::test_thing",
    testPath: "tests/test_x.py",
  });
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: "S1" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-gate",
    result: "fail",
    branchHeadSha: "S1",
    detail: { stillRed: [ac.id], tampered: [], advisory: [] },
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toMatchObject({ stepKey: "checks:arbitrate", handlerKey: "checks:arbitrate" });
});

test("resolver does NOT re-serve checks:arbitrate once a blame exists at the gate sha (falls through to checks:reauthor)", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const ac = insertAc(db, { ticketId, seq: 1, text: "does the thing", source: "checklist" });
  insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "tests/test_x.py::test_thing",
    testPath: "tests/test_x.py",
  });
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: "S1" });
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
    detail: { acId: ac.id, acCheckId: 1, blame: "code-wrong", reason: "r" },
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  // falls through past the arbiter arm — blame exists, checks:reauthor is pending (not yet run this
  // round) → served next.
  expect(d).toMatchObject({ stepKey: "checks:reauthor", handlerKey: "checks:reauthor" });
});

test("resolver falls through past checks:reauthor once it has succeeded this round (HEAD unchanged) — serves provision then the gate", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const ac = insertAc(db, { ticketId, seq: 1, text: "does the thing", source: "checklist" });
  insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "tests/test_x.py::test_thing",
    testPath: "tests/test_x.py",
  });
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: "S1" });
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
    detail: { acId: ac.id, acCheckId: 1, blame: "check-wrong", reason: "r" },
  });
  await succeed(db, ticketId, "checks:reauthor"); // this round's reauthor already ran; HEAD is still S1
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
  await succeed(db, ticketId, "provision");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toMatchObject({ stepKey: "verify:checks-gate" });
});

test("implement: needs_docs routes through docs:revise before advancing", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  setNeedsDocs(db, ticketId, 1);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  // Simulate integration verify complete: dispatch with branch_head_sha + matching PASS signal
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: "sha-abc" });
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "integration",
    result: "pass",
    branchHeadSha: "sha-abc",
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("docs:revise");
});

test("review: asks for review then advances to merge", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "review");
  const before = nextStepKey(db, ticketId);
  expect(before.kind === "step" && before.handlerKey).toBe("review");
  await succeed(db, ticketId, "review");
  const after = nextStepKey(db, ticketId);
  db.close();
  expect(after).toEqual({ kind: "advance", from: "review", to: "merge" });
});

test("merge: push → pr-ensure → wait human → advance to released", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "merge");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("merge:push");
  await succeed(db, ticketId, "merge:push");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("merge:pr-ensure");
  await succeed(db, ticketId, "merge:pr-ensure");
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "wait", signalType: "human_merge_approval" });
  const human = insertPending(db, { ticketId, signalType: "human_merge_approval" });
  markDelivered(db, human.id);
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "merge", to: "released" });
});

test("released: runs released:project then reports done", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "released");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("released:project");
  await succeed(db, ticketId, "released:project");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "done" });
});

test("provision succeeded in design is reused in implement (gate finds it done, no re-provision)", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision"); // as if provision ran at design-HEAD
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  // provision is already done → the implement gate skips it and asks completeness next
  expect(d).toMatchObject({ stepKey: "completeness:wu1" });
});

test("provision runs once before the first unit verify", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  expect(nextStepKey(db, ticketId)).toEqual({
    kind: "step",
    stepKey: "provision",
    stepType: "provision",
    handlerKey: "provision",
    workUnitId: null,
  });
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "completeness:wu1");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "verify:wu1:test" });
  db.close();
});

test("provision also gates verify:integration when units have no per-unit checks", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "data",
    verifyCheckTypes: [],
    status: "verifying",
  });
  // all units verified with no checks -> integration; provision must gate it
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
  db.close();
});

test("nextActionableUnit: dep-gating — wu2 gated until wu1 verified", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const wu1 = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "backend",
    verifyCheckTypes: ["test"],
    dependsOn: [1],
  });
  // wu1 is pending, wu2 dep not satisfied — should return wu1
  const first = nextActionableUnit(db, ticketId);
  expect(first?.seq).toBe(1);
  // mark wu1 verified — wu2 dep is now satisfied
  setStatus(db, wu1.id, "verified");
  const second = nextActionableUnit(db, ticketId);
  db.close();
  expect(second?.seq).toBe(2);
});

test("nextStepKey: blocked descriptor when unit is neither pending/verifying nor verified", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "blocked",
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "blocked", reason: "no actionable unit and not all units verified" });
});

test("nextUnrunCheck: returns first check-type lacking a signal", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test", "integration"],
    status: "verifying",
  });
  // Record a coding attempt at a known commit, then stamp the "test" PASS at that same SHA
  // so "test" is satisfied at the current commit and "integration" is returned as the next unrun check
  const disp = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
    workUnitId: u.id,
  });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: "sha-abc" });
  insertSignal(db, {
    ticketId,
    workUnitId: u.id,
    signalType: "test",
    result: "pass",
    branchHeadSha: "sha-abc",
  });
  const check = nextUnrunCheck(db, u);
  db.close();
  expect(check).toBe("integration");
});

test("nextUnrunCheck: a check that passed at an OLD commit is unrun at the new commit", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  setStatus(db, unit.id, "verifying");
  // latest coding attempt is at commit "new"
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0002",
    seq: nextSeq(db, ticketId),
    workUnitId: unit.id,
  });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "new" });
  // a stale PASS from a previous commit
  insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "pass",
    branchHeadSha: "old",
  });
  const u = getById(db, unit.id);
  if (!u) throw new Error("no unit");
  const check = nextUnrunCheck(db, u);
  db.close();
  expect(check).toBe("test"); // stale pass does NOT satisfy the current commit
});

test("nextUnrunCheck: a FAIL at the current commit still satisfies the check (advisory ran-at-sha, M4 §8b)", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test", "build"],
  });
  setStatus(db, unit.id, "verifying");
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0003",
    seq: nextSeq(db, ticketId),
    workUnitId: unit.id,
  });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "cur" });
  // A recorded advisory FAIL — not a pass — at the current commit.
  insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "fail",
    branchHeadSha: "cur",
    detail: { advisory: true },
  });
  const u = getById(db, unit.id);
  if (!u) throw new Error("no unit");
  const check = nextUnrunCheck(db, u);
  db.close();
  // "test" ran (fail recorded) → satisfied; "build" never ran → next unrun check.
  expect(check).toBe("build");
});

test("nextUnrunCheck: an ERROR (could-not-run) at the current commit does NOT satisfy the check (codex P1)", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test", "build"],
  });
  setStatus(db, unit.id, "verifying");
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0009",
    seq: nextSeq(db, ticketId),
    workUnitId: unit.id,
  });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "cur" });
  // A could-not-run error (empty-diff / no-components / infra crash) recorded at the current commit.
  // Unlike pass/fail this is NOT a verdict — the check never evaluated, so it must be re-served
  // (failure-policy's could-not-run retry), never swallowed into a silent advance.
  insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "error",
    branchHeadSha: "cur",
    detail: { reason: "empty-diff" },
  });
  const u = getById(db, unit.id);
  if (!u) throw new Error("no unit");
  const check = nextUnrunCheck(db, u);
  db.close();
  // "test" only has an error at cur → NOT satisfied → it is the first unrun check (re-served).
  expect(check).toBe("test");
});

test("nextUnrunCheck: a PASS at the current commit satisfies the check", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  setStatus(db, unit.id, "verifying");
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0002",
    seq: nextSeq(db, ticketId),
    workUnitId: unit.id,
  });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "cur" });
  insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "pass",
    branchHeadSha: "cur",
  });
  const u = getById(db, unit.id);
  if (!u) throw new Error("no unit");
  const check = nextUnrunCheck(db, u);
  db.close();
  expect(check).toBeNull(); // satisfied → resolver will mark-verified
});
