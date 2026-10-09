import { expect, test } from "bun:test";
import { getTicket, insertTicket, setBranch } from "../../../src/db/repos/ticket.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("ticket exposes branch fields and setBranch persists branch_name", () => {
  const { db, projectId } = makeTestDb();
  const id = insertTicket(db, { projectId, ident: "ENG-9" });
  const before = getTicket(db, id);
  setBranch(db, id, "feat/ENG-9-slug");
  const after = getTicket(db, id);
  db.close();
  expect(before?.branch_name).toBeNull();
  expect(after?.branch_name).toBe("feat/ENG-9-slug");
});
