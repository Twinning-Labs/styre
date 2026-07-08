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
  p: {
    ticketId: number;
    acId: number;
    selector: string;
    testPath?: string | null;
    redFirstResult?: "red" | "green" | "error" | null;
  },
): AcCheckRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ac_check (ticket_id, ac_id, selector, test_path, red_first_result, created_at, updated_at)
       VALUES ($t, $ac, $sel, $path, $red, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $ac: p.acId,
      $sel: p.selector,
      $path: p.testPath ?? null,
      $red: p.redFirstResult ?? null,
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

/** Delete every ac_check row for a ticket, returning the count removed. M2's `checks:dispatch`
 *  persists checks by delete-then-insert inside the step's success transaction (design §9): the
 *  step is effectful and `ac_check` has no uniqueness, so a crashed-and-resumed run would otherwise
 *  duplicate rows. This is the "delete" half; the insert-with-result is `insertAcCheck`. */
export function deleteByTicket(db: Database, ticketId: number): number {
  const res = db.query("DELETE FROM ac_check WHERE ticket_id = ?").run(ticketId);
  return Number(res.changes);
}
