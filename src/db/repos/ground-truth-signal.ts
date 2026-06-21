import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface GroundTruthSignalRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  signal_type: string;
  result: string;
  command: string | null;
  detail_json: string | null;
  measured_at: string;
}

const COLS = "id, ticket_id, work_unit_id, signal_type, result, command, detail_json, measured_at";

export function listByUnit(db: Database, workUnitId: number): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE work_unit_id = ? ORDER BY measured_at, id`,
    )
    .all(workUnitId);
}

export function insertSignal(
  db: Database,
  p: {
    ticketId: number;
    workUnitId?: number | null;
    signalType: string;
    result: string;
    command?: string;
    detail?: unknown;
  },
): GroundTruthSignalRow {
  const res = db
    .query(
      `INSERT INTO ground_truth_signal (ticket_id, work_unit_id, signal_type, result, command, detail_json, measured_at)
       VALUES ($t, $wu, $type, $result, $command, $detail, $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $type: p.signalType,
      $result: p.result,
      $command: p.command ?? null,
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
