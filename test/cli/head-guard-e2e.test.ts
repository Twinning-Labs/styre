import { expect, test } from "bun:test";
import { advanceBranchHead, resumeParkedTicket, runParkedTicket } from "../helpers/run-harness.ts";

test("a moved HEAD refuses plain --resume with exit 65 and changes nothing", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked); // operator commits on the branch after the park
  const { exitCode, ran } = await resumeParkedTicket(parked, {}); // no flags
  expect(exitCode).toBe(65);
  expect(ran).toBe(false); // no dispatch happened
});

test("--inspect on a moved HEAD prints diagnostics, exits 0, changes nothing", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked);
  const { exitCode, ran } = await resumeParkedTicket(parked, { inspect: true });
  expect(exitCode).toBe(0);
  expect(ran).toBe(false); // no dispatch happened
});

test("--accept-head resumes against the new HEAD WITHOUT carryover", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked);
  const { prompts, result } = await resumeParkedTicket(parked, { acceptHead: true });
  // The carryover advisory must NOT appear — it was dropped because the base changed.
  expect(prompts.some((p) => p.includes("previous attempt was interrupted"))).toBe(false);
  expect(result.outcome === "pr-ready" || result.outcome === "done").toBe(true);
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
});
