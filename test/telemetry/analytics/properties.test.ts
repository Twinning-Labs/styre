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
    schema_version: 2,
    type: "summary",
    run_id: "r1",
    ticket_id: 1,
    ident: "ENG-1",
    provider: "claude",
    started_at: "t0",
    ended_at: "t1",
    outcome: "pr-ready",
    stage: "merge",
    status: "waiting",
    ticks: 7,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_create: 0,
    usage_coverage: {
      dispatch_count: 3,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_create: 0,
    },
    dispatch_count: 3,
    dispatch_outcomes: { "clean-success": 3 },
    cycle_count: 0,
    escalation_count: 0,
    escalation_reasons: [],
    ...partial,
  };
}

test("bucket and durationBucket map to coarse strings", () => {
  expect(bucket(0)).toBe("0");
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
  // An escalation classifies by its reason keywords (reasons are populated).
  expect(failureBucket("escalated", ["blocking plan-defect found in review"])).toBe("plan-defect");
  expect(failureBucket("escalated", ["step 'design:extract' failed"])).toBe("unknown");
  // A resolver dead-end carries no escalation reasons → unknown.
  expect(failureBucket("blocked", [])).toBe("unknown");
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
      summary({ outcome: "escalated", escalation_reasons: ["budget exhausted"] }),
      5000,
      { complexityGrading: true, onPlanDefect: "redesign" },
    ),
    cliErrorProperties({
      command: "run",
      exitCode: 1,
      errorClass: "TypeError",
      errorKind: "operational",
    }),
  ];
  for (const bag of bags) {
    for (const key of Object.keys(bag)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  }
});

test("setupProperties buckets unknown component_kinds to 'other' and dedupes", () => {
  const bag = setupProperties({
    projectId: "p",
    checksSystem: "github",
    componentCount: 3,
    componentKinds: ["backend", "sveltekit", "rust"],
    stackBucket: "node",
    topologyType: "web-service",
  });
  const kinds = bag.component_kinds as string[];
  expect(kinds).toContain("backend");
  expect(kinds).toContain("other");
  expect(kinds).not.toContain("sveltekit");
  expect(kinds).not.toContain("rust");
  // the two unknowns collapse to a single deduped "other"
  expect(kinds.filter((k) => k === "other")).toHaveLength(1);
  expect(kinds).toHaveLength(2);
});

test("cli_error never carries a message field", () => {
  const bag = cliErrorProperties({
    command: "run",
    exitCode: 1,
    errorClass: "Error",
    errorKind: "internal",
  });
  expect("message" in bag).toBe(false);
});

test("cli_error carries an allow-listed error_kind", () => {
  const bag = cliErrorProperties({
    command: "run",
    exitCode: 78,
    errorClass: "StyreError",
    errorKind: "config",
  });
  expect(bag.error_kind).toBe("config");
  expect(ALLOWED_KEYS.has("error_kind")).toBe(true);
});
