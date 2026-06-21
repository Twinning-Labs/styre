import { expect, test } from "bun:test";
import { getById, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../helpers/db.ts";

test("insertWorkUnit persists title, description, and test_plan", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    title: "Add the widget",
    description: "Wire the widget into the registry",
    testPlan: "unit test the registry wiring",
    behavioral: 1,
  });
  const read = getById(db, u.id);
  db.close();
  expect(read?.title).toBe("Add the widget");
  expect(read?.description).toBe("Wire the widget into the registry");
  expect(read?.test_plan).toBe("unit test the registry wiring");
});

test("insertWorkUnit defaults the new text columns to null", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  const read = getById(db, u.id);
  db.close();
  expect(read?.title).toBeNull();
  expect(read?.description).toBeNull();
  expect(read?.test_plan).toBeNull();
});
