import { describe, expect, test } from "bun:test";
import type { RunResult } from "../../src/daemon/run-ticket.ts";
import { getRun, insertRun, markResumed } from "../../src/db/repos/run.ts";
import { buildSummary } from "../../src/telemetry/emitter.ts";
import type { TelemetryEvent } from "../../src/telemetry/events.ts";
import { makeTestDb } from "../helpers/db.ts";

const RESULT: RunResult = { outcome: "pr-ready", stage: "merge", status: "done", iterations: 1 };

/** Narrow buildSummary's union return to the summary member (throws if it isn't). */
function asSummary(e: TelemetryEvent): Extract<TelemetryEvent, { type: "summary" }> {
  if (e.type !== "summary") throw new Error(`expected summary, got ${e.type}`);
  return e;
}

/** getRun that throws instead of returning null — the run row is required for these assertions. */
function requireRun(db: Parameters<typeof getRun>[0]): NonNullable<ReturnType<typeof getRun>> {
  const row = getRun(db);
  if (!row) throw new Error("no run row");
  return row;
}

describe("run identity on the wire", () => {
  test("two runs of the same ticket emit distinct run_id", () => {
    // makeTestDb seeds a FIXED run_id ("test-run-0001"); override b's before building its summary
    // so the assertion reflects real distinct runs (each real run mints a fresh UUID).
    const a = makeTestDb();
    const b = makeTestDb();
    b.db.exec("DELETE FROM run;");
    insertRun(b.db, { runId: "test-run-0002", startedAt: "t", provider: "claude" });
    const sa = asSummary(buildSummary(a.db, a.ticketId, RESULT));
    const sb = asSummary(buildSummary(b.db, b.ticketId, RESULT));
    expect(sa.run_id).not.toBe(sb.run_id);
    a.db.close();
    b.db.close();
  });

  test("resume keeps the same run_id and marks resumed", () => {
    const { db, ticketId } = makeTestDb();
    const before = requireRun(db).run_id;
    markResumed(db);
    const s = asSummary(buildSummary(db, ticketId, RESULT));
    expect(s.run_id).toBe(before);
    expect(requireRun(db).resumed).toBe(1);
    expect(requireRun(db).attempt).toBe(2);
    db.close();
  });
});
