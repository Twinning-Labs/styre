import { afterEach, expect, test } from "bun:test";
import { setCurrentStep } from "../../src/daemon/current-step.ts";
import { DESIGN_TABLE, type StepRow } from "../../src/daemon/design-graph.ts";
import { UndeclaredReadError, readWorkUnitsForDesign } from "../../src/daemon/design-reads.ts";
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
