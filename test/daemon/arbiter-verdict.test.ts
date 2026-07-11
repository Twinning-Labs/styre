import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  GATE_ROUND_CAP,
  applyArbiterVerdict,
  applyReauthorVerdict,
} from "../../src/daemon/arbiter-verdict.ts";
import { latestChecksReauthorAcs } from "../../src/daemon/checks-verdict.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
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
import { checksFeedback } from "../../src/dispatch/checks-feedback.ts";
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

/** Seed a step already `succeeded` from a prior round (attempt bumps happen via markRunning as usual;
 *  markSucceeded then closes it out) — used to prove a check-wrong route RESETS it to pending. */
function seedSucceededStep(db: Database, ticketId: number, stepKey: string) {
  const s = insertPending(db, { ticketId, stepKey, stepType: "dispatch" });
  markRunning(db, s.id, {});
  markSucceeded(db, s.id, { ok: true });
  return s;
}

/** Bump a step's `attempt` N times via markRunning WITHOUT ever succeeding — mirrors the
 *  stuck-HEAD livelock scenario, where a step is repeatedly re-served but its round never resolves. */
function bumpAttempt(db: Database, ticketId: number, stepKey: string, times: number) {
  const s = insertPending(db, { ticketId, stepKey, stepType: "dispatch" });
  for (let i = 0; i < times; i++) markRunning(db, s.id, {});
  return s;
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

test("arbiter verdict: check-wrong routes to checks:reauthor (loop:'reauthor', NOT loop:'checks') — units + gate untouched, checks:reauthor reset to pending", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, 1);
  seedLatestDispatchSha(db, ticketId, "S1");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  // Simulate checks:reauthor having already succeeded a PRIOR round — this round's route must reset
  // it back to pending so the resolver re-serves it.
  seedSucceededStep(db, ticketId, "checks:reauthor");
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "check-wrong", reason: "positive AC contradiction" },
  });

  const v = applyArbiterVerdict(db, ticketId, { stepKey: "checks:arbitrate" });
  const unitAfter = getUnit(db, unit.id);
  const gateAfter = getByKey(db, ticketId, "verify:checks-gate");
  const reauthorAfter = getByKey(db, ticketId, "checks:reauthor");
  const loopbackEvents = listEvents(db, ticketId).filter((e) => e.kind === "loopback");
  const reauthorEvents = loopbackEvents.filter((e) => e.loop === "reauthor");
  const legacyChecksLoopEvents = loopbackEvents.filter((e) => e.loop === "checks");
  const legacyAcs = latestChecksReauthorAcs(db, ticketId);
  const legacyFeedback = checksFeedback(db, ticketId);
  db.close();

  expect(v.decision).toBe("loopback");
  // Units + the gate itself are untouched by the check-wrong route (only implement-loopback resets
  // units; this route is NOT an implement loopback).
  expect(unitAfter?.status).toBe("verified");
  expect(gateAfter?.status).toBe("running"); // unchanged (NOT reset to pending by this route)
  expect(gateAfter?.attempt).toBe(1);
  // checks:reauthor IS reset (from succeeded back to pending) so the resolver re-serves it.
  expect(reauthorAfter?.status).toBe("pending");
  // FIX I1: the routing event is loop:"reauthor", never loop:"checks" — the design-stage readers
  // (latestChecksReauthorAcs / checksFeedback) must never see it.
  expect(reauthorEvents.length).toBe(1);
  expect(reauthorEvents[0]?.route_to).toBe("checks:reauthor");
  expect(
    (JSON.parse(reauthorEvents[0]?.payload_json ?? "{}") as { acIds?: number[] }).acIds,
  ).toEqual([4]);
  expect((JSON.parse(reauthorEvents[0]?.payload_json ?? "{}") as { sha?: string }).sha).toBe("S1");
  expect(legacyChecksLoopEvents.length).toBe(0);
  expect(legacyAcs).toBeNull();
  expect(legacyFeedback).toBe("");
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

/** Seed the arbiter's `loop:"reauthor" routeTo:"checks:reauthor"` route event that
 *  `latestReauthorRoute`/`applyReauthorVerdict` read. */
function seedReauthorRoute(db: Database, ticketId: number, acIds: number[], sha: string) {
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "reauthor",
    routeTo: "checks:reauthor",
    signature: `arbiter:${acIds.join(",")}`,
    payload: { acIds, sha },
  });
}

test("reauthor verdict: pure check-wrong all installed → re-serves the gate (gate+arbiter reset, a payload-less gate:reauthored event, units untouched)", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, 1);
  seedSucceededStep(db, ticketId, "checks:arbitrate");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  seedReauthorRoute(db, ticketId, [4], "S1");
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "check-wrong", reason: "r" },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "pass",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, disposition: "installed" },
  });

  const v = applyReauthorVerdict(db, ticketId, { stepKey: "checks:reauthor" });
  const unitAfter = getUnit(db, unit.id);
  const gateAfter = getByKey(db, ticketId, "verify:checks-gate");
  const arbitrateAfter = getByKey(db, ticketId, "checks:arbitrate");
  const reauthoredEvent = listEvents(db, ticketId).find(
    (e) => e.kind === "loopback" && e.signature === "gate:reauthored",
  );
  db.close();

  expect(v.decision).toBe("loopback");
  expect(unitAfter?.status).toBe("verified"); // NOT reset — no re-code needed
  expect(gateAfter?.status).toBe("pending"); // reset so the resolver re-serves the gate
  expect(arbitrateAfter?.status).toBe("pending");
  expect(reauthoredEvent).toBeDefined();
  expect(reauthoredEvent?.route_to).toBe("verify:checks-gate");
  expect(reauthoredEvent?.payload_json).toBeNull(); // no acIds payload (§ the non-cross-wiring note)
});

test("reauthor verdict: mixed (a code-wrong blame present in the round) → loopback via gateOriginLoopback, units reset", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, 1);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  seedReauthorRoute(db, ticketId, [4, 5], "S1");
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "check-wrong", reason: "r" },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 5, acCheckId: 41, blame: "code-wrong", reason: "r2" },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "pass",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, disposition: "installed" },
  });

  const v = applyReauthorVerdict(db, ticketId, { stepKey: "checks:reauthor" });
  const unitAfter = getUnit(db, unit.id);
  db.close();

  expect(v.decision).toBe("loopback");
  expect(unitAfter?.status).toBe("pending"); // gateOriginLoopback: a real re-code is needed
});

test("reauthor verdict: all rejected → loopback via gateOriginLoopback, units reset (no silent pass)", () => {
  const { db, ticketId } = makeTestDb();
  seedGateStepWithAttempt(db, ticketId, 1);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  seedReauthorRoute(db, ticketId, [4], "S1");
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "check-wrong", reason: "r" },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, disposition: "rejected" },
  });

  const v = applyReauthorVerdict(db, ticketId, { stepKey: "checks:reauthor" });
  const unitAfter = getUnit(db, unit.id);
  db.close();

  expect(v.decision).toBe("loopback");
  expect(unitAfter?.status).toBe("pending");
});

test("reauthor verdict: no route → clean (no-op guard)", () => {
  const { db, ticketId } = makeTestDb();
  const v = applyReauthorVerdict(db, ticketId, { stepKey: "checks:reauthor" });
  db.close();
  expect(v.decision).toBe("clean");
});

test("reauthor verdict LIVENESS: a stuck-HEAD round (verify:checks-gate attempt never advances) still escalates once checks:reauthor's OWN attempt hits the cap", () => {
  const { db, ticketId } = makeTestDb();
  // The gate's own attempt is stuck below the cap (the livelock this closes: it never gets re-served
  // because blame already exists at the unchanged HEAD every cycle).
  seedGateStepWithAttempt(db, ticketId, 1);
  // checks:reauthor, in contrast, HAS been repeatedly re-served (resetToPending never touches attempt)
  // — its own attempt reaches the cap even though the gate's never does.
  bumpAttempt(db, ticketId, "checks:reauthor", GATE_ROUND_CAP);
  seedReauthorRoute(db, ticketId, [4], "S1");
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "check-wrong", reason: "r" },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, disposition: "rejected" },
  });

  const v = applyReauthorVerdict(db, ticketId, { stepKey: "checks:reauthor" });
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  const gateAfter = getByKey(db, ticketId, "verify:checks-gate");
  db.close();

  // Proves the livelock is closed: escalated even though the gate's OWN attempt (1) never reached
  // GATE_ROUND_CAP — only checks:reauthor's attempt did.
  expect(gateAfter?.attempt).toBeLessThan(GATE_ROUND_CAP);
  expect(v.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
});
