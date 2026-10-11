import { InvariantViolation } from "../engine/step-journal.ts";

/** The step key in flight, set by advance.ts around runStep and cleared after (spec §3, E8), so the
 *  named accessors (design-reads.ts) can check a read against the step's declared inputs. One slot
 *  per process is enough today: `styre run` drives one ticket, a ticket runs one step at a time, and
 *  `tick` awaits each ticket's step before it starts the next. A second step set while one is in
 *  flight would misattribute reads, so it is refused (a concurrent caller must give each step a slot
 *  of its own first). */
let current: string | null = null;

export function setCurrentStep(stepKey: string | null): void {
  if (stepKey !== null && current !== null)
    throw new InvariantViolation(`${stepKey} cannot start while ${current} is in flight`);
  current = stepKey;
}

export function currentStepKey(): string | null {
  return current;
}
