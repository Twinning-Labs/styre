import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./client.ts";
import schemaSql from "./schema.sql" with { type: "text" };

export interface MigrateResult {
  version: number;
  created: boolean;
}

function readVersion(db: Database): number | null {
  try {
    const row = db
      .query<{ version: number }, []>(
        "SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1",
      )
      .get();
    return row ? row.version : null;
  } catch {
    return null; // schema_meta table absent → fresh DB
  }
}

/** Self-bootstrapping migrate (control-loop §10): create DB + schema if absent; idempotent. */
export function migrate(path: string): MigrateResult {
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  try {
    const existing = readVersion(db);
    if (existing !== null) {
      return { version: existing, created: false };
    }
    db.exec(schemaSql);
    const version = readVersion(db);
    if (version === null) {
      throw new Error("migrate: schema_meta empty after bootstrap");
    }
    return { version, created: true };
  } finally {
    db.close();
  }
}
