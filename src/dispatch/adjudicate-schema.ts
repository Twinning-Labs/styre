import { z } from "zod";

/** The six labels the M3 adjudicator may return (§5): three red classes for coarse-red checks, three
 *  green-on-HEAD dispositions for coarse-green checks. */
export const AdjClassEnum = z.enum([
  "assertion",
  "absence",
  "environmental",
  "vacuous",
  "already-satisfied",
  "not-expressible",
]);
export type AdjClass = z.infer<typeof AdjClassEnum>;

/** One per-check adjudication. `ac_check_id` echoes the live ac_check.id the runner supplied; `reason`
 *  is the recorded evidence (§6). */
export const AdjudicationSchema = z.object({
  ac_check_id: z.number().int().positive(),
  class: AdjClassEnum,
  reason: z.string().min(1),
});
export type Adjudication = z.infer<typeof AdjudicationSchema>;

/** The `checks:classify` structured-output contract. An absent/malformed sidecar is a transport
 *  failure; a missing per-check element triggers a fault-isolated re-dispatch of only that check (§5),
 *  enforced by the handler — not by this schema (an empty array is well-formed). */
export const ChecksClassifyOutputSchema = z.object({
  classifications: z.array(AdjudicationSchema),
});
export type ChecksClassifyOutput = z.infer<typeof ChecksClassifyOutputSchema>;
