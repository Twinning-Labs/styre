import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
