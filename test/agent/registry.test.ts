import { expect, test } from "bun:test";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { selectAgentRunner } from "../../src/agent/registry.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";

const ok = {
  completed: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
};

test("selectAgentRunner returns the adapter for the configured provider", () => {
  const runner = new FakeAgentRunner(() => ok);
  const selected = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => runner });
  expect(selected).toBe(runner);
});

test("selectAgentRunner throws for an unregistered provider", () => {
  expect(() =>
    selectAgentRunner({ provider: "nope", models: { deep: "d", standard: "s", cheap: "c" } }, {}),
  ).toThrow();
});

test("FakeAgentRunner records inputs and fires onSpawn", async () => {
  const seen: number[] = [];
  const runner = new FakeAgentRunner(() => ok);
  await runner.run({
    prompt: "p",
    model: "m",
    allowedTools: [],
    cwd: "/tmp",
    timeoutMs: 1,
    onSpawn: (pid) => seen.push(pid),
  });
  expect(seen).toEqual([424242]);
  expect(runner.inputs[0]?.prompt).toBe("p");
});
