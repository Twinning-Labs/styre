import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface EventLogRow {
  id: number;
  ticket_id: number;
  seq: number;
  kind: string;
  actor: string | null;
  from_stage: string | null;
  to_stage: string | null;
  loop: string | null;
  route_to: string | null;
  signature: string | null;
  reason: string | null;
  created_at: string;
}

const COLS =
  "id, ticket_id, seq, kind, actor, from_stage, to_stage, loop, route_to, signature, reason, created_at";

export function nextSeq(db: Database, ticketId: number): number {
  const row = db
    .query<{ m: number | null }, [number]>(
      "SELECT MAX(seq) AS m FROM event_log WHERE ticket_id = ?",
    )
    .get(ticketId);
  return (row?.m ?? 0) + 1;
}

export function listByTicket(db: Database, ticketId: number): EventLogRow[] {
  return db
    .query<EventLogRow, [number]>(`SELECT ${COLS} FROM event_log WHERE ticket_id = ? ORDER BY seq`)
    .all(ticketId);
}

/** Rows journaled after `afterSeq` (exclusive), in seq order. Lets a streaming consumer process
 *  only genuinely-new rows per tick instead of re-scanning the full history. */
export function listByTicketSince(db: Database, ticketId: number, afterSeq: number): EventLogRow[] {
  return db
    .query<EventLogRow, [number, number]>(
      `SELECT ${COLS} FROM event_log WHERE ticket_id = ? AND seq > ? ORDER BY seq`,
    )
    .all(ticketId, afterSeq);
}

export function appendEvent(
  db: Database,
  e: {
    ticketId: number;
    kind: string;
    actor?: string;
    fromStage?: string;
    toStage?: string;
    loop?: string;
    routeTo?: string;
    signature?: string;
    reason?: string;
  },
): EventLogRow {
  const res = db
    .query(
      `INSERT INTO event_log
         (ticket_id, seq, kind, actor, from_stage, to_stage, loop, route_to, signature, reason, created_at)
       VALUES ($t, $seq, $kind, $actor, $from, $to, $loop, $route, $sig, $reason, $now)`,
    )
    .run({
      $t: e.ticketId,
      $seq: nextSeq(db, e.ticketId),
      $kind: e.kind,
      $actor: e.actor ?? "daemon",
      $from: e.fromStage ?? null,
      $to: e.toStage ?? null,
      $loop: e.loop ?? null,
      $route: e.routeTo ?? null,
      $sig: e.signature ?? null,
      $reason: e.reason ?? null,
      $now: nowUtc(),
    });
  const created = db
    .query<EventLogRow, [number]>(`SELECT ${COLS} FROM event_log WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("appendEvent: row missing after insert");
  }
  return created;
}
