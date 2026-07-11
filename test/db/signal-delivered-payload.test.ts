import { expect, test } from "bun:test";
import { getDeliveredPayload, recordDelivered } from "../../src/db/repos/signal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("getDeliveredPayload returns the delivered payload, else null", () => {
  const { db, ticketId } = makeTestDb();
  expect(getDeliveredPayload(db, ticketId, "external_pr_result")).toBeNull();
  recordDelivered(db, {
    ticketId,
    signalType: "external_pr_result",
    payload: { ref: "42", url: "https://github.com/x/y/pull/42" },
    idempotencyKey: "ENG-1:pr_result",
  });
  const p = getDeliveredPayload(db, ticketId, "external_pr_result");
  db.close();
  expect(p?.url).toBe("https://github.com/x/y/pull/42");
});
