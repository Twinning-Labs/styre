import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import * as door from "../../src/util/process/door.ts";
import {
  advanceBranchHead,
  cleanupParkedRun,
  resumeParkedTicket,
  runFreshTicket,
  runParkedTicket,
} from "../helpers/run-harness.ts";

// ENG-485 section 7.5: `styre run` and `--resume` must hand the step journal a way to read the
// HEAD of the TICKET branch (not the default branch, not whatever the checkout has), so the step in
// flight records where that branch stood when the step started.

beforeEach(() => door.__resetForTests());
afterEach(() => {
  mock.restore();
  door.__resetForTests();
});

const git = (repo: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

test("styre run records the HEAD of the ticket branch, which has diverged from the default branch", async () => {
  const seen: Array<ReturnType<typeof door.inFlightStep>> = [];
  // Every step registers itself, `provision` first. It runs before the ticket branch exists, so its
  // headAtStart must be null; a reader of the checkout's HEAD would record a sha here instead.
  const begun: Array<Parameters<typeof door.beginStep>[0]> = [];
  const realBeginStep = door.beginStep;
  const beginSpy = spyOn(door, "beginStep").mockImplementation((step) => {
    begun.push(step);
    realBeginStep(step);
  });
  const run = await runFreshTicket({
    // The checkout sits on `dev`, one commit ahead of `main` (the profile's default branch), so
    // the ticket branch that `provision` creates from it starts somewhere `main` is not.
    repoSetup: (repo) => {
      git(repo, "checkout", "-q", "-b", "dev");
      git(repo, "commit", "-q", "--allow-empty", "-m", "dev work");
    },
    onDispatch: () => seen.push(door.inFlightStep()),
  });
  expect(seen.length).toBeGreaterThan(0);
  const ticketHead = git(run.repoDir, "rev-parse", "feat/ENG-1");
  const defaultHead = git(run.repoDir, "rev-parse", "main");
  expect(ticketHead).not.toBe(defaultHead); // the setup really made them differ
  expect(seen[0]?.ident).toBe("ENG-1");
  expect(seen[0]?.headAtStart).toBe(ticketHead);
  beginSpy.mockRestore();
  expect(begun[0]?.headAtStart).toBeNull(); // provision: no ticket branch yet
  expect(begun.at(-1)?.headAtStart).toBe(ticketHead); // the dispatch step
  run.cleanup();
});

test("styre run --resume records the HEAD of the ticket branch, not the checkout's HEAD", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked); // the ticket branch moves; the checkout's own HEAD does not
  const dump = openDb(join(parked.dumpDir, "run.db"));
  const repo = (
    dump.query<{ target_repo: string }, []>("SELECT target_repo FROM project LIMIT 1").get() as {
      target_repo: string;
    }
  ).target_repo;
  dump.close();
  const ticketHead = git(repo, "rev-parse", "feat/ENG-1"); // before the resumed run commits more
  expect(ticketHead).not.toBe(git(repo, "rev-parse", "HEAD")); // the checkout is not on the ticket branch
  const seen: Array<ReturnType<typeof door.inFlightStep>> = [];
  await resumeParkedTicket(parked, {
    acceptHead: true,
    onDispatch: () => seen.push(door.inFlightStep()),
  });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]?.ident).toBe("ENG-1");
  expect(seen[0]?.headAtStart).toBe(ticketHead);
  cleanupParkedRun(parked);
});
