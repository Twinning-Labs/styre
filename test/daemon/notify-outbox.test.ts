import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue } from "../../src/db/repos/projection-outbox.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";
import { listByTicket } from "../../src/db/repos/event-log.ts";
import { makeTestDb } from "../helpers/db.ts";

test("drainOutbox delivers a notify row via the notifier port and marks it sent", async () => {
  const { db, ticketId } = makeTestDb();
  const msg = { ticketIdent: "ENG-1", event: "escalated", severity: "high", reason: "step failed" };
  enqueue(db, { ticketId, target: "notify", op: "post", payload: msg, idempotencyKey: "notify:1:evt:1" });
  const fake = fakeNotifier();
  const out = await drainOutbox(db, { issueTracker: fakeIssueTracker(), notifier: fake });
  db.close();
  expect(out.sent).toBe(1);
  expect(fake.calls[0]?.ticketIdent).toBe("ENG-1");
  expect(fake.calls[0]?.event).toBe("escalated");
});

test("a failing notify row is marked failed but NEVER escalates the ticket", async () => {
  const { db, ticketId } = makeTestDb();
  const msg = { ticketIdent: "ENG-1", event: "escalated", severity: "high" };
  enqueue(db, { ticketId, target: "notify", op: "post", payload: msg, idempotencyKey: "notify:1:evt:1" });
  const fake = fakeNotifier({ fail: true });
  // retryBudget:1 → the single failing attempt exhausts immediately.
  const out = await drainOutbox(db, { issueTracker: fakeIssueTracker(), notifier: fake }, { retryBudget: 1 });
  const escalations = listByTicket(db, ticketId).filter((e) => e.kind === "escalated");
  db.close();
  expect(out.failed).toBe(1);
  expect(escalations.length).toBe(0); // the asymmetry: notify failure does not escalate
});
