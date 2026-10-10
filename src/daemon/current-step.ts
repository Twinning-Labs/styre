/** The step key in flight, set by advance.ts around runStep and cleared after (spec §3, E8). Steps
 *  run one at a time per ticket, and `styre run` drives one ticket, so one slot suffices. */
let current: string | null = null;

export function setCurrentStep(stepKey: string | null): void {
  current = stepKey;
}

export function currentStepKey(): string | null {
  return current;
}
