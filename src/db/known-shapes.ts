import { Database } from "bun:sqlite";
import { RUN_TABLE_V8_DDL } from "./migrations/0008-run-table.ts";
import v7SignalBudgetSql from "./migrations/shapes/v7-signal-budget.sql" with { type: "text" };
import v7Sql from "./migrations/shapes/v7.sql" with { type: "text" };
import v8Sql from "./migrations/shapes/v8.sql" with { type: "text" };
import { type SchemaShape, describeSchema, diffShapes } from "./schema-shape.ts";

/** The released shapes this binary upgrades (spec §7.4), each detected by structure, never by the
 *  version number alone. `+run` is a v7 checkpoint bridged by ensureRunTable on v0.11+. */
export type KnownShape = "v7-signal-budget" | "v7-signal-budget+run" | "v7" | "v7+run" | "v8";

interface Known {
  name: KnownShape;
  version: number;
  shape: SchemaShape;
}

function shapeOf(sql: string, extra?: string): SchemaShape {
  const db = new Database(":memory:");
  try {
    db.exec(sql);
    if (extra) db.exec(extra);
    return describeSchema(db);
  } finally {
    db.close();
  }
}

let known: Known[] | null = null;
function knownShapes(): Known[] {
  known ??= [
    { name: "v7-signal-budget", version: 7, shape: shapeOf(v7SignalBudgetSql) },
    {
      name: "v7-signal-budget+run",
      version: 7,
      shape: shapeOf(v7SignalBudgetSql, RUN_TABLE_V8_DDL),
    },
    { name: "v7", version: 7, shape: shapeOf(v7Sql) },
    { name: "v7+run", version: 7, shape: shapeOf(v7Sql, RUN_TABLE_V8_DDL) },
    { name: "v8", version: 8, shape: shapeOf(v8Sql) },
  ];
  return known;
}

export function detectShape(db: Database, version: number): KnownShape | null {
  const actual = describeSchema(db);
  for (const k of knownShapes()) {
    if (k.version === version && diffShapes(k.shape, actual).length === 0) return k.name;
  }
  return null;
}
