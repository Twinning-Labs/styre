import { z } from "zod";

/** The telemetry event-stream schema version (open-core seam — bump on a breaking change). */
export const SCHEMA_VERSION = 2;
const version = z.literal(SCHEMA_VERSION);

/** An event_log row (per-ticket timeline: transition / loopback / escalated / resumed / note). */
const EventEvent = z.object({
  schema_version: version,
  type: z.literal("event"),
  run_id: z.string(),
  ticket_id: z.number(),
  dispatch_id: z.string().nullable(),
  seq: z.number(),
  kind: z.string(),
  actor: z.string().nullable(),
  from_stage: z.string().nullable(),
  to_stage: z.string().nullable(),
  loop: z.string().nullable(),
  route_to: z.string().nullable(),
  signature: z.string().nullable(),
  reason: z.string().nullable(),
  payload_json: z.string().nullable().optional(),
  created_at: z.string(),
});

/** A completed dispatch row (per-attempt cost/outcome/model/duration). */
const DispatchEvent = z.object({
  schema_version: version,
  type: z.literal("dispatch"),
  run_id: z.string(),
  dispatch_id: z.string(),
  ticket_id: z.number(),
  work_unit_id: z.number().nullable(),
  seq: z.number(),
  stage: z.string().nullable(),
  kind: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string(),
  trigger: z.string().nullable(),
  effort: z.string().nullable(),
  exit_code: z.number().nullable(),
  predecessor_dispatch_id: z.string().nullable(),
  outcome: z.string().nullable(),
  branch_head_sha: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  duration_ms: z.number().nullable(),
  tokens_in: z.number().nullable(),
  tokens_out: z.number().nullable(),
  cache_read: z.number().nullable(),
  cache_create: z.number().nullable(),
  cost_usd: z.number().nullable(),
  cost_usd_estimated: z.number().nullable(),
});

/** A ground-truth signal row (verify result: build/test/lint pass|fail|error). */
const SignalEvent = z.object({
  schema_version: version,
  type: z.literal("signal"),
  run_id: z.string(),
  id: z.number(),
  ticket_id: z.number(),
  work_unit_id: z.number().nullable(),
  signal_type: z.string(),
  result: z.string(),
  command: z.string().nullable(),
  branch_head_sha: z.string().nullable(),
  measured_at: z.string(),
});

/** The per-ticket summary emitted on exit. The plane aggregates these into the §5.3 dashboard
 *  rates (autonomous-fix ratio, first-time CI pass rate) across runs. */
const SummaryEvent = z.object({
  schema_version: version,
  type: z.literal("summary"),
  run_id: z.string(),
  ticket_id: z.number(),
  ident: z.string(),
  provider: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  outcome: z.string(),
  stage: z.string(),
  status: z.string(),
  ticks: z.number(),
  cost_usd: z.number().nullable(),
  cost_usd_estimated: z.number().nullable(),
  // Provenance of the price table used for cost_usd_estimated (built-in date or operator-set),
  // so a consumer can tell default estimates from config-overridden ones.
  pricing_version: z.string(),
  tokens_in: z.number().nullable(),
  tokens_out: z.number().nullable(),
  cache_read: z.number().nullable(),
  cache_create: z.number().nullable(),
  usage_coverage: z.object({
    dispatch_count: z.number(),
    cost_usd: z.number(),
    cost_usd_estimated: z.number(),
    tokens_in: z.number(),
    tokens_out: z.number(),
    cache_read: z.number(),
    cache_create: z.number(),
  }),
  dispatch_count: z.number(),
  dispatch_outcomes: z.record(z.string(), z.number()),
  cycle_count: z.number(),
  escalation_count: z.number(),
  escalation_reasons: z.array(z.string()),
});

/** A one-shot best-effort snapshot of remote CI state at PR-open, handed off to whoever owns the
 *  outer loop (the plane, or a human on GitHub). CI is reported, never gated (report-not-gate). */
const CiHandoffEvent = z.object({
  schema_version: version,
  type: z.literal("ci_handoff"),
  run_id: z.string(),
  ticket_id: z.number(),
  ident: z.string(),
  pr_ref: z.string().nullable(),
  pr_url: z.string().nullable(),
  branch_head_sha: z.string().nullable(),
  checks_system: z.string(),
  read: z.enum(["passing", "failing", "pending", "not-reported", "skipped"]),
  measured_at: z.string(),
});

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  EventEvent,
  DispatchEvent,
  SignalEvent,
  SummaryEvent,
  CiHandoffEvent,
]);

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
