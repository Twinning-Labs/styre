import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { insertPending } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";

/** Pause a ticket that has NO failed/running step to re-arm — a resolver dead-end (`blocked`) or a
 *  driveToTerminal stall — into the same `waiting` + pending `human_resume` shape an escalation
 *  produces, so it becomes a legible, resumable `paused (needs_you)` checkpoint that drops out of
 *  `v_ready_tickets`. `detail` is the honest note (design §3.4): it must state what a resume
 *  requires. This mirrors `checks-gate-verdict.ts escalate()` MINUS the step/dispatch specifics; it
 *  is deliberately NOT wired into the step-bearing failure-policy escalate paths (they leave a
 *  `failed` step and carry distinct signatures — a future DRY opportunity, not this ticket). */
export function pauseTicket(db: Database, ticketId: number, detail: string): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertPending(db, { ticketId, signalType: "human_resume", reason: detail });
    appendEvent(db, { ticketId, kind: "escalated", reason: detail });
  })();
}
