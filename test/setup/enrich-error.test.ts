import { expect, test } from "bun:test";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunResult } from "../../src/agent/runner.ts";
import { StyreError } from "../../src/cli/errors.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";
import { enrichRuntimeContext } from "../../src/setup/enrich.ts";

const scan = (o: unknown) => RuntimeContextSchema.parse(o);
const noSleep = () => Promise.resolve();

/** Always-failing agent CLI result: exits non-zero with a real stderr message. */
const failing: AgentRunResult = {
  completed: false,
  exitCode: 1,
  stdout: "",
  stderr: "boom-from-cli",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
};

test("enrich surfaces the agent CLI's real stderr in a configError on exhaustion", async () => {
  const runner = new FakeAgentRunner(() => failing);
  try {
    await enrichRuntimeContext("/tmp/repo", scan({}), {
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      sleep: noSleep,
    });
    throw new Error("expected enrichRuntimeContext to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(StyreError);
    const se = e as StyreError;
    expect(se.code).toBe(78); // EXIT.CONFIG — operator-fixable, not a bug
    expect(se.detail).toContain("boom-from-cli");
  }
});
