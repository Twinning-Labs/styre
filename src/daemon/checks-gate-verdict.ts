import type { Database } from "bun:sqlite";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
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

/**
 * What this run actually PROVED at `sha` (ENG-424, hole 1).
 *
 * `provenAcIds` are acceptance criteria whose check ran and came back green at the HEAD being
 * gated. A `disposition` (satisfied / not-expressible) is deliberately NOT evidence: those
 * checks never execute — `rerunAcChecks` skips them before it emits a signal — so nothing was
 * measured. `suitePassed` is the other, coarser source: a component's `test` sweep going green.
 *
 * SCOPED TO `sha`, always. A pass recorded against an earlier commit is a fact about that
 * commit, not about the code being gated now; counting it would be the same category of error
 * as reporting an unmeasured value as a measured one. `sha === null` therefore yields no
 * evidence at all rather than falling back to "the most recent pass anywhere".
 */
export interface VerifyEvidence {
  provenAcIds: number[];
  suitePassed: boolean;
}

export function verifyEvidenceAt(
  db: Database,
  ticketId: number,
  sha: string | null,
): VerifyEvidence {
  if (sha === null) return { provenAcIds: [], suitePassed: false };
  const proven = new Set<number>();
  let suitePassed = false;
  for (const s of listSignals(db, ticketId)) {
    if (s.branch_head_sha !== sha) continue;
    if (s.signal_type === "ac-check-post-implement") {
      const d = JSON.parse(s.detail_json ?? "{}") as { acId?: number; coarse?: string };
      if (d.coarse === "green" && typeof d.acId === "number") proven.add(d.acId);
    } else if (s.signal_type === "test" && s.result === "pass") {
      suitePassed = true;
    }
  }
  return { provenAcIds: [...proven].sort((a, b) => a - b), suitePassed };
}

/** Mutating escalate (ticket → waiting + human_resume signal + an 'escalated' event). Exported so
 *  advance.ts's interpreter can call it for the resolver's `{ kind: "escalate" }` descriptor (Task
 *  12 LIVENESS fix, see resolver.ts's `case "implement"` — the resolver stays pure/descriptor-only;
 *  this is the ONE place that performs the actual mutation for both the cap-based escalates below
 *  AND the stuck-replay escalate). `signature` defaults to the gate-round-cap shape for the two
 *  existing (cap-reached) call sites; the stuck-replay call site passes a distinct signature since
 *  it fires BELOW the cap, for a different reason (see resolver.ts's docstring). */
export function escalate(
  db: Database,
  ticketId: number,
  reason: string,
  signature = `gate-cap:${GATE_ROUND_CAP}`,
  dispatchId?: string | null,
): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, {
      ticketId,
      dispatchId: dispatchId ?? undefined,
      kind: "escalated",
      reason,
      signature,
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
  dispatchId?: string | null,
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
      dispatchId: dispatchId ?? undefined,
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
  // The gate is an in-process handler (src/dispatch/handlers.ts) — it never calls
  // runAgentDispatch, so it has no dispatch row of its own. Its events instead carry the CODE
  // dispatch (the latest dispatch whose HEAD the gate judged), matching what the gate handler
  // itself already looks up to find the sha it checks.
  const latest = getLatestForTicket(db, ticketId);
  const dispatchId = latest?.dispatch_id ?? undefined;
  const { stillRed, sha } = latestGate(db, ticketId);
  if (stillRed.length === 0) {
    // THE EVIDENCE FLOOR (ENG-424). An empty still-red set is not the same claim as "verified".
    // Three routes reach it having measured nothing at all: every check classified
    // `environmental` (permanently advisory), every check carrying a `disposition` (never
    // executed), and a ticket with NO checks (the gate handler returns early and writes no
    // signal, so `latestGate` finds none and `sha` is null).
    //
    // django__django-12325 took the first: one AC, one check, `No module named pytest`,
    // classified environmental, gate `{stillRed: [], advisory: [1]}` — and the run reached
    // `pr-ready` with 0 escalations, 0 loopbacks and a real pull request behind zero ground
    // truth. Every rule was individually correct; the run-level invariant was missing.
    //
    // ESCALATE rather than continue-with-a-caveat. Loop-not-halt's "bounded retry against
    // ground truth" presupposes a ground-truth channel; here the channel itself is broken, so
    // there is nothing to retry against. And `pr-ready` is styre's terminal SUCCESS claim —
    // a caveat in the PR body (which verify-report.ts already renders) does not make that
    // claim true.
    //
    // A green suite alone satisfies the floor: a docs-only or `not-expressible` ticket has
    // nothing to express as a check and must not be forced to escalate for it.
    const gateSha = sha ?? latest?.branch_head_sha ?? null;
    const evidence = verifyEvidenceAt(db, ticketId, gateSha);
    if (evidence.provenAcIds.length === 0 && !evidence.suitePassed) {
      escalate(
        db,
        ticketId,
        `gate: no acceptance criterion was proven and no test suite passed at ${gateSha ?? "an unknown HEAD"} — this run verified nothing`,
        "evidence-floor",
        dispatchId,
      );
      return { decision: "escalated" };
    }
    return { decision: "clean" };
  }
  const behavioral = sha === null ? [] : behavioralStillRed(db, ticketId, sha);
  if (behavioral.length > 0) {
    if (gateRoundExceeded(db, ticketId, GATE_ROUND_CAP)) {
      escalate(
        db,
        ticketId,
        `gate: check(s) ${behavioral.join(",")} still red after ${GATE_ROUND_CAP} arbitrated rounds`,
        undefined,
        dispatchId,
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
      undefined,
      dispatchId,
    );
    return { decision: "escalated" };
  }
  gateOriginLoopback(db, ticketId, "verify:checks-gate", { tampered: stillRed }, dispatchId);
  return { decision: "loopback" };
}
