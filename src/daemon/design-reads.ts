import type { Database } from "bun:sqlite";
import { type WorkUnitRow, listByTicket } from "../db/repos/work-unit.ts";
import { currentStepKey } from "./current-step.ts";
import { type OutputName, declaresInput } from "./design-graph.ts";

/** A design handler read an upstream output its row does not declare (spec §3, E8). */
export class UndeclaredReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndeclaredReadError";
  }
}

function assertDeclared(output: OutputName): void {
  const step = currentStepKey();
  if (step === null) throw new UndeclaredReadError(`no step in flight reads ${output}`);
  if (!declaresInput(step, output))
    throw new UndeclaredReadError(
      `${step} reads ${output}, which the design table does not declare for it`,
    );
}

/** design:extract's units, for the design steps that declare them (design:size, design:review).
 *  Steps outside the table keep reading the repository directly. */
export function readWorkUnitsForDesign(db: Database, ticketId: number): WorkUnitRow[] {
  assertDeclared("workUnits");
  return listByTicket(db, ticketId);
}
