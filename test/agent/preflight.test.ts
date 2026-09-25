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

/** `claude --help` excerpt carrying every flag the adapter pins (ENG-476). */
const FULL_HELP = [
  '  --output-format <format>  (choices: "text", "json", "stream-json")',
  '  --permission-mode <mode>  (choices: "acceptEdits", "auto", "dontAsk", "plan")',
  "  --restricted              Restricted mode: removes the built-in tools that run commands",
  "  --strict-mcp-config       Only use MCP servers from --mcp-config",
  "  --tools <tools...>        Specify the list of available tools from the built-in set.",
  "  --allowedTools, --allowed-tools <tools...>",
].join("\n");
const fullHelp = () => ({ ok: true, output: FULL_HELP });

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
    runVersion: () => ({ ok: true, output: "2.1.280 (Claude Code)" }),
    runHelp: fullHelp,
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: true, version: "2.1.280" });
});

test("present + below floor → unsupported-version with found/required", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "claude 2.1.216" }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "unsupported-version",
    command: "claude",
    found: "2.1.216",
    required: "2.1.280",
  });
});

test("codex is refused before its install or version is examined, so the first error is the real one", () => {
  const missing = preflightAgentCli(codexConfig, { onPath: () => false, env: env({}) });
  expect(missing).toEqual({ ok: false, reason: "provider-not-enforceable", command: "codex" });
  const old = preflightAgentCli(codexConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "codex-cli 0.139.0" }),
    env: env({ OPENAI_API_KEY: "x" }),
  });
  expect(old).toEqual({ ok: false, reason: "provider-not-enforceable", command: "codex" });
});

test("unparseable --version → fail-open (ok, version null)", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "a future format with no dotted number" }),
    runHelp: fullHelp,
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: true, version: null });
});

test("present + required env key unset → ok with unauthHint", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.280" }),
    runHelp: fullHelp,
    env: env({}),
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.unauthHint).toMatch(/ANTHROPIC_API_KEY/);
});

test("claude whose --help lacks a pinned flag → missing-capability naming every missing flag (ENG-476)", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.280" }),
    runHelp: () => ({
      ok: true,
      output: FULL_HELP.replace("--restricted", "--unrelated").replace("dontAsk", "manual"),
    }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "missing-capability",
    command: "claude",
    missing: ["--restricted", "--permission-mode dontAsk"],
  });
});

test("claude --help that cannot be run → missing-capability (fail closed, never assumed)", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.280" }),
    runHelp: () => ({ ok: false, output: "" }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("missing-capability");
});

test("codex at a supported version → provider-not-enforceable (refused until ENG-484)", () => {
  const r = preflightAgentCli(codexConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "codex-cli 0.156.1" }),
    env: env({ OPENAI_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: false, reason: "provider-not-enforceable", command: "codex" });
});

test("a flag named only inside another option's description does not count as supported", () => {
  const help = FULL_HELP.replace(
    "  --tools <tools...>        Specify the list of available tools from the built-in set.",
    "  --restricted-extra        Removes tools unless --tools names them.",
  );
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.280" }),
    runHelp: () => ({ ok: true, output: help }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "missing-capability",
    command: "claude",
    missing: ["--tools"],
  });
});

test("a wrapped description line starting with a flag (the real 2.1.280 --help shape) does not count", () => {
  const help = FULL_HELP.replace(
    "  --tools <tools...>        Specify the list of available tools from the built-in set.",
    "                                        --tools names them, and ignores user,",
  );
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.280" }),
    runHelp: () => ({ ok: true, output: help }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "missing-capability",
    command: "claude",
    missing: ["--tools"],
  });
});

test("a required choice counts only inside its own option, not anywhere in the help", () => {
  const help = `${FULL_HELP.replace('"dontAsk", ', "")}\n  --other <x>  mentions dontAsk here`;
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.280" }),
    runHelp: () => ({ ok: true, output: help }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "missing-capability",
    command: "claude",
    missing: ["--permission-mode dontAsk"],
  });
});
