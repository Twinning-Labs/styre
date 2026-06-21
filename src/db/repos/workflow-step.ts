import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface WorkflowStepRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  seq: number;
  step_key: string;
  step_type: string;
  status: string;
  attempt: number;
  idempotency_key: string | null;
  input_json: string | null;
  result_json: string | null;
  error_json: string | null;
  pid: number | null;
  await_signal_id: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, work_unit_id, seq, step_key, step_type, status, attempt, idempotency_key, " +
  "input_json, result_json, error_json, pid, await_signal_id, started_at, ended_at, created_at, updated_at";

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return JSON.stringify({ name: error.name, message: error.message });
  }
  return JSON.stringify({ name: "Error", message: String(error) });
}

export function nextSeq(db: Database, ticketId: number): number {
  const row = db
    .query<{ m: number | null }, [number]>(
      "SELECT MAX(seq) AS m FROM workflow_step WHERE ticket_id = ?",
    )
    .get(ticketId);
  return (row?.m ?? 0) + 1;
}

export function getById(db: Database, id: number): WorkflowStepRow | null {
  return (
    db.query<WorkflowStepRow, [number]>(`SELECT ${COLS} FROM workflow_step WHERE id = ?`).get(id) ??
    null
  );
}

export function getByKey(db: Database, ticketId: number, stepKey: string): WorkflowStepRow | null {
  return (
    db
      .query<WorkflowStepRow, [number, string]>(
        `SELECT ${COLS} FROM workflow_step WHERE ticket_id = ? AND step_key = ?`,
      )
      .get(ticketId, stepKey) ?? null
  );
}

export function insertPending(
  db: Database,
  p: {
    ticketId: number;
    workUnitId?: number | null;
    stepKey: string;
    stepType: string;
    input?: unknown;
  },
): WorkflowStepRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO workflow_step
         (ticket_id, work_unit_id, seq, step_key, step_type, status, attempt, input_json, created_at, updated_at)
       VALUES ($t, $wu, $seq, $k, $ty, 'pending', 0, $in, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $seq: nextSeq(db, p.ticketId),
      $k: p.stepKey,
      $ty: p.stepType,
      $in: p.input === undefined ? null : JSON.stringify(p.input),
      $now: now,
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertPending: row missing after insert");
  }
  return created;
}

export function markRunning(
  db: Database,
  id: number,
  opts: { idempotencyKey?: string | null; pid?: number | null },
): void {
  const now = nowUtc();
  db.query(
    `UPDATE workflow_step
       SET status = 'running', attempt = attempt + 1, idempotency_key = $key, pid = $pid,
           started_at = $now, updated_at = $now
     WHERE id = $id`,
  ).run({ $key: opts.idempotencyKey ?? null, $pid: opts.pid ?? null, $now: now, $id: id });
}

export function markSucceeded(db: Database, id: number, result: unknown): void {
  const now = nowUtc();
  db.query(
    `UPDATE workflow_step
       SET status = 'succeeded', result_json = $r, ended_at = $now, updated_at = $now
     WHERE id = $id`,
  ).run({ $r: JSON.stringify(result === undefined ? null : result), $now: now, $id: id });
}

export function markFailed(db: Database, id: number, error: unknown): void {
  const now = nowUtc();
  db.query(
    `UPDATE workflow_step
       SET status = 'failed', error_json = $e, ended_at = $now, updated_at = $now
     WHERE id = $id`,
  ).run({ $e: serializeError(error), $now: now, $id: id });
}

export function resetToPending(db: Database, id: number): void {
  db.query(
    `UPDATE workflow_step SET status = 'pending', pid = NULL, updated_at = $now WHERE id = $id`,
  ).run({ $now: nowUtc(), $id: id });
}

export function listStepsForUnit(
  db: Database,
  ticketId: number,
  workUnitId: number,
): WorkflowStepRow[] {
  return db
    .query<WorkflowStepRow, [number, number]>(
      `SELECT ${COLS} FROM workflow_step WHERE ticket_id = ? AND work_unit_id = ?`,
    )
    .all(ticketId, workUnitId);
}

export function listByStatus(db: Database, status: string): WorkflowStepRow[] {
  return db
    .query<WorkflowStepRow, [string]>(
      `SELECT ${COLS} FROM workflow_step WHERE status = ? ORDER BY ticket_id, seq`,
    )
    .all(status);
}

export function setPid(db: Database, id: number, pid: number | null): void {
  db.query("UPDATE workflow_step SET pid = $pid, updated_at = $now WHERE id = $id").run({
    $pid: pid,
    $now: nowUtc(),
    $id: id,
  });
}
