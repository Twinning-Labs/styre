import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface TicketRow {
  id: number;
  project_id: number;
  ident: string;
  title: string | null;
  description: string | null;
  stage: string;
  status: string;
  track: string | null;
  needs_docs: number;
  branch_name: string | null;
  branch_prefix: string | null;
  type_label: string | null;
}

const COLS =
  "id, project_id, ident, title, description, stage, status, track, needs_docs, branch_name, branch_prefix, type_label";

export function insertTicket(
  db: Database,
  t: {
    projectId: number;
    ident: string;
    stage?: string;
    status?: string;
    track?: string;
    needsDocs?: number;
    title?: string | null;
    description?: string | null;
    typeLabel?: string | null;
    branchPrefix?: string | null;
    externalId?: string | null;
  },
): number {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ticket
         (project_id, ident, title, description, type_label, branch_prefix, linear_issue_uuid,
          stage, status, track, needs_docs, created_at, updated_at)
       VALUES ($pid, $ident, $title, $description, $typeLabel, $branchPrefix, $externalId,
          $stage, $status, $track, $needsDocs, $now, $now)`,
    )
    .run({
      $pid: t.projectId,
      $ident: t.ident,
      $title: t.title ?? null,
      $description: t.description ?? null,
      $typeLabel: t.typeLabel ?? null,
      $branchPrefix: t.branchPrefix ?? null,
      $externalId: t.externalId ?? null,
      $stage: t.stage ?? "design",
      $status: t.status ?? "active",
      $track: t.track ?? null,
      $needsDocs: t.needsDocs ?? 0,
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

export function setTicketStage(db: Database, id: number, stage: string): void {
  db.query("UPDATE ticket SET stage = $stage, updated_at = $now WHERE id = $id").run({
    $stage: stage,
    $now: nowUtc(),
    $id: id,
  });
}

export function setTicketTrack(db: Database, id: number, track: string): void {
  db.query("UPDATE ticket SET track = $track, updated_at = $now WHERE id = $id").run({
    $track: track,
    $now: nowUtc(),
    $id: id,
  });
}

export function setNeedsDocs(db: Database, id: number, needsDocs: number): void {
  db.query("UPDATE ticket SET needs_docs = $nd, updated_at = $now WHERE id = $id").run({
    $nd: needsDocs,
    $now: nowUtc(),
    $id: id,
  });
}

export function setBranch(db: Database, id: number, branchName: string): void {
  db.query("UPDATE ticket SET branch_name = $b, updated_at = $now WHERE id = $id").run({
    $b: branchName,
    $now: nowUtc(),
    $id: id,
  });
}
