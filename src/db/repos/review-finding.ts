import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface ReviewFindingRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  dispatch_id: string | null;
  review_kind: string;
  finding_class_key: string | null;
  severity: string;
  category: string | null;
  factors_json: string | null;
  deferral_candidate: number;
  blocks_ship: number | null;
  location: string | null;
  rationale: string | null;
  status: string;
  created_at: string;
}

const COLS =
  "id, ticket_id, work_unit_id, dispatch_id, review_kind, finding_class_key, severity, category, " +
  "factors_json, deferral_candidate, blocks_ship, location, rationale, status, created_at";

export function getById(db: Database, id: number): ReviewFindingRow | null {
  return (
    db
      .query<ReviewFindingRow, [number]>(`SELECT ${COLS} FROM review_finding WHERE id = ?`)
      .get(id) ?? null
  );
}

export function insertFinding(
  db: Database,
  p: {
    ticketId: number;
    reviewKind: "plan" | "code";
    severity: string;
    dispatchId?: string | null;
    workUnitId?: number | null;
    category?: string | null;
    factorsJson?: string | null;
    deferralCandidate?: number;
    blocksShip?: number | null;
    location?: string | null;
    rationale?: string | null;
    findingClassKey?: string | null;
  },
): ReviewFindingRow {
  const res = db
    .query(
      `INSERT INTO review_finding
         (ticket_id, work_unit_id, dispatch_id, review_kind, finding_class_key, severity, category,
          factors_json, deferral_candidate, blocks_ship, location, rationale, status, created_at)
       VALUES ($t, $wu, $did, $kind, $fck, $sev, $cat, $fj, $defer, $blocks, $loc, $rat, 'open', $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $did: p.dispatchId ?? null,
      $kind: p.reviewKind,
      $fck: p.findingClassKey ?? null,
      $sev: p.severity,
      $cat: p.category ?? null,
      $fj: p.factorsJson ?? null,
      $defer: p.deferralCandidate ?? 0,
      $blocks: p.blocksShip ?? null,
      $loc: p.location ?? null,
      $rat: p.rationale ?? null,
      $now: nowUtc(),
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertFinding: row missing after insert");
  }
  return created;
}

export function listByDispatch(
  db: Database,
  ticketId: number,
  dispatchId: string,
): ReviewFindingRow[] {
  return db
    .query<ReviewFindingRow, [number, string]>(
      `SELECT ${COLS} FROM review_finding WHERE ticket_id = ? AND dispatch_id = ? ORDER BY id`,
    )
    .all(ticketId, dispatchId);
}

export function listOpenByTicket(db: Database, ticketId: number): ReviewFindingRow[] {
  return db
    .query<ReviewFindingRow, [number]>(
      `SELECT ${COLS} FROM review_finding WHERE ticket_id = ? AND status = 'open' ORDER BY id`,
    )
    .all(ticketId);
}

/** The dispatch_id of the most recent code-review round for this ticket (the dispatch with
 *  stage='review', highest seq). Findings are scoped to this so a clean re-review round is not
 *  re-judged against a prior round's blocking findings. */
export function latestReviewDispatchId(db: Database, ticketId: number): string | null {
  const row = db
    .query<{ dispatch_id: string }, [number]>(
      `SELECT dispatch_id FROM dispatch WHERE ticket_id = ? AND stage = 'review'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(ticketId);
  return row?.dispatch_id ?? null;
}

export type ReviewFindingStatus = "open" | "fixed" | "deferred" | "wont-fix";

export function setStatus(db: Database, id: number, status: ReviewFindingStatus): void {
  db.query("UPDATE review_finding SET status = $s WHERE id = $id").run({ $s: status, $id: id });
}
