import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface SignalRow {
  id: number;
  ticket_id: number;
  signal_type: string;
  status: string;
  reason: string | null;
  payload_json: string | null;
  idempotency_key: string | null;
  requested_at: string;
  delivered_at: string | null;
  consumed_at: string | null;
}

const COLS =
  "id, ticket_id, signal_type, status, reason, payload_json, idempotency_key, " +
  "requested_at, delivered_at, consumed_at";

export function getById(db: Database, id: number): SignalRow | null {
  return db.query<SignalRow, [number]>(`SELECT ${COLS} FROM signal WHERE id = ?`).get(id) ?? null;
}

export function listPending(db: Database, ticketId: number): SignalRow[] {
  return db
    .query<SignalRow, [number]>(
      `SELECT ${COLS} FROM signal WHERE ticket_id = ? AND status = 'pending' ORDER BY id`,
    )
    .all(ticketId);
}

/** True iff the ticket has a pending `human_resume` signal — i.e. the run escalated to a human
 *  rather than hitting a resolver dead-end. The single source of the escalation predicate; the
 *  runner's terminal decision reads it to report `escalated` vs `blocked`. */
export function hasPendingHumanResume(db: Database, ticketId: number): boolean {
  return listPending(db, ticketId).some((s) => s.signal_type === "human_resume");
}

export function insertPending(
  db: Database,
  p: { ticketId: number; signalType: string; reason?: string; idempotencyKey?: string | null },
): SignalRow {
  const res = db
    .query(
      `INSERT INTO signal (ticket_id, signal_type, status, reason, idempotency_key, requested_at)
       VALUES ($t, $ty, 'pending', $reason, $key, $now)`,
    )
    .run({
      $t: p.ticketId,
      $ty: p.signalType,
      $reason: p.reason ?? null,
      $key: p.idempotencyKey ?? null,
      $now: nowUtc(),
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("signal insertPending: row missing after insert");
  }
  return created;
}

export function markDelivered(db: Database, id: number, payload?: unknown): void {
  db.query(
    `UPDATE signal SET status = 'delivered', payload_json = $p, delivered_at = $now WHERE id = $id`,
  ).run({ $p: payload === undefined ? null : JSON.stringify(payload), $now: nowUtc(), $id: id });
}

export function markConsumed(db: Database, id: number): void {
  db.query(`UPDATE signal SET status = 'consumed', consumed_at = $now WHERE id = $id`).run({
    $now: nowUtc(),
    $id: id,
  });
}

export function hasDelivered(db: Database, ticketId: number, signalType: string): boolean {
  const row = db
    .query<{ n: number }, [number, string]>(
      `SELECT COUNT(*) AS n FROM signal
       WHERE ticket_id = ? AND signal_type = ? AND status IN ('delivered','consumed')`,
    )
    .get(ticketId, signalType);
  return (row?.n ?? 0) > 0;
}

export function getDeliveredPayload(
  db: Database,
  ticketId: number,
  signalType: string,
): Record<string, unknown> | null {
  const row = db
    .query<{ payload_json: string | null }, [number, string]>(
      `SELECT payload_json FROM signal
         WHERE ticket_id = ? AND signal_type = ? AND status IN ('delivered','consumed')
         ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, signalType);
  if (!row || row.payload_json === null) return null;
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

/** Insert a signal already in 'delivered' (a data-carrier the resolver never awaits, e.g.
 *  external_pr_result). Idempotent: INSERT OR IGNORE on the unique idempotency_key. */
export function recordDelivered(
  db: Database,
  p: { ticketId: number; signalType: string; payload?: unknown; idempotencyKey: string },
): void {
  const now = nowUtc();
  db.query(
    `INSERT OR IGNORE INTO signal
       (ticket_id, signal_type, status, payload_json, idempotency_key, requested_at, delivered_at)
     VALUES ($t, $ty, 'delivered', $p, $key, $now, $now)`,
  ).run({
    $t: p.ticketId,
    $ty: p.signalType,
    $p: p.payload === undefined ? null : JSON.stringify(p.payload),
    $key: p.idempotencyKey,
    $now: now,
  });
}

/** All pending signals of a given type, across tickets (the checks poll's work-list). */
export function listPendingByType(db: Database, signalType: string): SignalRow[] {
  return db
    .query<SignalRow, [string]>(
      `SELECT ${COLS} FROM signal WHERE signal_type = ? AND status = 'pending' ORDER BY id`,
    )
    .all(signalType);
}
