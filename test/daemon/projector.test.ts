import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { listByTicket } from "../../src/db/repos/event-log.ts";
import { enqueue, listPending } from "../../src/db/repos/projection-outbox.ts";
import { listPending as listSignals } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

test("drainOutbox applies a pending issue_tracker row via the port and marks it sent", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "issue_tracker",
    op: "set_state",
    payload: { state: "in_progress" },
    idempotencyKey: "k1",
  });
  const fake = fakeIssueTracker();
  const out = await drainOutbox(db, { issueTracker: fake });
  const pending = listPending(db);
  db.close();
  expect(out.sent).toBe(1);
  expect(pending.length).toBe(0);
  expect(fake.calls[0]?.method).toBe("setState");
  expect(fake.calls[0]?.args[1]).toBe("in_progress"); // arg0 is the ticket ident (ref)
});

test("drainOutbox applies set_labels with the add/remove delta", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "issue_tracker",
    op: "set_labels",
    payload: { add: ["stage:implement"], remove: ["stage:design"] },
    idempotencyKey: "k2",
  });
  const fake = fakeIssueTracker();
  await drainOutbox(db, { issueTracker: fake });
  db.close();
  expect(fake.calls[0]?.method).toBe("setLabels");
  expect(fake.calls[0]?.args[1]).toEqual({ add: ["stage:implement"], remove: ["stage:design"] });
});

test("a skipped state projection (applied:false) emits a projection_skipped note, row delivered", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "issue_tracker",
    op: "set_state",
    payload: { state: "done" },
    idempotencyKey: "k-skip",
  });
  const skipping = fakeIssueTracker();
  skipping.setState = async () => ({ applied: false, reason: "no transition to Done" });
  const out = await drainOutbox(db, { issueTracker: skipping });
  const events = listByTicket(db, ticketId);
  db.close();
  expect(out.sent).toBe(1); // a skip is a delivered row, not a transport failure/retry
  const note = events.find(
    (e) => e.kind === "note" && (e.payload_json ?? "").includes("projection_skipped"),
  );
  expect(note).toBeDefined();
  expect(note?.reason).toContain("no transition to Done");
});

test("a transient port error bumps attempts and keeps the row pending", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "issue_tracker",
    op: "set_state",
    payload: { state: "done" },
    idempotencyKey: "k3",
  });
  const throwing = fakeIssueTracker();
  throwing.setState = async () => {
    throw new Error("network blip");
  };
  await drainOutbox(db, { issueTracker: throwing });
  const pending = listPending(db);
  db.close();
  expect(pending.length).toBe(1);
  expect(pending[0]?.attempts).toBe(1);
});

test("a row past the retry budget is failed and the ticket is escalated", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "issue_tracker",
    op: "set_state",
    payload: { state: "done" },
    idempotencyKey: "k4",
  });
  // pre-set attempts to budget-1 so the next failure crosses the budget
  db.query("UPDATE projection_outbox SET attempts = 4 WHERE idempotency_key = 'k4'").run();
  const throwing = fakeIssueTracker();
  throwing.setState = async () => {
    throw new Error("service down");
  };
  const out = await drainOutbox(db, { issueTracker: throwing }, { retryBudget: 5 });
  const pending = listPending(db);
  const signals = listSignals(db, ticketId);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(out.failed).toBe(1);
  expect(pending.length).toBe(0); // row is now 'failed', not pending
  expect(signals.some((s) => s.signal_type === "human_resume")).toBe(true);
  expect(ticket?.status).toBe("waiting");
});
