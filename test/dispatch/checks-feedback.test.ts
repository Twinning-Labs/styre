import { expect, test } from "bun:test";
import { applyChecksVerdict } from "../../src/daemon/checks-verdict.ts";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { checksFeedback } from "../../src/dispatch/checks-feedback.ts";
import { makeTestDb } from "../helpers/db.ts";

test("checksFeedback is empty with no prior checks loopback", () => {
  const { db, ticketId } = makeTestDb();
  expect(checksFeedback(db, ticketId)).toBe("");
  db.close();
});

// Regression (Task 3e): Task 3d's simplified `{ acIds }`-only loopback payload silently dropped
// `findings`, so `checksFeedback` — which reads `payload_json.findings` — ALWAYS returned "" after a
// re-author loopback. The re-author `checks:dispatch` prompt went plan-blind (no "why the prior check
// was vacuous" text). This must FAIL against that `{ acIds }`-only payload.
test("checksFeedback surfaces the classification reason after a vacuous re-author loopback", () => {
  const { db, ticketId } = makeTestDb();
  insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  const check = insertAcCheck(db, { ticketId, acId: 1, selector: "s", testPath: "p" });
  // The classification signal `checks:classify` records for a vacuous verdict (§ handlers.ts) — read
  // by the verdict via the check's LIVE row id, DISPLAY-sourcing only (not control flow: the verdict's
  // decision of which ACs are flagged comes from `ac_check.red_class`/`disposition`, unaffected here).
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-classification",
    result: "fail",
    detail: {
      acCheckId: check.id,
      acId: 1,
      class: "vacuous",
      reason: "asserts on a constant, never exercises the new branch",
    },
  });
  const verdict = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(verdict.decision).toBe("loopback");
  const out = checksFeedback(db, ticketId);
  db.close();
  expect(out).toContain("asserts on a constant, never exercises the new branch");
  expect(out).toContain("AC 1");
});

test("checksFeedback reads the most recent checks loopback, not an earlier one", () => {
  const { db, ticketId } = makeTestDb();
  // Two DISTINCT ACs (not two rounds of the same AC) so both loopbacks stay "first round" — an escalate
  // is a separate concern (covered in checks-verdict.test.ts) and would suppress the 2nd loopback event.
  insertAc(db, { ticketId, seq: 1, text: "ac1", source: "checklist" });
  insertAc(db, { ticketId, seq: 2, text: "ac2", source: "checklist" });
  const round1 = insertAcCheck(db, { ticketId, acId: 1, selector: "s1", testPath: "p1" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-classification",
    result: "fail",
    detail: { acCheckId: round1.id, acId: 1, class: "vacuous", reason: "OLD-REASON" },
  });
  applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }); // AC 1 flagged: superseded, loopback
  const round2 = insertAcCheck(db, { ticketId, acId: 2, selector: "s2", testPath: "p2" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-classification",
    result: "fail",
    detail: { acCheckId: round2.id, acId: 2, class: "weak", reason: "NEW-REASON" },
  });
  applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }); // AC 2 flagged: superseded, loopback
  const out = checksFeedback(db, ticketId);
  db.close();
  expect(out).toContain("NEW-REASON");
  expect(out).not.toContain("OLD-REASON");
});
