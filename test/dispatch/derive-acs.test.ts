import { expect, test } from "bun:test";
import * as acs from "../../src/db/repos/acceptance-criterion.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { deriveAndPersistAcs } from "../../src/dispatch/derive-acs.ts";
import { makeTestDb } from "../helpers/db.ts";

function ticketWith(
  db: Parameters<typeof insertTicket>[0],
  projectId: number,
  description: string | null,
) {
  return insertTicket(db, { projectId, ident: "ENG-42", description });
}

test("checklist description ⇒ one AC per task-list item, seq 1..N, source checklist", () => {
  const { db, projectId } = makeTestDb();
  const id = ticketWith(db, projectId, "- [ ] returns 200\n- [ ] rejects bad input");
  const n = deriveAndPersistAcs(db, id);
  const rows = acs.listByTicket(db, id);
  db.close();
  expect(n).toBe(2);
  expect(rows.map((r) => [r.seq, r.text, r.source])).toEqual([
    [1, "returns 200", "checklist"],
    [2, "rejects bad input", "checklist"],
  ]);
});

test("no checklist ⇒ a single whole-description AC", () => {
  const { db, projectId } = makeTestDb();
  const id = ticketWith(db, projectId, "Fix the import so collection succeeds.");
  const n = deriveAndPersistAcs(db, id);
  const rows = acs.listByTicket(db, id);
  db.close();
  expect(n).toBe(1);
  expect(rows[0]?.source).toBe("whole-description");
  expect(rows[0]?.text).toBe("Fix the import so collection succeeds.");
});

test("empty description ⇒ zero ACs", () => {
  const { db, projectId } = makeTestDb();
  const id = ticketWith(db, projectId, "");
  const n = deriveAndPersistAcs(db, id);
  db.close();
  expect(n).toBe(0);
});

test("idempotent — a second call does not duplicate rows", () => {
  const { db, projectId } = makeTestDb();
  const id = ticketWith(db, projectId, "- [ ] a\n- [ ] b");
  expect(deriveAndPersistAcs(db, id)).toBe(2);
  expect(deriveAndPersistAcs(db, id)).toBe(2);
  const rows = acs.listByTicket(db, id);
  db.close();
  expect(rows.length).toBe(2);
});

test("throws for a missing ticket", () => {
  const { db } = makeTestDb();
  expect(() => deriveAndPersistAcs(db, 99999)).toThrow(/not found/);
  db.close();
});
