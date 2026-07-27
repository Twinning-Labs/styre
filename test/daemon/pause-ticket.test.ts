import { expect, test } from "bun:test";
import { pauseTicket } from "../../src/daemon/pause-ticket.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { hasPendingHumanResume } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { makeTestDb } from "../helpers/db.ts";

test("pauseTicket sets waiting, raises human_resume, and records the honest detail", () => {
  const { db, ticketId } = makeTestDb();
  pauseTicket(db, ticketId, "no next move on this plan — edit and resume");
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  expect(hasPendingHumanResume(db, ticketId)).toBe(true);
  const ev = listEvents(db, ticketId)
    .filter((e) => e.kind === "escalated")
    .at(-1);
  expect(ev?.reason).toBe("no next move on this plan — edit and resume");
  db.close();
});
