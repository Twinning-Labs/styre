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
