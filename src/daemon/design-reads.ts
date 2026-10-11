import type { Database } from "bun:sqlite";
import { type WorkUnitRow, listByTicket } from "../db/repos/work-unit.ts";
import { InvariantViolation } from "../engine/step-journal.ts";
import { currentStepKey } from "./current-step.ts";
import { type OutputName, declaresInput } from "./design-graph.ts";

/** A design handler read an upstream output its row does not declare (spec §3, E8). An invariant
 *  violation: the failure policy escalates it at once. */
export class UndeclaredReadError extends InvariantViolation {
  constructor(message: string) {
    super(message);
    this.name = "UndeclaredReadError";
  }
}

/** The step in flight, when it declares `output`. */
function assertDeclared(output: OutputName): string {
  const step = currentStepKey();
  if (step === null) throw new UndeclaredReadError(`no step in flight reads ${output}`);
  if (!declaresInput(step, output))
    throw new UndeclaredReadError(
      `${step} reads ${output}, which the design table does not declare for it`,
    );
  return step;
}

/** design:extract's units, in seq order, for the design steps that declare them (design:size,
 *  design:review). The workUnits digest (digestWorkUnits) covers only units of origin `extract`, so
 *  a unit of any other origin (a reconcile unit, written in verify) is refused: the step would read
 *  what its manifest never records. Steps outside the table keep reading the repository directly. */
export function readWorkUnitsForDesign(db: Database, ticketId: number): WorkUnitRow[] {
  const step = assertDeclared("workUnits");
  const units = listByTicket(db, ticketId);
  const foreign = units.find((u) => u.origin !== "extract");
  if (foreign)
    throw new InvariantViolation(
      `${step} reads workUnits, but unit ${foreign.seq} has origin ${foreign.origin}; the units digest covers only design:extract's units`,
    );
  return units;
}
