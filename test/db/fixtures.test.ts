import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCopyOf } from "../../src/db/read-copy.ts";
import {
  FIXTURES,
  RECORDED_RUNS,
  type RecordedMeta,
  type RecordedRun,
  copyFixture,
  copyRecordedRun,
  fixtureVersion,
} from "../helpers/db-fixtures.ts";

/** `stepPid`: a fragment of the comment on workflow_step.pid in that release's own schema text. It
 *  differs between v0.13.2 ("spawned worker PID") and 2b05680 ("legacy (before ENG-485)"), so each
 *  v8 fixture is proved to come from its own ref. */
const EXPECTED: Record<
  string,
  { version: number; budget: boolean; run: boolean; stepPid?: string }
> = {
  "v6-v0.7.0": { version: 6, budget: true, run: false },
  "v7-v0.9.0": { version: 7, budget: true, run: false },
  "v7-v0.9.0-bridged": { version: 7, budget: true, run: true },
  "v7-v0.10.0": { version: 7, budget: false, run: false },
  "v7-v0.10.0-bridged": { version: 7, budget: false, run: true },
  "v8-v0.13.2": { version: 8, budget: false, run: true, stepPid: "spawned worker PID" },
  "v8-main-2b05680": {
    version: 8,
    budget: false,
    run: true,
    stepPid: "legacy (before ENG-485)",
  },
};

interface RecordedExpect {
  files: string[];
  scenario: string;
  ticket: { stage: string; status: string };
  steps: Record<string, string>;
  lastEventKind: string;
}
const ALL_FILES = ["run.db", "transcript.json", "repo.bundle", "meta.json"];
const RECORDED: Record<RecordedRun, RecordedExpect> = {
  "v8-paused-worktree": {
    files: ALL_FILES,
    scenario: "implement-budget",
    ticket: { stage: "implement", status: "waiting" },
    steps: {
      provision: "succeeded",
      "design:dispatch": "succeeded",
      "design:extract": "succeeded",
      "design:size": "succeeded",
      "design:review": "succeeded",
    },
    lastEventKind: "parked",
  },
  "v8-plan-gate-worktree": {
    files: ["run.db", "repo.bundle", "meta.json"],
    scenario: "plan-gate",
    ticket: { stage: "design", status: "waiting" },
    steps: {
      provision: "succeeded",
      "design:dispatch": "succeeded",
      "design:extract": "succeeded",
      "design:size": "succeeded",
      "design:review": "succeeded",
    },
    lastEventKind: "escalated",
  },
  "v8-redesign-graded-worktree": {
    files: ALL_FILES,
    scenario: "redesign-budget-graded",
    ticket: { stage: "design", status: "waiting" },
    steps: {
      provision: "succeeded",
      "design:dispatch": "running",
      "design:extract": "pending",
      "design:size": "succeeded",
      "design:review": "pending",
    },
    lastEventKind: "parked",
  },
};

describe("historical database fixtures", () => {
  for (const name of FIXTURES) {
    test(`${name} has the shape its release wrote`, () => {
      const path = copyFixture(name);
      const want = EXPECTED[name];
      expect(fixtureVersion(path)).toBe(want.version);
      readCopyOf(path, (db) => {
        const signalCols = db
          .query<{ name: string }, []>("PRAGMA table_info('signal')")
          .all()
          .map((c) => c.name);
        expect(signalCols.includes("attempts")).toBe(want.budget);
        const hasRun =
          db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run'").get() !== null;
        expect(hasRun).toBe(want.run);
        if (want.stepPid !== undefined) {
          const sql = db
            .query<{ sql: string }, []>(
              "SELECT sql FROM sqlite_master WHERE name = 'workflow_step'",
            )
            .get();
          expect(sql?.sql).toContain(want.stepPid);
        }
        if (want.version >= 7) {
          // Seeded through that release's own repositories (seed-era.ts).
          const running = db
            .query<{ step_key: string }, []>(
              "SELECT step_key FROM workflow_step WHERE status = 'running'",
            )
            .all();
          expect(running.map((r) => r.step_key)).toEqual(["implement:wu1:dispatch"]);
          // The four design steps the run got through, all succeeded.
          const succeeded = db
            .query<{ step_key: string }, []>(
              "SELECT step_key FROM workflow_step WHERE status = 'succeeded' ORDER BY seq",
            )
            .all();
          expect(succeeded.map((r) => r.step_key)).toEqual([
            "provision",
            "design:dispatch",
            "design:extract",
            "design:size",
          ]);
          // The interrupted step has its dispatch row and its interruption note (what `--fresh`
          // and `clean` read).
          const runningId = db
            .query<{ id: number }, []>(
              "SELECT id FROM workflow_step WHERE step_key = 'implement:wu1:dispatch'",
            )
            .get()?.id;
          expect(runningId).toBeDefined();
          const dispatchCount = db
            .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM dispatch WHERE step_id = ?")
            .get(runningId as number);
          expect(dispatchCount?.n).toBe(1);
          const notes = db
            .query<{ payload_json: string }, []>(
              "SELECT payload_json FROM event_log WHERE kind = 'note' AND reason = 'interrupted'",
            )
            .all();
          expect(notes.length).toBe(1);
          expect(JSON.parse(notes[0]?.payload_json ?? "null")).toMatchObject({
            event: "interrupted",
            stepId: runningId,
          });
          const reconcile = db.query("SELECT 1 FROM work_unit WHERE kind = 'reconcile'").get();
          expect(reconcile).not.toBeNull();
          const awaiting = db
            .query("SELECT 1 FROM workflow_step WHERE await_signal_id IS NOT NULL")
            .get();
          expect(awaiting).not.toBeNull();
        }
      });
    });
  }

  for (const name of RECORDED_RUNS) {
    test(`the recorded v8 run ${name} is the stop its scenario drove, in worktree mode`, () => {
      const want = RECORDED[name];
      const dir = copyRecordedRun(name); // never the committed files in place
      for (const f of want.files) expect(existsSync(join(dir, f))).toBe(true);
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RecordedMeta;
      expect(meta.ident).toBe("ENG-1");
      expect(meta.scenario).toBe(want.scenario);
      const dbPath = join(dir, "run.db");
      expect(fixtureVersion(dbPath)).toBe(8);
      readCopyOf(dbPath, (db) => {
        const t = db
          .query<{ stage: string; status: string }, []>("SELECT stage, status FROM ticket")
          .get();
        expect(t).toEqual(want.ticket);
        const steps = Object.fromEntries(
          db
            .query<{ step_key: string; status: string }, []>(
              "SELECT step_key, status FROM workflow_step WHERE step_key IN ('provision', 'design:dispatch', 'design:extract', 'design:size', 'design:review')",
            )
            .all()
            .map((r) => [r.step_key, r.status]),
        );
        expect(steps).toEqual(want.steps);
        const last = db
          .query<{ kind: string }, []>("SELECT kind FROM event_log ORDER BY seq DESC LIMIT 1")
          .get();
        expect(last?.kind).toBe(want.lastEventKind);
        const latest = db
          .query<{ worktree_path: string }, []>(
            "SELECT worktree_path FROM dispatch WHERE worktree_path IS NOT NULL ORDER BY id DESC LIMIT 1",
          )
          .get();
        expect(latest?.worktree_path).not.toBe(meta.targetRepoAtRecording); // worktree mode
      });
    });
  }
});

test("every committed fixture is in rollback journal (DELETE) mode, never WAL", () => {
  // Read from the file header, never opened as a database: bytes 18 and 19 are the file format
  // write and read versions, 1 for a rollback journal and 2 for WAL (sqlite.org/fileformat2.html).
  const committed = join(import.meta.dir, "..", "fixtures", "db");
  const files = [...FIXTURES.map((f) => `${f}.db`), ...RECORDED_RUNS.map((r) => join(r, "run.db"))];
  for (const f of files) {
    const header = readFileSync(join(committed, f)).subarray(18, 20);
    expect([f, header[0], header[1]]).toEqual([f, 1, 1]);
  }
});
