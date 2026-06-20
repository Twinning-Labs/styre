import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { getTicket, setTicketStage, setTicketStatus } from "../db/repos/ticket.ts";
import { setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { getByKey } from "../db/repos/workflow-step.ts";
import { awaitSignal } from "../engine/signals.ts";
import { runStep } from "../engine/step-journal.ts";
import { applyFailurePolicy } from "./failure-policy.ts";
import { nextStepKey } from "./resolver.ts";
import type { StepRegistry } from "./step-registry.ts";

const MAX_TRANSITIONS = 100;

export type AdvanceOutcome =
  | { kind: "stepped"; stepKey: string }
  | { kind: "waiting"; signalType: string }
  | { kind: "done" }
  | { kind: "blocked"; reason: string }
  | { kind: "retry"; stepKey: string }
  | { kind: "loopback"; stepKey: string }
  | { kind: "escalated"; stepKey: string };

/** Interpret M2a's pure descriptors, advancing one ticket by one real step per call.
 *  Pure transitions (advance / mark-verified) collapse inline; a step runs via runStep
 *  with the registered handler; wait parks; done finalizes; a failed step routes through
 *  failure-policy. (control-loop §2.3; minimal-loop §1/§2.) */
export async function advanceOneStep(
  db: Database,
  ticketId: number,
  registry: StepRegistry,
): Promise<AdvanceOutcome> {
  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    const d = nextStepKey(db, ticketId);

    if (d.kind === "advance") {
      db.transaction(() => {
        setTicketStage(db, ticketId, d.to);
        appendEvent(db, { ticketId, kind: "transition", fromStage: d.from, toStage: d.to });
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
      await runStep(db, {
        ticketId,
        workUnitId: d.workUnitId,
        stepKey: d.stepKey,
        stepType: d.stepType,
        effectful: true,
        execute: (step) => handler({ db, ticket, step, workUnitId: d.workUnitId }),
      });
      return { kind: "stepped", stepKey: d.stepKey };
    } catch (err) {
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
