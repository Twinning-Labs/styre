import { z } from "zod";

export const FiledFindingSchema = z.object({
  severity: z.enum(["critical", "major", "minor", "nit"]),
  category: z.string().min(1),
  location: z.string().nullable(),
  rationale: z.string(),
  factors: z.record(z.string(), z.boolean()).nullable(),
  deferral_candidate: z.boolean(),
  work_unit_seq: z.number().int().positive().nullable(),
});

export type FiledFinding = z.infer<typeof FiledFindingSchema>;

export const ReviewOutputSchema = z.object({
  findings: z.array(FiledFindingSchema),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** Daemon-computed ship gate (control-loop §8): critical always blocks (non-deferrable);
 *  major blocks unless the reviewer flagged it deferral_candidate; minor/nit never block. */
export function computeBlocksShip(severity: string, deferralCandidate: boolean): 0 | 1 {
  if (severity === "critical") {
    return 1;
  }
  if (severity === "major") {
    return deferralCandidate ? 0 : 1;
  }
  return 0;
}

/** Light completeness gate. Returns human-readable errors (empty ⇒ valid). Never throws. */
export function validateReviewFindings(findings: FiledFinding[], unitSeqs: number[]): string[] {
  const errors: string[] = [];
  const seqSet = new Set(unitSeqs);
  for (const f of findings) {
    if (f.work_unit_seq !== null && !seqSet.has(f.work_unit_seq)) {
      errors.push(`finding references work_unit_seq ${f.work_unit_seq}, which does not exist`);
    }
    if (f.severity === "critical" && f.deferral_candidate) {
      errors.push("a critical finding cannot be deferral_candidate (critical is non-deferrable)");
    }
  }
  return errors;
}
