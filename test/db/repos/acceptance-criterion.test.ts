import { expect, test } from "bun:test";
import * as acs from "../../../src/db/repos/acceptance-criterion.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertAc round-trips a row; listByTicket returns it in seq order", () => {
  const { db, ticketId } = makeTestDb();
  acs.insertAc(db, { ticketId, seq: 2, text: "second", source: "checklist" });
  acs.insertAc(db, { ticketId, seq: 1, text: "first", source: "checklist" });
  const list = acs.listByTicket(db, ticketId);
  db.close();
  expect(list.map((a) => a.seq)).toEqual([1, 2]);
  expect(list[0]?.text).toBe("first");
  expect(list[0]?.source).toBe("checklist");
  expect(list[0]?.created_at).toBeTruthy();
});

test("listByTicket is empty for a ticket with no ACs", () => {
  const { db, ticketId } = makeTestDb();
  const list = acs.listByTicket(db, ticketId);
  db.close();
  expect(list).toEqual([]);
});

test("the (ticket_id, seq) UNIQUE constraint rejects a duplicate seq", () => {
  const { db, ticketId } = makeTestDb();
  acs.insertAc(db, { ticketId, seq: 1, text: "a", source: "checklist" });
  expect(() => acs.insertAc(db, { ticketId, seq: 1, text: "b", source: "checklist" })).toThrow();
  db.close();
});
