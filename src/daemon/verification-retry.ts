import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import {
  type WorkflowStepRow,
  getById,
  listByStatus,
  markFailed,
  resetAttempt,
  resetToPending,
} from "../db/repos/workflow-step.ts";
import { StepExecutionError } from "../engine/step-journal.ts";
import { DEFAULT_MAX_ATTEMPTS, applyFailurePolicy } from "./failure-policy.ts";

export function isSuiteStep(step: WorkflowStepRow): boolean {
  return (
    step.step_type === "verify" &&
    (step.work_unit_id !== null || step.step_key === "verify:integration")
  );
}

function isExecutionError(step: WorkflowStepRow): boolean {
  return step.error_json !== null && JSON.parse(step.error_json).name === "StepExecutionError";
}

/** Handle the crash windows before executing: failed before policy committed, or interrupted
 * running work recovered to pending. Automatic restart must not grant another attempt budget. */
export function prepareVerificationRetry(db: Database, step: WorkflowStepRow) {
  if (!isSuiteStep(step)) return null;
  if (step.status === "failed" && isExecutionError(step)) {
    return applyFailurePolicy(db, step.ticket_id, step);
  }
  if (step.status === "pending" && isExecutionError(step) && step.attempt >= DEFAULT_MAX_ATTEMPTS) {
    markFailed(
      db,
      step.id,
      new StepExecutionError("verification execution attempt budget exhausted before restart"),
    );
    const failed = getById(db, step.id);
    if (!failed) throw new Error(`verification step ${step.id} vanished`);
    return applyFailurePolicy(db, step.ticket_id, failed);
  }
  return null;
}

/** Only the explicit operator resume path may grant a new window. Preserve prior attempt/error
 * evidence in the event ledger before resetting the counter; never reset succeeded checkpoints. */
export function resumeVerificationRetries(db: Database, ticketId: number): void {
  for (const step of [
    ...listByStatus(db, "failed"),
    ...listByStatus(db, "running"),
    ...listByStatus(db, "pending"),
  ]) {
    if (step.ticket_id !== ticketId || !isSuiteStep(step)) continue;
    if (
      !(step.status === "failed" && isExecutionError(step)) &&
      !(
        step.status === "pending" &&
        step.attempt >= DEFAULT_MAX_ATTEMPTS &&
        isExecutionError(step)
      ) &&
      !(step.status === "running" && step.attempt >= DEFAULT_MAX_ATTEMPTS)
    )
      continue;
    appendEvent(db, {
      ticketId,
      kind: "note",
      reason: "verification-retry-window-granted",
      payload: {
        stepKey: step.step_key,
        priorAttempts: step.attempt,
        priorError: step.error_json === null ? null : JSON.parse(step.error_json),
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      },
    });
    resetAttempt(db, step.id);
    // Running process cleanup belongs to recover(), after resume preparation commits.
    if (step.status === "failed") resetToPending(db, step.id);
  }
}
