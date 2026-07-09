import { z } from "zod";

/** The TWO blame routes the M5 arbiter may return (§3). NO environmental route — a gated check that
 *  errors/stays-red post-implement is code-wrong; no agent un-gates a check. */
export const BlameEnum = z.enum(["code-wrong", "check-wrong"]);
export type Blame = z.infer<typeof BlameEnum>;

/** One per-behavioral-check blame. `ac_check_id` echoes the live ac_check.id the runner supplied;
 *  `reason` is the recorded evidence (for check-wrong it must cite the positive AC-contradiction). */
export const ArbitrationSchema = z.object({
  ac_check_id: z.number().int().positive(),
  blame: BlameEnum,
  reason: z.string().min(1),
});
export type Arbitration = z.infer<typeof ArbitrationSchema>;

/** The `checks:arbitrate` structured-output contract. An absent/malformed sidecar is a transport
 *  failure (re-dispatch); a missing per-check element triggers a fault-isolated re-dispatch of only
 *  that check (enforced by the handler, not this schema — an empty array is well-formed). */
export const ChecksArbitrateOutputSchema = z.object({
  arbitrations: z.array(ArbitrationSchema),
});
export type ChecksArbitrateOutput = z.infer<typeof ChecksArbitrateOutputSchema>;
