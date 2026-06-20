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
