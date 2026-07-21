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
