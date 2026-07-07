import type { Database } from "bun:sqlite";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";

/** The per-finding shape snapshotted into a design loopback event's payload by `redesignLoopback`. */
interface FindingSnapshot {
  category: string | null;
  location: string | null;
  rationale: string | null;
}

/** Corrective feedback for a design re-dispatch after a redesign loopback: the blocking findings
 *  that forced the most recent redesign, verbatim, with a disposition demand. The verdict
 *  (`redesignLoopback`) snapshots those findings into the loopback event's `payload_json`, so this
 *  covers BOTH the `design:review`→redesign and the code-review→plan-defect→redesign paths — the
 *  latter's findings live on the `review` (code) dispatch and were never rendered before (ENG-272).
 *  Empty string when there is no prior redesign — so a first design dispatch renders a blank
 *  `{{review_feedback}}` slot. Mirrors `implementFeedback` (feedback.ts). */
export function designFeedback(db: Database, ticketId: number): string {
  const loopbacks = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "design" && e.payload_json !== null,
  );
  const latest = loopbacks[loopbacks.length - 1];
  if (!latest?.payload_json) return "";
  const findings = (JSON.parse(latest.payload_json) as { findings?: FindingSnapshot[] }).findings;
  if (!findings || findings.length === 0) return "";
  const lines = findings.map(
    (f) => `- [${f.category ?? "?"}] ${f.location ?? "plan-wide"}: ${f.rationale ?? ""}`,
  );
  return `## Prior plan-review feedback (address before finalizing)\n\nA prior plan review raised the following. For EACH, either revise the plan to address it, or state explicitly in the plan why it does not apply or is an accepted trade-off — a bare "no changes needed" is not a disposition:\n${lines.join("\n")}`;
}
