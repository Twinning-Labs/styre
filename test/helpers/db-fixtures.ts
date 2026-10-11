import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { makeTempDir } from "./temp.ts";

/** One committed database per known released shape (spec §7.4, §7.5), plus v6 for the refusal.
 *  Produced by scripts/db-fixtures/generate.ts from each release's own code; never hand-written. */
export const FIXTURES = [
  "v6-v0.7.0",
  "v7-v0.9.0",
  "v7-v0.9.0-bridged",
  "v7-v0.10.0",
  "v7-v0.10.0-bridged",
  "v8-v0.13.2",
  "v8-main-2b05680",
] as const;
export type FixtureName = (typeof FIXTURES)[number];
export const MIGRATABLE_FIXTURES: readonly FixtureName[] = FIXTURES.filter(
  (f) => f !== "v6-v0.7.0",
);

/** The recorded v8 runs (scripts/db-fixtures/drive-v8-run.ts), one folder each. */
export const RECORDED_RUNS = [
  "v8-paused-worktree",
  "v8-plan-gate-worktree",
  "v8-redesign-graded-worktree",
] as const;
export type RecordedRun = (typeof RECORDED_RUNS)[number];

/** meta.json of a recorded run. */
export interface RecordedMeta {
  slug: string;
  ident: string;
  branch: string;
  scenario: string;
  targetRepoAtRecording: string;
  worktreeRootAtRecording: string;
}

const DIR = join(import.meta.dir, "..", "fixtures", "db");

/** A private copy, so no test ever opens a committed fixture: even a read only open of a WAL
 *  database writes `-shm` and `-wal` files beside it. The folder is removed for the caller. */
export function copyFixture(name: FixtureName): string {
  const dest = join(makeTempDir(`styre-fixture-${name}-`), "run.db");
  copyFileSync(join(DIR, `${name}.db`), dest);
  return dest;
}

/** A private copy of every file of a recorded run, in a folder removed for the caller. */
export function copyRecordedRun(name: RecordedRun): string {
  const dest = makeTempDir(`styre-recorded-${name}-`);
  for (const f of readdirSync(join(DIR, name))) copyFileSync(join(DIR, name, f), join(dest, f));
  return dest;
}

export function fixtureVersion(path: string): number {
  return readCopyOf(path, (db) => {
    const row = db
      .query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_meta")
      .get();
    // MAX() over an empty table is one row holding NULL, never no row.
    if (row === null || row.v === null) throw new Error(`${path}: schema_meta is empty`);
    return row.v;
  });
}
