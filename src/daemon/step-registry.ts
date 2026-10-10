import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import type { TicketRow } from "../db/repos/ticket.ts";
import type { WorkflowStepRow } from "../db/repos/workflow-step.ts";

/** Everything a step handler needs. Handlers do the work (dispatch/verify/project);
 *  in M2b's walking skeleton they are mocks. They return a result the journal records. */
export interface HandlerContext {
  db: Database;
  ticket: TicketRow;
  step: WorkflowStepRow;
  workUnitId: number | null;
  config: RuntimeConfig;
}

export type StepHandler = (ctx: HandlerContext) => unknown | Promise<unknown>;

/** Writes a step's own database outputs inside its success transaction (spec §6.2), from the
 *  handler's result, before any verdict reads them. */
export type StepCommit = (db: Database, ticketId: number, result: unknown) => void;

/** Maps a stable `handlerKey` (derived from a concrete step_key) to its handler.
 *  The resolver (M2b) computes the handlerKey and looks the handler up here. */
export class StepRegistry {
  /** Runner-owned durable inputs, synchronized before resolution (including resume with no pending steps).
   * Must not execute project commands or external effects. Test/synthetic registries need no snapshot. */
  constructor(readonly synchronize: (db: Database, ticketId: number) => void = () => {}) {}

  private readonly handlers = new Map<string, StepHandler>();
  private readonly commits = new Map<string, StepCommit>();

  register(handlerKey: string, handler: StepHandler, opts?: { commit?: StepCommit }): void {
    if (this.handlers.has(handlerKey)) {
      throw new Error(`StepRegistry: handlerKey '${handlerKey}' already registered`);
    }
    this.handlers.set(handlerKey, handler);
    if (opts?.commit) this.commits.set(handlerKey, opts.commit);
  }

  resolve(handlerKey: string): StepHandler | undefined {
    return this.handlers.get(handlerKey);
  }

  resolveCommit(handlerKey: string): StepCommit | undefined {
    return this.commits.get(handlerKey);
  }

  has(handlerKey: string): boolean {
    return this.handlers.has(handlerKey);
  }
}
