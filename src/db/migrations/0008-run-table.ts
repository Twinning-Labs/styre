import type { Database } from "bun:sqlite";
import { rebuildTable } from "./rebuild.ts";
import type { Migration } from "./types.ts";

/** `run` exactly as schema.sql v8 declares it (ENG-349). */
export const RUN_TABLE_V8_DDL = `CREATE TABLE run (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT    NOT NULL,
    started_at  TEXT    NOT NULL,
    provider    TEXT    NOT NULL,
    resumed     INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
    attempt     INTEGER NOT NULL DEFAULT 1
)`;

/** `signal` exactly as schema.sql v8 declares it, without the v0.8.0 to v0.9.0 wait budget columns.
 *  Exported for the rebuild helper's test. */
export const SIGNAL_V8_DDL = `CREATE TABLE signal (
    id              INTEGER PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    signal_type     TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending','delivered','consumed')),
    reason          TEXT,
    payload_json    TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    idempotency_key TEXT,
    requested_at    TEXT NOT NULL,
    delivered_at    TEXT,
    consumed_at     TEXT
)`;
export const SIGNAL_V8_COLUMNS: readonly string[] = [
  "id",
  "ticket_id",
  "signal_type",
  "status",
  "reason",
  "payload_json",
  "idempotency_key",
  "requested_at",
  "delivered_at",
  "consumed_at",
];
export const SIGNAL_V8_INDEXES: readonly string[] = [
  "CREATE UNIQUE INDEX idx_signal_idempotency ON signal (idempotency_key) WHERE idempotency_key IS NOT NULL",
  "CREATE INDEX idx_signal_pending ON signal (ticket_id, status)",
];

function columns(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
    .all()
    .map((c) => c.name);
}

/** v7 → v8 (spec §7.4). Each condition is handled on its own, because a v7 checkpoint resumed on
 *  v0.11+ was bridged by ensureRunTable without a version bump: rebuild `signal` when the wait
 *  budget columns (v0.8.0 to v0.9.0) are present; create `run` when it is absent. */
export const migration0008: Migration = {
  version: 8,
  note: "v8: add run table for telemetry run identity (ENG-349); drop the signal wait budget columns",
  up(db) {
    if (columns(db, "signal").includes("attempts")) {
      rebuildTable(db, {
        table: "signal",
        createSql: SIGNAL_V8_DDL,
        columns: SIGNAL_V8_COLUMNS,
        indexes: SIGNAL_V8_INDEXES,
      });
    }
    if (columns(db, "run").length === 0) db.exec(RUN_TABLE_V8_DDL);
  },
};
