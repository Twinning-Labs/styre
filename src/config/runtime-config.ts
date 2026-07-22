import { z } from "zod";
import { PricingConfigSchema } from "../telemetry/pricing.ts";
import { AgentConfigSchema } from "./agent-config.ts";

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
  // M-jira-2: JIRA adapter policy (non-secret). Absent -> built-in defaults; creds via env.
  jira: z
    .object({
      // neutral IssueState -> target JIRA status (+ optional resolution)
      statusMap: z
        .record(z.string(), z.object({ status: z.string(), resolution: z.string().optional() }))
        .optional(),
      // issue-type names treated as Bug (default ["Bug"])
      bugTypeNames: z.array(z.string()).optional(),
    })
    .optional(),
  // M6b: which forge (code-host) adapter handles push/PR ops. Vendor-neutral; creds via env.
  forge: z.string().default("github"),
  // OSS adoption analytics (PostHog). On by default; honors DO_NOT_TRACK / STYRE_TELEMETRY too.
  telemetry: z.boolean().default(true),
  // ENG-356: list-price-equivalent cost-estimate pricing. Top-level (NOT under `telemetry`, which is
  // the PostHog on/off boolean). Numbers/multipliers are operator-tunable; the built-in table is the
  // default. The token-accounting convention lives in code (telemetry/pricing.ts), not here.
  // zod 4's .default() does NOT parse its argument — .default({}) would yield an empty pricing
  // config (no rates/tiers => every estimate null, silently). Keep the thunk.
  pricing: PricingConfigSchema.default(() => PricingConfigSchema.parse({})),
  notifier: z.enum(["none", "slack"]).default("none"),
  notify: z.enum(["escalations", "transitions", "everything"]).default("escalations"),
  slack: z.object({ channel: z.string() }).optional(),
  // DEC-CX-5: the agent provider + per-tier models. Absent → the binary Claude preset.
  agent: AgentConfigSchema.optional(),
  // Checks-disposition arc: how implement handles undeclared new files. Default "reject" (proven,
  // today's behavior). "discard" opts implement into the checks-style discard path (guarded by
  // rename-safety + a sidecar re-dispatch guard). Off by default — the escape hatch, not the norm.
  implementDisposition: z.enum(["reject", "discard"]).default("reject"),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type OnPlanDefect = RuntimeConfig["onPlanDefect"];

/** The binary-defaults floor of the config precedence chain. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = RuntimeConfigSchema.parse({});
