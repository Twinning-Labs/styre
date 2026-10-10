import { afterEach, expect, test } from "bun:test";
import { currentStepKey, setCurrentStep } from "../../src/daemon/current-step.ts";
import { DESIGN_TABLE, type StepRow } from "../../src/daemon/design-graph.ts";
import { UndeclaredReadError, readWorkUnitsForDesign } from "../../src/daemon/design-reads.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { InvariantViolation } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

afterEach(() => setCurrentStep(null));

test("an accessor answers the step that declares the read", () => {
  const { db, ticketId } = makeTestDb();
  for (const key of ["design:size", "design:review"]) {
    setCurrentStep(key);
    expect(readWorkUnitsForDesign(db, ticketId)).toEqual([]);
    setCurrentStep(null);
  }
  db.close();
});

test(
  "the accessor returns the units design:extract wrote for this ticket, in seq order",
  async () => {
    const t = makeDesignTicket(); // the default script extracts two units
    await driveUntil(t, atStep("design:size"));
    setCurrentStep("design:size");
    const units = readWorkUnitsForDesign(t.db, t.ticketId);
    expect(units.map((u) => [u.seq, u.title, u.origin])).toEqual([
      [1, "Unit 1", "extract"],
      [2, "Unit 2", "extract"],
    ]);
    expect(units.every((u) => u.ticket_id === t.ticketId)).toBe(true);
  },
  STEP_TEST_TIMEOUT_MS,
);

test("an accessor called while another step is current throws (§8.10)", () => {
  const { db, ticketId } = makeTestDb();
  setCurrentStep("design:dispatch");
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow(UndeclaredReadError);
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow(
    "design:dispatch reads workUnits, which the design table does not declare for it",
  );
  setCurrentStep(null);
  setCurrentStep("checks:dispatch"); // outside the table: reads the repositories directly instead
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow(UndeclaredReadError);
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow("checks:dispatch reads workUnits");
  setCurrentStep(null);
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow(UndeclaredReadError);
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow("no step in flight reads workUnits");
  db.close();
});

// The accessor checks a read against the inputs a row declares under any grading value, since it
// does not know the run's config. That is exact only while every step that reads workUnits declares
// it under both values; this pins it, so a table change that makes it depend on grading fails here.
test("each step declares workUnits under both grading values or under neither", () => {
  const steps = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");
  const readers = steps.filter((r) =>
    [false, true].some((g) => r.inputs({ complexityGrading: g }).includes("workUnits")),
  );
  expect(readers.map((r) => r.stepKey)).toEqual(["design:size", "design:review"]);
  for (const r of readers) {
    expect(
      [false, true].map((g) => r.inputs({ complexityGrading: g }).includes("workUnits")),
    ).toEqual([true, true]);
  }
});

// The units digest (digestWorkUnits) covers only origin `extract` units, so a design step that saw a
// reconcile unit would read something its manifest never records. No path puts one in front of a
// design step today; the accessor makes that hold by construction.
test(
  "the accessor refuses when a unit is not design:extract's, naming the step and the unit",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("design:size"));
    // Stated exception (no faked state): only the integration failure path in verify writes a
    // reconcile unit, which no design step can reach, so it is inserted through the public
    // insertWorkUnit, as that path does.
    insertWorkUnit(t.db, { ticketId: t.ticketId, seq: 3, kind: "reconcile", origin: "reconcile" });
    setCurrentStep("design:size");
    expect(() => readWorkUnitsForDesign(t.db, t.ticketId)).toThrow(InvariantViolation);
    expect(() => readWorkUnitsForDesign(t.db, t.ticketId)).toThrow(
      "design:size reads workUnits, but unit 3 has origin reconcile",
    );
  },
  STEP_TEST_TIMEOUT_MS,
);

test("the slot refuses a second step while one is in flight, and names both", () => {
  setCurrentStep("design:size");
  expect(() => setCurrentStep("design:review")).toThrow(InvariantViolation);
  expect(() => setCurrentStep("design:review")).toThrow(
    "design:review cannot start while design:size is in flight",
  );
  expect(currentStepKey()).toBe("design:size"); // the step in flight keeps the slot
  setCurrentStep(null);
  setCurrentStep("design:review");
  expect(currentStepKey()).toBe("design:review");
});
