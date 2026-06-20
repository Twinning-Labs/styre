import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface ProjectRow {
  id: number;
  slug: string;
  target_repo: string;
  default_branch: string;
}

const COLS = "id, slug, target_repo, default_branch";

export function insertProject(
  db: Database,
  p: { slug: string; targetRepo: string; defaultBranch?: string },
): number {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO project (slug, target_repo, default_branch, created_at, updated_at)
       VALUES ($slug, $repo, $branch, $now, $now)`,
    )
    .run({ $slug: p.slug, $repo: p.targetRepo, $branch: p.defaultBranch ?? "main", $now: now });
  return Number(res.lastInsertRowid);
}

export function getProject(db: Database, id: number): ProjectRow | null {
  return db.query<ProjectRow, [number]>(`SELECT ${COLS} FROM project WHERE id = ?`).get(id) ?? null;
}
