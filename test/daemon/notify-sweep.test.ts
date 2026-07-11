import { expect, test } from "bun:test";
import { RuntimeConfigSchema } from "../../src/config/runtime-config.ts";
import { createNotifier } from "../../src/daemon/notify.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { listPending } from "../../src/db/repos/projection-outbox.ts";
import { insertPending, recordDelivered } from "../../src/db/repos/signal.ts";
import { makeTestDb } from "../helpers/db.ts";

function cfg(notify: "escalations" | "transitions" | "everything") {
  return RuntimeConfigSchema.parse({ notifier: "slack", notify, slack: { channel: "#x" } });
}
const payloads = (db: ReturnType<typeof makeTestDb>["db"]) =>
  listPending(db)
    .filter((r) => r.target === "notify")
    .map((r) => {
      // Pick fields explicitly — the stored message also has `ticketIdent`, and toEqual is a deep
      // check that would fail on the extra key. (The ident IS load-bearing; don't drop it from the
      // message — strip it here, in the test helper.)
      const p = JSON.parse(r.payload_json as string) as { event: string; severity: string };
      return { event: p.event, severity: p.severity };
    });

test("sweepNew enqueues escalated+parked at 'escalations', adds transition/loopback by tier", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, { ticketId, kind: "escalated", reason: "step failed" });
  appendEvent(db, { ticketId, kind: "transition", fromStage: "implement", toStage: "verify" });
  appendEvent(db, { ticketId, kind: "loopback" });

  createNotifier(cfg("escalations")).sweepNew(db, ticketId);
  let evs = payloads(db).map((p) => p.event);
  expect(evs).toEqual(["escalated"]); // transition + loopback filtered out

  // higher tier re-sweeps from scratch on a fresh notifier instance:
  const { db: db2, ticketId: t2 } = makeTestDb();
  appendEvent(db2, { ticketId: t2, kind: "escalated", reason: "x" });
  appendEvent(db2, { ticketId: t2, kind: "transition", fromStage: "implement", toStage: "verify" });
  appendEvent(db2, { ticketId: t2, kind: "loopback" });
  createNotifier(cfg("everything")).sweepNew(db2, t2);
  evs = payloads(db2).map((p) => p.event);
  expect(evs).toEqual(["escalated", "implement→verify", "loopback"]);
  db.close();
  db2.close();
});

test("notifyTerminal enqueues pr-ready(success) and no-progress(high); skips parked", () => {
  const { db, ticketId } = makeTestDb();
  const n = createNotifier(cfg("escalations"));
  n.notifyTerminal(db, ticketId, "pr-ready");
  n.notifyTerminal(db, ticketId, "no-progress");
  n.notifyTerminal(db, ticketId, "parked");
  const got = payloads(db);
  db.close();
  expect(got).toEqual([
    { event: "PR ready to merge", severity: "success" },
    { event: "gave up (no progress)", severity: "high" },
  ]);
});

test("blocked terminal: dead-end notifies, escalation-blocked does not (already evented)", () => {
  // dead-end: no pending human_resume → a "gave up (blocked)" notification.
  // Reuse the file's existing `payloads(db)` helper (returns {event, severity}).
  const a = makeTestDb();
  createNotifier(cfg("escalations")).notifyTerminal(a.db, a.ticketId, "blocked");
  const aPayloads = payloads(a.db);
  a.db.close();
  expect(aPayloads).toEqual([{ event: "gave up (blocked)", severity: "high" }]);

  // escalation-blocked: a pending human_resume → NO terminal notification.
  const b = makeTestDb();
  insertPending(b.db, { ticketId: b.ticketId, signalType: "human_resume", reason: "boom" });
  createNotifier(cfg("escalations")).notifyTerminal(b.db, b.ticketId, "blocked");
  const bCount = payloads(b.db).length;
  b.db.close();
  expect(bCount).toBe(0);
});

test("disabled notifier enqueues nothing", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, { ticketId, kind: "escalated", reason: "x" });
  const off = RuntimeConfigSchema.parse({});
  createNotifier(off).sweepNew(db, ticketId);
  createNotifier(off).notifyTerminal(db, ticketId, "pr-ready");
  const got = payloads(db);
  db.close();
  expect(got.length).toBe(0);
});

test("incremental sweep advances the watermark and never re-enqueues", () => {
  const { db, ticketId } = makeTestDb();
  const n = createNotifier(cfg("everything"));

  // First sweep with one event
  appendEvent(db, { ticketId, kind: "escalated", reason: "first" });
  n.sweepNew(db, ticketId);
  let rows = listPending(db).filter((r) => r.target === "notify");
  expect(rows.length).toBe(1);

  // Add another event and sweep again with the same notifier instance
  appendEvent(db, { ticketId, kind: "transition", fromStage: "implement", toStage: "verify" });
  n.sweepNew(db, ticketId);
  rows = listPending(db).filter((r) => r.target === "notify");
  expect(rows.length).toBe(2);

  // Verify the first event (escalated) appears exactly once — the watermark advanced and
  // did not re-enqueue it
  const escalatedRows = rows.filter((r) => {
    const msg = JSON.parse(r.payload_json as string) as { event: string };
    return msg.event === "escalated";
  });
  expect(escalatedRows.length).toBe(1);

  db.close();
});

test("idempotency key is seq-based, not reason-based", () => {
  const { db, ticketId } = makeTestDb();
  const ev = appendEvent(db, { ticketId, kind: "escalated", reason: "boom" });
  createNotifier(cfg("escalations")).sweepNew(db, ticketId);

  const rows = listPending(db).filter((r) => r.target === "notify");
  expect(rows.length).toBe(1);
  expect(rows[0].idempotency_key).toBe(`notify:${ticketId}:evt:${ev.seq}`);

  db.close();
});

test("sweep enriches the message with ticket title and PR url when available", () => {
  const { db, ticketId } = makeTestDb(); // seeds ENG-1 (title null by default)
  // give the ticket a title + a delivered PR result
  db.query("UPDATE ticket SET title = ? WHERE id = ?").run("Fix the widget", ticketId);
  recordDelivered(db, {
    ticketId,
    signalType: "external_pr_result",
    payload: { ref: "42", url: "https://gh/pr/42" },
    idempotencyKey: "ENG-1:pr_result",
  });
  appendEvent(db, { ticketId, kind: "escalated", reason: "boom" });
  createNotifier(cfg("escalations")).sweepNew(db, ticketId);
  const row = listPending(db).find((r) => r.target === "notify");
  const msg = JSON.parse(row?.payload_json as string) as { ticketTitle?: string; prUrl?: string };
  db.close();
  expect(msg.ticketTitle).toBe("Fix the widget");
  expect(msg.prUrl).toBe("https://gh/pr/42");
});
