import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCopyOf } from "../../src/db/read-copy.ts";
import {
  FIXTURES,
  MIGRATABLE_FIXTURES,
  RECORDED_RUNS,
  type RecordedMeta,
  type RecordedRun,
  copyFixture,
  copyRecordedRun,
  fixtureVersion,
} from "../helpers/db-fixtures.ts";
import { makeTempDir } from "../helpers/temp.ts";

const COMMITTED = join(import.meta.dir, "..", "fixtures", "db");
const bytes = (path: string) => readFileSync(path).toString("base64");
const filesIn = (dir: string) => readdirSync(dir).sort();

describe("the fixture list matches the committed files", () => {
  test("every committed .db file and recorded run folder is registered, and every registered one exists", () => {
    const onDisk = readdirSync(COMMITTED, { withFileTypes: true });
    expect(
      onDisk
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort(),
    ).toEqual(FIXTURES.map((f) => `${f}.db`).sort());
    expect(
      onDisk
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(),
    ).toEqual([...RECORDED_RUNS].sort());
  });

  test("the migratable fixtures are all of them but v6", () => {
    expect(MIGRATABLE_FIXTURES).toEqual(FIXTURES.filter((f) => f !== "v6-v0.7.0"));
    expect(MIGRATABLE_FIXTURES).not.toContain("v6-v0.7.0");
    expect(MIGRATABLE_FIXTURES.length).toBe(FIXTURES.length - 1);
  });

  test("no -wal, -shm or -journal file is committed beside a fixture", () => {
    const stray = [COMMITTED, ...RECORDED_RUNS.map((r) => join(COMMITTED, r))].flatMap((d) =>
      readdirSync(d).filter((n) => /\.db-(wal|shm|journal)$/.test(n)),
    );
    expect(stray).toEqual([]);
  });
});

describe("copyFixture and copyRecordedRun hand out private copies", () => {
  const made: string[] = [];

  test("copyFixture: a fresh temporary file with the committed bytes, never the committed path", () => {
    const a = copyFixture("v8-main-2b05680");
    const b = copyFixture("v8-main-2b05680");
    made.push(a, b);
    for (const p of [a, b]) {
      expect(p.startsWith(tmpdir())).toBe(true);
      expect(p).not.toStartWith(COMMITTED);
      expect(statSync(p).isFile()).toBe(true);
      expect(bytes(p)).toBe(bytes(join(COMMITTED, "v8-main-2b05680.db")));
    }
    expect(dirname(a)).not.toBe(dirname(b));
  });

  test("copyFixture: changing the copy leaves the committed fixture alone", () => {
    const committed = join(COMMITTED, "v7-v0.9.0.db");
    const before = bytes(committed);
    const path = copyFixture("v7-v0.9.0");
    made.push(path);
    // Never write to the committed file, even when copyFixture is what is broken.
    expect(path).not.toStartWith(COMMITTED);
    appendFileSync(path, "changed");
    const db = new Database(path);
    try {
      db.exec("UPDATE ticket SET title = 'changed'");
    } finally {
      db.close();
    }
    expect(bytes(committed)).toBe(before);
    expect(filesIn(COMMITTED).filter((n) => /-(wal|shm|journal)$/.test(n))).toEqual([]);
  });

  test("copyRecordedRun: a fresh temporary folder with exactly the committed files and bytes", () => {
    for (const name of RECORDED_RUNS) {
      const dir = copyRecordedRun(name);
      made.push(dir);
      expect(dir.startsWith(tmpdir())).toBe(true);
      expect(dir).not.toStartWith(COMMITTED);
      expect(filesIn(dir)).toEqual(filesIn(join(COMMITTED, name)));
      for (const f of filesIn(dir))
        expect(bytes(join(dir, f))).toBe(bytes(join(COMMITTED, name, f)));
    }
    // A needs_you pause writes no transcript; the two budget pauses do.
    expect(filesIn(join(COMMITTED, "v8-plan-gate-worktree"))).toEqual([
      "meta.json",
      "repo.bundle",
      "run.db",
    ]);
    for (const name of ["v8-paused-worktree", "v8-redesign-graded-worktree"]) {
      expect(filesIn(join(COMMITTED, name))).toEqual([
        "meta.json",
        "repo.bundle",
        "run.db",
        "transcript.json",
      ]);
    }
  });

  test("copyRecordedRun: changing the copy leaves the committed run alone", () => {
    const dir = copyRecordedRun("v8-paused-worktree");
    made.push(dir);
    // Never write to the committed folder, even when copyRecordedRun is what is broken.
    expect(dir).not.toStartWith(COMMITTED);
    const before = bytes(join(COMMITTED, "v8-paused-worktree", "meta.json"));
    writeFileSync(join(dir, "meta.json"), "{}");
    expect(bytes(join(COMMITTED, "v8-paused-worktree", "meta.json"))).toBe(before);
  });

  test("the copies are removed when their test ends", () => {
    expect(made.length).toBeGreaterThan(0);
    for (const p of made) expect(existsSync(p)).toBe(false);
  });
});

describe("fixtureVersion", () => {
  test("is the highest version in schema_meta", () => {
    const dir = makeTempDir("styre-fv-test-");
    const path = join(dir, "run.db");
    const db = new Database(path);
    try {
      db.exec(
        "CREATE TABLE schema_meta (version INTEGER); INSERT INTO schema_meta VALUES (3), (9), (7);",
      );
    } finally {
      db.close();
    }
    expect(fixtureVersion(path)).toBe(9);
  });

  test("an empty schema_meta throws, naming the file", () => {
    const dir = makeTempDir("styre-fv-test-");
    const path = join(dir, "run.db");
    const db = new Database(path);
    try {
      db.exec("CREATE TABLE schema_meta (version INTEGER);");
    } finally {
      db.close();
    }
    expect(() => fixtureVersion(path)).toThrow(`${path}: schema_meta is empty`);
  });

  test("reads a WAL database beside its live writer without touching any file beside it", () => {
    const dir = makeTempDir("styre-fv-test-");
    const path = join(dir, "run.db");
    const writer = new Database(path);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer.exec(
        "CREATE TABLE schema_meta (version INTEGER); INSERT INTO schema_meta VALUES (7);",
      );
      writer.exec("INSERT INTO schema_meta VALUES (8);"); // only in the -wal, never checkpointed
      const snapshot = () =>
        filesIn(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs, bytes(join(dir, f))]);
      const before = snapshot();
      expect(fixtureVersion(path)).toBe(8);
      expect(snapshot()).toEqual(before);
    } finally {
      writer.close();
    }
  });

  test("does not change the file it reads", () => {
    const path = copyFixture("v8-v0.13.2");
    const before = bytes(path);
    const dir = dirname(path);
    expect(fixtureVersion(path)).toBe(8);
    expect(bytes(path)).toBe(before);
    expect(filesIn(dir)).toEqual(["run.db"]);
  });
});

describe("the fixtures are tracked by git, not ignored", () => {
  /** Exit code of `git check-ignore --no-index -q <path>`: 0 ignored, 1 not ignored. The index is
   *  left out on purpose: it decides from .gitignore alone, as a fresh clone would. */
  function ignored(rel: string): number {
    const r = Bun.spawnSync(["git", "check-ignore", "--no-index", "-q", rel], {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
      timeout: 30_000,
    });
    if (r.exitCode !== 0 && r.exitCode !== 1) {
      throw new Error(`git check-ignore ${rel}: exit ${r.exitCode} ${r.stderr.toString()}`);
    }
    return r.exitCode as number;
  }

  test("every .db fixture and recorded run.db is not ignored; their -wal and -shm files are", () => {
    const files = [
      ...FIXTURES.map((f) => `${f}.db`),
      ...RECORDED_RUNS.map((r) => join(r, "run.db")),
    ];
    for (const f of files) expect([f, ignored(join("test/fixtures/db", f))]).toEqual([f, 1]);
    for (const f of files) {
      for (const ext of ["-wal", "-shm"]) {
        expect([f + ext, ignored(join("test/fixtures/db", f + ext))]).toEqual([f + ext, 0]);
      }
    }
  }, 120_000);

  test("a .db file outside the fixtures folder is still ignored", () => {
    expect(ignored("some/other/folder/run.db")).toBe(0);
    expect(ignored("test/fixtures/other/run.db")).toBe(0);
  }, 60_000);
});

describe("the recorded runs hold the particulars their scenarios exist for", () => {
  interface Facts {
    steps: Record<string, { status: string; result: Record<string, unknown> | null }>;
    dispatchesByStep: Record<string, number>;
    lastEvents: { kind: string; reason: string | null }[];
    worktreePaths: string[];
    meta: RecordedMeta;
    transcript: { dispatchId: string; cause: string }[] | null;
    dispatchIdOfStep: Record<string, string>;
  }
  function factsOf(name: RecordedRun): Facts {
    const dir = copyRecordedRun(name);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RecordedMeta;
    const transcriptPath = join(dir, "transcript.json");
    // dumpPark writes one JSON object per line for each park; the file may end without a newline.
    const transcript = existsSync(transcriptPath)
      ? readFileSync(transcriptPath, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as { dispatchId: string; cause: string })
      : null;
    return readCopyOf(join(dir, "run.db"), (db) => {
      const steps: Facts["steps"] = {};
      for (const r of db
        .query<{ step_key: string; status: string; result_json: string | null }, []>(
          "SELECT step_key, status, result_json FROM workflow_step",
        )
        .all()) {
        steps[r.step_key] = {
          status: r.status,
          result: r.result_json === null ? null : JSON.parse(r.result_json),
        };
      }
      const dispatches = db
        .query<{ dispatch_id: string; step_key: string; worktree_path: string | null }, []>(
          "SELECT d.dispatch_id, s.step_key, d.worktree_path FROM dispatch d JOIN workflow_step s ON s.id = d.step_id ORDER BY d.id",
        )
        .all();
      const dispatchesByStep: Record<string, number> = {};
      const dispatchIdOfStep: Record<string, string> = {};
      for (const d of dispatches) {
        dispatchesByStep[d.step_key] = (dispatchesByStep[d.step_key] ?? 0) + 1;
        dispatchIdOfStep[d.step_key] = d.dispatch_id; // the latest wins
      }
      return {
        steps,
        dispatchesByStep,
        dispatchIdOfStep,
        lastEvents: db
          .query<{ kind: string; reason: string | null }, []>(
            "SELECT kind, reason FROM event_log ORDER BY seq DESC LIMIT 2",
          )
          .all(),
        worktreePaths: dispatches.flatMap((d) =>
          d.worktree_path === null ? [] : [d.worktree_path],
        ),
        meta,
        transcript,
      };
    });
  }

  test("v8-paused-worktree: the implement dispatch of unit 1 was cut off by the session limit", () => {
    const f = factsOf("v8-paused-worktree");
    expect(f.steps["implement:wu1:dispatch"]).toEqual({ status: "running", result: null });
    expect(f.steps["design:size"]?.result).toEqual({ track: "full", graded: false });
    expect(f.dispatchesByStep["implement:wu1:dispatch"]).toBe(1);
    expect(f.lastEvents[0]).toEqual({ kind: "parked", reason: "session-limit; resets tomorrow" });
    expect(f.transcript?.map((t) => [t.dispatchId, t.cause])).toEqual([
      [f.dispatchIdOfStep["implement:wu1:dispatch"], "session-limit"],
    ]);
  });

  test("v8-plan-gate-worktree: one redesign, then the escalation on the same blocking finding", () => {
    const f = factsOf("v8-plan-gate-worktree");
    expect(f.dispatchesByStep["design:dispatch"]).toBe(2);
    expect(f.dispatchesByStep["design:review"]).toBe(2);
    expect(f.steps["design:review"]?.result).toEqual({ findings: 1, blocking: 1 });
    expect(f.lastEvents[0]?.kind).toBe("escalated");
    expect(f.lastEvents[0]?.reason).toContain("identical plan-review findings");
    expect(f.steps["implement:wu1:dispatch"]).toBeUndefined();
    expect(f.transcript).toBeNull();
  });

  test("v8-redesign-graded-worktree: graded size, a loopback, and the regenerated plan cut off", () => {
    const f = factsOf("v8-redesign-graded-worktree");
    expect(f.steps["design:size"]).toEqual({
      status: "succeeded",
      result: { track: "full", graded: true, overall: 6 },
    });
    expect(f.dispatchesByStep["design:dispatch"]).toBe(2); // the plan, then the redesign
    expect(f.dispatchesByStep["design:size"]).toBe(1); // v8's redesign never re-ran it
    expect(f.lastEvents.map((e) => e.kind)).toEqual(["parked", "loopback"]);
    expect(f.transcript?.map((t) => [t.dispatchId, t.cause])).toEqual([
      [f.dispatchIdOfStep["design:dispatch"], "session-limit"],
    ]);
  });

  test("every recorded run dispatched inside its recorded worktree folder, not in the repository", () => {
    for (const name of RECORDED_RUNS) {
      const f = factsOf(name);
      expect(f.worktreePaths.length).toBeGreaterThan(0);
      for (const p of f.worktreePaths) {
        expect(p.startsWith(`${f.meta.worktreeRootAtRecording}/`)).toBe(true);
        expect(p.startsWith(`${f.meta.targetRepoAtRecording}/`)).toBe(false);
      }
    }
  });
});
