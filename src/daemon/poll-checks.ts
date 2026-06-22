import type { Database } from "bun:sqlite";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import { appendEvent } from "../db/repos/event-log.ts";
import {
  insertPending as insertSignal,
  listPending,
  listPendingByType,
} from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { deliverSignal } from "../engine/signals.ts";
import type { ChecksPort } from "../integrations/checks.ts";

/** Raise a one-shot escalation for a ticket: a pending human_resume + an event. Guarded — if the
 *  ticket already has a pending human_resume, do nothing (the poll runs every tick → no spam). The
 *  ticket stays parked (its external_checks signal stays pending). */
function escalateOnce(db: Database, ticketId: number, reason: string): void {
  if (listPending(db, ticketId).some((s) => s.signal_type === "human_resume")) return;
  db.transaction(() => {
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, kind: "escalated", reason });
  })();
}

/** Deliver the external_checks signal for every parked ticket by reaching out to the project's
 *  checks system (control-loop §7.3 — polling, not webhooks). Called once per tick. NEVER throws:
 *  a per-ticket failure leaves that ticket parked for the next tick. checksSystem:
 *    "none"   → auto-deliver (skip; the human merge approval stays the gate, S8)
 *    "github" → poll the ChecksPort for the dispatch head sha: passing→deliver, failing→escalate,
 *               pending→leave parked
 *    other    → unsupported (e.g. "external"): leave parked (carry: wait-budget escalation). */
export async function pollChecks(
  db: Database,
  profile: { checksSystem: string },
  checks?: ChecksPort | null,
): Promise<void> {
  for (const sig of listPendingByType(db, "external_checks")) {
    try {
      const ticket = getTicket(db, sig.ticket_id);
      if (!ticket) continue;

      if (profile.checksSystem === "none") {
        deliverSignal(db, sig.id, { result: "skipped" });
        continue;
      }
      if (profile.checksSystem === "github") {
        if (!checks) continue; // not wired this run — leave parked
        const sha = getLatestForTicket(db, ticket.id)?.branch_head_sha;
        if (!sha) continue; // nothing to poll against yet
        const verdict = await checks.status({ ref: sha });
        if (verdict === "passing") deliverSignal(db, sig.id, { result: "passing", sha });
        else if (verdict === "failing") escalateOnce(db, ticket.id, `checks failing for ${sha}`);
        // "pending" → leave parked, re-poll next tick
      }

      // Unsupported checks system (e.g. "external"): leave parked, carry to the next tick.
      // No delivery, no escalation — the wait-budget poll escalates if it stays parked too long.
    } catch {
      // A transient poll failure must never block the loop — leave parked, retry next tick.
    }
  }
}
