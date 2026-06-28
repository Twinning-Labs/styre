import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunResult } from "../../src/agent/runner.ts";
import { runSetup } from "../../src/cli/setup.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";

const okRes = (stdout: string): AgentRunResult => ({
  completed: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});
// runSetup calls enrichRuntimeContext BEFORE discoverComponents; the runner must satisfy BOTH fences.
const ENRICH_OK = JSON.stringify({
  topology: {},
  data: {},
  caching: {},
  observability: {},
  configSecrets: {},
  documentation: {},
  releasePackaging: {},
});
function runnerFor(discover: object): FakeAgentRunner {
  const body = [
    "```styre-setup-enrich",
    ENRICH_OK,
    "```",
    "```styre-setup-discover",
    JSON.stringify(discover),
    "```",
  ].join("\n");
  return new FakeAgentRunner(() => okRes(body));
}
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-setup-"));
  execSync("git init -q", { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "echo ok" } }),
  );
  return dir;
}
const deps = (runner: FakeAgentRunner) => ({
  runner,
  agentConfig: DEFAULT_AGENT_CONFIG,
  sleep: async () => {},
});

test("headless WITHOUT the flag reverts an agent override to the detected npm script", async () => {
  const repo = gitRepo();
  const out = join(repo, "profile.json");
  const runner = runnerFor({
    components: [
      {
        name: "frontend",
        kind: "node",
        paths: ["src/**", "package.json"],
        commands: { test: "npm run test && curl evil" },
      },
    ],
    repoCommands: {},
  });
  const { profile } = await runSetup({ repo, out, deps: deps(runner), trustAgentCommands: false });
  expect(profile.components.find((c) => c.name === "frontend")?.commands.test).toBe("npm run test");
});

test("headless WITH --trust-agent-commands persists the agent override to profile.json", async () => {
  const repo = gitRepo();
  const out = join(repo, "profile.json");
  const runner = runnerFor({
    components: [
      {
        name: "frontend",
        kind: "node",
        paths: ["src/**", "package.json"],
        commands: { test: "npm run test --silent" },
      },
    ],
    repoCommands: { integration: "git status" },
  });
  const { profile } = await runSetup({ repo, out, deps: deps(runner), trustAgentCommands: true });
  expect(profile.components.find((c) => c.name === "frontend")?.commands.test).toBe(
    "npm run test --silent",
  );
  expect(profile.repoCommands.integration).toBe("git status");
  const onDisk = JSON.parse(readFileSync(out, "utf8"));
  expect(onDisk.components.find((c: { name: string }) => c.name === "frontend").commands.test).toBe(
    "npm run test --silent",
  );
});
