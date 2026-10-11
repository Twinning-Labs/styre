import type { Database } from "bun:sqlite";

export interface TicketInputRow {
  ticket_id: number;
  name: string;
  value_json: string;
  digest: string;
  captured_at: string;
}

const COLS = "ticket_id, name, value_json, digest, captured_at";

export function getInput(db: Database, ticketId: number, name: string): TicketInputRow | null {
  return (
    db
      .query<TicketInputRow, [number, string]>(
        `SELECT ${COLS} FROM ticket_input WHERE ticket_id = ? AND name = ?`,
      )
      .get(ticketId, name) ?? null
  );
}

export function listInputs(db: Database, ticketId: number): TicketInputRow[] {
  return db
    .query<TicketInputRow, [number]>(
      `SELECT ${COLS} FROM ticket_input WHERE ticket_id = ? ORDER BY name`,
    )
    .all(ticketId);
}

/** True when the row was written; an existing row is never touched. */
export function insertInputIfAbsent(db: Database, row: TicketInputRow): boolean {
  const res = db
    .query(`INSERT OR IGNORE INTO ticket_input (${COLS}) VALUES ($t, $n, $v, $d, $c)`)
    .run({
      $t: row.ticket_id,
      $n: row.name,
      $v: row.value_json,
      $d: row.digest,
      $c: row.captured_at,
    });
  return res.changes === 1;
}

export function upsertInput(db: Database, row: TicketInputRow): void {
  db.query(
    `INSERT INTO ticket_input (${COLS}) VALUES ($t, $n, $v, $d, $c)
     ON CONFLICT (ticket_id, name) DO UPDATE SET value_json = $v, digest = $d, captured_at = $c`,
  ).run({
    $t: row.ticket_id,
    $n: row.name,
    $v: row.value_json,
    $d: row.digest,
    $c: row.captured_at,
  });
}
