import type { Database } from "bun:sqlite";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { listByUnit } from "../db/repos/ground-truth-signal.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import {
  insertWorkUnit,
  listByTicket as listUnits,
  setStatus as setUnitStatus,
} from "../db/repos/work-unit.ts";
import { listVerifyStepsForUnit, resetToPending } from "../db/repos/workflow-step.ts";
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

/** The kind of the most recent recorded result for this verify step's check.
 *  'error' = could-not-run (infrastructure), 'fail' = genuine failure, null = none. */
function latestVerifyResult(db: Database, step: WorkflowStepRow): string | null {
  if (step.work_unit_id === null) {
    return null;
  }
  const check = step.step_key.split(":").pop() ?? "";
  const rows = listByUnit(db, step.work_unit_id).filter((s) => s.signal_type === check);
  return rows.length === 0 ? null : (rows[rows.length - 1]?.result ?? null);
}

/** True when the same failure signature was the immediately-previous loopback for this ticket
 *  (no progress between attempts → escalate). */
function isRepeatedFailure(db: Database, ticketId: number, signature: string): boolean {
  const loopbacks = listEvents(db, ticketId).filter((e) => e.kind === "loopback");
  const prev = loopbacks[loopbacks.length - 1];
  return prev?.signature === signature;
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
    const signature = failureSignature(step);

    // Could-not-run (infrastructure) → retry the check, don't re-code.
    if (latestVerifyResult(db, step) === "error") {
      resetToPending(db, step.id);
      return { decision: "retry" };
    }

    // No progress since the last identical failure → escalate now.
    if (isRepeatedFailure(db, ticketId, signature)) {
      db.transaction(() => {
        setTicketStatus(db, ticketId, "waiting");
        insertSignal(db, {
          ticketId,
          signalType: "human_resume",
          reason: `no progress: '${step.step_key}' failed identically twice`,
        });
        appendEvent(db, { ticketId, kind: "escalated", reason: "no progress", signature });
      })();
      return { decision: "escalated" };
    }

    // Genuine failure → bounce the unit back to coding; re-open ALL its checks so the
    // previously-passed ones re-run against the new commit.
    db.transaction(() => {
      setUnitStatus(db, workUnitId, "pending");
      for (const s of listVerifyStepsForUnit(db, ticketId, workUnitId)) {
        resetToPending(db, s.id);
      }
      appendEvent(db, {
        ticketId,
        kind: "loopback",
        loop: "implement",
        routeTo: step.step_key,
        signature,
      });
    })();
    return { decision: "loopback" };
  }

  // Whole-project (integration) failure → ticket-scoped reconcile: add a fix unit that runs
  // after all others, then re-open the integration check.
  if (step.step_type === "verify" && step.work_unit_id === null) {
    db.transaction(() => {
      const units = listUnits(db, ticketId);
      const nextSeqNum = Math.max(0, ...units.map((u) => u.seq)) + 1;
      insertWorkUnit(db, {
        ticketId,
        seq: nextSeqNum,
        kind: "reconcile",
        behavioral: 0,
        verifyCheckTypes: [],
        dependsOn: units.map((u) => u.seq),
      });
      resetToPending(db, step.id);
      appendEvent(db, {
        ticketId,
        kind: "loopback",
        loop: "integration",
        routeTo: step.step_key,
        signature: failureSignature(step),
      });
    })();
    return { decision: "loopback" };
  }

  resetToPending(db, step.id);
  return { decision: "retry" };
}
