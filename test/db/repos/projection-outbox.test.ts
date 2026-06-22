import { expect, test } from "bun:test";
import {
  bumpAttempt,
  enqueue,
  listPending,
  markFailed,
  markSent,
} from "../../../src/db/repos/projection-outbox.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("enqueue inserts a pending row; listPending returns it", () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "issue_tracker",
    op: "set_state",
    payload: { state: "in_progress" },
    idempotencyKey: "k1",
  });
  const pending = listPending(db);
  db.close();
  expect(pending.length).toBe(1);
  expect(pending[0]?.target).toBe("issue_tracker");
  expect(pending[0]?.op).toBe("set_state");
  expect(JSON.parse(pending[0]?.payload_json ?? "{}").state).toBe("in_progress");
});

test("enqueue is idempotent on idempotency_key (re-enqueue is a no-op)", () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", idempotencyKey: "dup" });
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", idempotencyKey: "dup" });
  const pending = listPending(db);
  db.close();
  expect(pending.length).toBe(1);
});

test("markSent removes a row from pending; bumpAttempt keeps it pending; markFailed removes it", () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", idempotencyKey: "a" });
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", idempotencyKey: "b" });
  const [a, b] = listPending(db);
  if (!a || !b) throw new Error("expected 2 pending rows");
  markSent(db, a.id, "resp-1");
  bumpAttempt(db, b.id, "transient");
  const afterPending = listPending(db);
  markFailed(db, b.id, "gave up");
  const finalPending = listPending(db);
  db.close();
  expect(afterPending.map((r) => r.id)).toEqual([b.id]); // a sent (gone), b still pending
  expect(afterPending[0]?.attempts).toBe(1);
  expect(finalPending.length).toBe(0); // b now failed
});
