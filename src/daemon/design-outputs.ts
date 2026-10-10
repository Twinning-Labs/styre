import type { Database } from "bun:sqlite";
import { z } from "zod";
import { insertFinding } from "../db/repos/review-finding.ts";
import { clearTicketTrack, setNeedsDocs, setTicketTrack } from "../db/repos/ticket.ts";
import { deleteByTicket as deleteUnits, insertWorkUnit } from "../db/repos/work-unit.ts";
import { type ExtractedWorkUnit, ExtractedWorkUnitSchema } from "../dispatch/extract-schema.ts";
import type { DesignStepKey } from "./design-graph.ts";

/** What an invalidation clears, per step (spec §6.1). */
export const CLEAR_OUTPUTS: Record<DesignStepKey, (db: Database, ticketId: number) => void> = {
  // reruns; nothing in the database
  provision: () => {},
  // the rerun revises the plan file in place
  "design:dispatch": () => {},
  "design:extract": (db, ticketId) => {
    // Every unit goes, reconcile units included (a stale one would collide on UNIQUE (ticket_id,
    // seq) or depend on units that no longer exist). Findings tied to a unit are detached first, so
    // the unit foreign key's cascade does not delete them: code findings as today, and plan
    // findings too (spec §6.1).
    db.query(
      "UPDATE review_finding SET work_unit_id = NULL WHERE ticket_id = ? AND work_unit_id IS NOT NULL",
    ).run(ticketId);
    deleteUnits(db, ticketId);
    setNeedsDocs(db, ticketId, 0);
  },
  "design:size": (db, ticketId) => clearTicketTrack(db, ticketId),
  // requiredPlanFindings already reads only the latest design:review dispatch
  "design:review": () => {},
};

/** A commit receives its handler's result typed `unknown`; a result of the wrong shape is a defect
 *  in the handler, refused loudly with the step named, so the success transaction rolls back and
 *  nothing is written. */
function parseResult<T>(stepKey: string, schema: z.ZodType<T>, result: unknown): T {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`${stepKey}: the step's result is malformed: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** design:extract's result: its rows, written by writeExtractOutputs in the success transaction. */
export interface ExtractResult {
  units: number;
  extracted: ExtractedWorkUnit[];
  needsDocs: boolean;
}

const ExtractResultSchema: z.ZodType<ExtractResult> = z
  .object({
    units: z.number().int().nonnegative(),
    extracted: z.array(ExtractedWorkUnitSchema),
    needsDocs: z.boolean(),
  })
  .refine((r) => r.units === r.extracted.length, "units must count the extracted units");

export function writeExtractOutputs(db: Database, ticketId: number, result: unknown): void {
  const r = parseResult("design:extract", ExtractResultSchema, result);
  for (const u of r.extracted) {
    insertWorkUnit(db, {
      ticketId,
      seq: u.seq,
      kind: u.kind,
      title: u.title,
      description: u.description,
      behavioral: u.behavioral ? 1 : 0, // the carry: classify explicitly, never default
      testPlan: u.test_plan,
      filesToTouch: u.files_to_touch,
      verifyCheckTypes: u.verify_check_types,
      dependsOn: u.depends_on,
      origin: "extract",
    });
  }
  setNeedsDocs(db, ticketId, r.needsDocs ? 1 : 0);
}

export interface SizeResult {
  track: "fast" | "full";
  graded: boolean;
  overall?: number;
}

const SizeResultSchema: z.ZodType<SizeResult> = z.object({
  track: z.enum(["fast", "full"]),
  graded: z.boolean(),
  overall: z.number().optional(),
});

export function writeSizeOutput(db: Database, ticketId: number, result: unknown): void {
  setTicketTrack(db, ticketId, parseResult("design:size", SizeResultSchema, result).track);
}

export interface PlanFindingInput {
  workUnitId: number | null;
  severity: string;
  category: string;
  factorsJson: string | null;
  deferralCandidate: 0 | 1;
  blocksShip: 0 | 1 | null;
  location: string | null;
  rationale: string;
}

export interface ReviewResult {
  findings: number;
  blocking: number;
  dispatchId: string;
  filed: PlanFindingInput[];
}

const PlanFindingInputSchema: z.ZodType<PlanFindingInput> = z.object({
  workUnitId: z.number().int().positive().nullable(),
  severity: z.string().min(1),
  category: z.string().min(1),
  factorsJson: z.string().nullable(),
  deferralCandidate: z.union([z.literal(0), z.literal(1)]),
  blocksShip: z.union([z.literal(0), z.literal(1), z.null()]),
  location: z.string().nullable(),
  rationale: z.string(),
});

const ReviewResultSchema: z.ZodType<ReviewResult> = z
  .object({
    findings: z.number().int().nonnegative(),
    blocking: z.number().int().nonnegative(),
    dispatchId: z.string().min(1),
    filed: z.array(PlanFindingInputSchema),
  })
  .refine((r) => r.findings === r.filed.length, "findings must count the filed findings")
  .refine(
    (r) => r.blocking === r.filed.filter((f) => f.blocksShip === 1).length,
    "blocking must count the filed findings that block ship",
  );

/** design:review's rows, as rows of this step's dispatch (spec §3.1 rule 2), written before
 *  applyReviewVerdict reads them in the same transaction (spec §6.2). */
export function writePlanFindings(db: Database, ticketId: number, result: unknown): void {
  const r = parseResult("design:review", ReviewResultSchema, result);
  for (const f of r.filed) {
    insertFinding(db, {
      ticketId,
      reviewKind: "plan",
      dispatchId: r.dispatchId,
      workUnitId: f.workUnitId,
      severity: f.severity,
      category: f.category,
      factorsJson: f.factorsJson,
      deferralCandidate: f.deferralCandidate,
      blocksShip: f.blocksShip,
      location: f.location,
      rationale: f.rationale,
    });
  }
}
