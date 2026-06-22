import { expect, test } from "bun:test";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { createTelemetryEmitter } from "../../src/telemetry/emitter.ts";
import type { TelemetryEvent } from "../../src/telemetry/events.ts";
import { makeTestDb } from "../helpers/db.ts";

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
    endedAt: new Date().toISOString(),
  });
  emitter.flushNew(db, ticketId);

  const firstCount = sink.length;
  expect(sink.some((e) => e.type === "event" && e.kind === "transition")).toBe(true);
  expect(sink.some((e) => e.type === "dispatch" && e.dispatch_id === "D1")).toBe(true);

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
  expect(summary.tokens_in).toBe(100);
  expect(summary.dispatch_count).toBe(1);
  expect(summary.cycle_count).toBe(1);
  expect(summary.outcome).toBe("pr-ready");
  db.close();
});
