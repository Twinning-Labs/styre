import { expect, test } from "bun:test";
import { hasPendingHumanResume, insertPending } from "../../src/db/repos/signal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("hasPendingHumanResume: true iff a pending human_resume signal exists", () => {
  const { db, ticketId } = makeTestDb();
  expect(hasPendingHumanResume(db, ticketId)).toBe(false);

  // A different pending signal must not count.
  insertPending(db, { ticketId, signalType: "human_merge_approval" });
  expect(hasPendingHumanResume(db, ticketId)).toBe(false);

  insertPending(db, { ticketId, signalType: "human_resume", reason: "boom" });
  expect(hasPendingHumanResume(db, ticketId)).toBe(true);

  db.close();
});
