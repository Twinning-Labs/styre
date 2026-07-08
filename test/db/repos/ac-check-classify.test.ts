import { expect, test } from "bun:test";
import {
  classifyAcCheck,
  deleteByAc,
  insertAcCheck,
  listByTicket,
  listUnresolvedByTicket,
} from "../../../src/db/repos/ac-check.ts";
import { insertAc } from "../../../src/db/repos/acceptance-criterion.ts";
import { makeTestDb } from "../../helpers/db.ts";

function seedAc(db: Parameters<typeof insertAc>[0], ticketId: number, seq: number) {
  return insertAc(db, { ticketId, seq, text: `ac ${seq}`, source: "checklist" }).id;
}

test("classifyAcCheck sets red_class and disposition per check; listUnresolvedByTicket excludes classified", () => {
  const { db, ticketId } = makeTestDb();
  const ac1 = seedAc(db, ticketId, 1);
  const ac2 = seedAc(db, ticketId, 2);
  const c1 = insertAcCheck(db, { ticketId, acId: ac1, selector: "s1", redFirstResult: "red" });
  const c2 = insertAcCheck(db, { ticketId, acId: ac2, selector: "s2", redFirstResult: "green" });

  // Both start unresolved.
  expect(
    listUnresolvedByTicket(db, ticketId)
      .map((r) => r.id)
      .sort(),
  ).toEqual([c1.id, c2.id].sort());

  classifyAcCheck(db, { acCheckId: c1.id, redClass: "assertion" });
  classifyAcCheck(db, { acCheckId: c2.id, disposition: "satisfied" });

  const rows = listByTicket(db, ticketId);
  expect(rows.find((r) => r.id === c1.id)?.red_class).toBe("assertion");
  expect(rows.find((r) => r.id === c2.id)?.disposition).toBe("satisfied");
  // Nothing unresolved now.
  expect(listUnresolvedByTicket(db, ticketId).length).toBe(0);
  db.close();
});

test("deleteByAc removes only that AC's checks", () => {
  const { db, ticketId } = makeTestDb();
  const ac1 = seedAc(db, ticketId, 1);
  const ac2 = seedAc(db, ticketId, 2);
  insertAcCheck(db, { ticketId, acId: ac1, selector: "a" });
  insertAcCheck(db, { ticketId, acId: ac1, selector: "b" });
  insertAcCheck(db, { ticketId, acId: ac2, selector: "c" });

  expect(deleteByAc(db, ac1)).toBe(2);
  const remaining = listByTicket(db, ticketId);
  expect(remaining.length).toBe(1);
  expect(remaining[0]?.ac_id).toBe(ac2);
  db.close();
});
