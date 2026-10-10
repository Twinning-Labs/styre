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

const EXPECTED: Record<string, { version: number; budget: boolean; run: boolean }> = {
  "v6-v0.7.0": { version: 6, budget: true, run: false },
  "v7-v0.9.0": { version: 7, budget: true, run: false },
  "v7-v0.9.0-bridged": { version: 7, budget: true, run: true },
  "v7-v0.10.0": { version: 7, budget: false, run: false },
  "v7-v0.10.0-bridged": { version: 7, budget: false, run: true },
  "v8-v0.13.2": { version: 8, budget: false, run: true },
  "v8-main-2b05680": { version: 8, budget: false, run: true },
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
        if (want.version >= 7) {
          // Seeded through that release's own repositories (seed-era.ts).
          const running = db
            .query<{ step_key: string }, []>(
              "SELECT step_key FROM workflow_step WHERE status = 'running'",
            )
            .all();
          expect(running.map((r) => r.step_key)).toEqual(["implement:wu1:dispatch"]);
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
