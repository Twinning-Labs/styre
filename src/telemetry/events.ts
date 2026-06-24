import { z } from "zod";

/** The telemetry event-stream schema version (open-core seam — bump on a breaking change). */
export const SCHEMA_VERSION = 1;
const version = z.literal(SCHEMA_VERSION);

/** An event_log row (per-ticket timeline: transition / loopback / escalated / resumed / note). */
const EventEvent = z.object({
  schema_version: version,
  type: z.literal("event"),
  ticket_id: z.number(),
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
  dispatch_id: z.string(),
  ticket_id: z.number(),
  work_unit_id: z.number().nullable(),
  seq: z.number(),
  stage: z.string().nullable(),
  kind: z.string().nullable(),
  model: z.string().nullable(),
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
});

/** A ground-truth signal row (verify result: build/test/lint pass|fail|error). */
const SignalEvent = z.object({
  schema_version: version,
  type: z.literal("signal"),
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
  ticket_id: z.number(),
  ident: z.string(),
  outcome: z.string(),
  stage: z.string(),
  status: z.string(),
  ticks: z.number(),
  cost_usd: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  cache_read: z.number(),
  cache_create: z.number(),
  dispatch_count: z.number(),
  dispatch_outcomes: z.record(z.string(), z.number()),
  cycle_count: z.number(),
  escalation_count: z.number(),
  escalation_reasons: z.array(z.string()),
});

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  EventEvent,
  DispatchEvent,
  SignalEvent,
  SummaryEvent,
]);

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
