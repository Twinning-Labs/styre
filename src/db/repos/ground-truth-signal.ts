import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface GroundTruthSignalRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  signal_type: string;
  result: string;
  command: string | null;
  branch_head_sha: string | null;
  detail_json: string | null;
  measured_at: string;
}

const COLS =
  "id, ticket_id, work_unit_id, signal_type, result, command, branch_head_sha, detail_json, measured_at";

export function listByUnit(db: Database, workUnitId: number): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE work_unit_id = ? ORDER BY measured_at, id`,
    )
    .all(workUnitId);
}

export function listByTicket(db: Database, ticketId: number): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE ticket_id = ? ORDER BY measured_at, id`,
    )
    .all(ticketId);
}

/** Rows with `id > afterId` (exclusive), in id order. For incremental streaming: signals are
 *  insert-only and id is monotonic, so id is a safe watermark over a run's growing ledger. */
export function listByTicketSince(
  db: Database,
  ticketId: number,
  afterId: number,
): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number, number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE ticket_id = ? AND id > ? ORDER BY id`,
    )
    .all(ticketId, afterId);
}

export function insertSignal(
  db: Database,
  p: {
    ticketId: number;
    workUnitId?: number | null;
    signalType: string;
    result: string;
    command?: string;
    branchHeadSha?: string;
    detail?: unknown;
  },
): GroundTruthSignalRow {
  const res = db
    .query(
      `INSERT INTO ground_truth_signal (ticket_id, work_unit_id, signal_type, result, command, branch_head_sha, detail_json, measured_at)
       VALUES ($t, $wu, $type, $result, $command, $sha, $detail, $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $type: p.signalType,
      $result: p.result,
      $command: p.command ?? null,
      $sha: p.branchHeadSha ?? null,
      $detail: p.detail === undefined ? null : JSON.stringify(p.detail),
      $now: nowUtc(),
    });
  const created = db
    .query<GroundTruthSignalRow, [number]>(`SELECT ${COLS} FROM ground_truth_signal WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertSignal: row missing after insert");
  }
  return created;
}

export function passingShasFor(
  db: Database,
  args: { ticketId: number; workUnitId: number | null; signalType: string },
): string[] {
  const rows = db
    .query<{ branch_head_sha: string | null }, [number, number | null, string]>(
      `SELECT branch_head_sha FROM ground_truth_signal
       WHERE ticket_id = ? AND work_unit_id IS ? AND signal_type = ? AND result = 'pass'
         AND branch_head_sha IS NOT NULL`,
    )
    .all(args.ticketId, args.workUnitId, args.signalType);
  return rows.map((r) => r.branch_head_sha).filter((s): s is string => s !== null);
}

/** Like passingShasFor but result-agnostic: the shas at which a signal of this type was RECORDED
 *  (any result). Used to route advisory gates (verify:check, verify:integration) on "ran at sha",
 *  so a recorded advisory `fail` still advances instead of re-emitting forever (M4 demotion). The
 *  HARD AC-check gate keeps using passingShasFor (`result='pass'`) — do NOT swap it here. */
export function ranShasFor(
  db: Database,
  args: { ticketId: number; workUnitId: number | null; signalType: string },
): string[] {
  const rows = db
    .query<{ branch_head_sha: string | null }, [number, number | null, string]>(
      `SELECT branch_head_sha FROM ground_truth_signal
       WHERE ticket_id = ? AND work_unit_id IS ? AND signal_type = ?
         AND branch_head_sha IS NOT NULL`,
    )
    .all(args.ticketId, args.workUnitId, args.signalType);
  return rows.map((r) => r.branch_head_sha).filter((s): s is string => s !== null);
}

/** The parsed shape M2b's `checks:dispatch` persists in an `ac-check-red-first` signal's detail. */
export interface RedFirstDetail {
  rawOutput: string;
  exitCode: number | null;
  framework: string | null;
  command: string | null;
  acCheckId: number;
}

/** Read the RED-first signal for a check by its LIVE `ac_check.id` (§3 read contract). `ground_truth_signal`
 *  is append-only, so a scoped re-author leaves the previous round's signal behind with a dangling
 *  acCheckId — classifying must key on the live id, never "the latest signal for the AC". Returns the
 *  newest matching signal + its parsed detail, or null. */
export function signalForAcCheck(
  db: Database,
  acCheckId: number,
): { row: GroundTruthSignalRow; detail: RedFirstDetail } | null {
  const row = db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal
       WHERE signal_type = 'ac-check-red-first'
         AND json_extract(detail_json, '$.acCheckId') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(acCheckId);
  if (!row) return null;
  return { row, detail: JSON.parse(row.detail_json ?? "{}") as RedFirstDetail };
}

/** The parsed shape `checks:classify` (`src/dispatch/handlers.ts`) persists in an
 *  `ac-check-classification` signal's detail. */
export interface ClassificationDetail {
  acCheckId: number;
  acId: number;
  class: string;
  reason: string;
}

/** Read the classification signal for a check by its LIVE `ac_check.id` (§3 read contract, mirrors
 *  `signalForAcCheck`). DISPLAY-sourcing only — the re-author prompt's "why the prior check was
 *  flagged" text (Task 3e). Control flow (which ACs to re-author, the escalate counter) never reads
 *  this; it reads `ac_check.red_class`/`disposition` directly (the M4 anti-pattern fix). Returns the
 *  newest matching signal + its parsed detail, or null. */
export function classificationForAcCheck(
  db: Database,
  acCheckId: number,
): { row: GroundTruthSignalRow; detail: ClassificationDetail } | null {
  const row = db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal
       WHERE signal_type = 'ac-check-classification'
         AND json_extract(detail_json, '$.acCheckId') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(acCheckId);
  if (!row) return null;
  return { row, detail: JSON.parse(row.detail_json ?? "{}") as ClassificationDetail };
}

/** The behavioral still-red AC-id set at `sha` = the latest `ac-check-gate` signal's stillRed minus
 *  its tampered (integrity is never arbitrated). Empty when the gate passed / was integrity-only. */
export function behavioralStillRed(db: Database, ticketId: number, sha: string): number[] {
  const sig = listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-gate" && s.branch_head_sha === sha)
    .at(-1);
  if (!sig) return [];
  const d = JSON.parse(sig.detail_json ?? "{}") as { stillRed?: number[]; tampered?: number[] };
  const tampered = new Set(d.tampered ?? []);
  return (d.stillRed ?? []).filter((id) => !tampered.has(id));
}

/** The shas at which any `ac-check-blame` signal exists (the round key: blame present ⇒ the arbiter
 *  already ran for that gate round). */
export function blameShasFor(db: Database, ticketId: number): string[] {
  return listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-blame" && s.branch_head_sha !== null)
    .map((s) => s.branch_head_sha as string);
}

export interface BlameDetail {
  acId: number;
  acCheckId: number;
  blame: string;
  reason: string;
}

/** The blames recorded at `sha` (one per behavioral check the arbiter judged that round). */
export function latestBlameAtSha(db: Database, ticketId: number, sha: string): BlameDetail[] {
  return listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-blame" && s.branch_head_sha === sha)
    .map((s) => JSON.parse(s.detail_json ?? "{}") as BlameDetail);
}

export interface ReauthorDetail {
  acId: number;
  acCheckId: number;
  disposition: "installed" | "rejected";
}

/** The shas at which any `ac-check-reauthor` disposition exists (the round key: a disposition present
 *  ⇒ checks:reauthor already ran for that arbiter round). */
export function reauthorShasFor(db: Database, ticketId: number): string[] {
  return listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-reauthor" && s.branch_head_sha !== null)
    .map((s) => s.branch_head_sha as string);
}

/** The re-author dispositions recorded at `sha` (one per check-wrong AC the reauthor step handled). */
export function latestReauthorAtSha(db: Database, ticketId: number, sha: string): ReauthorDetail[] {
  return listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-reauthor" && s.branch_head_sha === sha)
    .map((s) => JSON.parse(s.detail_json ?? "{}") as ReauthorDetail);
}

export interface PostImplementDetail {
  acCheckId: number;
  acId: number;
  coarse: string;
  redClass: string | null;
  outcome: string;
}

/** Newest `ac-check-post-implement` coarse per `acCheckId` at `sha`. `listByTicket` is measured_at,id
 *  ASC, so the last `set` for a given acCheckId wins = newest. M6 reads greenness here; never recomputes. */
export function postImplementAtSha(
  db: Database,
  ticketId: number,
  sha: string,
): Map<number, PostImplementDetail> {
  const byCheck = new Map<number, PostImplementDetail>();
  for (const s of listByTicket(db, ticketId)) {
    if (s.signal_type !== "ac-check-post-implement" || s.branch_head_sha !== sha) continue;
    const d = JSON.parse(s.detail_json ?? "{}") as PostImplementDetail;
    byCheck.set(d.acCheckId, d);
  }
  return byCheck;
}

export interface AdvisorySweep {
  type: string; // signal_type: 'integration' or a checkType (open vocab)
  result: string; // 'fail' | 'error'
  firstFailingJob?: string;
}

/** The demoted advisory suite/integration failures (M4 §8) — newest per `signal_type`, sha-agnostic
 *  (a check-only re-author moves HEAD without re-running the suite, so scoping to HEAD would drop a
 *  still-failing suite — review finding I2). Selected by `detail.advisory === true` (the boolean) so the
 *  `ac-check-gate` signal — whose `advisory` is a number[] — is never mis-selected; and `result !== pass`
 *  (include 'error', not just 'fail' — review finding M1). */
export function advisorySweeps(db: Database, ticketId: number): AdvisorySweep[] {
  const byType = new Map<string, AdvisorySweep>();
  for (const s of listByTicket(db, ticketId)) {
    const d = JSON.parse(s.detail_json ?? "{}") as {
      advisory?: unknown;
      ran?: Array<{ label: string; exitCode: number | null; timedOut?: boolean }>;
    };
    if (d.advisory !== true) continue;
    if (s.result === "pass") continue;
    let firstFailingJob: string | undefined;
    if (s.signal_type === "integration" && Array.isArray(d.ran)) {
      firstFailingJob = d.ran.find((j) => j.exitCode !== 0 || j.timedOut)?.label;
    }
    byType.set(s.signal_type, { type: s.signal_type, result: s.result, firstFailingJob });
  }
  return [...byType.values()];
}

export interface Provenance {
  acId: number;
  acCheckId: number;
  disposition: "installed" | "rejected";
  reason: string;
}

/** Newest re-author disposition per `acCheckId`, joined to the newest `check-wrong` blame reason for that
 *  check (reason lives on the blame signal; the reauthor signal has none). Sha-agnostic. Powers both the
 *  provenance section AND the C1 label: an ACTIVE check whose id appears here with `rejected` is the
 *  wrong-shape-unreplaced check (a rejected re-author leaves the old check active — arbiter-verdict.ts). */
export function reauthorProvenance(db: Database, ticketId: number): Provenance[] {
  const reasonByCheck = new Map<number, string>();
  const dispByCheck = new Map<number, { acId: number; disposition: "installed" | "rejected" }>();
  for (const s of listByTicket(db, ticketId)) {
    if (s.signal_type === "ac-check-blame") {
      const b = JSON.parse(s.detail_json ?? "{}") as BlameDetail;
      if (b.blame === "check-wrong") reasonByCheck.set(b.acCheckId, b.reason);
    } else if (s.signal_type === "ac-check-reauthor") {
      const r = JSON.parse(s.detail_json ?? "{}") as ReauthorDetail;
      dispByCheck.set(r.acCheckId, { acId: r.acId, disposition: r.disposition });
    }
  }
  const out: Provenance[] = [];
  for (const [acCheckId, { acId, disposition }] of dispByCheck) {
    out.push({ acId, acCheckId, disposition, reason: reasonByCheck.get(acCheckId) ?? "" });
  }
  return out;
}
