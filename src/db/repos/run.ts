import type { Database } from "bun:sqlite";

export interface RunRow {
  id: number;
  run_id: string;
  started_at: string;
  provider: string;
  resumed: number;
  attempt: number;
}

const COLS = "id, run_id, started_at, provider, resumed, attempt";

/** CREATE TABLE IF NOT EXISTS run — mirrors the definition in schema.sql verbatim. This exists
 *  only as the pre-upgrade-park resume bridge: migrate() is replay-once, so a DB bootstrapped
 *  before this table existed never gains it on resume. Keep identical to schema.sql. */
export function ensureRunTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS run (
       id          INTEGER PRIMARY KEY,
       run_id      TEXT    NOT NULL,
       started_at  TEXT    NOT NULL,
       provider    TEXT    NOT NULL,
       resumed     INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
       attempt     INTEGER NOT NULL DEFAULT 1
     )`,
  );
}

/** The single run row for this DB (there is exactly one per ephemeral run DB), or null. */
export function getRun(db: Database): RunRow | null {
  return db.query<RunRow, []>(`SELECT ${COLS} FROM run ORDER BY id LIMIT 1`).get() ?? null;
}

export function insertRun(
  db: Database,
  p: { runId: string; startedAt: string; provider: string },
): RunRow {
  db.query("INSERT INTO run (run_id, started_at, provider) VALUES ($rid, $started, $prov)").run({
    $rid: p.runId,
    $started: p.startedAt,
    $prov: p.provider,
  });
  const created = getRun(db);
  if (!created) throw new Error("insertRun: row missing after insert");
  return created;
}

/** Mark the run as resumed and bump its attempt counter (same logical run, new attempt). */
export function markResumed(db: Database): void {
  db.query("UPDATE run SET resumed = 1, attempt = attempt + 1").run();
}
