import type { Database } from "bun:sqlite";

/** Reads for the commands that look at a checkpoint WITHOUT migrating it: `styre ls`, `styre clean`
 *  and `--fresh`'s discard (spec §7.7). Each query names only columns present since schema v7, so it
 *  keeps working on an old checkpoint after the shared repository column lists grow (a growing list
 *  would throw there, and ENG-485's in place undo would be skipped without a word). */

export interface CheckpointTicket {
  id: number;
  project_id: number;
  ident: string;
  stage: string;
  status: string;
  branch_name: string | null;
  branch_prefix: string | null;
}

export function readCheckpointTicket(db: Database, ticketId: number): CheckpointTicket | null {
  return (
    db
      .query<CheckpointTicket, [number]>(
        "SELECT id, project_id, ident, stage, status, branch_name, branch_prefix FROM ticket WHERE id = ?",
      )
      .get(ticketId) ?? null
  );
}

export function readCheckpointTargetRepo(db: Database, projectId: number): string | null {
  return (
    db
      .query<{ target_repo: string }, [number]>("SELECT target_repo FROM project WHERE id = ?")
      .get(projectId)?.target_repo ?? null
  );
}

export function listCheckpointPendingSignals(
  db: Database,
  ticketId: number,
): { signal_type: string; reason: string | null }[] {
  return db
    .query<{ signal_type: string; reason: string | null }, [number]>(
      "SELECT signal_type, reason FROM signal WHERE ticket_id = ? AND status = 'pending' ORDER BY id",
    )
    .all(ticketId);
}

export interface CheckpointRunningStep {
  id: number;
  ticket_id: number;
  step_key: string;
  attempt: number;
  pid: number | null;
  started_at: string | null;
}

export function listCheckpointRunningSteps(db: Database): CheckpointRunningStep[] {
  return db
    .query<CheckpointRunningStep, []>(
      "SELECT id, ticket_id, step_key, attempt, pid, started_at FROM workflow_step WHERE status = 'running' ORDER BY ticket_id, seq",
    )
    .all();
}

/** The run's one ticket (a checkpoint holds one), or null. */
export function readCheckpointOnlyTicket(db: Database): CheckpointTicket | null {
  const row = db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get();
  return row ? readCheckpointTicket(db, row.id) : null;
}

/** The step a resume would dispatch again: the one left running, else the one that failed. */
export function findCheckpointParkedStepKey(db: Database, ticketId: number): string | null {
  const pick = (status: string) =>
    db
      .query<{ step_key: string }, [number, string]>(
        "SELECT step_key FROM workflow_step WHERE ticket_id = ? AND status = ? ORDER BY seq LIMIT 1",
      )
      .get(ticketId, status)?.step_key ?? null;
  return pick("running") ?? pick("failed");
}
