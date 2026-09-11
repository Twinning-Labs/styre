import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { GATE_ROUND_CAP } from "../../src/daemon/arbiter-verdict.ts";
import { applyAcCheckGateVerdict } from "../../src/daemon/checks-gate-verdict.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
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

/** An AC check that RAN and came back green at `sha` — the primary form of verify evidence. */
function provenAc(db: Database, ticketId: number, acId: number, sha: string) {
  return insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: sha,
    detail: { acCheckId: acId * 10, acId, coarse: "green", redClass: "assertion" },
  });
}

/** A component test sweep at `sha` — the coarser, second form of evidence. */
function suite(db: Database, ticketId: number, sha: string, result: "pass" | "fail") {
  return insertSignal(db, {
    ticketId,
    signalType: "test",
    result,
    branchHeadSha: sha,
    detail: { ran: [{ component: "api", exitCode: result === "pass" ? 0 : 1 }] },
  });
}

test("a passing ac-check-gate signal (stillRed=[]) WITH a proven AC → clean", () => {
  const { db, ticketId } = makeTestDb();
  gateSignal(db, ticketId, { stillRed: [], sha: "S1" });
  provenAc(db, ticketId, 1, "S1");
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  db.close();
  expect(r.decision).toBe("clean");
});

/**
 * ENG-424 — THE EVIDENCE FLOOR.
 *
 * These pin the invariant django__django-12325 violated: it reached `pr-ready` with 16 ticks,
 * 0 escalations, 0 loopbacks, a real pull request — and not one acceptance criterion ever
 * executed. Its single check hit `No module named pytest`, was correctly classified
 * `environmental`, and an environmental red is permanently advisory. The gate then saw
 * `stillRed: []` and called it clean.
 *
 * An empty still-red set is not the same claim as "verified".
 */
/** An AC check that RAN and came back RED at `sha` — django's advisory environmental check.
 *  It emits an `ac-check-post-implement` signal just like a green one, so the floor must read
 *  `coarse`, not merely the signal's presence. */
function unprovenAc(db: Database, ticketId: number, acId: number, sha: string) {
  return insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "fail",
    branchHeadSha: sha,
    detail: {
      acCheckId: acId * 10,
      acId,
      coarse: "red",
      redClass: "environmental",
      outcome: "advisory-red",
      rawOutput: "No module named pytest",
    },
  });
}

test("stillRed=[] but NOTHING was proven and no suite passed → escalated, not clean", () => {
  const { db, ticketId } = makeTestDb();
  // django-12325's exact shape: one AC check that RAN and came back red, classified
  // environmental so it never gated, plus a failing suite — and a gate that passed anyway.
  // The post-implement signal EXISTS here; only its `coarse` says it proved nothing.
  gateSignal(db, ticketId, { stillRed: [], sha: "S1" });
  unprovenAc(db, ticketId, 1, "S1");
  suite(db, ticketId, "S1", "fail");
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const events = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(r.decision).toBe("escalated");
  expect(events).toHaveLength(1);
  expect(events[0]?.signature).toBe("evidence-floor");
  expect(events[0]?.reason).toMatch(/verified nothing/);
  expect(ticket?.status).toBe("waiting");
});

test("a green test suite ALONE satisfies the floor (docs-only / not-expressible tickets)", () => {
  // No AC check can be expressed for some tickets. That must not force an escalation when the
  // repo's own suite ran green over the change.
  const { db, ticketId } = makeTestDb();
  gateSignal(db, ticketId, { stillRed: [], sha: "S1" });
  suite(db, ticketId, "S1", "pass");
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  db.close();
  expect(r.decision).toBe("clean");
});

test("evidence from an EARLIER head is not evidence about the head being gated", () => {
  // A pass recorded against S0 is a fact about S0. Counting it at S1 would be the same
  // category of error the floor exists to delete.
  const { db, ticketId } = makeTestDb();
  provenAc(db, ticketId, 1, "S0");
  suite(db, ticketId, "S0", "pass");
  gateSignal(db, ticketId, { stillRed: [], sha: "S1" });
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  db.close();
  expect(r.decision).toBe("escalated");
});

test("a ticket with NO ac-checks at all (no gate signal) still faces the floor", () => {
  // `verify:checks-gate` returns early when there are no checks, so it writes no signal and
  // `latestGate` finds none. That route reached `clean` too — zero checks is zero evidence.
  const { db, ticketId } = makeTestDb();
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  db.close();
  expect(r.decision).toBe("escalated");
});

test("no gate signal, but the suite passed at the dispatch head → clean", () => {
  // The same no-checks route, with real evidence: the floor must read the head off the latest
  // dispatch when there is no gate signal to carry one.
  const { db, ticketId } = makeTestDb();
  const seq = nextSeq(db, ticketId);
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: `d-${seq}`,
    seq,
    stage: "implement",
    model: "m",
  });
  // `branch_head_sha` lands at COMPLETION, not insert — and `getLatestForTicket` only returns
  // rows that have one, which is exactly the head the floor should judge against.
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "S9" });
  suite(db, ticketId, "S9", "pass");
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

test("gate loopback carries the code dispatch's dispatch_id (the gate itself has no dispatch row)", () => {
  const { db, ticketId } = makeTestDb();
  seedUnitAndGateStep(db, ticketId, GATE_ROUND_CAP - 1);
  // The gate is an in-process handler with no dispatch of its own — getLatestForTicket finds the
  // CODE dispatch instead (the latest dispatch WITH a branch_head_sha, i.e. the HEAD the gate
  // judged). Mirrors arbiter-verdict.test.ts's seedLatestDispatchSha pattern.
  const codeDisp = insertDispatch(db, {
    ticketId,
    dispatchId: "CODE-d0001",
    seq: nextSeq(db, ticketId),
  });
  completeDispatch(db, codeDisp.id, { outcome: "clean-success", branchHeadSha: "S1" });
  gateSignal(db, ticketId, { stillRed: [7], tampered: [7], sha: "S1" });
  const r = applyAcCheckGateVerdict(db, ticketId, { stepKey: "verify:checks-gate" });
  const loopback = listEvents(db, ticketId).find((e) => e.kind === "loopback");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(loopback?.dispatch_id).toBe("CODE-d0001");
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
