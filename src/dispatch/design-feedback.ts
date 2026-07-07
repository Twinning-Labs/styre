import type { Database } from "bun:sqlite";
import { latestDispatchForStep, listByDispatch } from "../db/repos/review-finding.ts";

/** Corrective feedback for a design re-dispatch after a plan-review loopback: the blocking findings
 *  from the ticket's most recent `design:review`, verbatim, with a disposition demand. Empty string
 *  when there is no prior review or it raised nothing blocking — so a first design dispatch renders
 *  a blank `{{review_feedback}}` slot. Mirrors `implementFeedback` (feedback.ts). */
export function designFeedback(db: Database, ticketId: number): string {
  const dispatchId = latestDispatchForStep(db, ticketId, "design:review");
  if (dispatchId === null) return "";
  const blocking = listByDispatch(db, ticketId, dispatchId).filter(
    (f) => f.status === "open" && f.blocks_ship === 1,
  );
  if (blocking.length === 0) return "";
  const lines = blocking.map(
    (f) => `- [${f.category ?? "?"}] ${f.location ?? "plan-wide"}: ${f.rationale ?? ""}`,
  );
  return (
    "## Prior plan-review feedback (address before finalizing)\n\n" +
    "A prior plan review raised the following. For EACH, either revise the plan to address it, or " +
    'state explicitly in the plan why it does not apply or is an accepted trade-off — a bare "no ' +
    'changes needed" is not a disposition:\n' +
    lines.join("\n")
  );
}
