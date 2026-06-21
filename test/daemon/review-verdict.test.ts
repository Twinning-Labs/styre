import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { applyReviewVerdict } from "../../src/daemon/review-verdict.ts";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertFinding } from "../../src/db/repos/review-finding.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function seedReviewRound(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  // a succeeded review step (the resolver would have run it)
  const s = insertPending(db, { ticketId, stepKey: "review", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  const did = "T-d0001";
  insertDispatch(db, { ticketId, dispatchId: did, seq: 1, stepId: s.id, stage: "review" });
  return { unit, did };
}

test("clean review (no findings) → decision clean", () => {
  const { db, ticketId } = makeTestDb();
  seedReviewRound(db, ticketId);
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" }, { stepKey: "review" });
  db.close();
  expect(r.decision).toBe("clean");
});

test("blocking code finding → loopback to implement (unit + review step reset, stage implement)", () => {
  const { db, ticketId } = makeTestDb();
  const { unit, did } = seedReviewRound(db, ticketId);
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "major",
    category: "correctness",
    deferralCandidate: 0,
    blocksShip: 1,
    workUnitId: unit.id,
    location: "a.ts:1",
  });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" }, { stepKey: "review" });
  const ticket = getTicket(db, ticketId);
  const reviewStep = getByKey(db, ticketId, "review");
  const events = listEvents(db, ticketId);
  db.close();
  expect(r.decision).toBe("loopback");
  expect(ticket?.stage).toBe("implement");
  expect(reviewStep?.status).toBe("pending");
  expect(events.some((e) => e.kind === "loopback" && e.loop === "implement")).toBe(true);
});

test("blocking plan-defect, config escalate → escalated (parked on human_resume, stays open)", () => {
  const { db, ticketId } = makeTestDb();
  const { did } = seedReviewRound(db, ticketId);
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "critical",
    category: "plan-defect",
    deferralCandidate: 0,
    blocksShip: 1,
    location: null,
  });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" }, { stepKey: "review" });
  const ticket = getTicket(db, ticketId);
  const signals = listPending(db, ticketId);
  db.close();
  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(signals.some((s) => s.signal_type === "human_resume")).toBe(true);
});

test("blocking plan-defect, config redesign → loopback to design (units cleared, design+review steps reset)", () => {
  const { db, ticketId } = makeTestDb();
  const { did } = seedReviewRound(db, ticketId);
  // seed the design steps the redesign route resets
  for (const k of ["design:dispatch", "design:extract"]) {
    const s = insertPending(db, { ticketId, stepKey: k, stepType: "dispatch" });
    db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  }
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "major",
    category: "plan-defect",
    deferralCandidate: 0,
    blocksShip: 1,
    location: null,
  });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "redesign" }, { stepKey: "review" });
  const ticket = getTicket(db, ticketId);
  const units = listUnits(db, ticketId);
  const designStep = getByKey(db, ticketId, "design:dispatch");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(ticket?.stage).toBe("design");
  expect(units.length).toBe(0);
  expect(designStep?.status).toBe("pending");
});

test("non-blocking major + deferral_candidate → escalated", () => {
  const { db, ticketId } = makeTestDb();
  const { did } = seedReviewRound(db, ticketId);
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "major",
    category: "maintainability",
    deferralCandidate: 1,
    blocksShip: 0,
    location: "a.ts:2",
  });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" }, { stepKey: "review" });
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
});

test("no-progress guard: identical blocking signature in prior loopback event → escalated (not loopback)", () => {
  // The signature for a blocking finding {category:"correctness", location:"a.ts:1"} is:
  //   "review:correctness:a.ts:1"
  // Seed a prior loopback event carrying that exact signature so the guard fires.
  const { db, ticketId } = makeTestDb();
  const { did } = seedReviewRound(db, ticketId);
  const matchingSignature = "review:correctness:a.ts:1";
  // Append a prior loopback event with the same signature the guard will compute below.
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "implement",
    routeTo: "review",
    signature: matchingSignature,
  });
  // File a blocking finding whose computed signature matches the seeded event.
  insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: did,
    severity: "major",
    category: "correctness",
    deferralCandidate: 0,
    blocksShip: 1,
    location: "a.ts:1",
  });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" }, { stepKey: "review" });
  const ticket = getTicket(db, ticketId);
  const signals = listPending(db, ticketId);
  db.close();
  // Guard fires: escalated instead of looping back again.
  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(signals.some((s) => s.signal_type === "human_resume")).toBe(true);
  // Proof the guard is doing the work: WITHOUT the matching prior loopback event the same
  // finding would produce decision "loopback" (see "blocking code finding" test above).
});

test("plan review: a blocking plan finding loops back to re-design", () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'design', track = 'full' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  for (const k of ["design:dispatch", "design:extract", "design:review"]) {
    const s = insertPending(db, { ticketId, stepKey: k, stepType: "dispatch" });
    db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  }
  const drStep = getByKey(db, ticketId, "design:review");
  if (!drStep) throw new Error("design:review step missing");
  const did = "T-dr01";
  insertDispatch(db, { ticketId, dispatchId: did, seq: 1, stepId: drStep.id, stage: "design" });
  insertFinding(db, {
    ticketId,
    reviewKind: "plan",
    dispatchId: did,
    severity: "critical",
    category: "feasibility",
    deferralCandidate: 0,
    blocksShip: 1,
    location: "plan:1",
  });
  const r = applyReviewVerdict(db, ticketId, DEFAULT_RUNTIME_CONFIG, { stepKey: "design:review" });
  const ticket = getTicket(db, ticketId);
  const units = listUnits(db, ticketId);
  const drAfter = getByKey(db, ticketId, "design:review");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(ticket?.stage).toBe("design");
  expect(units.length).toBe(0); // deleteByTicket cleared units for a fresh re-extract
  expect(drAfter?.status).toBe("pending"); // design:review reset so the NEW plan is re-reviewed
});

test("plan review: a clean round advances (no blocking findings)", () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'design', track = 'full' WHERE id = ?").run(ticketId);
  const s = insertPending(db, { ticketId, stepKey: "design:review", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  insertDispatch(db, { ticketId, dispatchId: "T-dr02", seq: 1, stepId: s.id, stage: "design" });
  // no findings filed → clean
  const r = applyReviewVerdict(db, ticketId, DEFAULT_RUNTIME_CONFIG, { stepKey: "design:review" });
  db.close();
  expect(r.decision).toBe("clean");
});

test("plan review: repeated identical blocking round escalates (no-progress)", () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'design', track = 'full' WHERE id = ?").run(ticketId);
  const s = insertPending(db, { ticketId, stepKey: "design:review", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  const did = "T-dr03";
  insertDispatch(db, { ticketId, dispatchId: did, seq: 1, stepId: s.id, stage: "design" });
  insertFinding(db, {
    ticketId,
    reviewKind: "plan",
    dispatchId: did,
    severity: "major",
    category: "scope",
    deferralCandidate: 0,
    blocksShip: 1,
    location: "plan:7",
  });
  // a prior design loopback with the SAME signature (review:scope:plan:7)
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "design:review",
    signature: "review:scope:plan:7",
  });
  const r = applyReviewVerdict(db, ticketId, DEFAULT_RUNTIME_CONFIG, { stepKey: "design:review" });
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
});
