import { expect, test } from "bun:test";
import { applyChecksVerdict } from "../../src/daemon/checks-verdict.ts";
import {
  classifyAcCheck,
  insertAcCheck,
  listByTicket,
  reauthorRoundsForAc,
} from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

test("no unresolved active checks → clean", () => {
  const { db, ticketId } = makeTestDb();
  insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  // a resolved (red_class set) active check → nothing to re-author
  const r = insertAcCheck(db, { ticketId, acId: 1, selector: "s", testPath: "p" });
  classifyAcCheck(db, { acCheckId: r.id, redClass: "assertion" });
  expect(applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }).decision).toBe("clean");
  db.close();
});

test("a weak/vacuous active check (unresolved) → loopback; the flagged row is SUPERSEDED (not deleted)", () => {
  const { db, ticketId } = makeTestDb();
  insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  const r = insertAcCheck(db, { ticketId, acId: 1, selector: "s", testPath: "p" }); // NULL/NULL = flagged
  expect(applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }).decision).toBe(
    "loopback",
  );
  expect(listByTicket(db, ticketId).find((x) => x.id === r.id)?.superseded_at).not.toBeNull(); // row still present, superseded
  expect(reauthorRoundsForAc(db, 1)).toBe(1);
  const ev = listEvents(db, ticketId)
    .filter((e) => e.loop === "checks")
    .at(-1);
  expect(JSON.parse(ev?.payload_json ?? "{}").acIds).toEqual([1]); // scopes checks:dispatch
  db.close();
});

test("the SAME AC flagged a second time (already superseded once) → escalate (counter ≥ cap)", () => {
  const { db, ticketId } = makeTestDb();
  insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: 1, selector: "s", testPath: "p" });
  applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }); // round 1 → superseded (count 1), loopback
  // Backdate round 1's superseded_at so round 2 below is guaranteed a distinct timestamp — ms-
  // resolution nowUtc() could otherwise collide across two live rounds driven synchronously in this
  // test (see the robustness note on reauthorRoundsForAc, Task 3b); production rounds are always
  // seconds apart (a real re-author dispatch), so this only compensates for test speed.
  db.query(
    "UPDATE ac_check SET superseded_at = ? WHERE ac_id = ? AND superseded_at IS NOT NULL",
  ).run("2020-01-01T00:00:00.000Z", 1);
  insertAcCheck(db, { ticketId, acId: 1, selector: "s2", testPath: "p2" }); // dispatch re-author, still flagged
  expect(applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }).decision).toBe(
    "escalated",
  );
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  db.close();
});

test("reason-agnostic: an AC flagged twice escalates regardless of vacuous-vs-weak (counter, not signature)", () => {
  // identical to above — the reason is never read; two re-author rounds of the same AC escalate.
  const { db, ticketId } = makeTestDb();
  insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: 1, selector: "s", testPath: "p" });
  applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  // Backdate round 1's superseded_at — see the robustness note in the test above.
  db.query(
    "UPDATE ac_check SET superseded_at = ? WHERE ac_id = ? AND superseded_at IS NOT NULL",
  ).run("2020-01-01T00:00:00.000Z", 1);
  insertAcCheck(db, { ticketId, acId: 1, selector: "s2", testPath: "p2" });
  expect(applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }).decision).toBe(
    "escalated",
  );
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  db.close();
});

test("a multi-check AC (2 active checks) escalates on the 2nd re-author ROUND, not on hitting 2 superseded ROWS", () => {
  // AC 1 owns TWO active checks (multiple test cases per one AC — supported + tested elsewhere, e.g.
  // ac-check-classify.test.ts inserts 2 checks for one AC). Round 1 leaves BOTH unresolved (one
  // vacuous, say) → applyChecksVerdict's single supersedeByAc(1) call supersedes BOTH rows under ONE
  // shared timestamp = ONE round. This must be loopback, NOT escalate — a naive COUNT(*) of superseded
  // rows would already read 2 here and wrongly escalate on the first flag (the Critical this pins).
  const { db, ticketId } = makeTestDb();
  insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: 1, selector: "s1", testPath: "p1" });
  insertAcCheck(db, { ticketId, acId: 1, selector: "s2", testPath: "p2" });
  const round1 = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(round1.decision).toBe("loopback"); // NOT escalated, despite 2 rows superseded
  expect(reauthorRoundsForAc(db, 1)).toBe(1); // ONE round

  // Backdate round 1's superseded_at so round 2 below is guaranteed a distinct timestamp — ms-
  // resolution nowUtc() could otherwise collide across two live rounds driven synchronously in this
  // test (see the robustness note on reauthorRoundsForAc, Task 3b); production rounds are always
  // seconds apart (a real re-author dispatch), so this only compensates for test speed.
  db.query(
    "UPDATE ac_check SET superseded_at = ? WHERE ac_id = ? AND superseded_at IS NOT NULL",
  ).run("2020-01-01T00:00:00.000Z", 1);

  // Round 2: dispatch re-authors a single fresh active check for AC 1, still flagged.
  insertAcCheck(db, { ticketId, acId: 1, selector: "s3", testPath: "p3" });
  const round2 = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(round2.decision).toBe("escalated"); // 2nd round ⇒ cap reached
  expect(reauthorRoundsForAc(db, 1)).toBe(2);
  db.close();
});

test("checks loopback carries the checks:classify dispatch_id", () => {
  const { db, ticketId } = makeTestDb();
  const cls = insertPending(db, { ticketId, stepKey: "checks:classify", stepType: "dispatch" });
  insertDispatch(db, { ticketId, dispatchId: "T-d0002", seq: 1, stepId: cls.id });
  insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: 1, selector: "s", testPath: "p" });
  const r = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  const loopback = listEvents(db, ticketId).find((e) => e.kind === "loopback");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(loopback?.dispatch_id).toBe("T-d0002");
});
