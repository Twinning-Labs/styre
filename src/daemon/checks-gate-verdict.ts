import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import {
  behavioralStillRed,
  listByTicket as listSignals,
} from "../db/repos/ground-truth-signal.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { listByTicket as listUnits, setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { getByKey, listStepsForUnit, resetToPending } from "../db/repos/workflow-step.ts";
import { GATE_ROUND_CAP, gateRoundExceeded } from "./arbiter-verdict.ts";

export interface GateVerdictResult {
  decision: "clean" | "loopback" | "escalated";
}

/** The latest ac-check-gate signal's full stillRed set + its HEAD sha (empty when the gate passed). */
function latestGate(db: Database, ticketId: number): { stillRed: number[]; sha: string | null } {
  const sig = listSignals(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-gate")
    .at(-1);
  if (!sig) return { stillRed: [], sha: null };
  const stillRed = (JSON.parse(sig.detail_json ?? "{}") as { stillRed?: number[] }).stillRed ?? [];
  return { stillRed: stillRed.slice().sort((a, b) => a - b), sha: sig.branch_head_sha };
}

function escalate(db: Database, ticketId: number, reason: string): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, {
      ticketId,
      kind: "escalated",
      reason,
      signature: `gate-cap:${GATE_ROUND_CAP}`,
    });
  })();
}

/** Reset all units + the gate step to pending (an implement loopback). PRESERVES the gate attempt
 *  (this IS a gate-origin loop). Also resets the arbiter step so it re-runs next round. */
export function gateOriginLoopback(
  db: Database,
  ticketId: number,
  routeTo: string,
  payload: Record<string, unknown>,
): void {
  db.transaction(() => {
    for (const u of listUnits(db, ticketId)) {
      setUnitStatus(db, u.id, "pending");
      for (const s of listStepsForUnit(db, ticketId, u.id)) resetToPending(db, s.id);
    }
    for (const key of ["verify:checks-gate", "checks:arbitrate", "checks:reauthor"]) {
      const s = getByKey(db, ticketId, key);
      if (s) resetToPending(db, s.id); // resetToPending never touches attempt → counter survives
    }
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "implement",
      routeTo,
      signature: `gate:${routeTo}`,
      payload,
    });
  })();
}

/** M5 gate verdict (onSucceed of verify:checks-gate). Splits integrity from behavioral:
 *  - stillRed empty                     → clean (gate passed).
 *  - integrity-only (behavioral empty)  → counter-escalate at the cap, else loopback (M4 shape, R5:
 *                                         tampering is NEVER arbitrated).
 *  - behavioral non-empty               → DEFER (clean): the resolver serves checks:arbitrate. */
export function applyAcCheckGateVerdict(
  db: Database,
  ticketId: number,
  _opts: { stepKey: string },
): GateVerdictResult {
  const { stillRed, sha } = latestGate(db, ticketId);
  if (stillRed.length === 0) return { decision: "clean" };
  const behavioral = sha === null ? [] : behavioralStillRed(db, ticketId, sha);
  if (behavioral.length > 0) {
    return { decision: "clean" }; // defer to the arbiter (resolver arm)
  }
  // integrity-only
  if (gateRoundExceeded(db, ticketId, GATE_ROUND_CAP)) {
    escalate(
      db,
      ticketId,
      `gate: check(s) ${stillRed.join(",")} tampered after ${GATE_ROUND_CAP} rounds`,
    );
    return { decision: "escalated" };
  }
  gateOriginLoopback(db, ticketId, "verify:checks-gate", { tampered: stillRed });
  return { decision: "loopback" };
}
