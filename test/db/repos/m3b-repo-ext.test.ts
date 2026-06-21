import { expect, test } from "bun:test";
import { getTicket, insertTicket, setBranch } from "../../../src/db/repos/ticket.ts";
import { getById, insertPending, setPid } from "../../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("setPid sets and clears the workflow_step pid", () => {
  const { db, ticketId } = makeTestDb();
  const step = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  setPid(db, step.id, 4242);
  expect(getById(db, step.id)?.pid).toBe(4242);
  setPid(db, step.id, null);
  const after = getById(db, step.id);
  db.close();
  expect(after?.pid).toBeNull();
});

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
