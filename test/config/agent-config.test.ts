import { expect, test } from "bun:test";
import {
  DEFAULT_AGENT_CONFIG,
  modelForTier,
  parseAgentConfig,
  requiredEnvFor,
} from "../../src/config/agent-config.ts";

test("the default config is the Claude preset", () => {
  expect(DEFAULT_AGENT_CONFIG.provider).toBe("claude");
  expect(DEFAULT_AGENT_CONFIG.command).toBe("claude");
  expect(DEFAULT_AGENT_CONFIG.models.deep).toBe("claude-opus-4-8");
  expect(DEFAULT_AGENT_CONFIG.models.standard).toBe("claude-sonnet-4-6");
  expect(DEFAULT_AGENT_CONFIG.models.cheap).toBe("claude-haiku-4-5-20251001");
});

test("parseAgentConfig validates a custom provider config", () => {
  const cfg = parseAgentConfig({
    provider: "acme",
    command: "acme-cli",
    models: { deep: "a-big", standard: "a-mid", cheap: "a-small" },
  });
  expect(cfg.provider).toBe("acme");
  expect(modelForTier(cfg, "standard")).toBe("a-mid");
});

test("parseAgentConfig rejects a config missing a tier model", () => {
  expect(() => parseAgentConfig({ provider: "x", models: { deep: "d", standard: "s" } })).toThrow();
});

test("modelForTier resolves each tier", () => {
  expect(modelForTier(DEFAULT_AGENT_CONFIG, "deep")).toBe("claude-opus-4-8");
  expect(modelForTier(DEFAULT_AGENT_CONFIG, "cheap")).toBe("claude-haiku-4-5-20251001");
});

test("requiredEnvFor maps providers to their auth env var", () => {
  expect(requiredEnvFor("claude")).toBe("ANTHROPIC_API_KEY");
  expect(requiredEnvFor("codex")).toBe("OPENAI_API_KEY");
  expect(requiredEnvFor("unknown")).toBeUndefined();
});
