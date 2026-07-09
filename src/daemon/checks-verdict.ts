import type { Database } from "bun:sqlite";
import {
  listUnresolvedByTicket,
  reauthorRoundsForAc,
  supersedeByAc,
} from "../db/repos/ac-check.ts";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { classificationForAcCheck } from "../db/repos/ground-truth-signal.ts";
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

/** Escalate when an AC has been re-authored this many ROUNDS (`reauthorRoundsForAc`, i.e. distinct
 *  `supersedeByAc` calls — NOT superseded rows, since one round can supersede several rows for a
 *  multi-check AC) and is STILL flagged (§5). The verdict supersedes BEFORE counting, so 2 ⇒ escalate
 *  on the 2nd consecutive round — the exact bound M3's predecessor-compare had. Monotone + per-AC: it
 *  replaces the log-signature machinery, which depended on live-id reuse (the anti-pattern the
 *  supersede schema deleted). */
const REAUTHOR_ESCALATE_CAP = 2;

/** The ACs flagged for re-author THIS round = the active checks `checks:classify` left unresolved
 *  (a vacuous/weak verdict sets neither red_class nor disposition). Read from the TABLE (active state
 *  via the active-scoped listUnresolvedByTicket), NEVER from the append-only signal log by id — the
 *  schema, not the log, is the control-state source (§3/§7, the M4 anti-pattern fix). */
function reauthorFindings(db: Database, ticketId: number): number[] {
  return [...new Set(listUnresolvedByTicket(db, ticketId).map((r) => r.ac_id))].sort(
    (a, b) => a - b,
  );
}

/** DISPLAY-only companion to `reauthorFindings` (Task 3e): the re-author REASON for each flagged AC,
 *  sourced from the `ac-check-classification` ground_truth_signal keyed by the check's LIVE row id
 *  (`classificationForAcCheck` — never "the latest signal for the AC", since the log is append-only and
 *  ids are never reused). This is audit/prompt-text sourcing, NOT control flow — which ACs are flagged
 *  and the escalate counter both come from `reauthorFindings`/`ac_check` columns, unchanged. An AC that
 *  owns >1 active unresolved check keeps its last row's reason (mirrors the pre-M4 by-AC dedup). Feeds
 *  `checksFeedback`'s "prior check was vacuous — <reason>" text at the re-author `checks:dispatch`. */
function reauthorFindingsWithReasons(db: Database, ticketId: number): VacuousFinding[] {
  const byAc = new Map<number, string>();
  for (const row of listUnresolvedByTicket(db, ticketId)) {
    byAc.set(row.ac_id, classificationForAcCheck(db, row.id)?.detail.reason ?? "");
  }
  return [...byAc.entries()]
    .map(([acId, reason]) => ({ acId, reason }))
    .sort((a, b) => a.acId - b.acId);
}

/** The flagged AC ids of the latest checks re-author event (or null). `checks:dispatch` reads this to
 *  scope its re-author to only those ACs (§2b). (Routing state on the event — not the anti-pattern.) */
export function latestChecksReauthorAcs(db: Database, ticketId: number): number[] | null {
  const events = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "checks",
  );
  const latest = events[events.length - 1];
  if (!latest?.payload_json) return null;
  const acIds = (JSON.parse(latest.payload_json) as { acIds?: number[] }).acIds;
  return acIds && acIds.length > 0 ? acIds : null;
}

/** M3/M4 verdict (§2/§5/§7): a `vacuous`/`weak` active check (left unresolved by classify) drives an
 *  AC-scoped re-author loopback — the verdict SUPERSEDES the flagged active generation (exactly-once;
 *  history preserved) and re-arms checks:dispatch/checks:classify. An AC superseded ≥ cap times and
 *  still flagged escalates (a per-AC monotone counter, reason-agnostic). Ground-truth over
 *  self-report — reads persisted TABLE state, never an agent verdict. Mirrors `applyReviewVerdict`. */
export function applyChecksVerdict(
  db: Database,
  ticketId: number,
  _opts: { stepKey: string },
): ChecksVerdictResult {
  const flagged = reauthorFindings(db, ticketId);
  if (flagged.length === 0) return { decision: "clean" };
  // Read BEFORE the transaction supersedes the flagged rows — findingsWithReasons keys off the
  // still-active unresolved rows' live ids (display-only; see its docstring).
  const findings = reauthorFindingsWithReasons(db, ticketId);
  let escalated = false;
  db.transaction(() => {
    // Re-author = supersede the flagged active generation (never delete). Count ROUNDS AFTER
    // superseding — reauthorRoundsForAc counts DISTINCT superseded_at values, not rows, so a
    // multi-check AC's whole round (all its rows, one shared timestamp) counts as ONE.
    for (const acId of flagged) supersedeByAc(db, acId);
    const exhausted = flagged.filter(
      (acId) => reauthorRoundsForAc(db, acId) >= REAUTHOR_ESCALATE_CAP,
    );
    if (exhausted.length > 0) {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, {
        ticketId,
        signalType: "human_resume",
        reason: `no progress: AC-check(s) ${exhausted.join(",")} still flagged after ${REAUTHOR_ESCALATE_CAP} re-authors`,
      });
      appendEvent(db, {
        ticketId,
        kind: "escalated",
        reason: "no progress: repeated re-author of the same AC-check",
        signature: `checks:${exhausted.join(",")}`,
      });
      escalated = true;
      return;
    }
    for (const key of ["checks:dispatch", "checks:classify"]) {
      const step = getByKey(db, ticketId, key);
      if (step) resetToPending(db, step.id);
    }
    // No stage flip — checks:dispatch + checks:classify are both in the design stage.
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "checks",
      routeTo: "checks:classify",
      signature: `checks:${flagged.join(",")}`, // audit label only (no longer read for repeat-detect)
      payload: { acIds: flagged, findings },
    });
  })();
  return escalated ? { decision: "escalated" } : { decision: "loopback" };
}
