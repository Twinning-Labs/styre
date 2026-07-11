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
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, ac_id, selector, test_path, red_first_result, red_class, disposition, superseded_at, created_at, updated_at";

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

/** The ticket's checks that are still unresolved: neither graded (`red_class`) nor dispositioned, and
 *  still unresolved AND active (`superseded_at IS NULL`): a superseded row is frozen history, never
 *  re-classified. `checks:classify` classifies ONLY these — already-classified rows are immutable
 *  (write-once, §7). */
export function listUnresolvedByTicket(db: Database, ticketId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(
      `SELECT ${COLS} FROM ac_check
       WHERE ticket_id = ? AND red_class IS NULL AND disposition IS NULL AND superseded_at IS NULL
       ORDER BY id`,
    )
    .all(ticketId);
}

export function listActiveByTicket(db: Database, ticketId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(
      `SELECT ${COLS} FROM ac_check WHERE ticket_id = ? AND superseded_at IS NULL ORDER BY id`,
    )
    .all(ticketId);
}

export function listActiveByAc(db: Database, acId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(
      `SELECT ${COLS} FROM ac_check WHERE ac_id = ? AND superseded_at IS NULL ORDER BY id`,
    )
    .all(acId);
}

/** Supersede (never delete) every ACTIVE check for one AC — the scoped re-author (§2/M4). Sets
 *  superseded_at=now where it is NULL; returns the count superseded. `nowUtc()` is called ONCE and
 *  bound to a single `$now`, so every row this call supersedes (an AC can own >1 active check — see
 *  `reauthorRoundsForAc`) shares exactly ONE timestamp — that's what makes a "round" countable by
 *  `COUNT(DISTINCT superseded_at)`. History is preserved and ids are never reused (AUTOINCREMENT), so
 *  the control loop reads live state from THIS table, never from the append-only signal log by
 *  (formerly-reused) id — the M4 anti-pattern fix. Idempotent: a second call supersedes 0. */
export function supersedeByAc(db: Database, acId: number): number {
  const res = db
    .query(
      "UPDATE ac_check SET superseded_at = $now, updated_at = $now WHERE ac_id = $ac AND superseded_at IS NULL",
    )
    .run({ $now: nowUtc(), $ac: acId });
  return Number(res.changes);
}

/** How many times an AC has been RE-AUTHORED — i.e. the number of DISTINCT `supersedeByAc` rounds,
 *  NOT the number of superseded rows. `supersedeByAc` supersedes every active row for the AC under one
 *  shared timestamp per call, so `COUNT(DISTINCT superseded_at)` = number of rounds regardless of how
 *  many checks the AC owns. The monotone escalate counter (M4 §5): ≥ REAUTHOR_ESCALATE_CAP ⇒ escalate.
 *  Replaces M3's log-signature + predecessor-compare, which depended on live-id reuse.
 *
 *  Correctness note (an independent review's Critical): a plain `COUNT(*)` of superseded ROWS is
 *  WRONG here — an AC with k active checks (multiple test cases per AC, e.g.
 *  `ac-check-classify.test.ts`) has all k rows superseded in ONE round by ONE `supersedeByAc` call, so
 *  a row-count reads k on the AC's FIRST flag and would escalate immediately instead of on the 2nd
 *  round. Counting DISTINCT timestamps instead fixes this.
 *
 *  Robustness: this depends on distinct rounds getting distinct `superseded_at` values. In production
 *  rounds are separated by a full re-author dispatch (seconds apart) → always distinct. `nowUtc()` is
 *  millisecond-resolution, so a synchronous unit test driving 2+ LIVE rounds back-to-back could in
 *  principle collide; such a test must force distinct timestamps (e.g. backdate the first round via a
 *  direct SQL `UPDATE ac_check SET superseded_at = ? ...` before triggering the second, matching this
 *  suite's existing nowUtc-override convention — see `test/cli/head-baseline.test.ts`). */
export function reauthorRoundsForAc(db: Database, acId: number): number {
  const row = db
    .query<{ n: number }, [number]>(
      "SELECT COUNT(DISTINCT superseded_at) AS n FROM ac_check WHERE ac_id = ? AND superseded_at IS NOT NULL",
    )
    .get(acId);
  return row?.n ?? 0;
}

/** Delete only the ACTIVE (not-yet-superseded) rows for an AC — checks:dispatch's re-run/resume dedup
 *  (§9). The scoped re-author's supersede lives in the VERDICT (exactly-once); checks:dispatch merely
 *  inserts fresh actives, so on a crash-resume it first clears its OWN not-yet-classified actives.
 *  Superseded history is untouched, so the escalate counter is never disturbed by a resume. */
export function deleteActiveByAc(db: Database, acId: number): number {
  const res = db.query("DELETE FROM ac_check WHERE ac_id = ? AND superseded_at IS NULL").run(acId);
  return Number(res.changes);
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
