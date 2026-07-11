import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface AcceptanceCriterionRow {
  id: number;
  ticket_id: number;
  seq: number;
  text: string;
  source: string;
  created_at: string;
  updated_at: string;
}

const COLS = "id, ticket_id, seq, text, source, created_at, updated_at";

export function insertAc(
  db: Database,
  p: { ticketId: number; seq: number; text: string; source: "checklist" | "whole-description" },
): AcceptanceCriterionRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO acceptance_criterion (ticket_id, seq, text, source, created_at, updated_at)
       VALUES ($t, $seq, $text, $source, $now, $now)`,
    )
    .run({ $t: p.ticketId, $seq: p.seq, $text: p.text, $source: p.source, $now: now });
  const created = db
    .query<AcceptanceCriterionRow, [number]>(
      `SELECT ${COLS} FROM acceptance_criterion WHERE id = ?`,
    )
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertAc: row missing after insert");
  }
  return created;
}

export function listByTicket(db: Database, ticketId: number): AcceptanceCriterionRow[] {
  return db
    .query<AcceptanceCriterionRow, [number]>(
      `SELECT ${COLS} FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq`,
    )
    .all(ticketId);
}
