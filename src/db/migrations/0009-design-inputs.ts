// src/db/migrations/0009-design-inputs.ts
import type { Migration } from "./types.ts";

// Each statement is the exact column or table text schema.sql v9 declares, so the structural proof
// compares equal. Added columns land last, in this order (spec §7.3).
export const TICKET_INPUT_DDL = `CREATE TABLE ticket_input (
    ticket_id   INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    value_json  TEXT    NOT NULL CHECK (json_valid(value_json)),
    digest      TEXT    NOT NULL,
    captured_at TEXT    NOT NULL,
    PRIMARY KEY (ticket_id, name)
)`;

export const STEP_HISTORY_DDL = `CREATE TABLE workflow_step_history (
    id                 INTEGER PRIMARY KEY,
    step_id            INTEGER NOT NULL REFERENCES workflow_step(id) ON DELETE CASCADE,
    ticket_id          INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    event_id           INTEGER NOT NULL REFERENCES event_log(id) ON DELETE CASCADE,
    step_key           TEXT    NOT NULL,
    status             TEXT    NOT NULL,
    attempt            INTEGER NOT NULL,
    result_json        TEXT,
    error_json         TEXT,
    input_manifest     TEXT,
    input_fingerprint  TEXT,
    output_digest      TEXT,
    fingerprint_scheme INTEGER,
    generation         INTEGER NOT NULL,
    started_at         TEXT,
    ended_at           TEXT,
    archived_at        TEXT    NOT NULL
)`;
export const STEP_HISTORY_INDEX =
  "CREATE INDEX idx_step_history_step ON workflow_step_history (step_id, generation)";

/** v8 → v9 (ENG-477, spec §7.4): only added columns and new tables; event_log is not rebuilt. */
export const migration0009: Migration = {
  version: 9,
  note: "v9: design input fingerprints, work_unit.origin, ticket_input, workflow_step_history (ENG-477)",
  up(db) {
    db.exec(
      "ALTER TABLE workflow_step ADD COLUMN input_manifest TEXT CHECK (input_manifest IS NULL OR json_valid(input_manifest))",
    );
    db.exec("ALTER TABLE workflow_step ADD COLUMN input_fingerprint TEXT");
    db.exec("ALTER TABLE workflow_step ADD COLUMN output_digest TEXT");
    db.exec("ALTER TABLE workflow_step ADD COLUMN fingerprint_scheme INTEGER");
    db.exec("ALTER TABLE workflow_step ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    db.exec(
      "ALTER TABLE work_unit ADD COLUMN origin TEXT NOT NULL DEFAULT 'extract' CHECK (origin IN ('extract','reconcile'))",
    );
    // The integration failure path (failure-policy.ts) is the only writer of kind 'reconcile'.
    db.exec("UPDATE work_unit SET origin = 'reconcile' WHERE kind = 'reconcile'");
    db.exec(TICKET_INPUT_DDL);
    db.exec(STEP_HISTORY_DDL);
    db.exec(STEP_HISTORY_INDEX);
  },
};
