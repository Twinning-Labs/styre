import type { Database } from "bun:sqlite";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "../config/runtime-config.ts";
import { appendEvent } from "../db/repos/event-log.ts";
import { getTicket, setTicketStage, setTicketStatus } from "../db/repos/ticket.ts";
import { setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { decrementAttempt, getByKey } from "../db/repos/workflow-step.ts";
import { ParkSignal } from "../engine/park-signal.ts";
import type { ParkInfo } from "../engine/park-signal.ts";
import { awaitSignal } from "../engine/signals.ts";
import { runStep } from "../engine/step-journal.ts";
import { type GateVerdictResult, applyAcCheckGateVerdict } from "./checks-gate-verdict.ts";
import { type ChecksVerdictResult, applyChecksVerdict } from "./checks-verdict.ts";
import { applyFailurePolicy } from "./failure-policy.ts";
import { enqueueStageProjection } from "./projector.ts";
import { nextStepKey } from "./resolver.ts";
import { type ReviewVerdictResult, applyReviewVerdict } from "./review-verdict.ts";
import type { StepRegistry } from "./step-registry.ts";

const MAX_TRANSITIONS = 100;

const VERDICT_BEARING_STEPS = new Set([
  "review",
  "design:review",
  "checks:classify",
  "verify:checks-gate",
]);

export type AdvanceOutcome =
  | { kind: "stepped"; stepKey: string }
  | { kind: "waiting"; signalType: string }
  | { kind: "done" }
  | { kind: "blocked"; reason: string }
  | { kind: "retry"; stepKey: string }
  | { kind: "loopback"; stepKey: string }
  | { kind: "escalated"; stepKey: string }
  | { kind: "parked"; stepKey: string; park: ParkInfo };

/** Interpret M2a's pure descriptors, advancing one ticket by one real step per call.
 *  Pure transitions (advance / mark-verified) collapse inline; a step runs via runStep
 *  with the registered handler; wait parks; done finalizes; a failed step routes through
 *  failure-policy. (control-loop §2.3; minimal-loop §1/§2.) */
export async function advanceOneStep(
  db: Database,
  ticketId: number,
  registry: StepRegistry,
  opts?: { config?: RuntimeConfig },
): Promise<AdvanceOutcome> {
  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    const d = nextStepKey(db, ticketId);

    if (d.kind === "advance") {
      const t = getTicket(db, ticketId);
      if (!t) {
        throw new Error(`advanceOneStep: ticket ${ticketId} not found`);
      }
      db.transaction(() => {
        setTicketStage(db, ticketId, d.to);
        appendEvent(db, { ticketId, kind: "transition", fromStage: d.from, toStage: d.to });
        enqueueStageProjection(db, t, d.from, d.to);
      })();
      continue;
    }

    if (d.kind === "mark-verified") {
      setUnitStatus(db, d.workUnitId, "verified");
      continue;
    }

    if (d.kind === "wait") {
      awaitSignal(db, { ticketId, signalType: d.signalType });
      return { kind: "waiting", signalType: d.signalType };
    }

    if (d.kind === "done") {
      setTicketStatus(db, ticketId, "done");
      return { kind: "done" };
    }

    if (d.kind === "blocked") {
      return { kind: "blocked", reason: d.reason };
    }

    // d.kind === "step"
    const ticket = getTicket(db, ticketId);
    if (!ticket) {
      throw new Error(`advanceOneStep: ticket ${ticketId} not found`);
    }
    const handler = registry.resolve(d.handlerKey);
    if (!handler) {
      throw new Error(`advanceOneStep: no handler registered for '${d.handlerKey}'`);
    }
    try {
      // The review verdict is applied in the SAME transaction that marks the step succeeded
      // (onSucceed). Otherwise a crash between the two would leave a `succeeded` review with an
      // un-applied verdict, and resume would advance review→merge past blocking findings (the
      // ground-truth verdict must survive crash-resume — invariants 3 + 4).
      const verdictBox: {
        value: ReviewVerdictResult | ChecksVerdictResult | GateVerdictResult | null;
      } = { value: null };
      await runStep(db, {
        ticketId,
        workUnitId: d.workUnitId,
        stepKey: d.stepKey,
        stepType: d.stepType,
        effectful: true,
        execute: (step) =>
          handler({
            db,
            ticket,
            step,
            workUnitId: d.workUnitId,
            config: opts?.config ?? DEFAULT_RUNTIME_CONFIG,
          }),
        onSucceed: VERDICT_BEARING_STEPS.has(d.stepKey)
          ? () => {
              const cfg = opts?.config ?? DEFAULT_RUNTIME_CONFIG;
              verdictBox.value =
                d.stepKey === "checks:classify"
                  ? applyChecksVerdict(db, ticketId, { stepKey: d.stepKey })
                  : d.stepKey === "verify:checks-gate"
                    ? applyAcCheckGateVerdict(db, ticketId, { stepKey: d.stepKey })
                    : applyReviewVerdict(db, ticketId, cfg, { stepKey: d.stepKey });
            }
          : undefined,
      });
      const verdict = verdictBox.value;
      if (verdict !== null && verdict.decision !== "clean") {
        return { kind: verdict.decision, stepKey: d.stepKey };
      }
      return { kind: "stepped", stepKey: d.stepKey };
    } catch (err) {
      if (err instanceof ParkSignal) {
        const parkedStep = getByKey(db, ticketId, d.stepKey);
        db.transaction(() => {
          // Undo the attempt++ that markRunning applied: a quota pause is not a real attempt
          // and must not consume retry budget (ENG-164). The step stays 'running' — recover()
          // needs that status to reset it to pending on resume.
          if (parkedStep) {
            decrementAttempt(db, parkedStep.id);
          }
          setTicketStatus(db, ticketId, "waiting");
          appendEvent(db, {
            ticketId,
            kind: "parked",
            reason:
              err.info.cause === "session-limit"
                ? `session-limit${err.info.resetAt ? `; resets ${err.info.resetAt}` : ""}`
                : "out-of-credits; top up to resume",
            payload: {
              cause: err.info.cause,
              resetAt: err.info.resetAt,
              dispatchId: err.info.dispatchId,
            },
          });
        })();
        return { kind: "parked", stepKey: d.stepKey, park: err.info };
      }
      const failed = getByKey(db, ticketId, d.stepKey);
      if (!failed || failed.status !== "failed") {
        // Not a handler failure — e.g. StepInFlightError (a running step; recover() owns it). Propagate.
        throw err;
      }
      const { decision } = applyFailurePolicy(db, ticketId, failed);
      return { kind: decision, stepKey: d.stepKey };
    }
  }
  throw new Error(`advanceOneStep: exceeded ${MAX_TRANSITIONS} transitions for ticket ${ticketId}`);
}
