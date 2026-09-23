import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export type OutboxTarget = "issue_tracker" | "forge" | "notify";

export interface OutboxRow {
  id: number;
  ticket_id: number;
  target: string;
  op: string;
  payload_json: string | null;
  idempotency_key: string;
  status: string;
  attempts: number;
  response_ref: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

const COLS =
  "id, ticket_id, target, op, payload_json, idempotency_key, status, attempts, response_ref, error, created_at, sent_at";

/** Enqueue a projection. No-ops on a duplicate idempotency_key (globally unique by construction →
 *  enqueue-twice is harmless), so callers can enqueue freely inside the state-change transaction. */
export function enqueue(
  db: Database,
  p: {
    ticketId: number;
    target: OutboxTarget;
    op: string;
    payload?: unknown;
    idempotencyKey: string;
  },
): void {
  db.query(
    `INSERT OR IGNORE INTO projection_outbox
       (ticket_id, target, op, payload_json, idempotency_key, status, attempts, created_at)
     VALUES ($t, $target, $op, $payload, $key, 'pending', 0, $now)`,
  ).run({
    $t: p.ticketId,
    $target: p.target,
    $op: p.op,
    $payload: p.payload === undefined ? null : JSON.stringify(p.payload),
    $key: p.idempotencyKey,
    $now: nowUtc(),
  });
}

export function listPending(db: Database): OutboxRow[] {
  return db
    .query<OutboxRow, []>(
      `SELECT ${COLS} FROM projection_outbox WHERE status = 'pending' ORDER BY created_at, id`,
    )
    .all();
}

export function markSent(db: Database, id: number, responseRef?: string | null): void {
  db.query(
    `UPDATE projection_outbox SET status = 'sent', response_ref = $ref, sent_at = $now WHERE id = $id`,
  ).run({ $ref: responseRef ?? null, $now: nowUtc(), $id: id });
}

export function bumpAttempt(db: Database, id: number, error: string): void {
  db.query("UPDATE projection_outbox SET attempts = attempts + 1, error = $err WHERE id = $id").run(
    { $err: error, $id: id },
  );
}

export function markFailed(db: Database, id: number, error: string): void {
  db.query(`UPDATE projection_outbox SET status = 'failed', error = $err WHERE id = $id`).run({
    $err: error,
    $id: id,
  });
}

/** Resume retries: return this ticket's failed forge rows for the CURRENT branch head to pending
 *  with a fresh retry budget, pointing a PR request at `prBase`. The payload is otherwise frozen at
 *  enqueue and a new enqueue of the same idempotency key is ignored, so without this a failed PR
 *  request (e.g. rejected as `base invalid`) could never be retried. A push or PR request for a
 *  commit the branch has moved past stays failed: re-sending it would publish stale code, and the
 *  required-suite guard would block it on every drain. The last error stays on the row. */
export function requeueFailedForge(
  db: Database,
  ticketId: number,
  prBase: string,
  headSha: string | null,
): number {
  const rows = db
    .query<{ id: number; op: string; payload_json: string | null }, [number]>(
      "SELECT id, op, payload_json FROM projection_outbox WHERE ticket_id = ? AND target = 'forge' AND status = 'failed'",
    )
    .all(ticketId);
  let requeued = 0;
  for (const row of rows) {
    const payload = row.payload_json === null ? {} : JSON.parse(row.payload_json);
    const commit =
      row.op === "push" ? payload.sha : row.op === "pr_create" ? payload.sourceSha : undefined;
    if ((row.op === "push" || row.op === "pr_create") && (headSha === null || commit !== headSha))
      continue;
    db.query(
      "UPDATE projection_outbox SET status = 'pending', attempts = 0, payload_json = $payload WHERE id = $id",
    ).run({
      $payload:
        row.op === "pr_create" ? JSON.stringify({ ...payload, base: prBase }) : row.payload_json,
      $id: row.id,
    });
    requeued += 1;
  }
  return requeued;
}
