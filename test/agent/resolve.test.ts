import { expect, test } from "bun:test";
import { resolveAgentRunner } from "../../src/agent/resolve.ts";
import { CODEX_PRESET, DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";

test("resolveAgentRunner returns a runner for claude and for codex", () => {
  expect(typeof resolveAgentRunner(DEFAULT_AGENT_CONFIG).run).toBe("function");
  expect(typeof resolveAgentRunner(CODEX_PRESET).run).toBe("function");
  expect(CODEX_PRESET.provider).toBe("codex");
});

test("resolveAgentRunner throws for an unregistered provider", () => {
  expect(() =>
    resolveAgentRunner({ provider: "nope", models: { deep: "d", standard: "s", cheap: "c" } }),
  ).toThrow();
});
