import { expect, test } from "bun:test";
import * as acChecks from "../../../src/db/repos/ac-check.ts";
import * as acs from "../../../src/db/repos/acceptance-criterion.ts";
import { makeTestDb } from "../../helpers/db.ts";

function seedAc(db: Parameters<typeof acs.insertAc>[0], ticketId: number, seq = 1): number {
  return acs.insertAc(db, { ticketId, seq, text: "ac", source: "checklist" }).id;
}

test("insertAcCheck round-trips; RED-first columns default to NULL", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  const row = acChecks.insertAcCheck(db, {
    ticketId,
    acId,
    selector: "tests/test_api.py::test_returns_200",
    testPath: "tests/test_api.py",
  });
  db.close();
  expect(row.ac_id).toBe(acId);
  expect(row.selector).toBe("tests/test_api.py::test_returns_200");
  expect(row.test_path).toBe("tests/test_api.py");
  expect(row.red_first_result).toBeNull();
  expect(row.red_class).toBeNull();
});

test("test_path is optional (NULL when omitted)", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  const row = acChecks.insertAcCheck(db, { ticketId, acId, selector: "-k returns_200" });
  db.close();
  expect(row.test_path).toBeNull();
});

test("listByTicket and listByAc return inserted rows", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s1" });
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s2" });
  const byTicket = acChecks.listByTicket(db, ticketId);
  const byAc = acChecks.listByAc(db, acId);
  db.close();
  expect(byTicket.map((r) => r.selector).sort()).toEqual(["s1", "s2"]);
  expect(byAc.length).toBe(2);
});

test("insertAcCheck records a coarse red_first_result when given one", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  const row = acChecks.insertAcCheck(db, {
    ticketId,
    acId,
    selector: "tests/t.py::test_ok",
    testPath: "tests/t.py",
    redFirstResult: "red",
  });
  db.close();
  expect(row.red_first_result).toBe("red");
  expect(row.red_class).toBeNull(); // M3 fills this
});

test("insertAcCheck rejects an out-of-vocab red_first_result (the CHECK constraint)", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  expect(() =>
    // @ts-expect-error — deliberately violating the "red"|"green"|"error" union at runtime
    acChecks.insertAcCheck(db, { ticketId, acId, selector: "s", redFirstResult: "pass" }),
  ).toThrow();
  db.close();
});

test("deleteByTicket removes this ticket's rows and returns the count (resume-dedup)", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s1", redFirstResult: "green" });
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s2", redFirstResult: "red" });
  const deleted = acChecks.deleteByTicket(db, ticketId);
  const remaining = acChecks.listByTicket(db, ticketId);
  db.close();
  expect(deleted).toBe(2);
  expect(remaining).toEqual([]);
});

test("listActiveByTicket returns only superseded_at IS NULL rows", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  const a = acChecks.insertAcCheck(db, { ticketId, acId, selector: "s", testPath: "p" });
  acChecks.supersedeByAc(db, acId);
  const b = acChecks.insertAcCheck(db, { ticketId, acId, selector: "s2", testPath: "p2" });
  const active = acChecks.listActiveByTicket(db, ticketId);
  db.close();
  expect(active.map((r) => r.id)).toEqual([b.id]);
  expect(b.id).not.toBe(a.id); // AUTOINCREMENT: the fresh row does NOT reuse the superseded id
});

test("supersedeByAc marks all active rows for the AC, is idempotent, leaves other ACs alone", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId, 1);
  const otherAc = seedAc(db, ticketId, 2);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s", testPath: "p" });
  acChecks.insertAcCheck(db, { ticketId, acId: otherAc, selector: "o", testPath: "op" });
  expect(acChecks.supersedeByAc(db, acId)).toBe(1);
  expect(acChecks.supersedeByAc(db, acId)).toBe(0); // idempotent
  const otherActive = acChecks.listActiveByAc(db, otherAc).length;
  db.close();
  expect(otherActive).toBe(1); // untouched
});

test("reauthorRoundsForAc counts DISTINCT re-author ROUNDS, not superseded rows", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s", testPath: "p" });
  expect(acChecks.reauthorRoundsForAc(db, acId)).toBe(0);
  acChecks.supersedeByAc(db, acId); // round 1: one UPDATE, one shared superseded_at
  const rounds = acChecks.reauthorRoundsForAc(db, acId);
  db.close();
  expect(rounds).toBe(1);
});

test("reauthorRoundsForAc counts ONE round even when an AC owns multiple checks (multi-test-case AC)", () => {
  // A single AC can own >1 active ac_check row (multiple test cases per AC — supported + tested
  // elsewhere, e.g. ac-check-classify.test.ts inserts 2 checks for one AC). supersedeByAc supersedes
  // BOTH in one round, under ONE shared timestamp — a raw COUNT(*) of superseded rows would read 2
  // here; the round-counter must still read 1 (the Critical this pins).
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s1", testPath: "p1" });
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s2", testPath: "p2" });
  acChecks.supersedeByAc(db, acId);
  const rounds = acChecks.reauthorRoundsForAc(db, acId);
  db.close();
  expect(rounds).toBe(1); // NOT 2
});

test("deleteActiveByAc deletes only active rows, preserving superseded history", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s", testPath: "p" });
  acChecks.supersedeByAc(db, acId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s2", testPath: "p2" }); // a fresh active
  expect(acChecks.deleteActiveByAc(db, acId)).toBe(1); // only the active row
  const rounds = acChecks.reauthorRoundsForAc(db, acId);
  db.close();
  expect(rounds).toBe(1); // history intact
});

test("listUnresolvedByTicket excludes superseded rows", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s", testPath: "p" });
  acChecks.supersedeByAc(db, acId);
  const unresolved = acChecks.listUnresolvedByTicket(db, ticketId).length;
  db.close();
  expect(unresolved).toBe(0);
});
