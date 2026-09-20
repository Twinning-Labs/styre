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

export const ReviewEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("source"),
      path: z.string().min(1),
      line: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("measurement"), signal_id: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("reference"), url: z.string().url() }).strict(),
]);
export const ReviewResponseSchema = z
  .object({
    finding_id: z.number().int().positive(),
    action: z.enum(["repaired", "disputed"]),
    rationale: z.string().trim().min(1),
    evidence: z.array(ReviewEvidenceSchema).min(1),
  })
  .strict();
export const ReviewResolutionSchema = z
  .object({
    finding_id: z.number().int().positive(),
    disposition: z.enum(["fixed", "invalid", "unresolved"]),
    rationale: z.string().trim().min(1),
    evidence: z.array(ReviewEvidenceSchema).min(1),
  })
  .strict();
export const CodeReviewOutputSchema = z
  .object({
    findings: z.array(FiledFindingSchema),
    resolutions: z.array(ReviewResolutionSchema).default([]),
    verification_requests: z.array(z.string().min(1)).max(1).default([]),
  })
  .strict();
export type CodeReviewOutput = z.infer<typeof CodeReviewOutputSchema>;
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** Daemon-computed ship gate (control-loop §8): critical always blocks (non-deferrable);
 *  major blocks even when deferral is suggested; minor/nit never block. */
export function computeBlocksShip(severity: string, _deferralCandidate: boolean): 0 | 1 {
  if (severity === "critical") {
    return 1;
  }
  if (severity === "major") {
    return 1;
  }
  return 0;
}

/** Light completeness gate. Returns human-readable errors (empty ⇒ valid). Never throws. */
export function validateReviewFindings(
  findings: FiledFinding[],
  unitSeqs: number[],
  kind: "plan" | "code" = "code",
): string[] {
  const errors: string[] = [];
  const seqSet = new Set(unitSeqs);
  for (const f of findings) {
    if (f.work_unit_seq !== null && !seqSet.has(f.work_unit_seq)) {
      errors.push(`finding references work_unit_seq ${f.work_unit_seq}, which does not exist`);
    }
    if (f.severity === "critical" && f.deferral_candidate) {
      errors.push("a critical finding cannot be deferral_candidate (critical is non-deferrable)");
    }
    if (kind === "plan" && f.deferral_candidate)
      errors.push("plan findings cannot be deferral_candidate");
    if (f.deferral_candidate && f.severity !== "major")
      errors.push("only major code findings can be deferral_candidate");
  }
  return errors;
}
