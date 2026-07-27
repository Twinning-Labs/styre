import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { hasPendingHumanResume } from "../../src/db/repos/signal.ts";
import {
  cleanupParkedRun,
  resumeParkedTicket,
  runNeedsYouTicket,
  runParkedTicket,
} from "../helpers/run-harness.ts";

test("resuming a needs_you checkpoint consumes the human_resume signal (does not instant-re-pause)", async () => {
  const parked = await runNeedsYouTicket();
  const before = openDb(join(parked.dumpDir, "run.db"));
  expect(hasPendingHumanResume(before, parked.ticketId)).toBe(true);
  before.close();

  const resumed = await resumeParkedTicket(parked); // resume-phase fake SUCCEEDS the step
  const after = openDb(join(parked.dumpDir, "run.db"));
  expect(hasPendingHumanResume(after, parked.ticketId)).toBe(false); // consumed
  after.close();
  expect(resumed.ran).toBe(true); // actually dispatched — did not no-op re-pause
  cleanupParkedRun(parked);
});

test("resuming a budget checkpoint proceeds normally (no reason gate on budget resumes)", async () => {
  const parked = await runParkedTicket();
  const resumed = await resumeParkedTicket(parked);
  // Budget checkpoints carry no human_resume signal — resume should dispatch/proceed, never refuse.
  expect(resumed.result.outcome).not.toBe("refused");
  expect(resumed.ran).toBe(true);
  cleanupParkedRun(parked);
});

test("resuming a ticket whose checkpoint dir has a live foreign run.lock refuses (exit 65) without dispatching", async () => {
  const parked = await runParkedTicket();
  // Seed a live foreign lock in the checkpoint dir — process.ppid is a real, live pid (the test
  // runner's parent), so acquireRunLock's stale-reclaim does NOT fire; the lock must be honored.
  writeFileSync(join(parked.dumpDir, "run.lock"), String(process.ppid));

  const resumed = await resumeParkedTicket(parked);
  expect(resumed.exitCode).toBe(65);
  expect(resumed.result.outcome).toBe("refused");
  expect(resumed.ran).toBe(false); // must not dispatch — the lock holder owns the run

  cleanupParkedRun(parked);
});
