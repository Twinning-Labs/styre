import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT, StyreError } from "../../src/cli/errors.ts";
import { migrateImpl } from "../../src/cli/migrate.ts";
import { openDb } from "../../src/db/client.ts";
import { type KnownShape, detectShape } from "../../src/db/known-shapes.ts";
import {
  backupPathFor,
  classifyDatabase,
  migrate,
  readDatabaseState,
} from "../../src/db/migrate.ts";
import {
  SIGNAL_V8_COLUMNS,
  SIGNAL_V8_DDL,
  SIGNAL_V8_INDEXES,
  migration0008,
} from "../../src/db/migrations/0008-run-table.ts";
import { CURRENT_VERSION, MIGRATIONS } from "../../src/db/migrations/index.ts";
import { rebuildTable } from "../../src/db/migrations/rebuild.ts";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { describeSchema, diffShapes } from "../../src/db/schema-shape.ts";
import { CHECK_PROBES_V8, SEED_ROWS_V8, probeChecks } from "../helpers/check-probes.ts";
import {
  type FixtureName,
  MIGRATABLE_FIXTURES,
  copyFixture,
  fixtureVersion,
} from "../helpers/db-fixtures.ts";
import { makeTestDb } from "../helpers/db.ts";
import { makeTempDir } from "../helpers/temp.ts";

function count(path: string, sql: string): number {
  return readCopyOf(path, (db) => {
    return (db.query<{ n: number }, []>(sql).get() as { n: number }).n;
  });
}
function refusalOf(fn: () => unknown): StyreError {
  try {
    fn();
  } catch (err) {
    if (err instanceof StyreError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}
/** The database file and whichever side files sit beside it, byte for byte. */
function filesAt(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ext of ["", "-wal", "-shm", "-journal"]) {
    const f = `${path}${ext}`;
    if (existsSync(f))
      out[ext] = new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex");
  }
  return out;
}

describe("migrate upgrades every known released shape", () => {
  for (const name of MIGRATABLE_FIXTURES) {
    test(`${name} reaches the current version with the structural proof and the CHECK probes`, () => {
      const path = copyFixture(name);
      const before = fixtureVersion(path);
      const steps = count(path, "SELECT COUNT(*) AS n FROM workflow_step");
      const units = count(path, "SELECT COUNT(*) AS n FROM work_unit");
      const logs: string[] = [];
      const r = migrate(path, { log: (l) => logs.push(l) });
      expect(r.version).toBe(CURRENT_VERSION);
      expect(r.migratedFrom).toBe(before === CURRENT_VERSION ? null : before);
      expect(fixtureVersion(path)).toBe(CURRENT_VERSION);
      // rows survive
      expect(count(path, "SELECT COUNT(*) AS n FROM workflow_step")).toBe(steps);
      expect(count(path, "SELECT COUNT(*) AS n FROM work_unit")).toBe(units);
      // the step waiting on a signal still points at a signal that exists
      expect(
        count(
          path,
          "SELECT COUNT(*) AS n FROM workflow_step w JOIN signal s ON s.id = w.await_signal_id",
        ),
      ).toBe(1);
      // structure equals a fresh database, and both reject the same forbidden values
      const db = openDb(path);
      const fresh = new Database(":memory:");
      try {
        fresh.exec(readFileSync(join(import.meta.dir, "../../src/db/schema.sql"), "utf8"));
        expect(diffShapes(describeSchema(fresh), describeSchema(db))).toEqual([]);
        expect(probeChecks(db, SEED_ROWS_V8, CHECK_PROBES_V8)).toEqual([]);
        expect(probeChecks(fresh, SEED_ROWS_V8, CHECK_PROBES_V8)).toEqual([]);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
        fresh.close();
      }
      if (before !== CURRENT_VERSION) {
        expect(r.backupPath).not.toBeNull();
        expect(existsSync(r.backupPath as string)).toBe(true);
        expect(fixtureVersion(r.backupPath as string)).toBe(before);
        expect(logs.join("\n")).toContain(r.backupPath as string);
      }
    });
  }

  test("v7 bridged on the v0.9.0 shape migrates: signal rebuilt, run kept, foreign keys intact", () => {
    const path = copyFixture("v7-v0.9.0-bridged");
    const signals = count(path, "SELECT COUNT(*) AS n FROM signal");
    migrate(path);
    readCopyOf(path, (db) => {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info('signal')")
        .all()
        .map((c) => c.name);
      expect(cols).not.toContain("attempts");
      expect(cols).not.toContain("max_attempts");
      expect(db.query("SELECT COUNT(*) AS n FROM signal").get()).toEqual({ n: signals });
      expect(db.query("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // the view that reads signal was dropped and recreated around the rebuild
      expect(db.query("SELECT COUNT(*) AS n FROM v_ready_tickets").get()).toEqual({ n: 0 });
    });
  });

  test("each fixture is detected as the released shape it was made from", () => {
    const expected: Record<string, KnownShape> = {
      "v7-v0.9.0": "v7-signal-budget",
      "v7-v0.9.0-bridged": "v7-signal-budget+run",
      "v7-v0.10.0": "v7",
      "v7-v0.10.0-bridged": "v7+run",
      "v8-v0.13.2": "v8",
      "v8-main-2b05680": "v8",
    };
    const seen: Record<string, KnownShape | null> = {};
    for (const name of MIGRATABLE_FIXTURES) {
      const path = copyFixture(name);
      const version = fixtureVersion(path);
      seen[name] = readCopyOf(path, (db) => detectShape(db, version));
    }
    expect(seen).toEqual(expected);
  });
});

describe("migrate refuses what it cannot upgrade", () => {
  test("a database newer than this binary is refused, naming both versions", () => {
    const { db } = makeTestDb();
    const path = db.filename;
    // A direct write: no step of this binary can produce a newer schema (stated exception, M18).
    db.query(
      "INSERT INTO schema_meta (version, applied_at, note) VALUES (99, 't', 'future')",
    ).run();
    db.close();
    const e = refusalOf(() => migrate(path));
    expect(e.code).toBe(EXIT.RESUME_REFUSED);
    expect(e.headline).toContain("v99");
    expect(e.headline).toContain(`v${CURRENT_VERSION}`);
  });

  test("a shape this binary does not know is refused with --fresh as the way out", () => {
    const path = copyFixture("v7-v0.10.0");
    const db = new Database(path);
    // A direct write: no released Styre produces this shape (stated exception, M18).
    db.exec("ALTER TABLE ticket ADD COLUMN surprise TEXT");
    db.close();
    const e = refusalOf(() => migrate(path));
    expect(e.code).toBe(EXIT.RESUME_REFUSED);
    expect(e.recovery).toContain("--fresh");
    expect(fixtureVersion(path)).toBe(7);
  });

  test("v6 is refused", () => {
    const e = refusalOf(() => migrate(copyFixture("v6-v0.7.0")));
    expect(e.code).toBe(EXIT.RESUME_REFUSED);
    expect(e.headline).toContain("v6");
    expect(e.headline).toContain("upgrades checkpoints from v7 on");
  });

  test("a database with tables but no schema_meta is refused, and nothing is added to it", () => {
    const path = join(makeTempDir("styre-noschema-"), "run.db");
    const db = new Database(path);
    db.exec("CREATE TABLE ticket (id INTEGER PRIMARY KEY)");
    db.close();
    const e = refusalOf(() => migrate(path));
    expect(e.code).toBe(EXIT.RESUME_REFUSED);
    expect(e.headline).toContain("no schema_meta");
    expect(e.recovery).toContain("--fresh");
    const tables = readCopyOf(path, (c) =>
      c
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name),
    );
    expect(tables).toEqual(["ticket"]);
  });
});

describe("how migrations run", () => {
  test("the backup holds every committed row while another reader holds a snapshot", () => {
    const path = copyFixture("v7-v0.10.0");
    const writer = new Database(path);
    writer.exec("PRAGMA journal_mode = WAL;");
    const ticketId = (writer.query("SELECT id FROM ticket LIMIT 1").get() as { id: number }).id;
    const reader = new Database(path, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT COUNT(*) FROM event_log").get(); // the read snapshot is now held
    for (let i = 0; i < 50; i++) {
      writer
        .query(
          "INSERT INTO event_log (ticket_id, seq, kind, created_at) VALUES (?, ?, 'note', 't')",
        )
        .run(ticketId, 1000 + i);
    }
    const events = count(path, "SELECT COUNT(*) AS n FROM event_log");
    const r = migrate(path);
    reader.exec("COMMIT");
    reader.close();
    writer.close();
    expect(count(r.backupPath as string, "SELECT COUNT(*) AS n FROM event_log")).toBe(events);
  });

  test("the backup is named <db>.v<old>.<UTC timestamp with milliseconds>.bak, beside the database", () => {
    const at = new Date("2026-10-09T12:00:00.123Z");
    expect(backupPathFor("/x/run.db", 7, at)).toBe("/x/run.db.v7.20261009T120000123Z.bak");
    const path = copyFixture("v7-v0.10.0");
    const r = migrate(path, { now: () => at });
    expect(r.backupPath).toBe(`${path}.v7.20261009T120000123Z.bak`);
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".bak"))).toEqual([
      "run.db.v7.20261009T120000123Z.bak",
    ]);
  });

  test("a failed backup stops the upgrade before any migration runs", () => {
    const path = copyFixture("v7-v0.10.0");
    const at = new Date("2026-10-09T12:00:00.000Z");
    const taken = backupPathFor(path, 7, at);
    writeFileSync(taken, "already here"); // VACUUM INTO refuses a file that is not empty
    let ran = false;
    const watching = [
      {
        ...migration0008,
        up: (db: Database) => {
          ran = true;
          migration0008.up(db);
        },
      },
    ];
    expect(() => migrate(path, { now: () => at, migrations: watching })).toThrow();
    expect(ran).toBe(false);
    expect(fixtureVersion(path)).toBe(7);
    expect(readFileSync(taken, "utf8")).toBe("already here");
  });

  test("a retried upgrade does not collide with an earlier backup (timestamped name)", () => {
    const path = copyFixture("v7-v0.10.0");
    const failing = [
      {
        version: 8,
        note: "fails",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    expect(() =>
      migrate(path, { now: () => new Date("2026-10-09T12:00:00.000Z"), migrations: failing }),
    ).toThrow("boom");
    // the retry backs up again under a new name; VACUUM INTO would refuse an existing file
    expect(() =>
      migrate(path, { now: () => new Date("2026-10-09T12:00:01.000Z"), migrations: failing }),
    ).toThrow("boom");
    const baks = readdirSync(dirname(path)).filter((f) => f.endsWith(".bak"));
    expect(baks.length).toBe(2);
    expect(fixtureVersion(path)).toBe(7);
  });

  test("a failing migration rolls back that step and leaves the previous version", () => {
    const path = copyFixture("v7-v0.10.0");
    const failing = [
      migration0008,
      {
        version: 9,
        note: "fails",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    expect(() => migrate(path, { migrations: failing })).toThrow("boom");
    expect(fixtureVersion(path)).toBe(8);
  });

  test("a failed structural proof rolls back the last migration and keeps the backup", () => {
    // The last pending migration leaves a stray column: the proof runs inside its transaction, so
    // the database stays at the previous version and the next run tries the upgrade again.
    const path = copyFixture("v7-v0.10.0");
    const last = MIGRATIONS.at(-1);
    if (!last) throw new Error("no migrations");
    const stray = [
      ...MIGRATIONS.slice(0, -1),
      {
        ...last,
        up: (db: Database) => {
          last.up(db);
          db.exec("ALTER TABLE ticket ADD COLUMN stray TEXT");
        },
      },
    ];
    // a fixed backup time, so the second backup below cannot collide with this one's name
    const at = () => new Date("2026-01-01T00:00:00.000Z");
    const r = () => migrate(path, { migrations: stray, now: at });
    expect(r).toThrow("does not match schema");
    expect(fixtureVersion(path)).toBe(CURRENT_VERSION - 1);
    const baks = readdirSync(dirname(path)).filter((f) => f.endsWith(".bak"));
    expect(baks.length).toBe(1);
    expect(fixtureVersion(join(dirname(path), baks[0] ?? ""))).toBe(7);
    // the real list, run again, reaches the current version
    expect(migrate(path).version).toBe(CURRENT_VERSION);
  });

  test("a schema_meta it cannot read is an error, not a refusal to start over", () => {
    const { db } = makeTestDb({ seedTicket: false });
    const path = db.filename;
    db.exec("DROP TABLE schema_meta; CREATE TABLE schema_meta (other TEXT)");
    db.close();
    expect(() => migrate(path)).toThrow("no such column: version");
  });

  test("a failing foreign_key_check aborts the migration and keeps v7", () => {
    const path = copyFixture("v7-v0.9.0");
    const db = new Database(path);
    // A direct write (stated exception, Task 2): a real step can never write an orphan row.
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(
      "INSERT INTO workflow_step (ticket_id, seq, step_key, step_type, created_at, updated_at) VALUES (4242, 99, 'orphan', 'dispatch', 't', 't')",
    );
    db.close();
    expect(() => migrate(path)).toThrow("foreign key violation");
    expect(fixtureVersion(path)).toBe(7);
  });

  test("the shared rebuild keeps rows, incoming foreign keys and dependent views", () => {
    const path = copyFixture("v8-main-2b05680");
    const db = new Database(path);
    try {
      const before = db.query("SELECT * FROM signal ORDER BY id").all();
      db.exec("PRAGMA foreign_keys = OFF;");
      // Recorded inside, asserted outside: an expect thrown inside the transaction is not the
      // assertion this test wants to rely on.
      let violations: unknown[] = ["not run"];
      db.transaction(() => {
        // The same definition the v7 -> v8 migration rebuilds with, imported rather than repeated.
        rebuildTable(db, {
          table: "signal",
          createSql: SIGNAL_V8_DDL,
          columns: SIGNAL_V8_COLUMNS,
          indexes: SIGNAL_V8_INDEXES,
        });
        violations = db.query("PRAGMA foreign_key_check").all();
      })();
      expect(violations).toEqual([]);
      db.exec("PRAGMA foreign_keys = ON;");
      expect(db.query("SELECT * FROM signal ORDER BY id").all()).toEqual(before);
      expect(db.query("SELECT COUNT(*) AS n FROM v_ready_tickets").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("a test migration that rebuilds a table with incoming foreign keys runs through migrate()", () => {
    // spec §7.2: rebuildTable through migrate()'s own transaction, foreign key check and proof.
    // signal is referenced by workflow_step.await_signal_id.
    const path = copyFixture("v7-v0.10.0");
    const signalsBefore = readCopyOf(path, (db) =>
      db.query("SELECT * FROM signal ORDER BY id").all(),
    );
    const rebuilding = [
      {
        version: 8,
        note: "test: v7 -> v8 plus a rebuild of signal",
        up: (db: Database) => {
          migration0008.up(db);
          rebuildTable(db, {
            table: "signal",
            createSql: SIGNAL_V8_DDL,
            columns: SIGNAL_V8_COLUMNS,
            indexes: SIGNAL_V8_INDEXES,
          });
        },
      },
    ];
    const r = migrate(path, { migrations: rebuilding });
    expect(r.version).toBe(8);
    expect(r.migratedFrom).toBe(7);
    const after = readCopyOf(path, (db) => ({
      signals: db.query("SELECT * FROM signal ORDER BY id").all(),
      violations: db.query("PRAGMA foreign_key_check").all(),
      waiting: db
        .query(
          "SELECT COUNT(*) AS n FROM workflow_step w JOIN signal s ON s.id = w.await_signal_id",
        )
        .get(),
      ready: db.query("SELECT COUNT(*) AS n FROM v_ready_tickets").get(),
      incoming: db
        .query<{ table: string }, []>("PRAGMA foreign_key_list('workflow_step')")
        .all()
        .filter((f) => f.table === "signal").length,
    }));
    expect(after).toEqual({
      signals: signalsBefore,
      violations: [],
      waiting: { n: 1 },
      ready: { n: 0 },
      incoming: 1,
    });
  });

  test("a migration list with a gap is refused before anything runs", () => {
    const path = copyFixture("v7-v0.10.0");
    const gap = [{ version: 9, note: "skips v8", up: () => {} }];
    expect(() => migrate(path, { migrations: gap })).toThrow("expected v8, found v9");
    expect(fixtureVersion(path)).toBe(7);
  });

  test("rebuildTable refuses to run with foreign keys on or outside a transaction", () => {
    const { db } = makeTestDb({ seedTicket: false });
    const spec = {
      table: "signal",
      createSql: SIGNAL_V8_DDL,
      columns: SIGNAL_V8_COLUMNS,
      indexes: SIGNAL_V8_INDEXES,
    };
    try {
      let onError = "";
      db.transaction(() => {
        try {
          rebuildTable(db, spec);
        } catch (err) {
          onError = String(err);
        }
      })();
      db.exec("PRAGMA foreign_keys = OFF;");
      let outsideError = "";
      try {
        rebuildTable(db, spec);
      } catch (err) {
        outsideError = String(err);
      }
      expect(onError).toContain("foreign keys must be off");
      expect(outsideError).toContain("must run inside a transaction");
    } finally {
      db.close();
    }
  });

  test("the migration list is contiguous and ends at the version schema.sql seeds", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions[0]).toBe(8);
    versions.forEach((v, i) => expect(v).toBe(8 + i));
    expect(versions.at(-1)).toBe(CURRENT_VERSION);
  });
});

describe("deciding what to do reads only", () => {
  const cases: [FixtureName, string][] = [
    ["v6-v0.7.0", "refuse"],
    ["v7-v0.9.0", "upgrade"],
    ["v7-v0.10.0-bridged", "upgrade"],
    ["v8-main-2b05680", CURRENT_VERSION === 8 ? "current" : "upgrade"],
  ];
  for (const [name, kind] of cases) {
    test(`classifyDatabase on ${name} says ${kind} and writes nothing`, () => {
      const path = copyFixture(name);
      const before = filesAt(path);
      const db = new Database(path);
      let changes: number;
      let state: ReturnType<typeof classifyDatabase>;
      try {
        state = classifyDatabase(db, path);
        changes = (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
      } finally {
        db.close();
      }
      expect(state.kind).toBe(kind as typeof state.kind);
      expect(changes).toBe(0);
      expect(filesAt(path)).toEqual(before);
    });
  }

  test("readDatabaseState never opens the database: no side files, no backup, same bytes", () => {
    const path = copyFixture("v7-v0.10.0");
    const before = filesAt(path);
    const state = readDatabaseState(path);
    expect(state).toEqual({ kind: "upgrade", version: 7 });
    expect(filesAt(path)).toEqual(before);
    expect(readdirSync(dirname(path))).toEqual(["run.db"]);
    const v6 = readDatabaseState(copyFixture("v6-v0.7.0"));
    expect(v6.kind).toBe("refuse");
    if (v6.kind === "refuse") expect(v6.error.code).toBe(EXIT.RESUME_REFUSED);
  });
});

describe("styre migrate's lines", () => {
  let stderr: string[] = [];
  let spy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    stderr = [];
    spy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  test("an upgrade says where the backup is, then upgraded from v<old>", async () => {
    const path = copyFixture("v7-v0.10.0");
    await migrateImpl({ args: { db: path } });
    const lines = stderr.join("").trimEnd().split("\n");
    const bak = readdirSync(dirname(path)).find((f) => f.endsWith(".bak")) ?? "(none)";
    expect(lines).toEqual([
      `migrate: backed up ${path} (schema v7) to ${join(dirname(path), bak)}`,
      `migrate: upgraded ${path} from schema v7 to v${CURRENT_VERSION}`,
      `upgraded from v7: ${path} (schema v${CURRENT_VERSION})`,
    ]);
    stderr = [];
    await migrateImpl({ args: { db: path } });
    expect(stderr.join("")).toBe(`already current: ${path} (schema v${CURRENT_VERSION})\n`);
  });

  test("a new database is bootstrapped", async () => {
    const path = join(makeTempDir("styre-mig-lines-"), "run.db");
    await migrateImpl({ args: { db: path } });
    expect(stderr.join("")).toBe(`bootstrapped: ${path} (schema v${CURRENT_VERSION})\n`);
  });
});
