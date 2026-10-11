import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.ts";
import { CURRENT_VERSION } from "../src/db/migrations/index.ts";
import { readCopyOf } from "../src/db/read-copy.ts";
import { makeTempDir } from "./helpers/temp.ts";

function tmpDbPath(): string {
  return join(makeTempDir("styre-mig-"), "styre.db");
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
  "run",
  "ticket_input",
  "workflow_step_history",
];

describe("migrate", () => {
  test("bootstraps a fresh DB at the current schema version", () => {
    const result = migrate(tmpDbPath());
    expect(result.created).toBe(true);
    expect(result.version).toBe(CURRENT_VERSION);
  });

  test("creates the core SoT tables", () => {
    const path = tmpDbPath();
    migrate(path);
    const names = readCopyOf(path, (db) =>
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
    for (const t of CORE_TABLES) {
      expect(names).toContain(t);
    }
  });

  test("is idempotent — a second run is a no-op, version unchanged", () => {
    const path = tmpDbPath();
    migrate(path);
    const second = migrate(path);
    expect(second.created).toBe(false);
    expect(second.version).toBe(CURRENT_VERSION);
  });
});
