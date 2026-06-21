import { expect, test } from "bun:test";
import {
  insertFinding,
  listByDispatch,
  listOpenByTicket,
  setStatus,
} from "../../../src/db/repos/review-finding.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertFinding persists fields and round-trips by dispatch", () => {
  const { db, ticketId } = makeTestDb();
  const f = insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: "ENG-1-d0005",
    severity: "major",
    category: "correctness",
    deferralCandidate: 0,
    blocksShip: 1,
    location: "src/a.ts:12",
    rationale: "off-by-one",
  });
  const byDispatch = listByDispatch(db, ticketId, "ENG-1-d0005");
  db.close();
  expect(byDispatch.length).toBe(1);
  expect(byDispatch[0]?.severity).toBe("major");
  expect(byDispatch[0]?.blocks_ship).toBe(1);
  expect(byDispatch[0]?.review_kind).toBe("code");
  expect(f.status).toBe("open");
});

test("listOpenByTicket returns only open; setStatus flips it", () => {
  const { db, ticketId } = makeTestDb();
  const f = insertFinding(db, { ticketId, reviewKind: "code", severity: "nit" });
  expect(listOpenByTicket(db, ticketId).length).toBe(1);
  setStatus(db, f.id, "fixed");
  const open = listOpenByTicket(db, ticketId);
  db.close();
  expect(open.length).toBe(0);
});
