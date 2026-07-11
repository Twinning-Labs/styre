import { expect, test } from "bun:test";
import { agentEnv, verifyEnv } from "../../src/agent/agent-env.ts";

const parent = { PATH: "/usr/bin", LINEAR_API_KEY: "l", GITHUB_TOKEN: "g", ANTHROPIC_API_KEY: "a" };

test("agentEnv strips Linear/GitHub but KEEPS Anthropic (agent CLI needs it)", () => {
  const e = agentEnv(parent);
  expect(e.PATH).toBe("/usr/bin");
  expect(e.LINEAR_API_KEY).toBeUndefined();
  expect(e.GITHUB_TOKEN).toBeUndefined();
  expect(e.ANTHROPIC_API_KEY).toBe("a");
});

test("verifyEnv additionally strips Anthropic (verify runs agent-authored code)", () => {
  const e = verifyEnv(parent);
  expect(e.PATH).toBe("/usr/bin"); // toolchain still runs
  expect(e.LINEAR_API_KEY).toBeUndefined();
  expect(e.GITHUB_TOKEN).toBeUndefined();
  expect(e.ANTHROPIC_API_KEY).toBeUndefined();
});

test("verifyEnv strips every provider key (F4 holds for codex too)", () => {
  const e = verifyEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "o",
    CODEX_API_KEY: "c",
    CODEX_ACCESS_TOKEN: "t",
  });
  expect(e.PATH).toBe("/usr/bin");
  expect(e.ANTHROPIC_API_KEY).toBeUndefined();
  expect(e.OPENAI_API_KEY).toBeUndefined();
  expect(e.CODEX_API_KEY).toBeUndefined();
  expect(e.CODEX_ACCESS_TOKEN).toBeUndefined();
});

test("agentEnv keeps OPENAI_API_KEY (codex CLI needs it)", () => {
  const e = agentEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "o", GITHUB_TOKEN: "g" });
  expect(e.OPENAI_API_KEY).toBe("o");
  expect(e.GITHUB_TOKEN).toBeUndefined();
});
