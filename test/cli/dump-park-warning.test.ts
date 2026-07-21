import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priorRunIdAt } from "../../src/cli/park.ts";
import { ensureRunTable, insertRun } from "../../src/db/repos/run.ts";

function dbWithRun(runId: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "dp-")), "run.db");
  const db = new Database(path);
  ensureRunTable(db);
  insertRun(db, { runId, startedAt: "2026-07-21T00:00:00.000Z", provider: "claude" });
  db.close();
  return path;
}

describe("priorRunIdAt", () => {
  test("returns the run_id of an existing dump", () => {
    expect(priorRunIdAt(dbWithRun("run-A"))).toBe("run-A");
  });
  test("returns null for a missing file", () => {
    expect(priorRunIdAt(join(tmpdir(), "does-not-exist.db"))).toBeNull();
  });
  test("returns null for a pre-upgrade dump with no run table", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dp-")), "run.db");
    const db = new Database(path);
    db.exec("CREATE TABLE ticket (id INTEGER PRIMARY KEY);"); // no run table
    db.close();
    expect(priorRunIdAt(path)).toBeNull();
  });
});
