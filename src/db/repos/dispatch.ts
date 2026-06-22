import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface DispatchRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  step_id: number | null;
  dispatch_id: string;
  seq: number;
  stage: string | null;
  kind: string | null;
  model: string | null;
  outcome: string | null;
  branch_head_sha: string | null;
  worktree_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  partial: number;
  created_at: string;
}

const COLS =
  "id, ticket_id, work_unit_id, step_id, dispatch_id, seq, stage, kind, model, outcome, " +
  "branch_head_sha, worktree_path, started_at, ended_at, duration_ms, tokens_in, tokens_out, " +
  "cost_usd, partial, created_at";

export function nextSeq(db: Database, ticketId: number): number {
  const row = db
    .query<{ m: number | null }, [number]>("SELECT MAX(seq) AS m FROM dispatch WHERE ticket_id = ?")
    .get(ticketId);
  return (row?.m ?? 0) + 1;
}

export function getByDispatchId(
  db: Database,
  ticketId: number,
  dispatchId: string,
): DispatchRow | null {
  return (
    db
      .query<DispatchRow, [number, string]>(
        `SELECT ${COLS} FROM dispatch WHERE ticket_id = ? AND dispatch_id = ?`,
      )
      .get(ticketId, dispatchId) ?? null
  );
}

export function listByTicket(db: Database, ticketId: number): DispatchRow[] {
  return db
    .query<DispatchRow, [number]>(`SELECT ${COLS} FROM dispatch WHERE ticket_id = ? ORDER BY seq`)
    .all(ticketId);
}

/** Rows with `id > afterId` (exclusive), in id order. For incremental streaming: a ticket's
 *  dispatches are created and completed within one tick (steps are serialized per ticket), so a row
 *  with a lower id is never still in flight when a higher one appears — id is a safe watermark. */
export function listByTicketSince(db: Database, ticketId: number, afterId: number): DispatchRow[] {
  return db
    .query<DispatchRow, [number, number]>(
      `SELECT ${COLS} FROM dispatch WHERE ticket_id = ? AND id > ? ORDER BY id`,
    )
    .all(ticketId, afterId);
}

export function insertDispatch(
  db: Database,
  p: {
    ticketId: number;
    dispatchId: string;
    seq: number;
    workUnitId?: number | null;
    stepId?: number | null;
    stage?: string | null;
    kind?: string | null;
    model?: string | null;
    startedAt?: string | null;
    worktreePath?: string | null;
  },
): DispatchRow {
  db.query(
    `INSERT INTO dispatch
       (ticket_id, work_unit_id, step_id, dispatch_id, seq, stage, kind, model, started_at, worktree_path, created_at)
     VALUES ($t, $wu, $step, $did, $seq, $stage, $kind, $model, $started, $wt, $now)`,
  ).run({
    $t: p.ticketId,
    $wu: p.workUnitId ?? null,
    $step: p.stepId ?? null,
    $did: p.dispatchId,
    $seq: p.seq,
    $stage: p.stage ?? null,
    $kind: p.kind ?? null,
    $model: p.model ?? null,
    $started: p.startedAt ?? null,
    $wt: p.worktreePath ?? null,
    $now: nowUtc(),
  });
  const created = getByDispatchId(db, p.ticketId, p.dispatchId);
  if (!created) {
    throw new Error("insertDispatch: row missing after insert");
  }
  return created;
}

export function completeDispatch(
  db: Database,
  id: number,
  p: {
    outcome: string;
    branchHeadSha?: string | null;
    endedAt?: string | null;
    durationMs?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    costUsd?: number | null;
    partial?: number;
  },
): void {
  db.query(
    `UPDATE dispatch
       SET outcome = $outcome, branch_head_sha = $sha, ended_at = $ended, duration_ms = $dur,
           tokens_in = $tin, tokens_out = $tout, cost_usd = $cost, partial = $partial
     WHERE id = $id`,
  ).run({
    $outcome: p.outcome,
    $sha: p.branchHeadSha ?? null,
    $ended: p.endedAt ?? null,
    $dur: p.durationMs ?? null,
    $tin: p.tokensIn ?? null,
    $tout: p.tokensOut ?? null,
    $cost: p.costUsd ?? null,
    $partial: p.partial ?? 0,
    $id: id,
  });
}

export function getLatestByWorkUnit(db: Database, workUnitId: number): DispatchRow | null {
  return (
    db
      .query<DispatchRow, [number]>(
        `SELECT ${COLS} FROM dispatch WHERE work_unit_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(workUnitId) ?? null
  );
}

export function getLatestForTicket(db: Database, ticketId: number): DispatchRow | null {
  return (
    db
      .query<DispatchRow, [number]>(
        `SELECT ${COLS} FROM dispatch WHERE ticket_id = ? AND branch_head_sha IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      )
      .get(ticketId) ?? null
  );
}
