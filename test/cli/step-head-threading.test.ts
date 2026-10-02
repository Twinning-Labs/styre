import { afterEach, beforeEach, expect, test } from "bun:test";
import * as door from "../../src/util/process/door.ts";
import {
  cleanupParkedRun,
  resumeParkedTicket,
  runFreshTicket,
  runParkedTicket,
} from "../helpers/run-harness.ts";

// ENG-485 section 7.5: `styre run` and `--resume` must hand the step journal a way to read the
// ticket branch's HEAD, so the step in flight records where the branch stood when it started.

beforeEach(() => door.__resetForTests());
afterEach(() => door.__resetForTests());

const headOf = (repo: string, ref: string): string =>
  Bun.spawnSync(["git", "rev-parse", ref], { cwd: repo }).stdout.toString().trim();

test("styre run records the branch HEAD at the start of each step", async () => {
  const seen: Array<ReturnType<typeof door.inFlightStep>> = [];
  const run = await runFreshTicket({ onDispatch: () => seen.push(door.inFlightStep()) });
  expect(seen.length).toBeGreaterThan(0);
  // `provision` has made the worktree and the branch before the first agent step starts.
  const branchHead = headOf(run.repoDir, "feat/ENG-1");
  expect(branchHead).toMatch(/^[0-9a-f]{40}$/);
  expect(seen[0]?.ident).toBe("ENG-1");
  expect(seen[0]?.headAtStart).toBe(branchHead);
  run.cleanup();
});

test("styre run --resume records the branch HEAD at the start of the resumed step", async () => {
  const parked = await runParkedTicket();
  const seen: Array<ReturnType<typeof door.inFlightStep>> = [];
  await resumeParkedTicket(parked, { onDispatch: () => seen.push(door.inFlightStep()) });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]?.ident).toBe("ENG-1");
  expect(seen[0]?.headAtStart).toMatch(/^[0-9a-f]{40}$/);
  cleanupParkedRun(parked);
});
