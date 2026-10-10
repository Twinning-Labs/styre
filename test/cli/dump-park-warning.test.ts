import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpPark, parkDir, priorRunIdAt } from "../../src/cli/park.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { makeTempDir } from "../helpers/temp.ts";

function dbWithRun(runId: string): string {
  const path = join(makeTempDir("dp-"), "run.db");
  migrate(path);
  const db = new Database(path);
  insertRun(db, { runId, startedAt: "2026-07-21T00:00:00.000Z", provider: "claude" });
  db.close();
  return path;
}

describe("priorRunIdAt", () => {
  test("returns the run_id of an existing dump", () => {
    expect(priorRunIdAt(dbWithRun("run-A"))).toBe("run-A");
  });
  test("returns null for a missing file", () => {
    expect(priorRunIdAt(join(tmpdir(), "does-not-exist.db"))).toBeNull();
  });
  test("returns null for a pre-upgrade dump with no run table", () => {
    const path = join(makeTempDir("dp-"), "run.db");
    const db = new Database(path);
    db.exec("CREATE TABLE ticket (id INTEGER PRIMARY KEY);"); // no run table
    db.close();
    expect(priorRunIdAt(path)).toBeNull();
  });
});

describe("dumpPark reads the paused copy it overwrites through a private copy", () => {
  const park = {
    cause: "session-limit" as const,
    resetAt: null,
    dispatchId: "ENG-1-d0001",
    transcript: "partial",
  };
  let stderr: string[] = [];
  let spy: ReturnType<typeof spyOn>;
  let prevState: string | undefined;
  beforeEach(() => {
    stderr = [];
    spy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    prevState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = makeTempDir("dp-state-");
  });
  afterEach(() => {
    spy.mockRestore();
    if (prevState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    else process.env.XDG_STATE_HOME = prevState;
  });

  /** The live run being paused: a database with run `runId`, left open for dumpPark to close. */
  function liveRun(runId: string) {
    const path = join(makeTempDir("dp-live-"), "run.db");
    migrate(path);
    const db = openDb(path);
    insertRun(db, { runId, startedAt: "2026-07-21T00:00:00.000Z", provider: "claude" });
    return { db, path };
  }

  test("a paused copy in WAL mode with no -wal or -shm still produces the overwriting warning", () => {
    const dest = join(parkDir("dp-slug", "ENG-1"), "run.db");
    mkdirSync(parkDir("dp-slug", "ENG-1"), { recursive: true });
    // the earlier pause's copy: WAL mode in its header, its side files gone (a read only open of
    // such a file fails on macOS)
    migrate(dest);
    const earlier = new Database(dest);
    insertRun(earlier, {
      runId: "run-A",
      startedAt: "2026-07-21T00:00:00.000Z",
      provider: "claude",
    });
    earlier.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    earlier.close();
    for (const ext of ["-wal", "-shm"]) rmSync(`${dest}${ext}`, { force: true });
    const { db, path } = liveRun("run-B");
    dumpPark(db, path, "dp-slug", "ENG-1", park, "run: ");
    expect(stderr.join("")).toContain("overwriting paused run run-A with run-B for ENG-1");
  });

  test("a paused copy that cannot be read is said so, with the caller's prefix", () => {
    const dest = join(parkDir("dp-slug", "ENG-1"), "run.db");
    mkdirSync(parkDir("dp-slug", "ENG-1"), { recursive: true });
    writeFileSync(dest, "not a database");
    const { db, path } = liveRun("run-B");
    dumpPark(db, path, "dp-slug", "ENG-1", park, "resume: ");
    expect(stderr.join("")).toContain(`resume: could not read the paused run at ${dest}`);
  });
});
