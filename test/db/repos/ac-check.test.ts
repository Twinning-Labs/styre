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
