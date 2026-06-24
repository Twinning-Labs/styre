import { expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
  advanceBranchHead,
  cleanupParkedRun,
  resumeParkedTicket,
  runParkedTicket,
} from "../helpers/run-harness.ts";

test("a moved HEAD refuses plain --resume with exit 65 and changes nothing", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked); // operator commits on the branch after the park
  const { exitCode, ran } = await resumeParkedTicket(parked, {}); // no flags
  expect(exitCode).toBe(65);
  expect(ran).toBe(false); // no dispatch happened
  cleanupParkedRun(parked);
});

test("--inspect on a moved HEAD prints diagnostics, exits 0, changes nothing", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked);
  const { exitCode, ran } = await resumeParkedTicket(parked, { inspect: true });
  expect(exitCode).toBe(0);
  expect(ran).toBe(false); // no dispatch happened
  cleanupParkedRun(parked);
});

test("--accept-head resumes against the new HEAD WITHOUT carryover", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked);
  const { prompts, result } = await resumeParkedTicket(parked, { acceptHead: true });
  // The carryover advisory must NOT appear — it was dropped because the base changed.
  expect(prompts.some((p) => p.includes("previous attempt was interrupted"))).toBe(false);
  expect(result.outcome === "pr-ready" || result.outcome === "done").toBe(true);
  cleanupParkedRun(parked);
});

test("park → resume → park → resume never exhausts maxAttempts (no attempt burned by a park)", async () => {
  const parked = await runParkedTicket();
  // resume into a runner that parks AGAIN — exit 75
  const second = await resumeParkedTicket(parked, { parkAgain: true });
  expect(second.result.outcome).toBe("parked");
  // resume a second time into a success runner — should complete
  const third = await resumeParkedTicket(parked, {});
  expect(third.result.outcome === "pr-ready" || third.result.outcome === "done").toBe(true);
  // And the run completed — a dispatch definitely happened
  expect(third.ran).toBe(true);

  // ENG-164 invariant: open the dump DB and confirm parks burned no retry budget.
  const dbPath = join(parked.dumpDir, "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);
  // The implement step should have attempt=1 (exactly one real successful execution, not 3).
  const implStep = db
    .query<{ attempt: number }, []>(
      "SELECT attempt FROM workflow_step WHERE step_key LIKE 'implement%' ORDER BY id LIMIT 1",
    )
    .get();
  expect(implStep).not.toBeNull();
  expect(implStep?.attempt).toBe(1); // 2 parks (attempt-neutral) + 1 real run = attempt 1

  // No escalation was raised: a human_resume signal means the failure policy fired on a park.
  const escalation = db
    .query<{ id: number }, []>("SELECT id FROM signal WHERE signal_type = 'human_resume' LIMIT 1")
    .get();
  expect(escalation).toBeNull(); // no escalation raised — retry budget was NOT exhausted
  db.close();
  cleanupParkedRun(parked);
});
