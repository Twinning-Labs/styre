import type { Database } from "bun:sqlite";
import { insertAc, listByTicket } from "../db/repos/acceptance-criterion.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { parseAcChecklist } from "./ac-checklist.ts";

/** Deterministically derive the ticket's acceptance criteria from its description and
 *  persist them (seq 1..N). Idempotent: if the ticket already has ACs, returns the
 *  existing count without inserting (single-writer re-derivation guard). Returns the
 *  number of ACs now present for the ticket. Lives in dispatch/ (not db/repos/) so the
 *  repo layer never imports the parser — dependency direction stays dispatch → repo. */
export function deriveAndPersistAcs(db: Database, ticketId: number): number {
  const existing = listByTicket(db, ticketId);
  if (existing.length > 0) return existing.length;
  const ticket = getTicket(db, ticketId);
  if (!ticket) {
    throw new Error(`deriveAndPersistAcs: ticket ${ticketId} not found`);
  }
  const parsed = parseAcChecklist(ticket.description);
  parsed.forEach((ac, i) =>
    insertAc(db, { ticketId, seq: i + 1, text: ac.text, source: ac.source }),
  );
  return parsed.length;
}
