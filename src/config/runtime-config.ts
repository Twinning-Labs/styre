import { z } from "zod";

/** Daemon runtime config: operator policy knobs, threaded as one object through the loop.
 *  This is NOT the probed project Profile (product shape). The *values* live outside the target
 *  repo and are read at startup (workspace config.json > per-ticket), merged over the binary
 *  defaults below; that loader is built with the startup-entrypoint milestone. Here we define
 *  the object + its safe defaults so the seam is ready and callers thread a single object. */
export const RuntimeConfigSchema = z.object({
  // When code review finds a blocking PLAN-level defect: escalate to a human, or loop back to redesign.
  onPlanDefect: z.enum(["escalate", "redesign"]).default("escalate"),
  // M5b-3: opt-in cold complexity grader for track sizing. Off = deterministic sprawl-only.
  complexityGrading: z.boolean().default(false),
  // M6a: which issue-tracker adapter projects ticket state outward. Vendor-neutral; creds via env.
  issueTracker: z.string().default("linear"),
  // M6b: which forge (code-host) adapter handles push/PR ops. Vendor-neutral; creds via env.
  forge: z.string().default("github"),
  // OSS adoption analytics (PostHog). On by default; honors DO_NOT_TRACK / STYRE_TELEMETRY too.
  telemetry: z.boolean().default(true),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type OnPlanDefect = RuntimeConfig["onPlanDefect"];

/** The binary-defaults floor of the config precedence chain. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = RuntimeConfigSchema.parse({});
