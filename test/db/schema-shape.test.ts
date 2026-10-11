import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeSchema, diffShapes, stripSqlComments } from "../../src/db/schema-shape.ts";
import { CHECK_PROBES_V9, SEED_ROWS_V9, probeChecks } from "../helpers/check-probes.ts";

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
  expect(CHECK_PROBES_V9.length).toBe(checks);
  expect(probeChecks(fresh(), SEED_ROWS_V9, CHECK_PROBES_V9)).toEqual([]);
});

/** The differences diffShapes reports between two databases built from `a` and `b`. */
function diffOf(a: string, b: string): string {
  const da = new Database(":memory:");
  const db = new Database(":memory:");
  try {
    da.exec(a);
    db.exec(b);
    return diffShapes(describeSchema(da), describeSchema(db)).join("\n");
  } finally {
    da.close();
    db.close();
  }
}

const PARENT = "CREATE TABLE p (id INTEGER PRIMARY KEY);";

test("a REFERENCES clause is compared", () => {
  expect(
    diffOf(
      `${PARENT} CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))`,
      `${PARENT} CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER)`,
    ),
  ).toContain("table c: foreignKeys differ");
});

test("a foreign key's ON DELETE is compared", () => {
  expect(
    diffOf(
      `${PARENT} CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE CASCADE)`,
      `${PARENT} CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))`,
    ),
  ).toContain("table c: foreignKeys differ");
});

test("a view's body is compared", () => {
  expect(
    diffOf(
      "CREATE TABLE t (k TEXT, j TEXT); CREATE VIEW v AS SELECT k FROM t",
      "CREATE TABLE t (k TEXT, j TEXT); CREATE VIEW v AS SELECT j FROM t",
    ),
  ).toContain("views v:");
});

test("a trigger's body is compared", () => {
  expect(
    diffOf(
      "CREATE TABLE t (k TEXT); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
      "CREATE TABLE t (k TEXT); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 2; END",
    ),
  ).toContain("triggers tr:");
});

test("a unique index differs from a plain one on the same column", () => {
  expect(
    diffOf(
      "CREATE TABLE t (k TEXT); CREATE UNIQUE INDEX i ON t (k)",
      "CREATE TABLE t (k TEXT); CREATE INDEX i ON t (k)",
    ),
  ).toContain("table t: indexes differ");
});

test("an index on a different column is a difference", () => {
  expect(
    diffOf(
      "CREATE TABLE t (k TEXT, j TEXT); CREATE INDEX i ON t (k)",
      "CREATE TABLE t (k TEXT, j TEXT); CREATE INDEX i ON t (j)",
    ),
  ).toContain("table t: indexes differ");
});
