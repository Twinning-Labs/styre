import type { Database } from "bun:sqlite";
import { SuiteObservationSchema, suiteResult } from "../../dispatch/suite-observation.ts";
import type { SuiteObservation } from "../../dispatch/suite-observation.ts";
import { nowUtc } from "../../util/time.ts";
import { getLatestForTicket } from "./dispatch.ts";

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

/** The shas at which this signal type was recorded with a REAL VERDICT (`pass` or `fail`) — i.e.
 *  the check actually evaluated. Excludes `result='error'` (could-not-run: empty-diff, no-components,
 *  infra crash). Used to route the demoted advisory verify:check on "reached a verdict at sha": a
 *  genuine `fail` still satisfies routing (no re-emit wedge — the M4 demotion), but an `error` does
 *  NOT count as satisfied, so failure-policy's could-not-run retry is honoured and the unit never
 *  advances treating a check that never ran as complete (codex finding P1). */
export function verdictShasFor(
  db: Database,
  args: { ticketId: number; workUnitId: number | null; signalType: string },
): string[] {
  const rows = db
    .query<{ branch_head_sha: string | null }, [number, number | null, string]>(
      `SELECT branch_head_sha FROM ground_truth_signal
       WHERE ticket_id = ? AND work_unit_id IS ? AND signal_type = ?
         AND result != 'error' AND branch_head_sha IS NOT NULL`,
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
  /** Untrusted until CheckExecutionPlanSchema validates it on resume. */
  executionPlan?: unknown;
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
  /** ENG-402: the A1 gate overwrites a PASSING suite result to `fail` when a behavioral unit
   *  shipped no test (`handlers.ts`). Carrying the reason lets the report say what actually
   *  happened instead of claiming the suite failed, which it did not. */
  reason?: string;
  component?: string;
  /** ENG-412: the components this run excluded for want of a toolchain (plural — one signal
   *  carries them all, because `advisorySweeps` keys by signal_type and would otherwise keep
   *  only the last). */
  components?: string[];
  /** ENG-412: the programs/scripts whose absence caused the exclusion. */
  missing?: string[];
  /** ENG-425: the classification that excluded each of `components` (fixture/example/vendored),
   *  positionally aligned with it. */
  roles?: string[];
  /** ENG-426: per-component reasons a check framework could not be executed. */
  details?: string[];
  changed?: string[];
  /** Legacy input compatibility only. Exit-derived booleans cannot establish causality;
   *  advisorySweeps no longer emits this field and reports must ignore it. */
  preexisting?: boolean;
}

/** The demoted advisory suite/integration failures — newest per work-unit/type, sha-agnostic
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
      reason?: string;
      component?: string;
      components?: string[];
      changed?: string[];
      preexisting?: boolean;
      missing?: string[];
      roles?: string[];
      details?: string[];
    };
    if (d.advisory !== true) continue;
    // A successful aggregate covers this unit/type's earlier failure. Select latest first;
    // another unit's result cannot clear or replace this unit's evidence.
    const key = JSON.stringify([s.work_unit_id, s.signal_type]);
    if (s.result === "pass") {
      byType.delete(key);
      continue;
    }
    let firstFailingJob: string | undefined;
    if (s.signal_type === "integration" && Array.isArray(d.ran)) {
      firstFailingJob = d.ran.find((j) => j.exitCode !== 0 || j.timedOut)?.label;
    }
    byType.set(key, {
      type: s.signal_type,
      result: s.result,
      firstFailingJob,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
      ...(d.component !== undefined ? { component: d.component } : {}),
      ...(Array.isArray(d.components) ? { components: d.components } : {}),
      ...(Array.isArray(d.missing) ? { missing: d.missing } : {}),
      ...(Array.isArray(d.roles) ? { roles: d.roles } : {}),
      ...(Array.isArray(d.details) ? { details: d.details } : {}),
      ...(Array.isArray(d.changed) ? { changed: d.changed } : {}),
      // Legacy booleans were derived from exits alone and cannot establish pre-existence.
    });
  }
  return [...byType.values()];
}

export interface BindingEvidence {
  component: string;
  bound: string[];
  nonBinding: string[];
  unproven: string[];
}

/** Newest `delivered-test-binding` per component (ENG-402). Recorded on EVERY path, including the
 *  all-clear, so "the proof ran and passed" is distinguishable from "the proof never ran" —
 *  which it was not when the signal was only written on failure. */
export function deliveredTestBinding(db: Database, ticketId: number): BindingEvidence[] {
  const byComponent = new Map<string, BindingEvidence>();
  for (const s of listByTicket(db, ticketId)) {
    if (s.signal_type !== "delivered-test-binding") continue;
    const d = JSON.parse(s.detail_json ?? "{}") as Partial<BindingEvidence>;
    if (typeof d.component !== "string") continue;
    byComponent.set(d.component, {
      component: d.component,
      bound: Array.isArray(d.bound) ? d.bound : [],
      nonBinding: Array.isArray(d.nonBinding) ? d.nonBinding : [],
      unproven: Array.isArray(d.unproven) ? d.unproven : [],
    });
  }
  return [...byComponent.values()];
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

/** One command a verify step actually executed. `kind` is tagged by the PRODUCER at the moment it
 *  builds the job list — never inferred later from the label, because `repoCommands` names are
 *  free text authored by the setup agent (`prompts/setup-discover.md` offers `"integration"` as its
 *  own example), so `label.endsWith(":test")` silently misses a repo whose only suite is a repo
 *  command under any other name. */
export interface RanJob {
  /** verify:integration names jobs; verify:check names components. One of the two is always set. */
  label?: string;
  component?: string;
  /** Absent on every row written before ENG-439 added it — see `exercisesBehaviour`. */
  kind?: "build" | "test" | "repo" | "other";
  exitCode: number | null;
  timedOut?: boolean;
  observation?: SuiteObservation;
}

/** The `detail` of a suite/check signal. `executed` is DERIVED from `ran`, never passed in, and
 *  `extra` is spread FIRST so it cannot override either — a caller cannot claim an execution it did
 *  not record. That closes the accidental over-claim (a `pass` written beside no run record); it
 *  does NOT make a fabricated `ran` impossible, and nothing here should be described as if it did.
 *  Control flow reads `ran` (see `isExecutedPass`), not `executed`; `executed` exists for the human
 *  reading the ledger, which is why it is safe for it to be the forgeable term. */
export function suiteDetail(
  ran: RanJob[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extra, ran, executed: ran.length > 0 };
}

/** `detail.ran` as jobs, or `[]` when the signal carries no run record at all — which is exactly
 *  what the three "passed without executing anything" producers write (inert-only, the
 *  reviewer-only degrade, and the no-impacted-component fall-through). */
export function executedJobs(row: GroundTruthSignalRow): RanJob[] {
  // Total by construction. `insertSignal` stringifies whatever it is given, so a `detail: null`
  // persists as the literal string "null" and `JSON.parse` returns null — and this is read from
  // inside `nextStepKey`, which is called OUTSIDE advance.ts's try/catch. A throw here would crash
  // the run with a stack trace instead of pausing it. No producer writes either shape today; that
  // is not a reason to be one edit away from it.
  const parsed = JSON.parse(row.detail_json ?? "{}") as { ran?: unknown } | null;
  const ran = parsed?.ran;
  if (!Array.isArray(ran)) return [];
  return ran.filter((j): j is RanJob => j !== null && typeof j === "object");
}

/** A signal that PASSED and can name the commands it ran to earn that.
 *
 *  Deliberately keyed on `ran`, not on `detail.executed`: `executed` is a claim, `ran` is the
 *  record the claim is derived from, and a predicate that reads the claim can be defeated by
 *  writing the claim. (Review finding: the only forgeable term in the conjunction was the one that
 *  added nothing.)
 *
 *  This says "commands ran and exited 0". It does NOT say the commands asserted anything: `npm
 *  test` on a repo with no matching tests, `jest --passWithNoTests`, or a no-op test script all
 *  exit 0. Vacuous execution is a real, separate hole — `ac-check-red-first` and
 *  `delivered-test-binding` are the mechanisms aimed at it. Do not read this predicate as more
 *  than it is. */
export function isExecutedPass(row: GroundTruthSignalRow): boolean {
  if (row.result !== "pass") return false;
  const jobs = executedJobs(row);
  return (
    jobs.length > 0 &&
    jobs.every((j) => {
      if (j.exitCode !== 0 || j.timedOut === true) return false;
      if (j.observation === undefined) return true; // explicit legacy process-only evidence
      const parsed = SuiteObservationSchema.safeParse(j.observation);
      return (
        parsed.success && parsed.data.exitCode === j.exitCode && suiteResult(parsed.data) === "pass"
      );
    })
  );
}

/** Select AC evidence for the current ticket head, never merely the latest measured commit.
 *  A docs-only commit may reuse its source measurements, but only through the explicit carry
 *  recorded by `carryVerifiedVerdictForward`: both a carried passing gate and an integration
 *  record naming the source SHA at this head. This is one hop, matching the unit-sweep channel.
 *  Older carries without `carriedFrom` cannot establish that link and fail closed; measurements
 *  at the current head need no new metadata and remain readable on legacy checkpoints. */
export function acEvidenceSha(db: Database, ticketId: number): string | null {
  const head = getLatestForTicket(db, ticketId)?.branch_head_sha;
  if (!head) return null;
  const signals = listByTicket(db, ticketId);
  // Even a partial or failing measurement at this head takes precedence over carried evidence.
  if (
    signals.some((s) => s.signal_type === "ac-check-post-implement" && s.branch_head_sha === head)
  ) {
    return head;
  }
  const atHead = signals.filter((s) => s.branch_head_sha === head && s.work_unit_id === null);
  const integration = atHead.filter((s) => s.signal_type === "integration").at(-1);
  const gate = atHead.filter((s) => s.signal_type === "ac-check-gate").at(-1);
  const carried = JSON.parse(integration?.detail_json ?? "null") as {
    carriedForward?: unknown;
    carriedFrom?: unknown;
  } | null;
  const gateDetail = JSON.parse(gate?.detail_json ?? "null") as { carriedForward?: unknown } | null;
  if (
    carried?.carriedForward !== true ||
    typeof carried.carriedFrom !== "string" ||
    !carried.carriedFrom ||
    gate?.result !== "pass" ||
    gateDetail?.carriedForward !== true
  )
    return null;
  return signals.some(
    (s) => s.signal_type === "ac-check-post-implement" && s.branch_head_sha === carried.carriedFrom,
  )
    ? carried.carriedFrom
    : null;
}
