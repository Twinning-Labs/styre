import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface WorkUnitRow {
  id: number;
  ticket_id: number;
  seq: number;
  kind: string;
  title: string | null;
  description: string | null;
  status: string;
  behavioral: number;
  files_to_touch: string | null;
  test_plan: string | null;
  verify_check_types: string | null;
  depends_on: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, seq, kind, title, description, status, behavioral, files_to_touch, test_plan, verify_check_types, depends_on, created_at, updated_at";

export function getById(db: Database, id: number): WorkUnitRow | null {
  return (
    db.query<WorkUnitRow, [number]>(`SELECT ${COLS} FROM work_unit WHERE id = ?`).get(id) ?? null
  );
}

export function listByTicket(db: Database, ticketId: number): WorkUnitRow[] {
  return db
    .query<WorkUnitRow, [number]>(`SELECT ${COLS} FROM work_unit WHERE ticket_id = ? ORDER BY seq`)
    .all(ticketId);
}

export function insertWorkUnit(
  db: Database,
  p: {
    ticketId: number;
    seq: number;
    kind: string;
    title?: string | null;
    description?: string | null;
    testPlan?: string | null;
    status?: string;
    behavioral?: number;
    filesToTouch?: string[] | null;
    verifyCheckTypes?: number[] | string[] | null;
    dependsOn?: number[] | null;
  },
): WorkUnitRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO work_unit
         (ticket_id, seq, kind, title, description, status, behavioral, files_to_touch, test_plan, verify_check_types, depends_on, created_at, updated_at)
       VALUES ($t, $seq, $kind, $title, $desc, $status, $behavioral, $ftt, $tp, $vct, $dep, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $seq: p.seq,
      $kind: p.kind,
      $title: p.title ?? null,
      $desc: p.description ?? null,
      $status: p.status ?? "pending",
      $behavioral: p.behavioral ?? 1,
      $ftt: p.filesToTouch == null ? null : JSON.stringify(p.filesToTouch),
      $tp: p.testPlan ?? null,
      $vct: p.verifyCheckTypes == null ? null : JSON.stringify(p.verifyCheckTypes),
      $dep: p.dependsOn == null ? null : JSON.stringify(p.dependsOn),
      $now: now,
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertWorkUnit: row missing after insert");
  }
  return created;
}

export function setStatus(db: Database, id: number, status: string): void {
  db.query("UPDATE work_unit SET status = $status, updated_at = $now WHERE id = $id").run({
    $status: status,
    $now: nowUtc(),
    $id: id,
  });
}

export function deleteByTicket(db: Database, ticketId: number): void {
  db.query("DELETE FROM work_unit WHERE ticket_id = ?").run(ticketId);
}

export function parseDependsOn(row: WorkUnitRow): number[] {
  return row.depends_on === null ? [] : (JSON.parse(row.depends_on) as number[]);
}

export function parseVerifyCheckTypes(row: WorkUnitRow): string[] {
  return row.verify_check_types === null ? [] : (JSON.parse(row.verify_check_types) as string[]);
}

export function parseFilesToTouch(row: WorkUnitRow): string[] {
  return row.files_to_touch === null ? [] : (JSON.parse(row.files_to_touch) as string[]);
}
