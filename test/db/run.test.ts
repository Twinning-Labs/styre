import { describe, expect, test } from "bun:test";
import { getRun, markResumed } from "../../src/db/repos/run.ts";
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
});
