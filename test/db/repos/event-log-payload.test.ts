import { expect, test } from "bun:test";
import { appendEvent, listByTicket } from "../../../src/db/repos/event-log.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("a 'parked' event persists with a JSON payload", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, {
    ticketId,
    kind: "parked",
    reason: "session-limit; resets 11:10pm",
    payload: { cause: "session-limit", resetAt: "11:10pm", dispatchId: "ENG-1-d0001" },
  });
  const row = listByTicket(db, ticketId).at(-1);
  expect(row?.kind).toBe("parked");
  expect(JSON.parse(row?.payload_json ?? "{}").cause).toBe("session-limit");
  db.close();
});
