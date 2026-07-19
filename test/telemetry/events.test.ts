import { expect, test } from "bun:test";
import { noopSink, stdoutSink } from "../../src/telemetry/emit.ts";
import { SCHEMA_VERSION, TelemetryEventSchema } from "../../src/telemetry/events.ts";

test("SCHEMA_VERSION is 1", () => {
  expect(SCHEMA_VERSION).toBe(1);
});

test("a summary event round-trips through the schema", () => {
  const ev = {
    schema_version: 1 as const,
    type: "summary" as const,
    ticket_id: 1,
    ident: "ENG-1",
    outcome: "pr-ready",
    stage: "merge",
    status: "waiting",
    ticks: 7,
    cost_usd: 0.42,
    tokens_in: 100,
    tokens_out: 50,
    cache_read: 70,
    cache_create: 12,
    dispatch_count: 2,
    dispatch_outcomes: { "clean-success": 2 },
    cycle_count: 1,
    escalation_count: 0,
    escalation_reasons: [],
  };
  const parsed = TelemetryEventSchema.parse(ev);
  expect(parsed.type).toBe("summary");
});

test("an event row variant round-trips (nullable fields allowed)", () => {
  const ev = {
    schema_version: 1 as const,
    type: "event" as const,
    ticket_id: 1,
    seq: 3,
    kind: "transition",
    actor: "runner",
    from_stage: "design",
    to_stage: "implement",
    loop: null,
    route_to: null,
    signature: null,
    reason: null,
    created_at: "2026-06-22T00:00:00Z",
  };
  expect(TelemetryEventSchema.parse(ev).type).toBe("event");
});

test("the schema rejects an unknown type and a wrong version", () => {
  expect(() => TelemetryEventSchema.parse({ schema_version: 1, type: "nope" })).toThrow();
  expect(() => TelemetryEventSchema.parse({ schema_version: 2, type: "summary" })).toThrow();
});

test("TelemetryEventSchema accepts a ci_handoff event", () => {
  const ev = {
    schema_version: SCHEMA_VERSION,
    type: "ci_handoff",
    ticket_id: 1,
    ident: "STYRE-1",
    pr_ref: "42",
    pr_url: "https://github.com/o/r/pull/42",
    branch_head_sha: "abc123",
    checks_system: "github",
    read: "not-reported",
    measured_at: "2026-07-18T12:00:00Z",
  };
  expect(TelemetryEventSchema.safeParse(ev).success).toBe(true);
});

test("TelemetryEventSchema rejects a ci_handoff with an unknown read value", () => {
  const ev = {
    schema_version: SCHEMA_VERSION,
    type: "ci_handoff",
    ticket_id: 1,
    ident: "STYRE-1",
    pr_ref: null,
    pr_url: null,
    branch_head_sha: null,
    checks_system: "none",
    read: "green",
    measured_at: "2026-07-18T12:00:00Z",
  };
  expect(TelemetryEventSchema.safeParse(ev).success).toBe(false);
});

test("stdoutSink writes one JSON line; noopSink writes nothing", () => {
  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    written.push(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    stdoutSink({
      schema_version: 1,
      type: "summary",
      ticket_id: 1,
      ident: "ENG-1",
      outcome: "done",
      stage: "released",
      status: "done",
      ticks: 1,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_create: 0,
      dispatch_count: 0,
      dispatch_outcomes: {},
      cycle_count: 0,
      escalation_count: 0,
      escalation_reasons: [],
    });
    noopSink({ schema_version: 1, type: "summary" } as never);
  } finally {
    process.stdout.write = orig;
  }
  expect(written.length).toBe(1);
  expect(written[0].endsWith("\n")).toBe(true);
  expect(JSON.parse(written[0]).ident).toBe("ENG-1");
});
