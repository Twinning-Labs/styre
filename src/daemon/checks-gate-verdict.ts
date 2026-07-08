import type { Database } from "bun:sqlite";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { listByTicket as listSignals } from "../db/repos/ground-truth-signal.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { listByTicket as listUnits, setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { getByKey, listStepsForUnit, resetToPending } from "../db/repos/workflow-step.ts";

export interface GateVerdictResult {
  decision: "clean" | "loopback" | "escalated";
}

/** The still-red AC-id set of the latest `ac-check-gate` signal (empty when the gate passed). */
function latestStillRed(db: Database, ticketId: number): number[] {
  const sigs = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-gate");
  const latest = sigs[sigs.length - 1];
  if (!latest) return [];
  return ((JSON.parse(latest.detail_json ?? "{}") as { stillRed?: number[] }).stillRed ?? [])
    .slice()
    .sort((a, b) => a - b);
}

function gateSignature(stillRed: number[]): string {
  return `gate:${stillRed.join(",")}`;
}

/** Predecessor-only compare (§5): the prior gate-origin implement loopback carried this signature. */
function isRepeatedGateLoopback(db: Database, ticketId: number, signature: string): boolean {
  const prior = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement" && e.route_to === "verify:checks-gate",
  );
  return prior[prior.length - 1]?.signature === signature;
}

/** M4 gate verdict: a still-red gated AC-check drives a bounded loopback-to-implement (reset all units
 *  + re-arm the gate); a repeated still-red AC-id set escalates. Ground-truth over self-report —
 *  reads the persisted `ac-check-gate` signal, never an agent verdict. Mirrors applyChecksVerdict. */
export function applyAcCheckGateVerdict(
  db: Database,
  ticketId: number,
  _opts: { stepKey: string },
): GateVerdictResult {
  const stillRed = latestStillRed(db, ticketId);
  if (stillRed.length === 0) return { decision: "clean" };
  const signature = gateSignature(stillRed);
  if (isRepeatedGateLoopback(db, ticketId, signature)) {
    db.transaction(() => {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, {
        ticketId,
        signalType: "human_resume",
        reason: `gate: AC-check(s) ${stillRed.join(",")} still red after re-implement`,
      });
      appendEvent(db, {
        ticketId,
        kind: "escalated",
        reason: "no progress: identical still-red AC-check gate",
        signature,
      });
    })();
    return { decision: "escalated" };
  }
  db.transaction(() => {
    for (const u of listUnits(db, ticketId)) {
      setUnitStatus(db, u.id, "pending");
      for (const s of listStepsForUnit(db, ticketId, u.id)) resetToPending(db, s.id);
    }
    const gate = getByKey(db, ticketId, "verify:checks-gate");
    if (gate) resetToPending(db, gate.id);
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "implement",
      routeTo: "verify:checks-gate",
      signature,
      payload: { acIds: stillRed },
    });
  })();
  return { decision: "loopback" };
}
