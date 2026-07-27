import { expect, test } from "bun:test";
import { runCompletedProperties } from "../../src/telemetry/analytics/properties.ts";
import type { TelemetryEvent } from "../../src/telemetry/events.ts";

// run_completed maps the exported buildSummary output; assert the mapping for a paused(budget) run.
type SummaryEvent = Extract<TelemetryEvent, { type: "summary" }>;
const paused: SummaryEvent = {
  schema_version: 2,
  type: "summary",
  run_id: "r1",
  ticket_id: 1,
  ident: "ENG-1",
  provider: "claude",
  started_at: "t0",
  ended_at: "t1",
  outcome: "paused",
  stage: "implement",
  status: "running",
  ticks: 12,
  cost_usd: 0,
  cost_usd_estimated: null,
  pricing_version: "builtin@2026-07-22",
  tokens_in: 0,
  tokens_out: 0,
  cache_read: 0,
  cache_create: 0,
  usage_coverage: {
    dispatch_count: 4,
    cost_usd: 0,
    cost_usd_estimated: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_create: 0,
  },
  dispatch_count: 4,
  dispatch_outcomes: { "clean-success": 3, "build-red": 1 },
  cycle_count: 2,
  escalation_count: 0,
  escalation_reasons: [],
};

test("paused run maps outcome through and the right buckets", () => {
  const props = runCompletedProperties(paused, 7 * 60_000, {
    complexityGrading: false,
    onPlanDefect: "escalate",
  });
  expect(props.outcome).toBe("paused");
  // failureBucket still keys off the old "parked" string literal — re-keying it to paused+reason
  // (e.g. "parked-credits" for a budget pause) is ENG-383/384 Task 3's job; for now it falls
  // through to the escalation_reasons keyword scan, which is empty here → "unknown".
  expect(props.failure_bucket).toBe("unknown");
  expect(props.terminal_stage).toBe("implement");
  expect(props.duration_bucket).toBe("5-15m");
  expect(props.first_time_ci_pass).toBe(false);
});
