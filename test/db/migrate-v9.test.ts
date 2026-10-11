// test/db/migrate-v9.test.ts
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.ts";
import { CURRENT_VERSION } from "../../src/db/migrations/index.ts";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { insertWorkUnit, listByTicket } from "../../src/db/repos/work-unit.ts";
import { listByStatus } from "../../src/db/repos/workflow-step.ts";
import { MIGRATABLE_FIXTURES, copyFixture } from "../helpers/db-fixtures.ts";
import { makeTestDb } from "../helpers/db.ts";
import { makeTempDir } from "../helpers/temp.ts";

test("the current version is 9", () => {
  expect(CURRENT_VERSION).toBe(9);
});

for (const name of MIGRATABLE_FIXTURES) {
  test(`${name}: origin is backfilled from kind = 'reconcile', manifests are empty, generation 0`, () => {
    const path = copyFixture(name);
    migrate(path);
    readCopyOf(path, (db) => {
      const units = db
        .query<{ kind: string; origin: string }, []>(
          "SELECT kind, origin FROM work_unit ORDER BY seq",
        )
        .all();
      expect(units).toEqual([
        { kind: "backend", origin: "extract" },
        { kind: "reconcile", origin: "reconcile" },
      ]);
      const steps = db
        .query<{ m: string | null; g: number }, []>(
          "SELECT input_manifest AS m, generation AS g FROM workflow_step",
        )
        .all();
      expect(steps.every((s) => s.m === null && s.g === 0)).toBe(true);
      expect(db.query("SELECT COUNT(*) AS n FROM ticket_input").get()).toEqual({ n: 0 });
      expect(db.query("SELECT COUNT(*) AS n FROM workflow_step_history").get()).toEqual({ n: 0 });
    });
  });
}

test("insertWorkUnit records origin, defaulting to extract", () => {
  const { db, ticketId } = makeTestDb();
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  insertWorkUnit(db, { ticketId, seq: 2, kind: "reconcile", origin: "reconcile" });
  expect(listByTicket(db, ticketId).map((u) => u.origin)).toEqual(["extract", "reconcile"]);
  db.close();
});

/** What 0009 adds, read through the pragmas: `cid|name|type|notnull|default|pk` per column, the
 *  foreign keys and the indexes. Written out from the ENG-477 plan, not read back from schema.sql:
 *  the structural proof compares the migrated database with schema.sql, so a mistake made in both
 *  would pass it; this pins the declared values themselves. */
function additions(db: Database) {
  const cols = (t: string) =>
    db
      .query<Record<string, unknown>, []>(`PRAGMA table_xinfo('${t}')`)
      .all()
      .map((c) => `${c.cid}|${c.name}|${c.type}|${c.notnull}|${c.dflt_value}|${c.pk}`);
  const fks = (t: string) =>
    db
      .query<Record<string, unknown>, []>(`PRAGMA foreign_key_list('${t}')`)
      .all()
      .map((f) => `${f.from}->${f.table}(${f.to}) on delete ${f.on_delete}`)
      .sort();
  const indexes = (t: string) =>
    db
      .query<{ name: string; unique: number; origin: string }, []>(`PRAGMA index_list('${t}')`)
      .all()
      .map((ix) => {
        const on = db
          .query<{ name: string }, []>(`PRAGMA index_info('${ix.name}')`)
          .all()
          .map((c) => c.name)
          .join(",");
        return `${ix.origin === "c" ? ix.name : `(${ix.origin})`}|unique=${ix.unique}|${on}`;
      })
      .sort();
  const step = cols("workflow_step");
  const unit = cols("work_unit");
  return {
    workflowStepCount: step.length,
    workflowStepLast: step.slice(-5),
    workUnitCount: unit.length,
    workUnitLast: unit.slice(-1),
    ticketInput: {
      columns: cols("ticket_input"),
      fks: fks("ticket_input"),
      indexes: indexes("ticket_input"),
    },
    history: {
      columns: cols("workflow_step_history"),
      fks: fks("workflow_step_history"),
      indexes: indexes("workflow_step_history"),
    },
  };
}

const V9_ADDITIONS = {
  // v8 has 18 workflow_step columns and 15 work_unit columns: the new ones come last.
  workflowStepCount: 23,
  workflowStepLast: [
    "18|input_manifest|TEXT|0|null|0",
    "19|input_fingerprint|TEXT|0|null|0",
    "20|output_digest|TEXT|0|null|0",
    "21|fingerprint_scheme|INTEGER|0|null|0",
    "22|generation|INTEGER|1|0|0",
  ],
  workUnitCount: 16,
  workUnitLast: ["15|origin|TEXT|1|'extract'|0"],
  ticketInput: {
    columns: [
      "0|ticket_id|INTEGER|1|null|1",
      "1|name|TEXT|1|null|2",
      "2|value_json|TEXT|1|null|0",
      "3|digest|TEXT|1|null|0",
      "4|captured_at|TEXT|1|null|0",
    ],
    fks: ["ticket_id->ticket(id) on delete CASCADE"],
    indexes: ["(pk)|unique=1|ticket_id,name"],
  },
  history: {
    columns: [
      "0|id|INTEGER|0|null|1",
      "1|step_id|INTEGER|1|null|0",
      "2|ticket_id|INTEGER|1|null|0",
      "3|event_id|INTEGER|1|null|0",
      "4|step_key|TEXT|1|null|0",
      "5|status|TEXT|1|null|0",
      "6|attempt|INTEGER|1|null|0",
      "7|result_json|TEXT|0|null|0",
      "8|error_json|TEXT|0|null|0",
      "9|input_manifest|TEXT|0|null|0",
      "10|input_fingerprint|TEXT|0|null|0",
      "11|output_digest|TEXT|0|null|0",
      "12|fingerprint_scheme|INTEGER|0|null|0",
      "13|generation|INTEGER|1|null|0",
      "14|started_at|TEXT|0|null|0",
      "15|ended_at|TEXT|0|null|0",
      "16|archived_at|TEXT|1|null|0",
    ],
    fks: [
      "event_id->event_log(id) on delete CASCADE",
      "step_id->workflow_step(id) on delete CASCADE",
      "ticket_id->ticket(id) on delete CASCADE",
    ],
    indexes: ["idx_step_history_step|unique=0|step_id,generation"],
  },
};

test("the v9 additions are as declared, on a new database and on an upgraded one", () => {
  const fresh = join(makeTempDir("styre-v9-additions-"), "run.db");
  migrate(fresh);
  const upgraded = copyFixture("v8-main-2b05680");
  migrate(upgraded);
  expect(readCopyOf(fresh, additions)).toEqual(V9_ADDITIONS);
  expect(readCopyOf(upgraded, additions)).toEqual(V9_ADDITIONS);
});

test("the step repository reads the new columns of an upgraded checkpoint", () => {
  const path = copyFixture("v8-main-2b05680");
  migrate(path);
  const rows = readCopyOf(path, (db) => listByStatus(db, "succeeded"));
  expect(rows.length).toBe(4); // the four succeeded design steps every fixture holds
  expect(
    rows.map((r) => [
      r.input_manifest,
      r.input_fingerprint,
      r.output_digest,
      r.fingerprint_scheme,
      r.generation,
    ]),
  ).toEqual(Array(4).fill([null, null, null, null, 0]));
});
