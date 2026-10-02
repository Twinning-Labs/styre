import { RunInterrupted } from "../util/process/door.ts";
import { capabilityFault } from "./capabilities.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./runner.ts";

/** The ONLY sanctioned way to run an agent (ENG-476). Runs it, then decides whether its
 *  confinement is confirmed. `fault` is non-null when the run must not be trusted:
 *  - a completed run must carry a clean capability report matching the step's allowlist;
 *  - a failed run is checked too whenever the provider reported anything (e.g. an agent killed at
 *    startup for a wrong tool set), so an unconfined run is never retried as an ordinary failure.
 *  A failed run with no report (it died before reporting) is an ordinary failure: fault is null.
 *  An agent stopped by the signal handler (`result.interrupted`) makes this throw `RunInterrupted`
 *  (ENG-485 section 7.5), for both `run` and `setup`; the caller never sees such a result.
 *  A source guard (test/setup/agent-confinement.test.ts) fails if any other file calls `.run(`
 *  with a tool allowlist. */
export async function launchAgent(
  runner: AgentRunner,
  input: AgentRunInput,
): Promise<{ result: AgentRunResult; fault: string | null }> {
  const result = await runner.run(input);
  if (result.interrupted) throw new RunInterrupted();
  const mustCheck = (result.completed && !result.timedOut) || result.capabilities !== undefined;
  return {
    result,
    fault: mustCheck ? capabilityFault(input.allowedTools, result.capabilities) : null,
  };
}
