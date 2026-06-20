import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { resetToPending } from "../db/repos/workflow-step.ts";
import type { WorkflowStepRow } from "../db/repos/workflow-step.ts";

export type FailureDecision = "retry" | "loopback" | "escalated";

export interface FailurePolicyResult {
  decision: FailureDecision;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function failureSignature(step: WorkflowStepRow): string {
  const message = step.error_json === null ? "" : (JSON.parse(step.error_json).message ?? "");
  return `${step.step_key}:${message}`;
}

/** Failure-policy SHAPE (minimal-loop §2 / control-loop §8): bounded retry → loopback
 *  for verify failures → escalate to a resumable wait. The full atlas (signature-based
 *  distinct counting, B2/B3 budgets, the per-route table) is a later milestone. */
export function applyFailurePolicy(
  db: Database,
  ticketId: number,
  step: WorkflowStepRow,
  opts?: { maxAttempts?: number },
): FailurePolicyResult {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (step.attempt >= maxAttempts) {
    db.transaction(() => {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, {
        ticketId,
        signalType: "human_resume",
        reason: `step '${step.step_key}' exhausted after ${step.attempt} attempts`,
      });
      appendEvent(db, {
        ticketId,
        kind: "escalated",
        reason: `step '${step.step_key}' failed`,
        signature: failureSignature(step),
      });
    })();
    return { decision: "escalated" };
  }

  if (step.step_type === "verify" && step.work_unit_id !== null) {
    const workUnitId = step.work_unit_id;
    db.transaction(() => {
      setUnitStatus(db, workUnitId, "pending");
      resetToPending(db, step.id);
      appendEvent(db, {
        ticketId,
        kind: "loopback",
        loop: "implement",
        routeTo: step.step_key,
        signature: failureSignature(step),
      });
    })();
    return { decision: "loopback" };
  }

  resetToPending(db, step.id);
  return { decision: "retry" };
}
