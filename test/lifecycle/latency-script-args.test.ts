// scripts/measure-lifecycle-latency.ts judges "within noise" by the spread of the round medians, so
// one round has no noise and every difference reads as "NOT WITHIN NOISE" (final review B m9). It
// must refuse fewer than 2 rounds, before it starts anything.
import { expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/measure-lifecycle-latency.ts");

test.each([
  [["--rounds", "1"], "--rounds must be at least 2"],
  [["--rounds", "0"], "usage:"],
  [["--rounds"], "usage:"],
  [["--dispatches", "x"], "usage:"],
])("measure-lifecycle-latency %p exits 64 and says why", (args, said) => {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  expect(r.exitCode).toBe(64);
  expect(r.stderr.toString()).toContain(said);
  expect(r.stdout.toString()).toBe("");
});
