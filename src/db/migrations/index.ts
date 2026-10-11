import schemaSql from "../schema.sql" with { type: "text" };
import { migration0008 } from "./0008-run-table.ts";
import { migration0009 } from "./0009-design-inputs.ts";
import type { Migration } from "./types.ts";

/** In order; each produces the version after the previous one. */
export const MIGRATIONS: readonly Migration[] = [migration0008, migration0009];

/** v6 → v7 renamed columns; those checkpoints already could not resume (spec §7.4). */
export const OLDEST_MIGRATABLE_VERSION = 7;

/** The version a fresh database gets from schema.sql. */
export const CURRENT_VERSION: number = (() => {
  const m = schemaSql.match(/INSERT INTO schema_meta[\s\S]*?VALUES \((\d+),/);
  if (!m) throw new Error("schema.sql: no schema_meta seed row");
  return Number(m[1]);
})();

if (MIGRATIONS.at(-1)?.version !== CURRENT_VERSION) {
  throw new Error(
    `migrations end at v${MIGRATIONS.at(-1)?.version} but schema.sql seeds v${CURRENT_VERSION}`,
  );
}
