import { expect, test } from "bun:test";
import type { RunResult } from "../../src/daemon/run-ticket.ts";
import {
  completeDispatch,
  getByDispatchId,
  insertDispatch,
  nextSeq,
} from "../../src/db/repos/dispatch.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { getRun } from "../../src/db/repos/run.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildSummary, createTelemetryEmitter } from "../../src/telemetry/emitter.ts";
import type { TelemetryEvent } from "../../src/telemetry/events.ts";
import { PricingConfigSchema } from "../../src/telemetry/pricing.ts";
import { nowUtc } from "../../src/util/time.ts";
import { makeTestDb } from "../helpers/db.ts";

const RESULT: RunResult = { outcome: "pr-ready", stage: "merge", status: "done", iterations: 1 };

/** Narrow buildSummary's union return to the summary member (throws if it isn't). */
function asSummary(e: TelemetryEvent): Extract<TelemetryEvent, { type: "summary" }> {
  if (e.type !== "summary") throw new Error(`expected summary, got ${e.type}`);
  return e;
}

/** getByDispatchId that throws instead of returning null — for test setup where the row must exist. */
function dispatchId(
  db: Parameters<typeof getByDispatchId>[0],
  ticketId: number,
  did: string,
): number {
  const row = getByDispatchId(db, ticketId, did);
  if (!row) throw new Error(`dispatch ${did} not found`);
  return row.id;
}

test("flushNew emits each row once (dedup) across calls; summary sums cost + counts cycles", () => {
  const { db, ticketId } = makeTestDb();
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));

  // First batch: a transition event + a completed dispatch with cost.
  appendEvent(db, { ticketId, kind: "transition", fromStage: "design", toStage: "implement" });
  const d1 = insertDispatch(db, { ticketId, dispatchId: "D1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d1.id, {
    outcome: "clean-success",
    branchHeadSha: "s1",
    costUsd: 0.25,
    tokensIn: 100,
    tokensOut: 40,
    cacheRead: 60,
    cacheCreate: 15,
    endedAt: new Date().toISOString(),
  });
  emitter.flushNew(db, ticketId);

  const firstCount = sink.length;
  expect(sink.some((e) => e.type === "event" && e.kind === "transition")).toBe(true);
  const d1Event = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "D1");
  expect(d1Event).toBeDefined();
  if (d1Event?.type === "dispatch") {
    expect(d1Event.cache_read).toBe(60);
    expect(d1Event.cache_create).toBe(15);
  }

  // Re-flush with no new rows → nothing added (dedup).
  emitter.flushNew(db, ticketId);
  expect(sink.length).toBe(firstCount);

  // Second batch: a loopback event + a ground-truth signal.
  appendEvent(db, { ticketId, kind: "loopback", reason: "verify failed" });
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "fail" });
  emitter.flushNew(db, ticketId);
  expect(sink.some((e) => e.type === "event" && e.kind === "loopback")).toBe(true);
  expect(sink.some((e) => e.type === "signal" && e.result === "fail")).toBe(true);

  // Summary: cost summed from dispatch; cycle_count from loopback events.
  emitter.emitSummary(db, ticketId, {
    outcome: "pr-ready",
    iterations: 5,
    stage: "merge",
    status: "waiting",
  });
  const summary = sink.find((e) => e.type === "summary");
  if (!summary || summary.type !== "summary") throw new Error("no summary emitted");
  expect(summary.cost_usd).toBeCloseTo(0.25);
  expect(summary.cache_read).toBe(60);
  expect(summary.cache_create).toBe(15);
  expect(summary.tokens_in).toBe(100);
  expect(summary.dispatch_count).toBe(1);
  expect(summary.cycle_count).toBe(1);
  expect(summary.outcome).toBe("pr-ready");
  db.close();
});

test("emitSummary: an escalated outcome passes through to summary.outcome, with escalation reasons", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, { ticketId, kind: "escalated", reason: "step 'design:extract' failed" });
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  emitter.emitSummary(db, ticketId, {
    outcome: "escalated",
    iterations: 3,
    stage: "design",
    status: "waiting",
  });
  const summary = sink.find((e) => e.type === "summary");
  if (!summary || summary.type !== "summary") throw new Error("no summary emitted");
  expect(summary.outcome).toBe("escalated");
  expect(summary.escalation_count).toBe(1);
  expect(summary.escalation_reasons).toContain("step 'design:extract' failed");
  db.close();
});

test("no dispatch reports cost => cost_usd is null, not 0 (ENG-339)", () => {
  const { db, ticketId } = makeTestDb();
  // two dispatches, neither reports cost (codex-style)
  for (const [i, did] of [
    [1, "ENG-1-d0001"],
    [2, "ENG-1-d0002"],
  ] as const) {
    insertDispatch(db, { ticketId, dispatchId: did, seq: i, startedAt: "t0" });
    completeDispatch(db, dispatchId(db, ticketId, did), {
      outcome: "clean-success",
      endedAt: "t1",
      tokensIn: 10,
    });
  }
  const s = asSummary(buildSummary(db, ticketId, RESULT));
  expect(s.type).toBe("summary");
  expect(s.cost_usd).toBeNull();
  expect(s.usage_coverage.cost_usd).toBe(0);
  expect(s.tokens_in).toBe(20); // both reported tokens
  expect(s.usage_coverage.tokens_in).toBe(2);
  db.close();
});

test("mixed cost => floor sum + partial coverage", () => {
  const { db, ticketId } = makeTestDb();
  insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1, startedAt: "t0" });
  completeDispatch(db, dispatchId(db, ticketId, "ENG-1-d0001"), {
    outcome: "clean-success",
    endedAt: "t1",
    costUsd: 0.4,
  });
  insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: 2, startedAt: "t0" });
  completeDispatch(db, dispatchId(db, ticketId, "ENG-1-d0002"), {
    outcome: "clean-success",
    endedAt: "t1",
    costUsd: null,
  });
  const s = asSummary(buildSummary(db, ticketId, RESULT));
  expect(s.cost_usd).toBeCloseTo(0.4); // floor
  expect(s.usage_coverage.cost_usd).toBe(1);
  expect(s.usage_coverage.dispatch_count).toBe(2);
  db.close();
});

test("summary carries run_id, provider, timestamps", () => {
  const { db, ticketId } = makeTestDb();
  const s = asSummary(buildSummary(db, ticketId, RESULT));
  const run = getRun(db);
  expect(s.run_id).toBe(run?.run_id ?? "");
  expect(s.provider).toBe("claude");
  expect(typeof s.started_at).toBe("string");
  expect(typeof s.ended_at).toBe("string");
  db.close();
});

test("buildSummary throws when no run row (D9 invariant)", () => {
  const { db, ticketId } = makeTestDb();
  db.exec("DELETE FROM run;");
  expect(() => buildSummary(db, ticketId, RESULT)).toThrow();
  db.close();
});

test("emitCiHandoff sinks a well-formed ci_handoff event", () => {
  const { db, ticketId } = makeTestDb(); // seed a ticket with an ident
  db.query("UPDATE ticket SET ident = 'STYRE-9' WHERE id = ?").run(ticketId);
  const seen: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => seen.push(e));
  emitter.emitCiHandoff(db, ticketId, {
    prRef: "7",
    prUrl: "https://x/pull/7",
    sha: "deadbeef",
    checksSystem: "github",
    read: "pending",
  });
  expect(seen).toHaveLength(1);
  const ev = seen[0];
  expect(ev.type).toBe("ci_handoff");
  if (ev.type === "ci_handoff") {
    expect(ev.ident).toBe("STYRE-9");
    expect(ev.pr_ref).toBe("7");
    expect(ev.branch_head_sha).toBe("deadbeef");
    expect(ev.checks_system).toBe("github");
    expect(ev.read).toBe("pending");
    expect(typeof ev.measured_at).toBe("string");
  }
  db.close();
});

test("claude run: reported cost_usd untouched AND cost_usd_estimated computed", () => {
  const { db, ticketId } = makeTestDb(); // provider = claude
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "C1",
    seq: nextSeq(db, ticketId),
    model: "claude-opus-4-8",
  });
  completeDispatch(db, d.id, {
    outcome: "clean-success",
    costUsd: 0.25,
    tokensIn: 1000,
    tokensOut: 200,
    cacheRead: 400,
    cacheCreate: 100,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "C1");
  expect(ev?.type).toBe("dispatch");
  if (ev?.type === "dispatch") {
    expect(ev.cost_usd).toBeCloseTo(0.25); // reported, untouched
    expect(ev.cost_usd_estimated).toBeCloseTo(
      (1000 * 5.0 + 400 * 0.5 + 100 * 6.25 + 200 * 25.0) / 1e6,
      8,
    );
  }
  db.close();
});

test("table-drift guard: claude estimate matches a SYNTHETIC reported cost computed from the same rate literals", () => {
  // NOT a calibration test and NOT a real invoice: `reported` below is computed from the exact same
  // list-price literals that `deriveCost`'s rate table uses, so this cannot detect the table being
  // miscalibrated against reality. What it DOES catch is drift between the two computations of "cost
  // from these rates" — e.g. an arithmetic slip in `deriveCost`, or the pricing table being edited in
  // one place and not the other. Treat it as a regression/drift guard, not evidence of accuracy.
  const { db, ticketId } = makeTestDb();
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "K1",
    seq: nextSeq(db, ticketId),
    model: "claude-opus-4-8",
  });
  // Synthetic "reported" cost: same list-price literals as BUILTIN_RATES["claude-opus-4-8"], not a
  // captured invoice.
  const reported = (120_000 * 5.0 + 800_000 * 0.5 + 40_000 * 6.25 + 6_000 * 25.0) / 1e6;
  completeDispatch(db, d.id, {
    outcome: "clean-success",
    costUsd: reported,
    tokensIn: 120_000,
    tokensOut: 6_000,
    cacheRead: 800_000,
    cacheCreate: 40_000,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "K1");
  if (ev?.type === "dispatch" && ev.cost_usd !== null && ev.cost_usd_estimated !== null) {
    // Guards gross table/formula drift: estimate within 1% of the synthetic "reported" figure.
    expect(Math.abs(ev.cost_usd_estimated - ev.cost_usd) / ev.cost_usd).toBeLessThan(0.01);
  } else {
    throw new Error("expected both reported and estimated cost");
  }
  db.close();
});

test("codex run: cost_usd null, cost_usd_estimated non-null; summary floor-sum + coverage", () => {
  const { db, ticketId } = makeTestDb({ provider: "codex" });
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "X1",
    seq: nextSeq(db, ticketId),
    model: "gpt-5.6-sol",
  });
  completeDispatch(db, d.id, {
    outcome: "clean-success",
    // no costUsd → cost_usd stays null (codex reports none)
    tokensIn: 51599,
    tokensOut: 267,
    cacheRead: 36339,
    cacheCreate: 15248,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "X1");
  if (ev?.type === "dispatch") {
    expect(ev.cost_usd).toBeNull();
    expect(ev.cost_usd_estimated).toBeCloseTo(0.1215395, 6);
  }
  emitter.emitSummary(db, ticketId, {
    outcome: "pr-ready",
    iterations: 1,
    stage: "merge",
    status: "done",
  });
  const s = sink.find((e) => e.type === "summary");
  if (s?.type === "summary") {
    expect(s.cost_usd).toBeNull(); // no dispatch reported USD
    expect(s.cost_usd_estimated).toBeCloseTo(0.1215395, 6);
    expect(s.usage_coverage.cost_usd_estimated).toBe(1);
    expect(s.pricing_version).toBe("builtin@2026-07-22");
  }
  db.close();
});

test("codex unknown model: cost_usd_estimated null", () => {
  const { db, ticketId } = makeTestDb({ provider: "codex" });
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "U1",
    seq: nextSeq(db, ticketId),
    model: "gpt-9.9-unknown",
  });
  completeDispatch(db, d.id, {
    outcome: "clean-success",
    tokensIn: 100,
    tokensOut: 40,
    cacheRead: 0,
    cacheCreate: 0,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "U1");
  if (ev?.type === "dispatch") expect(ev.cost_usd_estimated).toBeNull();
  db.close();
});

test("the emitter HONORS an injected pricing config (not just the built-in default)", () => {
  const { db, ticketId } = makeTestDb({ provider: "codex" });
  const sink: TelemetryEvent[] = [];
  const cfg = PricingConfigSchema.parse({
    version: "operator-test",
    rates: { "gpt-5.6-sol": { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 } },
  });
  const emitter = createTelemetryEmitter((e) => sink.push(e), cfg);
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "O1",
    seq: nextSeq(db, ticketId),
    model: "gpt-5.6-sol",
  });
  completeDispatch(db, d.id, {
    outcome: "clean-success",
    tokensIn: 1000,
    tokensOut: 100,
    cacheRead: 0,
    cacheCreate: 0,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "O1");
  if (ev?.type === "dispatch") {
    // All-1.0 rates → (1000 + 100)/1e6. Would be ~0.008 under the built-in sol rates.
    expect(ev.cost_usd_estimated).toBeCloseTo(1100 / 1e6, 10);
  }
  emitter.emitSummary(db, ticketId, {
    outcome: "pr-ready",
    iterations: 1,
    stage: "merge",
    status: "done",
  });
  const s = sink.find((e) => e.type === "summary");
  if (s?.type === "summary") expect(s.pricing_version).toBe("operator-test");
  db.close();
});
