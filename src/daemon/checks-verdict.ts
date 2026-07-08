import type { Database } from "bun:sqlite";
import { deleteByAc, listByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { listByTicket as listSignals } from "../db/repos/ground-truth-signal.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { getByKey, resetToPending } from "../db/repos/workflow-step.ts";

export interface ChecksVerdictResult {
  decision: "clean" | "loopback" | "escalated";
}

interface VacuousFinding {
  acId: number;
  reason: string;
}

/** The vacuous findings of the CURRENT round: classification signals of class `vacuous` whose
 *  acCheckId is a LIVE ac_check row (§3/§7 by-live-id — a re-author deletes the prior round's rows,
 *  so its stale vacuous signals point to dead ids and drop out). Distinct by AC. */
function currentVacuousFindings(db: Database, ticketId: number): VacuousFinding[] {
  const liveIds = new Set(listAcChecks(db, ticketId).map((r) => r.id));
  const byAc = new Map<number, string>();
  for (const s of listSignals(db, ticketId)) {
    if (s.signal_type !== "ac-check-classification") continue;
    const d = JSON.parse(s.detail_json ?? "{}") as {
      acCheckId?: number;
      acId?: number;
      class?: string;
      reason?: string;
    };
    if (d.class !== "vacuous" || d.acCheckId === undefined || !liveIds.has(d.acCheckId)) continue;
    if (d.acId !== undefined) byAc.set(d.acId, d.reason ?? "");
  }
  return [...byAc.entries()].map(([acId, reason]) => ({ acId, reason }));
}

/** Signature keyed on (ac_ids, "vacuous") (§7): scoping makes a stuck AC produce a repeated,
 *  AC-keyed finding across re-authors even though the check text differs. */
function vacuousSignature(findings: VacuousFinding[]): string {
  return `checks:${findings
    .map((f) => f.acId)
    .sort((a, b) => a - b)
    .join(",")}`;
}

/** True when the previous checks-origin loopback carried the same signature (no progress). */
function isRepeatedChecksLoopback(db: Database, ticketId: number, signature: string): boolean {
  const prior = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "checks",
  );
  return prior[prior.length - 1]?.signature === signature;
}

/** The flagged AC ids of the latest checks re-author event (or null). `checks:dispatch` reads this to
 *  scope its re-author to only those ACs (§2b). */
export function latestChecksReauthorAcs(db: Database, ticketId: number): number[] | null {
  const events = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "checks",
  );
  const latest = events[events.length - 1];
  if (!latest?.payload_json) return null;
  const acIds = (JSON.parse(latest.payload_json) as { acIds?: number[] }).acIds;
  return acIds && acIds.length > 0 ? acIds : null;
}

function escalate(db: Database, ticketId: number, reason: string, signature: string): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, kind: "escalated", reason, signature });
  })();
}

function checksLoopback(
  db: Database,
  ticketId: number,
  findings: VacuousFinding[],
  signature: string,
): void {
  db.transaction(() => {
    for (const f of findings) deleteByAc(db, f.acId); // scoped: only the flagged ACs' checks
    for (const key of ["checks:dispatch", "checks:classify"]) {
      const step = getByKey(db, ticketId, key);
      if (step) {
        resetToPending(db, step.id);
      }
    }
    // No stage flip — checks:dispatch + checks:classify are both in the design stage.
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "checks",
      routeTo: "checks:classify",
      signature,
      payload: { acIds: findings.map((f) => f.acId), findings },
    });
  })();
}

/** M3 verdict (§2/§7): a `vacuous` green-on-HEAD check triggers an AC-scoped re-author loopback;
 *  a repeated (ac_ids,"vacuous") signature escalates. Ground-truth over self-report — reads the
 *  persisted classification signals, never an agent verdict. Mirrors `applyReviewVerdict`. */
export function applyChecksVerdict(
  db: Database,
  ticketId: number,
  _opts: { stepKey: string },
): ChecksVerdictResult {
  const findings = currentVacuousFindings(db, ticketId);
  if (findings.length === 0) return { decision: "clean" };
  const signature = vacuousSignature(findings);
  if (isRepeatedChecksLoopback(db, ticketId, signature)) {
    escalate(db, ticketId, "no progress: identical vacuous-check AC(s) after re-author", signature);
    return { decision: "escalated" };
  }
  checksLoopback(db, ticketId, findings, signature);
  return { decision: "loopback" };
}
