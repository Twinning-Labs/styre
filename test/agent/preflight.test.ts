import { expect, test } from "bun:test";
import { compareVersions, parseCliVersion, preflightAgentCli } from "../../src/agent/preflight.ts";
import type { AgentConfig } from "../../src/config/agent-config.ts";

const claudeConfig: AgentConfig = {
  provider: "claude",
  command: "claude",
  models: { deep: "d", standard: "s", cheap: "c" },
};
const codexConfig: AgentConfig = {
  provider: "codex",
  command: "codex",
  models: { deep: "d", standard: "s", cheap: "c" },
};
const env = (e: Record<string, string>): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

test("parseCliVersion takes the LAST full MAJOR.MINOR.PATCH triple (skips leading date AND trailing 2-part noise)", () => {
  expect(parseCliVersion("2.1.216 (Claude Code)")).toEqual([2, 1, 216]);
  expect(parseCliVersion("codex-cli 0.144.6")).toEqual([0, 144, 6]);
  expect(parseCliVersion("2026.07.22 build; claude 2.1.216")).toEqual([2, 1, 216]); // leading date skipped
  expect(parseCliVersion("claude 2.1.216 (build 1.2)")).toEqual([2, 1, 216]); // trailing 2-part fragment skipped
  expect(parseCliVersion("no version here")).toBeNull();
  expect(parseCliVersion("claude 2.1")).toBeNull(); // fewer than 3 components → unreadable → caller fails open
});

test("compareVersions orders by major, then minor, then patch", () => {
  expect(compareVersions([2, 1, 216], [2, 1, 200])).toBe(1);
  expect(compareVersions([2, 1, 200], [2, 1, 200])).toBe(0);
  expect(compareVersions([2, 0, 9], [2, 1, 200])).toBe(-1);
});

test("missing binary → { ok:false, reason:'missing' }", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => false,
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: false, reason: "missing", command: "claude" });
});

test("present + supported version → ok", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.216 (Claude Code)" }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: true, version: "2.1.216" });
});

test("present + below floor → unsupported-version with found/required", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "claude 2.0.9" }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "unsupported-version",
    command: "claude",
    found: "2.0.9",
    required: "2.1.200",
  });
});

test("codex below its own floor → unsupported-version", () => {
  const r = preflightAgentCli(codexConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "codex-cli 0.139.0" }),
    env: env({ OPENAI_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "unsupported-version",
    command: "codex",
    found: "0.139.0",
    required: "0.140.0",
  });
});

test("unparseable --version → fail-open (ok, version null)", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "a future format with no dotted number" }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: true, version: null });
});

test("present + required env key unset → ok with unauthHint", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.216" }),
    env: env({}),
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.unauthHint).toMatch(/ANTHROPIC_API_KEY/);
});
