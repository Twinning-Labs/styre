import type { Database } from "bun:sqlite";
import type { TicketRow } from "../db/repos/ticket.ts";
import type { WorkflowStepRow } from "../db/repos/workflow-step.ts";

/** Everything a step handler needs. Handlers do the work (dispatch/verify/project);
 *  in M2b's walking skeleton they are mocks. They return a result the journal records. */
export interface HandlerContext {
  db: Database;
  ticket: TicketRow;
  step: WorkflowStepRow;
  workUnitId: number | null;
}

export type StepHandler = (ctx: HandlerContext) => unknown | Promise<unknown>;

/** Maps a stable `handlerKey` (derived from a concrete step_key) to its handler.
 *  The resolver (M2b) computes the handlerKey and looks the handler up here. */
export class StepRegistry {
  private readonly handlers = new Map<string, StepHandler>();

  register(handlerKey: string, handler: StepHandler): void {
    if (this.handlers.has(handlerKey)) {
      throw new Error(`StepRegistry: handlerKey '${handlerKey}' already registered`);
    }
    this.handlers.set(handlerKey, handler);
  }

  resolve(handlerKey: string): StepHandler | undefined {
    return this.handlers.get(handlerKey);
  }

  has(handlerKey: string): boolean {
    return this.handlers.has(handlerKey);
  }
}
