import type { Database } from "bun:sqlite";

/** One schema step. `migrate()` runs `up` inside its own immediate transaction with foreign keys
 *  off, inserts the `schema_meta` row and runs `PRAGMA foreign_key_check` (spec §7.1). */
export interface Migration {
  /** The version this migration produces. */
  version: number;
  note: string;
  up(db: Database): void;
}
