import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import {
  type ReviewFindingRow,
  latestDispatchForStep,
  listByDispatch,
} from "../db/repos/review-finding.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStage, setTicketStatus } from "../db/repos/ticket.ts";
import {
  deleteByTicket,
  listByTicket as listUnits,
  setStatus as setUnitStatus,
} from "../db/repos/work-unit.ts";
import {
  getByKey,
  listStepsForUnit,
  resetAttempt,
  resetToPending,
} from "../db/repos/workflow-step.ts";

export type ReviewDecision = "clean" | "loopback" | "escalated";

export interface ReviewVerdictResult {
  decision: ReviewDecision;
}

/** Deterministic signature of a set of findings: sorted `category:location`. Two rounds with the
 *  same shape produce the same signature → no-progress detection. */
function findingsSignature(blocking: ReviewFindingRow[]): string {
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

/** Ticket-level verify steps re-arm on any HEAD-moving loopback: their recorded success is content-
 *  keyed to the OLD head, so leaving them 'succeeded' replays a stale gate pass at the new HEAD →
 *  resolver re-emit → MAX_TRANSITIONS. Reset is a no-op when a step doesn't exist (getByKey null). */
function resetTicketVerifySteps(db: Database, ticketId: number): void {
  for (const key of [
    "verify:integration",
    "verify:checks-gate",
    "checks:arbitrate",
    "checks:reauthor",
  ]) {
    const s = getByKey(db, ticketId, key);
    if (s) resetToPending(db, s.id);
  }
  // §6: review/design re-entry is NOT a gate-origin round → reset the monotone gate-round counter, so
  // a healthy ticket that loops review does not accumulate attempts toward a false escalate.
  const gate = getByKey(db, ticketId, "verify:checks-gate");
  if (gate) resetAttempt(db, gate.id);
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
    resetTicketVerifySteps(db, ticketId);
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

function redesignLoopback(
  db: Database,
  ticketId: number,
  signature: string,
  blocking: ReviewFindingRow[],
): void {
  // Snapshot the blocking findings that forced this redesign into the loopback event's payload, so
  // the re-dispatched design agent (via designFeedback) sees exactly what to fix — regardless of
  // which review step raised them (plan review OR code review, ENG-272). The snapshot rides
  // event_log.payload_json (no schema change) and survives the deleteByTicket below, so no detach
  // of per-unit findings is needed.
  const findings = blocking.map((f) => ({
    category: f.category,
    location: f.location,
    rationale: f.rationale,
  }));
  db.transaction(() => {
    deleteByTicket(db, ticketId);
    for (const key of ["design:dispatch", "design:extract", "design:review", "review"]) {
      const step = getByKey(db, ticketId, key);
      if (step) {
        resetToPending(db, step.id);
      }
    }
    resetTicketVerifySteps(db, ticketId);
    setTicketStage(db, ticketId, "design");
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "design",
      routeTo: "review",
      signature,
      payload: { findings },
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
  opts: { stepKey: string },
): ReviewVerdictResult {
  const dispatchId = latestDispatchForStep(db, ticketId, opts.stepKey);
  if (dispatchId === null) {
    return { decision: "clean" };
  }

  const open = listByDispatch(db, ticketId, dispatchId).filter((f) => f.status === "open");
  const blocking = open.filter((f) => f.blocks_ship === 1);

  // Plan review (S1c): any blocking plan finding → re-design (always; re-design is the natural
  // action at design time). No category routing, no deferral path. No-progress → escalate.
  if (opts.stepKey === "design:review") {
    if (blocking.length === 0) {
      return { decision: "clean" };
    }
    const signature = findingsSignature(blocking);
    if (isRepeatedReviewLoopback(db, ticketId, signature)) {
      escalate(db, ticketId, "no progress: identical plan-review findings", signature);
      return { decision: "escalated" };
    }
    redesignLoopback(db, ticketId, signature, blocking);
    return { decision: "loopback" };
  }

  // Code review (S5): existing M5b-1 routing.
  const deferred = open.filter((f) => f.severity === "major" && f.deferral_candidate === 1);

  if (blocking.length > 0) {
    const signature = findingsSignature(blocking);

    if (isRepeatedReviewLoopback(db, ticketId, signature)) {
      escalate(db, ticketId, "no progress: identical review findings", signature);
      return { decision: "escalated" };
    }

    const isPlanDefect = blocking.some((f) => f.category === "plan-defect");
    if (isPlanDefect) {
      if (config.onPlanDefect === "redesign") {
        // Carry the triggering code-review findings into the redesign so the design agent knows
        // what forced it (ENG-272): redesignLoopback snapshots them into the loopback event.
        redesignLoopback(db, ticketId, signature, blocking);
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
      findingsSignature(deferred),
    );
    return { decision: "escalated" };
  }

  return { decision: "clean" };
}
