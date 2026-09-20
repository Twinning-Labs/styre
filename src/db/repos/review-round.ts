import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  CodeReviewOutputSchema,
  type ReviewResponse,
  computeBlocksShip,
} from "../../dispatch/review-schema.ts";
import { getLatestForTicket } from "./dispatch.ts";
import { listByTicket as events, appendEvent } from "./event-log.ts";
import {
  type ReviewFindingRow,
  insertFinding,
  latestDispatchForStep,
  listByDispatch,
  listOpenByTicket,
  setStatus,
} from "./review-finding.ts";
import { listByTicket as units } from "./work-unit.ts";
import { getByKey } from "./workflow-step.ts";

export const REVIEW_REPAIR_LIMIT = 3;
export const ReviewCompletionSchema = z.object({
  version: z.literal(1),
  dispatchId: z.string().min(1),
  sha: z.string().min(1),
  output: CodeReviewOutputSchema,
});
export type ReviewCompletion = z.infer<typeof ReviewCompletionSchema>;

/** Severity is authoritative even on checkpoints which persisted deferrable majors as blocks_ship=0. */
export function requiresResolution(f: ReviewFindingRow): boolean {
  return f.status === "open" && (f.severity === "major" || f.severity === "critical");
}

export function requiredPlanFindings(db: Database, ticketId: number): ReviewFindingRow[] {
  const dispatchId = latestDispatchForStep(db, ticketId, "design:review");
  return listOpenByTicket(db, ticketId).filter(
    (f) => f.review_kind === "plan" && f.dispatch_id === dispatchId && requiresResolution(f),
  );
}

export function requiredCodeFindings(db: Database, ticketId: number): ReviewFindingRow[] {
  const open = listOpenByTicket(db, ticketId).filter(
    (f) => f.review_kind === "code" && requiresResolution(f),
  );
  const start = events(db, ticketId).find((e) => e.reason === "review-contract-started");
  if (!start) {
    const latest = latestDispatchForStep(db, ticketId, "review");
    const step = getByKey(db, ticketId, "review");
    const result = JSON.parse(step?.result_json ?? "null") as { findings?: number } | null;
    // A dispatch alone does not prove a valid review. Interrupted/malformed legacy rounds have
    // no reliable completion boundary, so preserve ambiguous debt instead of inferring a pass.
    if (
      latest &&
      step?.status === "succeeded" &&
      result?.findings === listByDispatch(db, ticketId, latest).length
    )
      return open.filter((f) => f.dispatch_id === latest);
    return open;
  }
  const snapshot = JSON.parse(start.payload_json ?? "{}");
  const contract = z
    .object({
      superseded: z.array(z.object({ id: z.number().int(), dispatchId: z.string().nullable() })),
    })
    .parse(snapshot);
  return open.filter(
    (f) => !contract.superseded.some((old) => old.id === f.id && old.dispatchId === f.dispatch_id),
  );
}

/** Snapshot the old latest-round policy once, before any new dispatch can hide its ledger.
 * Historical legacy rows superseded by a clean review remain historical; active Sphinx-like rows carry forward. */
export function beginReviewContract(db: Database, ticketId: number): void {
  if (events(db, ticketId).some((e) => e.reason === "review-contract-started")) return;
  const active = new Set(requiredCodeFindings(db, ticketId).map((f) => f.id));
  const superseded = listOpenByTicket(db, ticketId)
    .filter((f) => f.review_kind === "code" && requiresResolution(f) && !active.has(f.id))
    .map((f) => ({ id: f.id, dispatchId: f.dispatch_id }));
  appendEvent(db, {
    ticketId,
    kind: "note",
    reason: "review-contract-started",
    payload: { version: 1, superseded },
  });
}

/** Ticket-wide claims are investigated once by the first unit; all units still re-verify on loopback. */
export function findingsForUnit(
  db: Database,
  ticketId: number,
  unitId: number,
): ReviewFindingRow[] {
  const first = units(db, ticketId)[0]?.id;
  return requiredCodeFindings(db, ticketId).filter(
    (f) => f.work_unit_id === unitId || (f.work_unit_id === null && unitId === first),
  );
}

export function assertExactFindingIds(actual: number[], expected: number[]): void {
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    actual.some((id) => !expected.includes(id))
  ) {
    throw new Error(
      `review contract: expected exactly finding IDs [${expected.join(",")}], received [${actual.join(",")}]`,
    );
  }
}

export function recordResponses(
  db: Database,
  ticketId: number,
  dispatchId: string,
  sha: string,
  responses: ReviewResponse[],
): void {
  appendEvent(db, {
    ticketId,
    dispatchId,
    kind: "note",
    reason: "review-responses",
    payload: { version: 1, sha, responses },
  });
}

/** Called inside markSucceeded's transaction, before routing. Never close findings on a failed review. */
export function commitReviewCompletion(db: Database, ticketId: number): void {
  const step = getByKey(db, ticketId, "review");
  const result = JSON.parse(step?.result_json ?? "null") as { reviewCompletion?: unknown } | null;
  if (!result?.reviewCompletion) return; // legacy checkpoint / synthetic handler
  const c = ReviewCompletionSchema.parse(result.reviewCompletion);
  if (
    events(db, ticketId).some(
      (e) => e.reason === "review-completed" && e.dispatch_id === c.dispatchId,
    )
  )
    return;
  const previous = requiredCodeFindings(db, ticketId);
  assertExactFindingIds(
    c.output.resolutions.map((r) => r.finding_id),
    previous.map((f) => f.id),
  );
  if (c.output.verification_requests.length)
    throw new Error("review completion cannot contain pending verification requests");
  for (const r of c.output.resolutions) {
    if (r.disposition !== "unresolved")
      setStatus(db, r.finding_id, r.disposition === "fixed" ? "fixed" : "wont-fix");
  }
  const seqToId = new Map(units(db, ticketId).map((u) => [u.seq, u.id]));
  for (const f of c.output.findings) {
    const unitId = f.work_unit_seq === null ? null : seqToId.get(f.work_unit_seq);
    if (unitId === undefined) throw new Error("review completion references a missing work unit");
    insertFinding(db, {
      ticketId,
      dispatchId: c.dispatchId,
      reviewKind: "code",
      workUnitId: unitId,
      severity: f.severity,
      category: f.category,
      factorsJson: JSON.stringify(f.factors),
      deferralCandidate: f.deferral_candidate ? 1 : 0,
      blocksShip: computeBlocksShip(f.severity, f.deferral_candidate),
      location: f.location,
      rationale: f.rationale,
    });
  }
  appendEvent(db, {
    ticketId,
    dispatchId: c.dispatchId,
    kind: "note",
    reason: "review-completed",
    payload: c,
  });
}

export function reviewRepairCount(db: Database, ticketId: number): number {
  return events(db, ticketId).filter((e) => e.kind === "loopback" && e.route_to === "review")
    .length;
}

/** A deferred disposition is valid only at its explicitly accepted SHA. Reopen it after HEAD changes. */
export function reopenStaleDeferrals(db: Database, ticketId: number, head: string): void {
  const deferred = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM review_finding WHERE ticket_id=? AND status='deferred'",
    )
    .all(ticketId);
  const accepted = events(db, ticketId).filter((e) => e.reason === "review-risk-accepted");
  for (const f of deferred) {
    const valid = accepted.some((e) => {
      const p = JSON.parse(e.payload_json ?? "null") as {
        sha?: string;
        findingIds?: number[];
      } | null;
      return p?.sha === head && p.findingIds?.includes(f.id);
    });
    if (!valid) setStatus(db, f.id, "open");
  }
}

export function unresolvedReviewReason(
  db: Database,
  ticketId: number,
  expectedSha?: string,
): string | null {
  const open = requiredCodeFindings(db, ticketId);
  if (open.length) return `unresolved code-review findings: ${open.map((f) => f.id).join(",")}`;
  const head = expectedSha ?? getLatestForTicket(db, ticketId)?.branch_head_sha;
  const deferred = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM review_finding WHERE ticket_id=? AND status='deferred'",
    )
    .all(ticketId);
  for (const f of deferred) {
    if (
      !events(db, ticketId).some((e) => {
        if (e.reason !== "review-risk-accepted") return false;
        const p = JSON.parse(e.payload_json ?? "null") as {
          sha?: string;
          findingIds?: number[];
        } | null;
        return !!head && p?.sha === head && p.findingIds?.includes(f.id);
      })
    )
      return `stale risk acceptance for finding ${f.id}`;
  }
  return null;
}
