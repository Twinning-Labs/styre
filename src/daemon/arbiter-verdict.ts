import type { Database } from "bun:sqlite";
import { getByKey } from "../db/repos/workflow-step.ts";

/** §6: the monotone per-ticket gate-round bound = the verify:checks-gate step attempt. Escalate at
 *  the cap. See the plan's "Flagged for the lead #3" for the value. */
export const GATE_ROUND_CAP = 3;

export function gateRoundExceeded(db: Database, ticketId: number, cap: number): boolean {
  const gate = getByKey(db, ticketId, "verify:checks-gate");
  return (gate?.attempt ?? 0) >= cap;
}
