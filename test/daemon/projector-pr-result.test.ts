import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue } from "../../src/db/repos/projection-outbox.ts";
import { hasDelivered, listPendingByType, recordDelivered } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

test("recordDelivered inserts a delivered signal idempotently (OR IGNORE on key)", () => {
  const { db, ticketId } = makeTestDb();
  recordDelivered(db, {
    ticketId,
    signalType: "external_pr_result",
    payload: { ref: "7" },
    idempotencyKey: "K1",
  });
  recordDelivered(db, {
    ticketId,
    signalType: "external_pr_result",
    payload: { ref: "7" },
    idempotencyKey: "K1",
  });
  const row = db
    .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM signal WHERE ticket_id = ?")
    .get(ticketId);
  expect(row?.n).toBe(1);
  expect(hasDelivered(db, ticketId, "external_pr_result")).toBe(true);
  db.close();
});

test("listPendingByType returns pending signals of a type across tickets", () => {
  const { db, ticketId } = makeTestDb();
  db.query(
    "INSERT INTO signal (ticket_id, signal_type, status, requested_at) VALUES (?, 'external_checks', 'pending', '2026-01-01T00:00:00Z')",
  ).run(ticketId);
  const pending = listPendingByType(db, "external_checks");
  expect(pending.length).toBe(1);
  expect(pending[0].ticket_id).toBe(ticketId);
  db.close();
});

test("draining a pr_create row delivers external_pr_result carrying the PR ref", async () => {
  const { db, ticketId } = makeTestDb();
  const ticket = getTicket(db, ticketId);
  enqueue(db, {
    ticketId,
    target: "forge",
    op: "pr_create",
    payload: { branch: "b", base: "main", title: "t", body: "x" },
    idempotencyKey: `${ticket?.ident}:pr_create:b`,
  });

  await drainOutbox(db, { issueTracker: fakeIssueTracker(), forge: fakeForge() });

  expect(hasDelivered(db, ticketId, "external_pr_result")).toBe(true);
  const sig = db
    .query<{ payload_json: string | null }, [number]>(
      "SELECT payload_json FROM signal WHERE ticket_id = ? AND signal_type = 'external_pr_result'",
    )
    .get(ticketId);
  const payload = JSON.parse(sig?.payload_json ?? "{}");
  expect(typeof payload.ref).toBe("string"); // fakeForge.ensurePr → "fake-pr-1"
  db.close();
});
