import type { Database } from "bun:sqlite";
import { latestDispatchForStep, listByDispatch } from "../db/repos/review-finding.ts";

/** Corrective feedback for an implement re-code after a code-review→implement loopback: the blocking
 *  findings from the latest `review` round that pertain to THIS unit (its own findings, plus any
 *  finding not tied to a unit — those re-code the whole ticket). Empty when there is no prior review
 *  round, or none of its blocking findings touch this unit — so a first implement dispatch renders a
 *  blank `{{review_feedback}}`. Ground truth: reads the persisted finding ledger scoped to the round
 *  that forced the bounce (the same set `applyReviewVerdict` used), never an agent verdict. Mirrors
 *  `implementFeedback`/`gateFeedback` (feedback.ts) and `designFeedback`. */
export function reviewFeedback(db: Database, ticketId: number, workUnitId: number): string {
  const dispatchId = latestDispatchForStep(db, ticketId, "review");
  if (dispatchId === null) return "";
  const blocking = listByDispatch(db, ticketId, dispatchId).filter(
    (f) =>
      f.status === "open" &&
      f.blocks_ship === 1 &&
      (f.work_unit_id === workUnitId || f.work_unit_id === null),
  );
  if (blocking.length === 0) return "";
  const lines = blocking.map(
    (f) => `- [${f.severity}] ${f.location ?? "unit-wide"}: ${f.rationale ?? ""}`,
  );
  return `## Code-review findings to fix (a prior review blocked shipping on these)\n\nThe last code review of your work raised the following blocking findings. Fix EACH before you finish — do NOT weaken or delete tests to hide them:\n${lines.join("\n")}`;
}
