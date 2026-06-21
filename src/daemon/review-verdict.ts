import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import {
  type ReviewFindingRow,
  latestReviewDispatchId,
  listByDispatch,
} from "../db/repos/review-finding.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStage, setTicketStatus } from "../db/repos/ticket.ts";
import {
  deleteByTicket,
  listByTicket as listUnits,
  setStatus as setUnitStatus,
} from "../db/repos/work-unit.ts";
import { getByKey, listStepsForUnit, resetToPending } from "../db/repos/workflow-step.ts";

export type ReviewDecision = "clean" | "loopback" | "escalated";

export interface ReviewVerdictResult {
  decision: ReviewDecision;
}

/** Deterministic signature of a blocking round: sorted `category:location` of the blocking
 *  findings. Two rounds with the same blocking shape produce the same signature → no-progress. */
function blockingSignature(blocking: ReviewFindingRow[]): string {
  const parts = blocking.map((f) => `${f.category ?? ""}:${f.location ?? ""}`).sort();
  return `review:${parts.join("|")}`;
}

/** True when the previous review-origin loopback (loop ∈ {implement, design}) carried the same
 *  signature — i.e. we already bounced on these exact findings and made no progress. */
function isRepeatedReviewLoopback(db: Database, ticketId: number, signature: string): boolean {
  const prior = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && (e.loop === "implement" || e.loop === "design"),
  );
  const prev = prior[prior.length - 1];
  return prev?.signature === signature;
}

function escalate(db: Database, ticketId: number, reason: string, signature: string): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, kind: "escalated", reason, signature });
  })();
}

function codeLoopback(
  db: Database,
  ticketId: number,
  blocking: ReviewFindingRow[],
  signature: string,
): void {
  db.transaction(() => {
    const anyNullUnit = blocking.some((f) => f.work_unit_id === null);
    if (anyNullUnit) {
      // Conservative: a blocking code finding not tied to a unit re-codes the whole ticket.
      for (const unit of listUnits(db, ticketId)) {
        setUnitStatus(db, unit.id, "pending");
        for (const s of listStepsForUnit(db, ticketId, unit.id)) {
          resetToPending(db, s.id);
        }
      }
    } else {
      const unitIds = new Set(
        blocking.map((f) => f.work_unit_id).filter((id): id is number => id !== null),
      );
      for (const unitId of unitIds) {
        setUnitStatus(db, unitId, "pending");
        for (const s of listStepsForUnit(db, ticketId, unitId)) {
          resetToPending(db, s.id);
        }
      }
    }
    const reviewStep = getByKey(db, ticketId, "review");
    if (reviewStep) {
      resetToPending(db, reviewStep.id);
    }
    setTicketStage(db, ticketId, "implement");
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "implement",
      routeTo: "review",
      signature,
    });
  })();
}

function redesignLoopback(db: Database, ticketId: number, signature: string): void {
  db.transaction(() => {
    deleteByTicket(db, ticketId);
    for (const key of ["design:dispatch", "design:extract", "review"]) {
      const step = getByKey(db, ticketId, key);
      if (step) {
        resetToPending(db, step.id);
      }
    }
    setTicketStage(db, ticketId, "design");
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "design",
      routeTo: "review",
      signature,
    });
  })();
}

/** Read the latest review round's findings and decide what happens next (M5b-1):
 *  clean → advance; blocking code → re-code loopback; blocking plan-defect → (config) escalate
 *  or redesign loopback; deferrable major → escalate. Ground-truth over self-report: this reads
 *  the persisted findings ledger, never an agent verdict. */
export function applyReviewVerdict(
  db: Database,
  ticketId: number,
  config: RuntimeConfig,
): ReviewVerdictResult {
  const dispatchId = latestReviewDispatchId(db, ticketId);
  if (dispatchId === null) {
    return { decision: "clean" };
  }

  const open = listByDispatch(db, ticketId, dispatchId).filter((f) => f.status === "open");
  const blocking = open.filter((f) => f.blocks_ship === 1);
  const deferred = open.filter((f) => f.severity === "major" && f.deferral_candidate === 1);

  if (blocking.length > 0) {
    const signature = blockingSignature(blocking);

    if (isRepeatedReviewLoopback(db, ticketId, signature)) {
      escalate(db, ticketId, "no progress: identical review findings", signature);
      return { decision: "escalated" };
    }

    const isPlanDefect = blocking.some((f) => f.category === "plan-defect");
    if (isPlanDefect) {
      if (config.onPlanDefect === "redesign") {
        redesignLoopback(db, ticketId, signature);
        return { decision: "loopback" };
      }
      escalate(
        db,
        ticketId,
        "blocking plan-defect found in code review; operator policy is escalate",
        signature,
      );
      return { decision: "escalated" };
    }

    codeLoopback(db, ticketId, blocking, signature);
    return { decision: "loopback" };
  }

  if (deferred.length > 0) {
    escalate(
      db,
      ticketId,
      "deferrable major finding requires a human deferral decision",
      blockingSignature(deferred),
    );
    return { decision: "escalated" };
  }

  return { decision: "clean" };
}
