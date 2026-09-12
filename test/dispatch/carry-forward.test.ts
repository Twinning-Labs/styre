import { expect, test } from "bun:test";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertSignal, listByTicket } from "../../src/db/repos/ground-truth-signal.ts";
import { carryVerifiedVerdictForward } from "../../src/dispatch/carry-forward.ts";
import { makeTestDb } from "../helpers/db.ts";

test("carries the integration signal verbatim (result+detail) to the new sha; ac-check-gate only if checks exist", () => {
  const { db, ticketId } = makeTestDb();
  // verified integration at V (advisory tox fail)
  insertSignal(db, {
    ticketId,
    signalType: "integration",
    result: "fail",
    command: "tox",
    branchHeadSha: "V",
    detail: { ran: [{ label: "backend:test", exitCode: 1 }], advisory: true },
  });
  // one active ac-check
  const ac = insertAc(db, { ticketId, seq: 1, text: "x", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });

  carryVerifiedVerdictForward(db, ticketId, "C1");

  const atC1 = listByTicket(db, ticketId).filter((s) => s.branch_head_sha === "C1");
  const integ = atC1.find((s) => s.signal_type === "integration");
  expect(integ?.result).toBe("fail");
  expect(JSON.parse(integ?.detail_json ?? "{}").advisory).toBe(true);
  expect(integ?.command).toBe("tox");
  const gate = atC1.find((s) => s.signal_type === "ac-check-gate");
  expect(gate?.result).toBe("pass");
  // The load-bearing invariant: both carried rows MUST be ticket-level (work_unit_id NULL), else
  // they fall outside passingShasFor/ranShasFor's `work_unit_id IS NULL` filter and the resolver
  // wedges instead of advancing. (T5 review — the mechanism, previously untested.)
  expect(integ?.work_unit_id).toBeNull();
  expect(gate?.work_unit_id).toBeNull();
});

test("no ac-check-gate carry when the ticket has no active checks", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, { ticketId, signalType: "integration", result: "pass", branchHeadSha: "V" });
  carryVerifiedVerdictForward(db, ticketId, "C1");
  const atC1 = listByTicket(db, ticketId).filter((s) => s.branch_head_sha === "C1");
  expect(atC1.some((s) => s.signal_type === "ac-check-gate")).toBe(false);
  expect(atC1.some((s) => s.signal_type === "integration")).toBe(true);
});

test("the carried integration signal names the head it was carried FROM (ENG-439)", () => {
  // `carriedFrom` is read by the evidence floor: the per-unit sweeps are NOT carried, so the floor
  // follows this back to find them. Asserted at the PRODUCER — the floor's own test builds the
  // carried signal by hand, so dropping this write would break the floor and fail nothing.
  const { db, ticketId } = makeTestDb();
  insertSignal(db, {
    ticketId,
    signalType: "integration",
    result: "fail",
    branchHeadSha: "V",
    detail: { ran: [{ label: "api:test", kind: "test", exitCode: 1 }], advisory: true },
  });
  carryVerifiedVerdictForward(db, ticketId, "W");
  const carried = listByTicket(db, ticketId)
    .filter((r) => r.signal_type === "integration" && r.branch_head_sha === "W")
    .at(-1);
  const detail = JSON.parse(carried?.detail_json ?? "{}");
  db.close();
  expect(detail.carriedForward).toBe(true);
  expect(detail.carriedFrom).toBe("V");
});

test("a second carry names the head IT carried from, never inheriting the first (ENG-439)", () => {
  // `...carried` replicates the previous detail wholesale, so a stale `carriedFrom` would ride
  // along and point the evidence floor two hops back — at a head where the per-unit sweeps it is
  // looking for do not live. `docs:revise` is journaled exactly-once so this cannot happen today;
  // the guard is one `?? null` and the cost of learning otherwise the hard way is a false
  // "verified".
  const { db, ticketId } = makeTestDb();
  insertSignal(db, {
    ticketId,
    signalType: "integration",
    result: "pass",
    branchHeadSha: "V",
    detail: { ran: [{ label: "api:test", kind: "test", exitCode: 0 }], advisory: true },
  });
  carryVerifiedVerdictForward(db, ticketId, "W");
  carryVerifiedVerdictForward(db, ticketId, "X");
  const latest = listByTicket(db, ticketId)
    .filter((r) => r.signal_type === "integration" && r.branch_head_sha === "X")
    .at(-1);
  const detail = JSON.parse(latest?.detail_json ?? "{}");
  db.close();
  expect(detail.carriedFrom).toBe("W"); // the head this hop came from, not "V"
});
