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
 *  - behavioral non-empty               → DEFER (clean) UNDER the cap: the resolver serves
 *                                         checks:arbitrate. AT the cap → counter-escalate here too.
 *
 *  LIVENESS (an Opus review flagged this): a pure-code-wrong stuck-HEAD round — the re-implement
 *  commits NOTHING new — leaves `sha`/`behavioralStillRed` identical round over round. The resolver's
 *  blame-at-HEAD fallback then serves checks:reauthor once (a no-op: applyReauthorVerdict's
 *  route===null guard returns 'clean' before its own escalate check, since the arbiter never routed a
 *  code-wrong AC there), after which `blamed && !done(reauthor)` is permanently false — so
 *  checks:arbitrate is never re-served (blame already exists at that unchanged sha) and checks:reauthor
 *  is never re-served (already 'succeeded'). Only verify:checks-gate itself keeps getting re-served
 *  every cycle thereafter, its `attempt` incrementing each time — but this defer branch used to return
 *  'clean' UNCONDITIONALLY, so nothing ever read that attempt. The gate step is the one thing that DOES
 *  keep advancing in this stuck path, so checking the cap right here (using the SAME `attempt` the
 *  integrity-only branch already gates on) closes the gap: a genuinely stuck ticket now escalates
 *  cleanly instead of spinning to the global 200-tick cap (a dirty no-progress, not a clean escalate).
 *  A healthy multi-round arbitration is unaffected: this fires at the SAME round (attempt === CAP) that
 *  applyArbiterVerdict/applyReauthorVerdict would otherwise have caught it one dispatch later — it only
 *  short-circuits an otherwise-wasted arbiter/reauthor re-dispatch once the cap is already known to be
 *  hit, never before. */
export function applyAcCheckGateVerdict(
  db: Database,
  ticketId: number,
  _opts: { stepKey: string },
): GateVerdictResult {
  const { stillRed, sha } = latestGate(db, ticketId);
  if (stillRed.length === 0) return { decision: "clean" };
  const behavioral = sha === null ? [] : behavioralStillRed(db, ticketId, sha);
  if (behavioral.length > 0) {
    if (gateRoundExceeded(db, ticketId, GATE_ROUND_CAP)) {
      escalate(
        db,
        ticketId,
        `gate: check(s) ${behavioral.join(",")} still red after ${GATE_ROUND_CAP} arbitrated rounds`,
      );
      return { decision: "escalated" };
    }
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
