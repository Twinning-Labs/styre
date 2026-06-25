import { expect, test } from "bun:test";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunResult } from "../../src/agent/runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import type { Component } from "../../src/dispatch/profile.ts";
import { discoverComponents } from "../../src/setup/discover.ts";

const ok = (stdout: string): AgentRunResult => ({
  completed: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});

const notCompleted = (): AgentRunResult => ({
  completed: false,
  exitCode: 1,
  stdout: "",
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});

function sidecar(json: string): string {
  return `Here is the discovery result:\n\`\`\`styre-setup-discover\n${json}\n\`\`\`\n`;
}

const SCAN_COMPONENTS: Component[] = [
  {
    name: "rust-core",
    kind: "rust",
    paths: ["src-tauri/**", "crates/**"],
    commands: { build: "cargo build --workspace", test: "cargo test --workspace" },
  },
  {
    name: "frontend",
    kind: "node",
    paths: ["src/**", "static/**", "package.json"],
    commands: { build: "npm run build" },
  },
];

test("agent refines kind/commands; scan paths are preserved; non-existent command is dropped", async () => {
  const agentProposal = {
    components: [
      {
        name: "rust-core",
        kind: "rust",
        paths: ["src-tauri/**", "crates/**"],
        commands: {
          build: "cargo build --workspace",
          test: "cargo test --workspace",
          check: "cargo clippy --workspace",
          // fabricated nonexistent command — should be dropped by the probe
          lint: "definitely-not-a-real-binary-xyz --lint",
        },
      },
      {
        name: "frontend",
        kind: "sveltekit",
        paths: ["src/**", "static/**", "package.json", "vite.config.js"],
        commands: { build: "vite build", check: "svelte-check" },
      },
    ],
    repoCommands: {},
  };

  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(agentProposal))));
  const result = await discoverComponents(
    process.cwd(), // use cwd so `git` binary resolves; vite/svelte-check may not be present
    { components: SCAN_COMPONENTS, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
  );

  // Scan paths are preserved
  const rust = result.components.find((c) => c.name === "rust-core");
  expect(rust?.paths).toContain("src-tauri/**");
  expect(rust?.paths).toContain("crates/**");

  // Agent-refined kind adopted
  const fe = result.components.find((c) => c.name === "frontend");
  expect(fe?.kind).toBe("sveltekit");

  // Fabricated nonexistent command dropped by probe
  expect(rust?.commands.lint).toBeUndefined();

  // cargo and git commands should survive (cargo may or may not be present, skip if not)
  // but the nonexistent binary is definitely gone
  expect(rust?.commands).not.toHaveProperty("lint");
});

test("agent failure (completed=false) → scan returned unchanged", async () => {
  const runner = new FakeAgentRunner(() => notCompleted());
  const result = await discoverComponents(
    process.cwd(),
    { components: SCAN_COMPONENTS, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
  );
  expect(result.components).toBe(SCAN_COMPONENTS); // exact same reference (no copy made on fallback)
  expect(result.repoCommands).toEqual({});
});

test("agent timedOut → scan returned unchanged", async () => {
  const runner = new FakeAgentRunner((): AgentRunResult => ({ ...ok(""), timedOut: true }));
  const result = await discoverComponents(
    process.cwd(),
    { components: SCAN_COMPONENTS, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
  );
  expect(result.components).toBe(SCAN_COMPONENTS);
});

test("agent no sidecar block → scan returned unchanged", async () => {
  const runner = new FakeAgentRunner(() => ok("I looked around but found nothing useful."));
  const result = await discoverComponents(
    process.cwd(),
    { components: SCAN_COMPONENTS, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
  );
  expect(result.components).toBe(SCAN_COMPONENTS);
});

test("discover passes read-only tools + standard model + repoDir as cwd", async () => {
  // Use notCompleted so the probe never runs (avoids needing the cwd to exist).
  const runner = new FakeAgentRunner(() => notCompleted());
  await discoverComponents(
    "/tmp/test-repo",
    { components: SCAN_COMPONENTS, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
  );
  const input = runner.inputs[0];
  expect(input?.allowedTools).toEqual(["Read", "Grep", "Glob"]);
  expect(input?.model).toBe("claude-sonnet-4-6");
  expect(input?.cwd).toBe("/tmp/test-repo");
});

test("repoCommands from agent are adopted in result", async () => {
  const agentProposal = {
    components: SCAN_COMPONENTS,
    repoCommands: { integration: "git status" },
  };
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(agentProposal))));
  const result = await discoverComponents(
    process.cwd(),
    { components: SCAN_COMPONENTS, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
  );
  expect(result.repoCommands.integration).toBe("git status");
});
