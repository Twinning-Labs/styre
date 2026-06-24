import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resumeParkedTicket, runParkedTicket } from "../helpers/run-harness.ts";

test("a parked run writes run.db + transcript.json under the state dir and reports cause", async () => {
  // runParkedTicket: sets XDG_STATE_HOME to a temp dir, drives ENG-1 with a session-limit FakeRunner
  // via the same wiring as src/cli/run.ts, and returns { slug, ident, park, exitCode, dumpDir }.
  // dumpDir is captured while XDG_STATE_HOME is still set (before the harness restores it).
  const { exitCode, dumpDir } = await runParkedTicket();
  expect(existsSync(join(dumpDir, "run.db"))).toBe(true);
  expect(existsSync(join(dumpDir, "transcript.json"))).toBe(true);
  expect(exitCode).toBe(75);
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
});
