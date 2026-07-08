import { expect, test } from "bun:test";
import { applyChecksVerdict } from "../../src/daemon/checks-verdict.ts";
import { insertAcCheck, listByTicket as listAcChecks } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function seedVacuous(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, seq: number) {
  const acId = insertAc(db, { ticketId, seq, text: `ac ${seq}`, source: "checklist" }).id;
  const row = insertAcCheck(db, { ticketId, acId, selector: `s${seq}`, redFirstResult: "green" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-classification",
    result: "fail",
    detail: { acCheckId: row.id, acId, class: "vacuous", reason: "trivial" },
  });
  return { acId, acCheckId: row.id };
}

function seedWeak(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, seq: number) {
  const acId = insertAc(db, { ticketId, seq, text: `ac ${seq}`, source: "checklist" }).id;
  const row = insertAcCheck(db, { ticketId, acId, selector: `s${seq}`, redFirstResult: "green" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-classification",
    result: "fail",
    detail: { acCheckId: row.id, acId, class: "weak", reason: "shallow assertion" },
  });
  return { acId, acCheckId: row.id };
}

test("no vacuous checks → clean", () => {
  const { db, ticketId } = makeTestDb();
  const acId = insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" }).id;
  insertAcCheck(db, { ticketId, acId, selector: "s", redFirstResult: "red" });
  expect(applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" })).toEqual({
    decision: "clean",
  });
  db.close();
});

test("a vacuous check loops back: flagged AC's checks deleted, checks:dispatch+classify reset, event appended, stage stays design", () => {
  const { db, ticketId } = makeTestDb();
  insertPending(db, { ticketId, stepKey: "checks:dispatch", stepType: "dispatch" });
  insertPending(db, { ticketId, stepKey: "checks:classify", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded'").run();
  seedVacuous(db, ticketId, 1);

  const res = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(res.decision).toBe("loopback");
  expect(listAcChecks(db, ticketId).length).toBe(0); // flagged AC's checks deleted
  expect(getByKey(db, ticketId, "checks:dispatch")?.status).toBe("pending");
  expect(getByKey(db, ticketId, "checks:classify")?.status).toBe("pending");
  expect(getTicket(db, ticketId)?.stage).toBe("design"); // no flip
  db.close();
});

test("repeated identical (ac_ids,vacuous) signature → escalate", () => {
  const { db, ticketId } = makeTestDb();
  const { acId } = seedVacuous(db, ticketId, 1);
  // Prior checks-loopback with the same signature.
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "checks",
    routeTo: "checks:classify",
    signature: `checks:${acId}`,
  });
  const res = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(res.decision).toBe("escalated");
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  db.close();
});

test("a weak-only AC triggers the re-author loopback", () => {
  const { db, ticketId } = makeTestDb();
  insertPending(db, { ticketId, stepKey: "checks:dispatch", stepType: "dispatch" });
  insertPending(db, { ticketId, stepKey: "checks:classify", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded'").run();
  seedWeak(db, ticketId, 1);

  const res = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(res.decision).toBe("loopback");
  expect(listAcChecks(db, ticketId).length).toBe(0); // flagged AC's checks deleted
  db.close();
});

test("an AC oscillating vacuous->weak still escalates (reason-agnostic signature)", () => {
  const { db, ticketId } = makeTestDb();
  // Current round: the same AC is now flagged 'weak' instead of 'vacuous'.
  const { acId } = seedWeak(db, ticketId, 1);
  // Prior checks-loopback was recorded while this AC was 'vacuous'. The signature format is
  // reason-agnostic (ac_ids only), so it's identical to what the current 'weak' round computes.
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "checks",
    routeTo: "checks:classify",
    signature: `checks:${acId}`,
  });

  // Same AC-id set -> same signature 'checks:<acId>' even though the reason differs -> escalate.
  const res = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(res.decision).toBe("escalated");
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  db.close();
});
