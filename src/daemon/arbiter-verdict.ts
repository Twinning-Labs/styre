import type { Database } from "bun:sqlite";
import { getLatestForTicket } from "../db/repos/dispatch.ts"; // the current branch HEAD sha source used by the resolver
import { appendEvent } from "../db/repos/event-log.ts";
import { latestBlameAtSha } from "../db/repos/ground-truth-signal.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { getByKey } from "../db/repos/workflow-step.ts";
import { type GateVerdictResult, gateOriginLoopback } from "./checks-gate-verdict.ts";

/** §6: the monotone per-ticket gate-round bound = the verify:checks-gate step attempt. Escalate at
 *  the cap. See the plan's "Flagged for the lead #3" for the value. */
export const GATE_ROUND_CAP = 3;

export function gateRoundExceeded(db: Database, ticketId: number, cap: number): boolean {
  const gate = getByKey(db, ticketId, "verify:checks-gate");
  return (gate?.attempt ?? 0) >= cap;
}

/** onSucceed of checks:arbitrate. Routes on the blame recorded at the current gate round + the
 *  gate-round counter. Task 5 (arbitration-only): both routes loopback implement. Task 6 rewires the
 *  check-wrong route to loop back to the SEPARATE checks:reauthor step (which installs the re-authors,
 *  then its own verdict re-serves the gate or loops implement). */
export function applyArbiterVerdict(
  db: Database,
  ticketId: number,
  _opts: { stepKey: string },
): GateVerdictResult {
  const sha = getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
  const blames = sha === null ? [] : latestBlameAtSha(db, ticketId, sha);
  if (blames.length === 0) return { decision: "clean" }; // nothing to route (no-op guard)

  if (gateRoundExceeded(db, ticketId, GATE_ROUND_CAP)) {
    db.transaction(() => {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, {
        ticketId,
        signalType: "human_resume",
        reason: `gate: still red after ${GATE_ROUND_CAP} arbitrated rounds (${blames.map((b) => `${b.acCheckId}:${b.blame}`).join(", ")})`,
      });
      appendEvent(db, {
        ticketId,
        kind: "escalated",
        reason: "gate-round cap",
        signature: `gate-cap:${GATE_ROUND_CAP}`,
      });
    })();
    return { decision: "escalated" };
  }

  // Task 5: every blame loops implement (both code-wrong and, provisionally, check-wrong).
  gateOriginLoopback(db, ticketId, "checks:arbitrate", {
    blame: blames.map((b) => ({ acCheckId: b.acCheckId, blame: b.blame })),
  });
  return { decision: "loopback" };
}
