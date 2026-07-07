import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface AcCheckRow {
  id: number;
  ticket_id: number;
  ac_id: number;
  selector: string;
  test_path: string | null;
  red_first_result: string | null;
  red_class: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, ac_id, selector, test_path, red_first_result, red_class, created_at, updated_at";

export function insertAcCheck(
  db: Database,
  p: { ticketId: number; acId: number; selector: string; testPath?: string | null },
): AcCheckRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ac_check (ticket_id, ac_id, selector, test_path, created_at, updated_at)
       VALUES ($t, $ac, $sel, $path, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $ac: p.acId,
      $sel: p.selector,
      $path: p.testPath ?? null,
      $now: now,
    });
  const created = db
    .query<AcCheckRow, [number]>(`SELECT ${COLS} FROM ac_check WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertAcCheck: row missing after insert");
  }
  return created;
}

export function listByTicket(db: Database, ticketId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(`SELECT ${COLS} FROM ac_check WHERE ticket_id = ? ORDER BY id`)
    .all(ticketId);
}

export function listByAc(db: Database, acId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(`SELECT ${COLS} FROM ac_check WHERE ac_id = ? ORDER BY id`)
    .all(acId);
}
