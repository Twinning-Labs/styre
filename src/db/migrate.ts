import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EXIT, StyreError } from "../cli/errors.ts";
import { nowUtc } from "../util/time.ts";
import { openDb } from "./client.ts";
import { detectShape } from "./known-shapes.ts";
import { CURRENT_VERSION, MIGRATIONS, OLDEST_MIGRATABLE_VERSION } from "./migrations/index.ts";
import type { Migration } from "./migrations/types.ts";
import { readCopyOf } from "./read-copy.ts";
import { describeSchema, diffShapes } from "./schema-shape.ts";
import schemaSql from "./schema.sql" with { type: "text" };

export interface MigrateResult {
  version: number;
  created: boolean;
  /** The version the database had before this call upgraded it, or null when nothing ran. */
  migratedFrom: number | null;
  backupPath: string | null;
}

export interface MigrateOptions {
  /** Human lines (the backup path, the upgrade). `run` sends them to stderr. */
  log?: (line: string) => void;
  now?: () => Date;
  /** Tests only: run this list instead of MIGRATIONS. */
  migrations?: readonly Migration[];
}

function readVersion(db: Database): number | null {
  try {
    const row = db
      .query<{ version: number }, []>(
        "SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1",
      )
      .get();
    return row ? row.version : null;
  } catch (err) {
    // Only a database without the table is "not created yet". A busy, damaged or odd one surfaces
    // as it is: refusing it as an unknown shape would tell the operator to discard a valid run.
    if (/no such table: schema_meta/.test(String(err))) return null;
    throw err;
  }
}

function hasTables(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== null;
}

/** `<db>.v<old>.<UTC timestamp with milliseconds>.bak`, next to the database (spec §7.1). */
export function backupPathFor(path: string, version: number, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(".", "");
  return `${path}.v${version}.${stamp}.bak`;
}

function refused(headline: string, recovery: string): StyreError {
  return new StyreError({ code: EXIT.RESUME_REFUSED, headline, recovery });
}

/** Differences between `db` and a fresh database built from schema.sql (spec §7.3). */
export function proveSchema(db: Database): string[] {
  const fresh = new Database(":memory:");
  try {
    fresh.exec(schemaSql);
    return diffShapes(describeSchema(fresh), describeSchema(db));
  } finally {
    fresh.close();
  }
}

/** Runs each pending migration in its own immediate transaction. `prove` runs inside the
 *  transaction of the migration that reaches CURRENT_VERSION, before it commits (spec §7.1,
 *  §7.3): a difference rolls that migration back like any other failure. */
function applyMigrations(
  db: Database,
  from: number,
  migrations: readonly Migration[],
  prove: (db: Database) => void,
): number {
  const pending = migrations.filter((m) => m.version > from);
  pending.forEach((m, i) => {
    if (m.version !== from + 1 + i)
      throw new Error(
        `migrate: migrations are not contiguous: expected v${from + 1 + i}, found v${m.version}`,
      );
  });
  // Inside a transaction the pragma is a silent no op, so it is set before the first BEGIN.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    for (const m of pending) {
      db.transaction(() => {
        m.up(db);
        db.query("INSERT INTO schema_meta (version, applied_at, note) VALUES (?, ?, ?)").run(
          m.version,
          nowUtc(),
          m.note,
        );
        const violations = db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
        if (violations.length > 0)
          throw new Error(
            `migrate: v${m.version} left ${violations.length} foreign key violation(s); first: ${JSON.stringify(violations[0])}`,
          );
        if (m.version === CURRENT_VERSION) prove(db);
      }).immediate();
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return pending.at(-1)?.version ?? from;
}

/** What migrate() would do with a database, decided by reading it only (spec §7.1). */
export type DatabaseState =
  | { kind: "empty" }
  | { kind: "current"; version: number }
  | { kind: "upgrade"; version: number }
  | { kind: "refuse"; version: number | null; error: StyreError };

/** The same refusals reach `styre migrate --db <path>`, whose database may be no run's checkpoint. */
const NOT_A_RUN =
  " For a database given to styre migrate that is no run's checkpoint: remove it, and styre migrate creates a new one.";

/** No schema_meta and no tables: empty. Current: nothing to do. Newer, older than v7, or a shape
 *  this binary does not know: refuse (exit 65). Otherwise an upgrade. Writes nothing. */
export function classifyDatabase(db: Database, path: string): DatabaseState {
  const existing = readVersion(db);
  if (existing === null) {
    if (!hasTables(db)) return { kind: "empty" };
    return {
      kind: "refuse",
      version: null,
      error: refused(
        `migrate: ${path} has tables but no schema_meta, a shape this Styre does not know`,
        `Start that run over: styre run <ticket> --fresh.${NOT_A_RUN}`,
      ),
    };
  }
  if (existing === CURRENT_VERSION) return { kind: "current", version: existing };
  if (existing > CURRENT_VERSION)
    return {
      kind: "refuse",
      version: existing,
      error: refused(
        `migrate: ${path} is schema v${existing}, newer than this Styre's v${CURRENT_VERSION}`,
        `Use the newer Styre that wrote it, or start that run over: styre run <ticket> --fresh.${NOT_A_RUN}`,
      ),
    };
  if (existing < OLDEST_MIGRATABLE_VERSION)
    return {
      kind: "refuse",
      version: existing,
      error: refused(
        `migrate: ${path} is schema v${existing}; Styre upgrades checkpoints from v${OLDEST_MIGRATABLE_VERSION} on`,
        `Start that run over: styre run <ticket> --fresh.${NOT_A_RUN}`,
      ),
    };
  if (detectShape(db, existing) === null)
    return {
      kind: "refuse",
      version: existing,
      error: refused(
        `migrate: ${path} is schema v${existing} but has a shape this Styre does not know`,
        `Start that run over: styre run <ticket> --fresh.${NOT_A_RUN}`,
      ),
    };
  return { kind: "upgrade", version: existing };
}

/** classifyDatabase on a private copy (`readCopyOf`): the database itself is never opened, so
 *  nothing beside it changes and no backup is made. For `--inspect`. */
export function readDatabaseState(path: string): DatabaseState {
  return readCopyOf(path, (db) => {
    return classifyDatabase(db, path);
  });
}

/** Create, or upgrade, the run's database (control-loop §10, spec §7.1). Empty: create from
 *  schema.sql. Current: nothing (a current version was proven before it committed). Refused:
 *  throw the refusal (exit 65). Otherwise back up with VACUUM INTO, run each pending migration in
 *  its own transaction, and prove the result against schema.sql inside the last one's transaction. */
export function migrate(path: string, opts: MigrateOptions = {}): MigrateResult {
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  try {
    const state = classifyDatabase(db, path);
    if (state.kind === "refuse") throw state.error;
    if (state.kind === "empty") {
      db.exec(schemaSql);
      const version = readVersion(db);
      if (version === null) throw new Error("migrate: schema_meta empty after bootstrap");
      return { version, created: true, migratedFrom: null, backupPath: null };
    }
    if (state.kind === "current")
      return { version: state.version, created: false, migratedFrom: null, backupPath: null };
    const existing = state.version;
    const backupPath = backupPathFor(path, existing, opts.now?.() ?? new Date());
    // A file copy misses rows a reader's snapshot pins in the WAL; VACUUM INTO does not.
    db.query("VACUUM INTO ?").run(backupPath);
    opts.log?.(`migrate: backed up ${path} (schema v${existing}) to ${backupPath}`);
    const reached = applyMigrations(db, existing, opts.migrations ?? MIGRATIONS, (inTx) => {
      const diff = proveSchema(inTx);
      if (diff.length > 0)
        throw new Error(
          `migrate: ${path} does not match schema v${CURRENT_VERSION} after migrating:\n${diff.join("\n")}`,
        );
    });
    opts.log?.(`migrate: upgraded ${path} from schema v${existing} to v${reached}`);
    return { version: reached, created: false, migratedFrom: existing, backupPath };
  } finally {
    db.close();
  }
}
