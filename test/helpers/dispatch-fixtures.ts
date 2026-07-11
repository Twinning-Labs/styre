import type { Database } from "bun:sqlite";
import { insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";

/** A `design:review` workflow_step + a dispatch row owned by it, so
 *  `latestDispatchForStep(db, ticketId, "design:review")` resolves. Returns the dispatch_id. */
export function insertDesignReviewDispatch(db: Database, ticketId: number): string {
  const step = insertPending(db, { ticketId, stepKey: "design:review", stepType: "dispatch" });
  const dispatchId = `${ticketId}-review-1`;
  insertDispatch(db, { ticketId, dispatchId, seq: nextSeq(db, ticketId), stepId: step.id });
  return dispatchId;
}
