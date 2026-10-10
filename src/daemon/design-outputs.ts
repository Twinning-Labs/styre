import type { Database } from "bun:sqlite";
import { clearTicketTrack, setNeedsDocs } from "../db/repos/ticket.ts";
import { deleteByTicket as deleteUnits } from "../db/repos/work-unit.ts";
import type { DesignStepKey } from "./design-graph.ts";

/** What an invalidation clears, per step (spec §6.1). */
export const CLEAR_OUTPUTS: Record<DesignStepKey, (db: Database, ticketId: number) => void> = {
  // reruns; nothing in the database
  provision: () => {},
  // the rerun revises the plan file in place
  "design:dispatch": () => {},
  "design:extract": (db, ticketId) => {
    // Every unit goes, reconcile units included (a stale one would collide on UNIQUE (ticket_id,
    // seq) or depend on units that no longer exist). Findings tied to a unit are detached first, so
    // the unit foreign key's cascade does not delete them: code findings as today, and plan
    // findings too (spec §6.1).
    db.query(
      "UPDATE review_finding SET work_unit_id = NULL WHERE ticket_id = ? AND work_unit_id IS NOT NULL",
    ).run(ticketId);
    deleteUnits(db, ticketId);
    setNeedsDocs(db, ticketId, 0);
  },
  "design:size": (db, ticketId) => clearTicketTrack(db, ticketId),
  // requiredPlanFindings already reads only the latest design:review dispatch
  "design:review": () => {},
};
