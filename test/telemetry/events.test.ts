import { expect, test } from "bun:test";
import { noopSink, stdoutSink } from "../../src/telemetry/emit.ts";
import { SCHEMA_VERSION, TelemetryEventSchema } from "../../src/telemetry/events.ts";

test("SCHEMA_VERSION is 2", () => {
  expect(SCHEMA_VERSION).toBe(2);
});

test("a summary round-trips with null cost + usage_coverage + identity", () => {
  const ev = {
    schema_version: 2 as const,
    type: "summary" as const,
    run_id: "r1",
    ticket_id: 1,
    ident: "ENG-1",
    provider: "codex",
    started_at: "2026-07-21T00:00:00Z",
    ended_at: "2026-07-21T00:01:00Z",
    outcome: "pr-ready",
    stage: "merge",
    status: "waiting",
    ticks: 7,
    cost_usd: null,
    tokens_in: 100,
    tokens_out: 50,
    cache_read: null,
    cache_create: null,
    usage_coverage: {
      dispatch_count: 2,
      cost_usd: 0,
      tokens_in: 2,
      tokens_out: 2,
      cache_read: 0,
      cache_create: 0,
    },
    dispatch_count: 2,
    dispatch_outcomes: { "clean-success": 2 },
    cycle_count: 1,
    escalation_count: 0,
    escalation_reasons: [],
  };
  expect(TelemetryEventSchema.parse(ev)).toMatchObject({ type: "summary", cost_usd: null });
});

test("a dispatch carries run_id + provider + forensic fields", () => {
  const ev = {
    schema_version: 2 as const,
    type: "dispatch" as const,
    run_id: "r1",
    dispatch_id: "ENG-1-d0001",
    ticket_id: 1,
    work_unit_id: null,
    seq: 1,
    stage: "implement",
    kind: null,
    model: "claude-opus-4-8",
    provider: "claude",
    trigger: "transition",
    effort: null,
    exit_code: 0,
    predecessor_dispatch_id: null,
    outcome: "clean-success",
    branch_head_sha: "abc",
    started_at: "t0",
    ended_at: "t1",
    duration_ms: 12,
    tokens_in: 1,
    tokens_out: 1,
    cache_read: null,
    cache_create: null,
    cost_usd: 0.5,
  };
  expect(TelemetryEventSchema.parse(ev)).toMatchObject({ provider: "claude" });
});

test("an event carries run_id + nullable dispatch_id", () => {
  const ev = {
    schema_version: 2 as const,
    type: "event" as const,
    run_id: "r1",
    ticket_id: 1,
    dispatch_id: null,
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
  expect(TelemetryEventSchema.parse(ev)).toMatchObject({ type: "event", dispatch_id: null });
});

test("the schema rejects an unknown type and a wrong version", () => {
  expect(() => TelemetryEventSchema.parse({ schema_version: 2, type: "nope" })).toThrow();
  expect(() => TelemetryEventSchema.parse({ schema_version: 1, type: "summary" })).toThrow();
});

test("TelemetryEventSchema accepts a ci_handoff event", () => {
  const ev = {
    schema_version: SCHEMA_VERSION,
    type: "ci_handoff",
    run_id: "r1",
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
    run_id: "r1",
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
      schema_version: 2,
      type: "summary",
      run_id: "r1",
      ticket_id: 1,
      ident: "ENG-1",
      provider: "claude",
      started_at: "t0",
      ended_at: "t1",
      outcome: "done",
      stage: "released",
      status: "done",
      ticks: 1,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_create: 0,
      usage_coverage: {
        dispatch_count: 0,
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        cache_read: 0,
        cache_create: 0,
      },
      dispatch_count: 0,
      dispatch_outcomes: {},
      cycle_count: 0,
      escalation_count: 0,
      escalation_reasons: [],
    });
    noopSink({ schema_version: 2, type: "summary" } as never);
  } finally {
    process.stdout.write = orig;
  }
  expect(written.length).toBe(1);
  expect(written[0].endsWith("\n")).toBe(true);
  expect(JSON.parse(written[0]).ident).toBe("ENG-1");
});
