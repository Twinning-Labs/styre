import { expect, test } from "bun:test";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { awaitSignal, consumeSignal, deliverSignal } from "../../src/engine/signals.ts";
import { makeTestDb } from "../helpers/db.ts";

test("awaitSignal parks the ticket on a pending signal", () => {
  const { db, ticketId } = makeTestDb();
  const sig = awaitSignal(db, {
    ticketId,
    signalType: "human_merge_approval",
    reason: "awaiting merge",
  });
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(sig.status).toBe("pending");
  expect(sig.signal_type).toBe("human_merge_approval");
  expect(ticket?.status).toBe("waiting");
});

test("awaitSignal is idempotent for the same signal type (no duplicate park)", () => {
  const { db, ticketId } = makeTestDb();
  const a = awaitSignal(db, { ticketId, signalType: "external_checks" });
  const b = awaitSignal(db, { ticketId, signalType: "external_checks" });
  db.close();
  expect(b.id).toBe(a.id);
});

test("deliverSignal marks delivered, stores payload, and un-parks the ticket", () => {
  const { db, ticketId } = makeTestDb();
  const sig = awaitSignal(db, { ticketId, signalType: "external_pr_result" });
  const delivered = deliverSignal(db, sig.id, { pr: 42 });
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(delivered.status).toBe("delivered");
  expect(JSON.parse(delivered.payload_json ?? "null")).toEqual({ pr: 42 });
  expect(ticket?.status).toBe("active");
});

test("consumeSignal marks the signal consumed", () => {
  const { db, ticketId } = makeTestDb();
  const sig = awaitSignal(db, { ticketId, signalType: "human_resume" });
  deliverSignal(db, sig.id);
  const consumed = consumeSignal(db, sig.id);
  db.close();
  expect(consumed.status).toBe("consumed");
  expect(consumed.consumed_at).not.toBeNull();
});
