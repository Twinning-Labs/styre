import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunResult } from "../../src/agent/runner.ts";
import { EXIT, StyreError } from "../../src/cli/errors.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";
import { discoverComponents } from "../../src/setup/discover.ts";
import { enrichRuntimeContext } from "../../src/setup/enrich.ts";

// ENG-476: setup's agent steps run on the developer's repository like every other step, so a
// provider that did not confine the agent must stop setup loudly — never a silent fallback to
// machine observations and never a retry against the same unconfined provider.

const widened: AgentRunResult = {
  completed: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
  capabilities: { tools: ["Glob", "Grep", "Read", "Bash"], error: null },
};

test("discovery refuses an unconfined agent instead of falling back to machine observations", async () => {
  let calls = 0;
  const runner = new FakeAgentRunner(() => {
    calls++;
    return widened;
  });
  const err = await discoverComponents(
    process.cwd(),
    { components: [], repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
    { interactive: false, trustAgentCommands: true },
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StyreError);
  expect((err as StyreError).code).toBe(EXIT.TOOLCHAIN_MISSING);
  expect((err as StyreError).headline).toMatch(/could not confirm the agent was confined/);
  expect((err as StyreError).detail).toContain("unexpected tools: Bash");
  expect(calls).toBe(1);
});

test("enrichment refuses an unconfined agent on the first attempt, without retrying", async () => {
  let calls = 0;
  const runner = new FakeAgentRunner(() => {
    calls++;
    return widened;
  });
  const err = await enrichRuntimeContext("/tmp/repo", RuntimeContextSchema.parse({}), {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: () => Promise.resolve(),
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StyreError);
  expect((err as StyreError).code).toBe(EXIT.TOOLCHAIN_MISSING);
  expect((err as StyreError).detail).toContain("unexpected tools: Bash");
  expect(calls).toBe(1);
});

/** Every agent launch goes through `launchAgent` (ENG-476, class guard): outside the agent layer,
 *  no source file may call `.run(` on a runner directly — a new call site that bypasses the
 *  confinement check fails here instead of shipping unverified. */
test("no source file outside the agent layer calls a runner's .run( directly", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  const src = join(import.meta.dir, "../../src");
  walk(src);
  // The agent layer itself: the helper, the interface, the providers, the test double.
  const agentLayer = new Set(
    [
      "agent/launch.ts",
      "agent/runner.ts",
      "agent/fake-runner.ts",
      "agent/registry.ts",
      "agent/resolve.ts",
    ].map((f) => join(src, f)),
  );
  const direct = /\b\w*[Rr]unner\w*\s*\.\s*run\s*\(/;
  const offenders = files.filter(
    (f) =>
      !agentLayer.has(f) &&
      !f.includes(`${join(src, "agent", "providers")}`) &&
      direct.test(readFileSync(f, "utf8")),
  );
  expect(offenders).toEqual([]);
  // The guard must be able to see a violation: the helper itself matches the pattern.
  expect(direct.test(readFileSync(join(src, "agent/launch.ts"), "utf8"))).toBe(true);
});

test("discovery also refuses a FAILED run its provider stopped for a wrong tool set", async () => {
  const runner = new FakeAgentRunner(() => ({
    ...widened,
    completed: false,
    exitCode: null,
    capabilities: { tools: ["Read", "Bash"], error: "stopped at startup: unexpected tools: Bash" },
  }));
  const err = await discoverComponents(
    process.cwd(),
    { components: [], repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
    { interactive: false, trustAgentCommands: true },
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StyreError);
  expect((err as StyreError).detail).toContain("stopped at startup");
});
