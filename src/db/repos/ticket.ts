import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface TicketRow {
  id: number;
  project_id: number;
  ident: string;
  stage: string;
  status: string;
}

const COLS = "id, project_id, ident, stage, status";

export function insertTicket(
  db: Database,
  t: { projectId: number; ident: string; stage?: string; status?: string },
): number {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ticket (project_id, ident, stage, status, created_at, updated_at)
       VALUES ($pid, $ident, $stage, $status, $now, $now)`,
    )
    .run({
      $pid: t.projectId,
      $ident: t.ident,
      $stage: t.stage ?? "design",
      $status: t.status ?? "active",
      $now: now,
    });
  return Number(res.lastInsertRowid);
}

export function getTicket(db: Database, id: number): TicketRow | null {
  return db.query<TicketRow, [number]>(`SELECT ${COLS} FROM ticket WHERE id = ?`).get(id) ?? null;
}

export function setTicketStatus(db: Database, id: number, status: string): void {
  db.query("UPDATE ticket SET status = $status, updated_at = $now WHERE id = $id").run({
    $status: status,
    $now: nowUtc(),
    $id: id,
  });
}
