import { z } from "zod";

/** One work-unit as proposed by design:extract (control-loop §3a). The daemon assigns nothing
 *  the agent can fake: completeness is checked deterministically by validateExtraction. */
export const ExtractedWorkUnitSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.string().min(1),
  title: z.string(),
  description: z.string(),
  behavioral: z.boolean(),
  test_plan: z.string().nullable(),
  files_to_touch: z.array(z.string()),
  verify_check_types: z.array(z.string()),
  depends_on: z.array(z.number().int().positive()),
});

export type ExtractedWorkUnit = z.infer<typeof ExtractedWorkUnitSchema>;

export const ExtractOutputSchema = z.object({
  units: z.array(ExtractedWorkUnitSchema),
});

export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

/** Deterministic completeness gate (S1b postcondition). Returns human-readable errors;
 *  an empty array means the extraction is well-formed. Never throws. */
export function validateExtraction(units: ExtractedWorkUnit[]): string[] {
  const errors: string[] = [];
  if (units.length === 0) {
    errors.push("extraction has no work units");
    return errors;
  }

  const seqs = units.map((u) => u.seq);
  const seqSet = new Set(seqs);
  const expected = new Set(Array.from({ length: units.length }, (_, i) => i + 1));
  const contiguous = seqSet.size === seqs.length && [...expected].every((s) => seqSet.has(s));
  if (!contiguous) {
    errors.push(
      `seqs must be the unique contiguous set 1..${units.length}, got [${seqs.join(", ")}]`,
    );
  }

  for (const u of units) {
    if (u.behavioral) {
      if (u.test_plan === null || u.test_plan.trim() === "") {
        errors.push(`unit seq ${u.seq} is behavioral but has no test_plan`);
      }
      if (!u.verify_check_types.includes("test")) {
        errors.push(`unit seq ${u.seq} is behavioral but verify_check_types lacks "test"`);
      }
    }
    for (const dep of u.depends_on) {
      if (dep >= u.seq) {
        errors.push(`unit seq ${u.seq} depends on ${dep}, which is not a strictly-earlier unit`);
      } else if (!seqSet.has(dep)) {
        errors.push(`unit seq ${u.seq} depends on ${dep}, which does not exist`);
      }
    }
  }
  return errors;
}
