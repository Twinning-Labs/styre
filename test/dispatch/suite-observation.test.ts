import { expect, test } from "bun:test";
import {
  advisorySweeps,
  insertSignal,
  listByTicket,
} from "../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { suiteDiagnostics } from "../../src/dispatch/suite-diagnostics.ts";
import {
  SuiteObservationSchema,
  observeSuiteCommand,
  suiteObservation,
} from "../../src/dispatch/suite-observation.ts";
import { makeTestDb } from "../helpers/db.ts";

const context = { sha: "candidate-sha", command: "pytest", cwd: "/repo" };
const failing = suiteObservation(context, {
  exitCode: 1,
  timedOut: false,
  stdout: "assertion on stdout",
  stderr: "dependency on stderr",
});

test("command outcome preserves evidence without inventing behavioral or environmental blame", () => {
  for (const exitCode of [1, 2, 5, 126, 127]) {
    const o = suiteObservation(context, { exitCode, timedOut: false, stdout: "", stderr: "" });
    expect(o.outcome).toBe("completed-nonzero");
    expect(o).not.toHaveProperty("preexisting");
  }
  expect(SuiteObservationSchema.safeParse({ ...failing, outcome: "completed-zero" }).success).toBe(
    false,
  );
});

test("bounded observations retain both output channels and expose truncation", () => {
  const o = suiteObservation(context, {
    exitCode: 1,
    timedOut: false,
    stdout: `start${"x".repeat(10000)}end`,
    stderr: "stderr",
  });
  expect(o.stdout.startsWith("start")).toBe(true);
  expect(o.stdout.endsWith("end")).toBe(true);
  expect(o.stdout.length).toBeLessThan(3100);
  expect(o.outputTruncated).toBe(true);
  expect(o.stderr).toBe("stderr");
});

test("native suite runner captures stdout/stderr and exposes the process recovery hook", async () => {
  let pid = 0;
  let settled = false;
  const o = await observeSuiteCommand({
    ...context,
    cwd: process.cwd(),
    command: "echo failing-test-output; echo setup-diagnostic >&2; exit 1",
    timeoutMs: 5000,
    onSpawn: (p) => {
      pid = p;
    },
    onSettled: () => {
      settled = true;
    },
  });
  expect(pid).toBeGreaterThan(0);
  expect(settled).toBe(true);
  expect(o.stdout).toContain("failing-test-output");
  expect(o.stderr).toContain("setup-diagnostic");
  expect(o.outcome).toBe("completed-nonzero");
  expect(o.timing?.timeoutMs).toBe(5000);
  expect(o.timing?.durationMs).toBeGreaterThan(0);
});

test("latest pass clears one unit's advisory without clearing another unit", () => {
  const { db, ticketId } = makeTestDb();
  try {
    const one = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
    const two = insertWorkUnit(db, { ticketId, seq: 2, kind: "backend" });
    for (const workUnitId of [one.id, two.id])
      insertSignal(db, {
        ticketId,
        workUnitId,
        signalType: "test",
        result: "fail",
        branchHeadSha: "old",
        detail: { advisory: true, ran: [{ component: "api", exitCode: 1, observation: failing }] },
      });
    insertSignal(db, {
      ticketId,
      workUnitId: one.id,
      signalType: "test",
      result: "pass",
      branchHeadSha: "new",
      detail: { advisory: true, ran: [{ component: "api", exitCode: 0 }] },
    });
    expect(advisorySweeps(db, ticketId)).toHaveLength(1);
    const diagnostics = suiteDiagnostics(listByTicket(db, ticketId), "new");
    expect(diagnostics.observations).toHaveLength(1);
    expect(diagnostics.observations[0].workUnitId).toBe(two.id);
    expect(diagnostics.observations[0].atCurrentSha).toBe(false);
    expect(diagnostics.observations[0].measuredSha).toBe("old");
  } finally {
    db.close();
  }
});

test("integration fail then pass clears the stale warning", () => {
  const { db, ticketId } = makeTestDb();
  try {
    for (const result of ["fail", "pass"] as const)
      insertSignal(db, {
        ticketId,
        signalType: "integration",
        result,
        branchHeadSha: "head",
        detail: {
          advisory: true,
          ran: [{ label: "api:test", exitCode: result === "pass" ? 0 : 1 }],
        },
      });
    expect(advisorySweeps(db, ticketId)).toEqual([]);
    expect(suiteDiagnostics(listByTicket(db, ticketId), "head").observations).toEqual([]);
  } finally {
    db.close();
  }
});

test("review diagnostics preserve failed baseline preparation and aggregate reason", () => {
  const { db, ticketId } = makeTestDb();
  try {
    insertSignal(db, {
      ticketId,
      signalType: "integration",
      result: "fail",
      branchHeadSha: "candidate-sha",
      detail: {
        advisory: true,
        reason: "delivered-test-does-not-bind",
        component: "api",
        changed: ["test.py"],
        ran: [{ label: "api:test", exitCode: 1, observation: failing }],
        baseline: {
          version: 1,
          requestedSha: "base-sha",
          comparison: "unqualified",
          reason: "checkout unavailable",
          execution: null,
        },
        notExecuted: ["api:build"],
      },
    });
    const d = suiteDiagnostics(listByTicket(db, ticketId), "candidate-sha").observations[0];
    expect(d.baseline).toEqual({
      requestedSha: "base-sha",
      comparison: "unqualified",
      reason: "checkout unavailable",
      execution: null,
    });
    expect(d.aggregateReason).toBe("delivered-test-does-not-bind");
    expect(d.jobs[0].execution?.stdout).toContain("assertion on stdout");
    expect(d.notExecuted).toEqual(["api:build"]);
  } finally {
    db.close();
  }
});

test("bounded diagnostics retain a fresh failure for a previously seen scope", () => {
  const { db, ticketId } = makeTestDb();
  try {
    const units = Array.from({ length: 9 }, (_, i) =>
      insertWorkUnit(db, { ticketId, seq: i + 1, kind: "backend" }),
    );
    for (const workUnitId of [...units.map((u) => u.id), units[0].id])
      insertSignal(db, {
        ticketId,
        workUnitId,
        signalType: "test",
        result: "fail",
        detail: { advisory: true, ran: [{ component: "api", observation: failing }] },
      });
    const rows = listByTicket(db, ticketId);
    const d = suiteDiagnostics(rows, "candidate-sha");
    expect(d.omittedSignals).toBe(1);
    expect(d.observations).toHaveLength(8);
    expect(d.observations.at(-1)?.signalId).toBe(rows.at(-1)?.id);
    expect(d.observations.at(-1)?.workUnitId).toBe(units[0].id);
  } finally {
    db.close();
  }
});

test("diagnostics expose malformed and partially missing execution evidence", () => {
  const { db, ticketId } = makeTestDb();
  try {
    const insert = (observations: unknown[]) =>
      insertSignal(db, {
        ticketId,
        signalType: "integration",
        result: "fail",
        detail: {
          advisory: true,
          ran: observations.map((observation) => ({ label: "api:test", observation })),
        },
      });
    insert([{ version: 99 }]);
    let d = suiteDiagnostics(listByTicket(db, ticketId), null).observations[0];
    expect(d.jobs[0].execution).toBeNull();
    expect(d.evidenceMissing).toBe(true);
    expect(d.jobsMissingEvidence).toBe(1);
    insert([failing, { version: 99 }]);
    d = suiteDiagnostics(listByTicket(db, ticketId), null).observations[0];
    expect(d.evidenceMissing).toBe(false);
    expect(d.jobsMissingEvidence).toBe(1);
    // Valid evidence outside the bounded visible jobs must not hide missing visible evidence.
    insert([failing, {}, {}, {}, {}]);
    d = suiteDiagnostics(listByTicket(db, ticketId), null).observations[0];
    expect(d.evidenceMissing).toBe(true);
    expect(d.jobsMissingEvidence).toBe(4);
    expect(d.omittedJobs).toBe(1);
  } finally {
    db.close();
  }
});
