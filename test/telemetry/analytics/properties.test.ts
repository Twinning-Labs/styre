import { expect, test } from "bun:test";
import {
  ALLOWED_KEYS,
  bucket,
  cliErrorProperties,
  durationBucket,
  failureBucket,
  runCompletedProperties,
  runStartedProperties,
  setupProperties,
  superProperties,
} from "../../../src/telemetry/analytics/properties.ts";
import type { TelemetryEvent } from "../../../src/telemetry/events.ts";

type SummaryEvent = Extract<TelemetryEvent, { type: "summary" }>;

function summary(partial: Partial<SummaryEvent>): SummaryEvent {
  return {
    schema_version: 1,
    type: "summary",
    ticket_id: 1,
    ident: "ENG-1",
    outcome: "pr-ready",
    stage: "merge",
    status: "waiting",
    ticks: 7,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_create: 0,
    dispatch_count: 3,
    dispatch_outcomes: { "clean-success": 3 },
    cycle_count: 0,
    escalation_count: 0,
    escalation_reasons: [],
    ...partial,
  };
}

test("bucket and durationBucket map to coarse strings", () => {
  expect(bucket(3)).toBe("1-5");
  expect(bucket(40)).toBe("21-50");
  expect(bucket(99)).toBe("50+");
  expect(durationBucket(2 * 60_000)).toBe("<5m");
  expect(durationBucket(90 * 60_000)).toBe(">60m");
});

test("failureBucket: success → null; parked → parked-credits; keyword maps blocked", () => {
  expect(failureBucket("pr-ready", [])).toBeNull();
  expect(failureBucket("parked", [])).toBe("parked-credits");
  expect(failureBucket("no-progress", [])).toBe("no-progress");
  expect(failureBucket("blocked", ["plan defect found in design"])).toBe("plan-defect");
  expect(failureBucket("blocked", ["something weird"])).toBe("unknown");
});

test("run_completed derives first_time_ci_pass and autonomous_fix from dispatch_outcomes", () => {
  const clean = runCompletedProperties(summary({}), 1000, {
    complexityGrading: false,
    onPlanDefect: "escalate",
  });
  expect(clean.first_time_ci_pass).toBe(true);
  expect(clean.autonomous_fix).toBe(false);
  expect(clean.terminal_stage).toBe("merge");

  const recovered = runCompletedProperties(
    summary({ dispatch_outcomes: { "build-red": 1, "clean-success": 2 } }),
    1000,
    { complexityGrading: false, onPlanDefect: "escalate" },
  );
  expect(recovered.first_time_ci_pass).toBe(false);
  expect(recovered.autonomous_fix).toBe(true);
});

test("ALLOW-LIST GUARD: every builder emits only allow-listed keys", () => {
  const bags: Record<string, unknown>[] = [
    superProperties(),
    setupProperties({
      projectId: "p",
      checksSystem: "github",
      componentCount: 2,
      componentKinds: ["backend"],
      stackBucket: "node",
      topologyType: "web-service",
    }),
    runStartedProperties({ projectId: "p", resumed: false, tracker: "linear", forge: "github" }),
    runCompletedProperties(
      summary({ outcome: "blocked", escalation_reasons: ["budget exhausted"] }),
      5000,
      { complexityGrading: true, onPlanDefect: "redesign" },
    ),
    cliErrorProperties({ command: "run", exitCode: 1, errorClass: "TypeError" }),
  ];
  for (const bag of bags) {
    for (const key of Object.keys(bag)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  }
});

test("cli_error never carries a message field", () => {
  const bag = cliErrorProperties({ command: "run", exitCode: 1, errorClass: "Error" });
  expect("message" in bag).toBe(false);
});
