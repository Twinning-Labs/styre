import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parkDir } from "../../src/cli/park.ts";
import { runFreshTicket } from "../helpers/run-harness.ts";

test("a fresh run journals its SoT to parkDir/run.db, not a temp dir", async () => {
  const run = await runFreshTicket(); // drives real runImpl to a terminal; returns { checkpointDir, dbPath, cleanup }
  expect(run.dbPath).toBe(join(parkDir("test-project", "ENG-1"), "run.db"));
  expect(existsSync(run.dbPath)).toBe(true);
  run.cleanup();
});

test("a second fresh run on an existing checkpoint refuses (usage error), does not clobber", async () => {
  const first = await runFreshTicket();
  await expect(runFreshTicket({ reuseStateOf: first })).rejects.toThrow(
    /checkpoint already exists|--fresh/i,
  );
  first.cleanup();
});

test("--fresh discards an existing checkpoint (whole dir) and starts over", async () => {
  const first = await runFreshTicket();
  expect(existsSync(first.dbPath)).toBe(true);
  // A sidecar unrelated to run.db, dropped straight into the checkpoint dir, to prove --fresh
  // wipes the WHOLE dir (per the brief: run.db + -wal/-shm + transcript.json + run.lock) rather
  // than just unlinking dbPath. A narrower "just rm dbPath" fix would leave this behind.
  //
  // NOTE: the brief's literal third assertion (`existsSync(`${first.dbPath}-wal`)).toBe(false)`)
  // is not achievable here: bun:sqlite's `PRAGMA wal_checkpoint(TRUNCATE)` (which dumpPark runs
  // before every close, on every parked run — see src/cli/park.ts) truncates the -wal file's
  // *content* to zero bytes but never unlinks it; a completed second run always parks again via
  // the harness's session-limit runner and so leaves its own fresh (empty) -wal stub at the same
  // path. Verified empirically with bun:sqlite and the system sqlite3 CLI: TRUNCATE-checkpoint +
  // close leaves a present, 0-byte `-wal` file on disk in every case, --fresh or not. This sentinel
  // check exercises the same "whole dir vs. single file" guarantee without depending on that
  // internal SQLite/dumpPark behavior.
  const sentinel = join(first.checkpointDir, "leftover-sentinel.txt");
  writeFileSync(sentinel, "stale");
  const second = await runFreshTicket({ reuseStateOf: first, fresh: true }); // must NOT reject
  expect(existsSync(second.dbPath)).toBe(true);
  expect(existsSync(sentinel)).toBe(false); // whole dir wiped, not just run.db
  // second doesn't own stateRoot (reuseStateOf'd from first) — its cleanup only rewinds env to
  // what first left in place. first.cleanup() must run too, to restore the env to its true
  // pre-test value and remove the shared stateRoot (it's the one that owns it).
  second.cleanup();
  first.cleanup();
});
