import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue, listPending } from "../../src/db/repos/projection-outbox.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a malformed forge push payload is a transient error (bumped, not crashing the drain)", async () => {
  const { db, ticketId } = makeTestDb();
  const ticket = getTicket(db, ticketId);
  // push payload missing required `sha` — must be rejected, not blindly cast.
  enqueue(db, {
    ticketId,
    target: "forge",
    op: "push",
    payload: { branch: "b" },
    idempotencyKey: `${ticket?.ident}:push:bad`,
  });

  // drainOutbox never throws out; the bad row is retried (attempts bumped), loop continues.
  const res = await drainOutbox(db, { issueTracker: fakeIssueTracker(), forge: fakeForge() });
  expect(res.sent).toBe(0);
  const pending = listPending(db).find((r) => r.op === "push");
  expect(pending?.attempts).toBeGreaterThan(0); // bumped, still pending (under budget)
  db.close();
});
