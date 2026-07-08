import { expect, test } from "bun:test";
import * as acChecks from "../../../src/db/repos/ac-check.ts";
import * as acs from "../../../src/db/repos/acceptance-criterion.ts";
import { makeTestDb } from "../../helpers/db.ts";

function seedAc(db: Parameters<typeof acs.insertAc>[0], ticketId: number): number {
  return acs.insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" }).id;
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
