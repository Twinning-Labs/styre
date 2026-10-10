import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeSchema, diffShapes, stripSqlComments } from "../../src/db/schema-shape.ts";
import { CHECK_PROBES_V8, SEED_ROWS_V8, probeChecks } from "../helpers/check-probes.ts";

const SCHEMA = readFileSync(join(import.meta.dir, "../../src/db/schema.sql"), "utf8");
const fresh = () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
};

test("comments and whitespace do not change the shape", () => {
  const a = fresh();
  const b = new Database(":memory:");
  b.exec(stripSqlComments(SCHEMA).replace(/\s+/g, " "));
  expect(diffShapes(describeSchema(a), describeSchema(b))).toEqual([]);
});

test("a column added in the middle of the table is a difference (column order is structure)", () => {
  const a = new Database(":memory:");
  a.exec("CREATE TABLE t (a INTEGER, b TEXT, c TEXT)");
  const b = new Database(":memory:");
  b.exec("CREATE TABLE t (a INTEGER, c TEXT)");
  b.exec("ALTER TABLE t ADD COLUMN b TEXT");
  expect(diffShapes(describeSchema(a), describeSchema(b)).join("\n")).toContain("columns differ");
});

test("AUTOINCREMENT is compared even though the pragmas cannot see it", () => {
  const a = new Database(":memory:");
  a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT)");
  const b = new Database(":memory:");
  b.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
  expect(diffShapes(describeSchema(a), describeSchema(b)).join("\n")).toContain("AUTOINCREMENT");
});

test("a partial index's WHERE text is compared", () => {
  const a = new Database(":memory:");
  a.exec("CREATE TABLE t (k TEXT); CREATE INDEX i ON t (k) WHERE k IS NOT NULL");
  const b = new Database(":memory:");
  b.exec("CREATE TABLE t (k TEXT); CREATE INDEX i ON t (k) WHERE k <> ''");
  expect(diffShapes(describeSchema(a), describeSchema(b)).join("\n")).toContain("indexes differ");
});

test("every CHECK in schema.sql has a probe, and the fresh schema rejects each", () => {
  const checks = (stripSqlComments(SCHEMA).match(/\bCHECK\s*\(/g) ?? []).length;
  expect(CHECK_PROBES_V8.length).toBe(checks);
  expect(probeChecks(fresh(), SEED_ROWS_V8, CHECK_PROBES_V8)).toEqual([]);
});
