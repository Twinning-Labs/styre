import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { GATE_ROUND_CAP } from "../../src/daemon/arbiter-verdict.ts";
import { applyAcCheckGateVerdict } from "../../src/daemon/checks-gate-verdict.ts";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending, markRunning } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function gateSignal(
  db: Database,
  ticketId: number,
  args: { stillRed: number[]; tampered?: number[]; sha?: string },
) {
  return insertSignal(db, {
    ticketId,
    signalType: "ac-check-gate",
    result: args.stillRed.length === 0 ? "pass" : "fail",
    branchHeadSha: args.sha,
    detail: { stillRed: args.stillRed, tampered: args.tampered ?? [], advisory: [] },
  });
}

/** One verified unit + a `verify:checks-gate` step, its `attempt` bumped to the given count
 *  (mirrors real usage: `markRunning` is what advance.ts calls before dispatching a step). */
function seedUnitAndGateStep(db: Database, ticketId: number, attempt = 0) {
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const gateStep = insertPending(db, {
    ticketId,
    stepKey: "verify:checks-gate",
    stepType: "verify",
  });
  for (let i = 0; i < attempt; i++) markRunning(db, gateStep.id, {});
  return { unit, gateStep };
}

test("a passing ac-check-gate signal (stillRed=[]) → clean", () => {
  const { db, ticketId } = makeTestDb();
  gateSignal(db, ticketId, { stillRed: [] });
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  db.close();
  expect(r.decision).toBe("clean");
});

test("behavioral still-red DEFERS (clean) so the resolver can serve the arbiter", () => {
  const { db, ticketId } = makeTestDb();
  const { unit } = seedUnitAndGateStep(db, ticketId);
  gateSignal(db, ticketId, { stillRed: [4], tampered: [], sha: "S1" });
  const v = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const unitAfter = getUnit(db, unit.id);
  const gateAfter = getByKey(db, ticketId, "verify:checks-gate");
  db.close();
  expect(v.decision).toBe("clean"); // deferred — no route
  expect(unitAfter?.status).toBe("verified"); // NOT reset
  expect(gateAfter?.status).toBe("pending"); // NOT reset (was already pending — never touched)
});

test("integrity-only still-red loopbacks under the cap; units + gate step reset to pending", () => {
  const { db, ticketId } = makeTestDb();
  const { unit } = seedUnitAndGateStep(db, ticketId, GATE_ROUND_CAP - 1);
  gateSignal(db, ticketId, { stillRed: [7], tampered: [7], sha: "S1" });

  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const unitAfter = getUnit(db, unit.id);
  const gateAfter = getByKey(db, ticketId, "verify:checks-gate");
  const events = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement",
  );
  db.close();

  expect(r.decision).toBe("loopback");
  expect(unitAfter?.status).toBe("pending");
  expect(gateAfter?.status).toBe("pending");
  expect(gateAfter?.attempt).toBe(GATE_ROUND_CAP - 1); // resetToPending never touches attempt
  expect(events.length).toBe(1);
  expect(events[0]?.route_to).toBe("verify:checks-gate");
  expect(JSON.parse(events[0]?.payload_json ?? "{}").tampered).toEqual([7]);
});

test("gate loopback carries the verify:checks-gate dispatch_id", () => {
  const { db, ticketId } = makeTestDb();
  const { gateStep } = seedUnitAndGateStep(db, ticketId, GATE_ROUND_CAP - 1);
  insertDispatch(db, { ticketId, dispatchId: "T-d0003", seq: 1, stepId: gateStep.id });
  gateSignal(db, ticketId, { stillRed: [7], tampered: [7], sha: "S1" });
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const loopback = listEvents(db, ticketId).find((e) => e.kind === "loopback");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(loopback?.dispatch_id).toBe("T-d0003");
});

test("LIVENESS: behavioral still-red at the gate-round cap → escalated (closes the pure-code-wrong stuck-HEAD livelock)", () => {
  // A pure-code-wrong stuck-HEAD round: the re-implement commits nothing new, so the arbiter is
  // never re-served (blame already exists at HEAD) and checks:reauthor short-circuits to a no-op
  // 'clean' verdict (route===null guard) — the ONLY place left that can observe the round count is
  // the gate's own defer path, which previously deferred unconditionally with no cap check. This
  // proves the gate itself now closes the gap: once its OWN attempt (bumped by repeated re-serves
  // of verify:checks-gate, exactly as traced in the resolver) reaches the cap, behavioral still-red
  // escalates instead of deferring forever.
  const { db, ticketId } = makeTestDb();
  seedUnitAndGateStep(db, ticketId, GATE_ROUND_CAP);
  gateSignal(db, ticketId, { stillRed: [4], tampered: [], sha: "S1" });

  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  db.close();

  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
});

test("behavioral still-red UNDER the cap still defers (clean) — a healthy multi-round arbitration is not false-escalated", () => {
  const { db, ticketId } = makeTestDb();
  seedUnitAndGateStep(db, ticketId, GATE_ROUND_CAP - 1);
  gateSignal(db, ticketId, { stillRed: [4], tampered: [], sha: "S1" });

  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const ticket = getTicket(db, ticketId);
  db.close();

  expect(r.decision).toBe("clean"); // still defers to the arbiter — not yet at cap
  expect(ticket?.status).not.toBe("waiting");
});

test("integrity-only still-red at the gate-round cap → escalated, ticket waiting", () => {
  const { db, ticketId } = makeTestDb();
  seedUnitAndGateStep(db, ticketId, GATE_ROUND_CAP);
  gateSignal(db, ticketId, { stillRed: [7], tampered: [7], sha: "S1" });

  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  db.close();

  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
});
