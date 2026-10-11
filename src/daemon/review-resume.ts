import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { getByDispatchId } from "../db/repos/dispatch.ts";
import {
  type EventLogRow,
  appendEvent,
  listByTicket as listEvents,
} from "../db/repos/event-log.ts";
import { latestDispatchForStep, listByDispatch, setStatus } from "../db/repos/review-finding.ts";
import {
  REVIEW_REPAIR_LIMIT,
  assertExactFindingIds,
  beginReviewContract,
  reopenStaleDeferrals,
  requiredCodeFindings,
  requiredPlanFindings,
  reviewRepairCount,
  unresolvedReviewReason,
} from "../db/repos/review-round.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { getByKey } from "../db/repos/workflow-step.ts";
import { DESIGN_TABLE, type GateRow } from "./design-graph.ts";
import { applyReviewVerdict, codeLoopback, redesignLoopback } from "./review-verdict.ts";

export interface ReviewResumeOptions {
  action?: string;
  findings?: string;
  reason?: string;
}
export type ReviewResumePlan =
  | { kind: "none" }
  | { kind: "retry-plan"; head: string; moved: boolean }
  | { kind: "retry"; head: string; moved: boolean }
  | { kind: "accept-risk"; head: string; dispatchId: string; ids: number[]; reason: string };

/** The plan review gate row's escalation signature (`review:unresolved-plan`). */
function planGateSignature(): string {
  const gate = DESIGN_TABLE.find(
    (r): r is GateRow => r.kind === "gate" && r.name === "plan-review",
  );
  if (!gate) throw new Error("the declared design table has no plan-review gate");
  return gate.signature;
}

/** An escalation from plan review: the gate row's (its signature), or the plan review verdict's
 *  ("no progress: identical plan-review findings", or its repair limit), which carries the blocking
 *  findings' `review:` signature and the latest design:review dispatch. Never by dispatch id alone:
 *  the interpreter's other escalations (the invalidate loop guard, the step replay guard) carry the
 *  ticket's latest dispatch, which can be that design:review dispatch. */
function isPlanReviewEscalation(
  e: EventLogRow,
  gateSignature: string,
  reviewDispatch: string | null,
): boolean {
  if (e.kind !== "escalated" || e.signature === null) return false;
  if (e.signature === gateSignature) return true;
  return (
    e.signature.startsWith("review:") && reviewDispatch !== null && e.dispatch_id === reviewDispatch
  );
}

/** An `invalidated` note that names a design step past provision. Provision's own invalidations
 *  (a worktree mode resume recreating the worktree, cause `worktree-recreated`; an implement diff
 *  touching a dependency manifest, cause `manifest-touched`; a changed toolchain list, cause
 *  `inputs`) say nothing about the plan or its review, so they never move a run off the gate. */
function invalidatesDesignStep(e: EventLogRow): boolean {
  if (e.kind !== "note" || e.reason !== "invalidated" || e.payload_json === null) return false;
  const p = JSON.parse(e.payload_json) as { stepKeys?: string[] };
  return (p.stepKeys ?? []).some((k) => k.startsWith("design:"));
}

/** True when the run stopped at the plan review gate (operator ruling, 2026-10-09; spec §6.4): an
 *  escalation since the last `resumed` event is plan review's, and no design loopback or
 *  `invalidated` note for a design step came after it. Any such escalation, not only the latest: a
 *  later escalation of another kind in the same run (the projector giving up on a row, the resume's
 *  toolchain pause) does not move the run off the gate, and is ignored. event_log has no step key
 *  column; these are what the gate and the verdict write, and v8 wrote them the same way. A run
 *  paused anywhere else in design, a budget pause in a redesign's regenerated design:dispatch say,
 *  is not at the gate, although design:review is still succeeded with blocking findings from before
 *  the redesign. */
export function stoppedAtPlanReviewGate(db: Database, ticketId: number): boolean {
  const events = listEvents(db, ticketId);
  const since = events.slice(events.findLastIndex((e) => e.kind === "resumed") + 1);
  const gate = planGateSignature();
  const review = latestDispatchForStep(db, ticketId, "design:review");
  const at = since.findLastIndex((e) => isPlanReviewEscalation(e, gate, review));
  if (at === -1) return false;
  const movedOn = since
    .slice(at + 1)
    .some((e) => (e.kind === "loopback" && e.loop === "design") || invalidatesDesignStep(e));
  return !movedOn;
}

/** Pure validation before any worktree mutation or signal consumption. */
export function planReviewResume(
  db: Database,
  ticketId: number,
  head: string | null,
  moved: boolean,
  options: ReviewResumeOptions,
): ReviewResumePlan {
  if (options.action && !["retry", "accept-risk"].includes(options.action))
    throw new Error("--review-action must be retry or accept-risk");
  if (
    options.action !== "accept-risk" &&
    (options.findings !== undefined || options.reason !== undefined)
  )
    throw new Error("--review-findings and --review-reason require --review-action accept-risk");
  const ticket = getTicket(db, ticketId);
  const step = getByKey(db, ticketId, "review");
  const open = requiredCodeFindings(db, ticketId);
  if (options.action === "accept-risk") {
    if (!head || moved)
      throw new Error(
        "risk acceptance requires the unchanged reviewed HEAD; --accept-head cannot override this",
      );
    if (ticket?.stage !== "review" || step?.status !== "succeeded")
      throw new Error("risk acceptance requires a completed current code review paused in review");
    const did = latestDispatchForStep(db, ticketId, "review");
    const dispatch = did ? getByDispatchId(db, ticketId, did) : null;
    if (!did || dispatch?.branch_head_sha !== head)
      throw new Error("risk acceptance has no completed review at this HEAD");
    const result = JSON.parse(step.result_json ?? "null") as {
      findings?: number;
      reviewCompletion?: {
        dispatchId?: string;
        output?: { resolutions?: { finding_id: number }[] };
      };
    } | null;
    if (!result || (result.reviewCompletion && result.reviewCompletion.dispatchId !== did))
      throw new Error("risk acceptance review provenance is incomplete");
    if (!result.reviewCompletion && result.findings !== listByDispatch(db, ticketId, did).length)
      throw new Error("legacy review result does not match its findings ledger");
    const reviewed = new Set([
      ...listByDispatch(db, ticketId, did).map((f) => f.id),
      ...(result.reviewCompletion?.output?.resolutions ?? []).map((r) => r.finding_id),
    ]);
    if (!options.findings || !/^\d+(,\d+)*$/.test(options.findings))
      throw new Error("--review-findings must list explicit comma-separated finding IDs");
    const ids = options.findings.split(",").map(Number);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw new Error("invalid review finding ID");
    assertExactFindingIds(
      ids,
      open.map((f) => f.id),
    ); // partial acceptance is intentionally rejected
    if (
      !open.length ||
      open.some((f) => !reviewed.has(f.id) || f.severity !== "major" || f.deferral_candidate !== 1)
    )
      throw new Error(
        "only currently reviewed, nominated major findings may be accepted; critical findings cannot be deferred",
      );
    const reason = options.reason?.trim();
    if (!reason) throw new Error("--review-reason must explain the accepted risk");
    return { kind: "accept-risk", head, dispatchId: did, ids, reason };
  }
  if (
    ticket?.stage === "design" &&
    getByKey(db, ticketId, "design:review")?.status === "succeeded" &&
    requiredPlanFindings(db, ticketId).length &&
    stoppedAtPlanReviewGate(db, ticketId)
  ) {
    if (!head) throw new Error("plan-review resume requires a resolvable branch HEAD");
    if (reviewRepairCount(db, ticketId) >= REVIEW_REPAIR_LIMIT)
      throw new Error("review repair limit reached; inspect the plan or start --fresh");
    return { kind: "retry-plan", head, moved };
  }
  const relevant = ticket?.stage === "review" || ticket?.stage === "merge";
  if (relevant && step?.status === "succeeded" && !head)
    throw new Error("review resume requires a resolvable branch HEAD");
  if (!relevant || (!unresolvedReviewReason(db, ticketId) && !moved)) {
    if (options.action) throw new Error("no completed unresolved review to retry");
    return { kind: "none" };
  }
  if (!head) throw new Error("review resume requires a resolvable branch HEAD");
  // An interrupted/failed review must finish its own validation; never reroute it based on partial output.
  if (!moved && step?.status !== "succeeded") return { kind: "none" };
  if (!moved && reviewRepairCount(db, ticketId) >= REVIEW_REPAIR_LIMIT)
    throw new Error(
      "review repair limit reached; fix the code and resume with --accept-head, or explicitly accept eligible risks",
    );
  const pending = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM projection_outbox WHERE ticket_id=? AND target='forge' AND op IN ('push','pr_create') AND status='pending'",
    )
    .all(ticketId);
  if (pending.length)
    throw new Error(
      "cannot retry review with pending forge effects; inspect the checkpoint or start --fresh",
    );
  return { kind: "retry", head, moved };
}

/** Caller encloses this with signal consumption + resumed event in one transaction. */
export function applyReviewResume(
  db: Database,
  ticketId: number,
  config: RuntimeConfig,
  plan: ReviewResumePlan,
): void {
  if (plan.kind === "none") return;
  if (plan.kind === "retry-plan") {
    if (plan.moved)
      redesignLoopback(
        db,
        ticketId,
        "review:operator-plan-head-changed",
        requiredPlanFindings(db, ticketId),
        latestDispatchForStep(db, ticketId, "design:review"),
        ["design:dispatch", "design:extract"],
      );
    else applyReviewVerdict(db, ticketId, config, { stepKey: "design:review" }); // design:dispatch only
    return;
  }
  beginReviewContract(db, ticketId);
  if (plan.kind === "accept-risk") {
    const snapshot = requiredCodeFindings(db, ticketId);
    for (const id of plan.ids) setStatus(db, id, "deferred");
    appendEvent(db, {
      ticketId,
      dispatchId: plan.dispatchId,
      kind: "note",
      actor: "operator",
      reason: "review-risk-accepted",
      payload: {
        version: 1,
        sha: plan.head,
        findingIds: plan.ids,
        rationale: plan.reason,
        findings: snapshot,
      },
    });
    return;
  }
  reopenStaleDeferrals(db, ticketId, plan.head);
  if (plan.moved) {
    // Re-enter implementation so its dispatch records the operator's new HEAD and normal checks run.
    codeLoopback(
      db,
      ticketId,
      [],
      "review:operator-head-changed",
      latestDispatchForStep(db, ticketId, "review"),
    );
  } else {
    applyReviewVerdict(db, ticketId, config, { stepKey: "review" });
  }
}
