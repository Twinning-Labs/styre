import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { archiveStep } from "../db/repos/step-history.ts";
import { getByKey, resetForInvalidate } from "../db/repos/workflow-step.ts";
import { type DesignStepKey, isTableStep } from "./design-graph.ts";
import { CLEAR_OUTPUTS } from "./design-outputs.ts";

export type InvalidateCause = "inputs" | "feedback" | "worktree-recreated" | "manifest-touched";

export interface InvalidateReason {
  cause: InvalidateCause;
  /** The input names whose digests changed (cause `inputs`). */
  changed?: string[];
}

/** Apply an invalidate (spec §6), in one transaction: one `note` event, reason `invalidated` (not
 *  a loopback, so v_rejection_counts and REVIEW_REPAIR_LIMIT do not count it); for each step, its
 *  row copied to workflow_step_history with that event's id, then reset to a fresh round in the
 *  next generation; then its outputs cleared (§6.1). Returns the event id and each step's new
 *  generation. The one function that invalidates a design table step. (recover() and the failure
 *  policy still return a running or failed step to pending; that is a retry of the same round, not
 *  an invalidation, and such a step holds no manifest.) */
export function invalidateSteps(
  db: Database,
  ticketId: number,
  stepKeys: readonly DesignStepKey[],
  reason: InvalidateReason,
): { eventId: number; generations: Partial<Record<DesignStepKey, number>> } {
  for (const key of stepKeys) {
    if (!isTableStep(key)) throw new Error(`invalidateSteps: '${key}' is not a design table step`);
  }
  return db.transaction(() => {
    const event = appendEvent(db, {
      ticketId,
      kind: "note",
      reason: "invalidated",
      payload: {
        event: "invalidated",
        stepKeys: [...stepKeys],
        cause: reason.cause,
        changed: reason.changed ?? [],
      },
    });
    const generations: Partial<Record<DesignStepKey, number>> = {};
    for (const key of stepKeys) {
      const step = getByKey(db, ticketId, key);
      if (step) {
        archiveStep(db, step, event.id);
        resetForInvalidate(db, step.id);
        generations[key] = step.generation + 1;
      }
      CLEAR_OUTPUTS[key](db, ticketId);
    }
    return { eventId: event.id, generations };
  })();
}
