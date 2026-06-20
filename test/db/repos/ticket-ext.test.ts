import { expect, test } from "bun:test";
import { hasDelivered, insertPending, markDelivered } from "../../../src/db/repos/signal.ts";
import {
  getTicket,
  insertTicket,
  setNeedsDocs,
  setTicketStage,
  setTicketTrack,
} from "../../../src/db/repos/ticket.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertTicket accepts track and needsDocs; defaults are null/0", () => {
  const { db, projectId } = makeTestDb();
  const fastId = insertTicket(db, { projectId, ident: "ENG-2", track: "fast", needsDocs: 1 });
  const plainId = insertTicket(db, { projectId, ident: "ENG-3" });
  const fast = getTicket(db, fastId);
  const plain = getTicket(db, plainId);
  db.close();
  expect(fast?.track).toBe("fast");
  expect(fast?.needs_docs).toBe(1);
  expect(plain?.track).toBeNull();
  expect(plain?.needs_docs).toBe(0);
});

test("setTicketStage / setTicketTrack / setNeedsDocs update the row", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  setTicketTrack(db, ticketId, "full");
  setNeedsDocs(db, ticketId, 1);
  const t = getTicket(db, ticketId);
  db.close();
  expect(t?.stage).toBe("implement");
  expect(t?.track).toBe("full");
  expect(t?.needs_docs).toBe(1);
});

test("hasDelivered is false until a signal is delivered, then true", () => {
  const { db, ticketId } = makeTestDb();
  const sig = insertPending(db, { ticketId, signalType: "external_checks" });
  const before = hasDelivered(db, ticketId, "external_checks");
  markDelivered(db, sig.id);
  const after = hasDelivered(db, ticketId, "external_checks");
  db.close();
  expect(before).toBe(false);
  expect(after).toBe(true);
});
