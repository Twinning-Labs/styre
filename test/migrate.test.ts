import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.ts";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "styre-mig-")), "styre.db");
}

const CORE_TABLES = [
  "schema_meta",
  "project",
  "ticket",
  "work_unit",
  "workflow_step",
  "signal",
  "dispatch",
  "event_log",
  "metric_event",
  "ground_truth_signal",
  "review_finding",
  "acceptance_criterion",
  "ac_check",
  "external_id_cache",
  "projection_state",
  "projection_outbox",
];

describe("migrate", () => {
  test("bootstraps a fresh DB at schema v7", () => {
    const result = migrate(tmpDbPath());
    expect(result.created).toBe(true);
    expect(result.version).toBe(7);
  });

  test("creates the core SoT tables", () => {
    const path = tmpDbPath();
    migrate(path);
    const db = new Database(path, { readonly: true });
    const names = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    db.close();
    for (const t of CORE_TABLES) {
      expect(names).toContain(t);
    }
  });

  test("is idempotent — a second run is a no-op, version unchanged", () => {
    const path = tmpDbPath();
    migrate(path);
    const second = migrate(path);
    expect(second.created).toBe(false);
    expect(second.version).toBe(7);
  });
});
