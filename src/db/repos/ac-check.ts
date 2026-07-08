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
  disposition: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, ac_id, selector, test_path, red_first_result, red_class, disposition, created_at, updated_at";

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

/** Delete every ac_check row for ONE acceptance criterion (the scoped re-author, §2): a `vacuous`
 *  loopback re-authors only the flagged ACs, so their rows are deleted then re-inserted while every
 *  other AC's classified rows stay frozen. Returns the count removed. */
export function deleteByAc(db: Database, acId: number): number {
  const res = db.query("DELETE FROM ac_check WHERE ac_id = ?").run(acId);
  return Number(res.changes);
}

/** The ticket's checks that are still unresolved: neither graded (`red_class`) nor dispositioned.
 *  `checks:classify` classifies ONLY these — already-classified rows are immutable (write-once, §7). */
export function listUnresolvedByTicket(db: Database, ticketId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(
      `SELECT ${COLS} FROM ac_check
       WHERE ticket_id = ? AND red_class IS NULL AND disposition IS NULL ORDER BY id`,
    )
    .all(ticketId);
}

/** Record a check's classification (M3). A red check gets a `redClass`; a green-on-HEAD check gets a
 *  `disposition`. Exactly one is expected per call; both columns are otherwise write-once (the caller
 *  only ever classifies unresolved rows). */
export function classifyAcCheck(
  db: Database,
  p: {
    acCheckId: number;
    redClass?: "assertion" | "absence" | "environmental";
    disposition?: "satisfied" | "not-expressible";
  },
): void {
  db.query(
    `UPDATE ac_check SET red_class = COALESCE($rc, red_class),
       disposition = COALESCE($disp, disposition), updated_at = $now WHERE id = $id`,
  ).run({
    $id: p.acCheckId,
    $rc: p.redClass ?? null,
    $disp: p.disposition ?? null,
    $now: nowUtc(),
  });
}
