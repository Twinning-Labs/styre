import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue, listPending } from "../../src/db/repos/projection-outbox.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

function ports() {
  return { issueTracker: fakeIssueTracker(), forge: fakeForge() };
}

test("drainOutbox applies a forge push row via the forge port", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "forge",
    op: "push",
    payload: { branch: "feat/x", sha: "abc" },
    idempotencyKey: "p1",
  });
  const p = ports();
  const out = await drainOutbox(db, p);
  db.close();
  expect(out.sent).toBe(1);
  expect((p.forge.calls[0]?.args[0] as { branch: string }).branch).toBe("feat/x");
});

test("a forge pr_create row stores the PR ref in response_ref", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "forge",
    op: "pr_create",
    payload: { branch: "feat/x", base: "main", title: "t", body: "b" },
    idempotencyKey: "pr1",
  });
  const p = ports();
  await drainOutbox(db, p);
  // the row is now 'sent' (gone from pending); read it back to assert response_ref
  const row = db
    .query("SELECT response_ref, status FROM projection_outbox WHERE idempotency_key = 'pr1'")
    .get() as { response_ref: string; status: string };
  db.close();
  expect(row.status).toBe("sent");
  expect(row.response_ref).toContain("fake-pr"); // the PR ref captured
  expect(p.forge.calls[0]?.method).toBe("ensurePr");
});

test("a forge row with no forge port fails (drained as a transient error)", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "forge",
    op: "push",
    payload: { branch: "b", sha: "s" },
    idempotencyKey: "p2",
  });
  await drainOutbox(db, { issueTracker: fakeIssueTracker() }); // no forge
  const pending = listPending(db);
  db.close();
  expect(pending.length).toBe(1); // stayed pending (bumped), not silently dropped
  expect(pending[0]?.attempts).toBe(1);
});
