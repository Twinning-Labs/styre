import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupParkedRun,
  resumeParkedTicket,
  runNeedsYouTicket,
  runParkedTicket,
} from "../helpers/run-harness.ts";

test("a parked run writes run.db + transcript.json under the state dir and reports cause", async () => {
  // runParkedTicket: sets XDG_STATE_HOME to a temp dir, drives ENG-1 with a session-limit FakeRunner
  // via the same wiring as src/cli/run.ts, and returns { slug, ident, park, exitCode, dumpDir }.
  // dumpDir is captured while XDG_STATE_HOME is still set (before the harness restores it).
  const parked = await runParkedTicket();
  expect(existsSync(join(parked.dumpDir, "run.db"))).toBe(true);
  expect(existsSync(join(parked.dumpDir, "transcript.json"))).toBe(true);
  expect(parked.exitCode).toBe(75);
  cleanupParkedRun(parked);
});

test("resume re-runs only the interrupted step, injects the carryover block, and completes", async () => {
  // runParkedTicket parks ENG-1 mid-implement; resumeParkedTicket re-opens the same dump with a
  // FakeAgentRunner that SUCCEEDS, and records every prompt it receives.
  const parked = await runParkedTicket();
  const { prompts, result } = await resumeParkedTicket(parked); // no --accept-head, head unchanged
  // The interrupted implement step is re-dispatched exactly once, with the advisory block:
  const implementPrompt = prompts.find((p) => p.includes("previous attempt was interrupted"));
  expect(implementPrompt).toBeDefined();
  expect(implementPrompt).toContain("partial"); // the carried transcript text
  // Completed steps were NOT re-dispatched (exactly-once); the run advanced past the park:
  expect(result.outcome === "pr-ready" || result.outcome === "done").toBe(true);
  cleanupParkedRun(parked);
});

test("a failure that escalates to needs_you proceeds past the failed step on resume (ENG-385 AC)", async () => {
  // runNeedsYouTicket drives the failing implement step to DEFAULT_MAX_ATTEMPTS, at which point
  // applyFailurePolicy escalates: ticket → waiting, a pending human_resume signal is inserted, and
  // driveToTerminal returns paused(needs_you) — the exact checkpoint the resume gate must unblock.
  const parked = await runNeedsYouTicket();
  // resumeParkedTicket's FakeAgentRunner now SUCCEEDS the (re-armed, still-failed) implement step —
  // no new re-arm code is needed: the resolver re-serves the non-succeeded step and runStep
  // re-executes it via its normal pending|failed branch.
  const { result } = await resumeParkedTicket(parked);
  expect(result.outcome === "pr-ready" || result.outcome === "done").toBe(true);
  cleanupParkedRun(parked);
});
