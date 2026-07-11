import { expect, test } from "bun:test";
import {
  getById,
  insertPending,
  markFailed,
  markSucceeded,
} from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

test("markSucceeded clears a prior error_json (no stale carry after a success)", () => {
  const { db, ticketId } = makeTestDb();
  const step = insertPending(db, {
    ticketId,
    workUnitId: null,
    stepKey: "design:extract",
    stepType: "dispatch",
    input: null,
  });
  markFailed(db, step.id, new Error("design:extract completeness failed: unit seq 3 no files"));
  expect(getById(db, step.id)?.error_json).not.toBeNull();
  markSucceeded(db, step.id, { units: 2 });
  expect(getById(db, step.id)?.error_json).toBeNull(); // cleared
});
