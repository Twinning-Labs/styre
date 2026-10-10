import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";
import type { WorkflowStepRow } from "./workflow-step.ts";

export interface StepHistoryRow {
  id: number;
  step_id: number;
  ticket_id: number;
  event_id: number;
  step_key: string;
  status: string;
  attempt: number;
  result_json: string | null;
  error_json: string | null;
  input_manifest: string | null;
  input_fingerprint: string | null;
  output_digest: string | null;
  fingerprint_scheme: number | null;
  generation: number;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string;
}

const COLS =
  "id, step_id, ticket_id, event_id, step_key, status, attempt, result_json, error_json, input_manifest, " +
  "input_fingerprint, output_digest, fingerprint_scheme, generation, started_at, ended_at, archived_at";

/** Copy `step` as it is now, before an invalidation resets it (spec §6 step 2). */
export function archiveStep(db: Database, step: WorkflowStepRow, eventId: number): void {
  db.query(
    `INSERT INTO workflow_step_history
       (step_id, ticket_id, event_id, step_key, status, attempt, result_json, error_json, input_manifest,
        input_fingerprint, output_digest, fingerprint_scheme, generation, started_at, ended_at, archived_at)
     VALUES ($sid, $tid, $eid, $key, $status, $attempt, $result, $error, $manifest,
        $fingerprint, $output, $scheme, $generation, $started, $ended, $now)`,
  ).run({
    $sid: step.id,
    $tid: step.ticket_id,
    $eid: eventId,
    $key: step.step_key,
    $status: step.status,
    $attempt: step.attempt,
    $result: step.result_json,
    $error: step.error_json,
    $manifest: step.input_manifest,
    $fingerprint: step.input_fingerprint,
    $output: step.output_digest,
    $scheme: step.fingerprint_scheme,
    $generation: step.generation,
    $started: step.started_at,
    $ended: step.ended_at,
    $now: nowUtc(),
  });
}

export function listStepHistory(
  db: Database,
  ticketId: number,
  stepKey?: string,
): StepHistoryRow[] {
  return stepKey === undefined
    ? db
        .query<StepHistoryRow, [number]>(
          `SELECT ${COLS} FROM workflow_step_history WHERE ticket_id = ? ORDER BY id`,
        )
        .all(ticketId)
    : db
        .query<StepHistoryRow, [number, string]>(
          `SELECT ${COLS} FROM workflow_step_history WHERE ticket_id = ? AND step_key = ? ORDER BY id`,
        )
        .all(ticketId, stepKey);
}
