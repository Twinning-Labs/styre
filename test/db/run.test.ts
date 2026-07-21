import { describe, expect, test } from "bun:test";
import { ensureRunTable, getRun, insertRun, markResumed } from "../../src/db/repos/run.ts";
import { makeTestDb } from "../helpers/db.ts";

describe("run repo", () => {
  test("insertRun + getRun roundtrip", () => {
    const { db } = makeTestDb();
    // makeTestDb already seeds a run row (Step 7); read it back.
    const seeded = getRun(db);
    expect(seeded).not.toBeNull();
    expect(typeof seeded?.run_id).toBe("string");
    expect(seeded?.attempt).toBe(1);
    expect(seeded?.resumed).toBe(0);
    db.close();
  });

  test("markResumed sets resumed and bumps attempt", () => {
    const { db } = makeTestDb();
    markResumed(db);
    const r = getRun(db);
    expect(r).not.toBeNull();
    expect(r?.resumed).toBe(1);
    expect(r?.attempt).toBe(2);
    db.close();
  });

  test("ensureRunTable creates the table when missing (pre-upgrade park bridge)", () => {
    const { db } = makeTestDb();
    db.exec("DROP TABLE run;"); // simulate a pre-upgrade DB
    expect(() => getRun(db)).toThrow(); // no table
    ensureRunTable(db);
    expect(getRun(db)).toBeNull(); // table exists, no row yet
    insertRun(db, {
      runId: "backfill-id",
      startedAt: "2026-07-21T00:00:00.000Z",
      provider: "claude",
    });
    expect(getRun(db)?.run_id).toBe("backfill-id");
    db.close();
  });
});
