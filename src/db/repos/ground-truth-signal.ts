import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface GroundTruthSignalRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  signal_type: string;
  result: string;
  command: string | null;
  branch_head_sha: string | null;
  detail_json: string | null;
  measured_at: string;
}

const COLS =
  "id, ticket_id, work_unit_id, signal_type, result, command, branch_head_sha, detail_json, measured_at";

export function listByUnit(db: Database, workUnitId: number): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE work_unit_id = ? ORDER BY measured_at, id`,
    )
    .all(workUnitId);
}

export function listByTicket(db: Database, ticketId: number): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE ticket_id = ? ORDER BY measured_at, id`,
    )
    .all(ticketId);
}

/** Rows with `id > afterId` (exclusive), in id order. For incremental streaming: signals are
 *  insert-only and id is monotonic, so id is a safe watermark over a run's growing ledger. */
export function listByTicketSince(
  db: Database,
  ticketId: number,
  afterId: number,
): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number, number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE ticket_id = ? AND id > ? ORDER BY id`,
    )
    .all(ticketId, afterId);
}

export function insertSignal(
  db: Database,
  p: {
    ticketId: number;
    workUnitId?: number | null;
    signalType: string;
    result: string;
    command?: string;
    branchHeadSha?: string;
    detail?: unknown;
  },
): GroundTruthSignalRow {
  const res = db
    .query(
      `INSERT INTO ground_truth_signal (ticket_id, work_unit_id, signal_type, result, command, branch_head_sha, detail_json, measured_at)
       VALUES ($t, $wu, $type, $result, $command, $sha, $detail, $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $type: p.signalType,
      $result: p.result,
      $command: p.command ?? null,
      $sha: p.branchHeadSha ?? null,
      $detail: p.detail === undefined ? null : JSON.stringify(p.detail),
      $now: nowUtc(),
    });
  const created = db
    .query<GroundTruthSignalRow, [number]>(`SELECT ${COLS} FROM ground_truth_signal WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertSignal: row missing after insert");
  }
  return created;
}

export function passingShasFor(
  db: Database,
  args: { ticketId: number; workUnitId: number | null; signalType: string },
): string[] {
  const rows = db
    .query<{ branch_head_sha: string | null }, [number, number | null, string]>(
      `SELECT branch_head_sha FROM ground_truth_signal
       WHERE ticket_id = ? AND work_unit_id IS ? AND signal_type = ? AND result = 'pass'
         AND branch_head_sha IS NOT NULL`,
    )
    .all(args.ticketId, args.workUnitId, args.signalType);
  return rows.map((r) => r.branch_head_sha).filter((s): s is string => s !== null);
}
