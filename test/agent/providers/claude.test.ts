import { expect, test } from "bun:test";
import { buildClaudeArgs, parseClaudeJson } from "../../../src/agent/providers/claude.ts";

test("buildClaudeArgs assembles -p, json output, model, and allowed tools", () => {
  const args = buildClaudeArgs({ model: "claude-opus-4-8", allowedTools: ["Read", "Write"] });
  expect(args).toContain("-p");
  expect(args).toContain("--model");
  expect(args).toContain("claude-opus-4-8");
  expect(args.join(" ")).toContain("Read");
});

test("parseClaudeJson extracts usage, tolerating missing fields", () => {
  const good = parseClaudeJson(
    JSON.stringify({ total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 3 } }),
  );
  expect(good.costUsd).toBe(0.5);
  expect(good.tokensIn).toBe(10);
  const bad = parseClaudeJson("not json");
  expect(bad).toEqual({ costUsd: null, tokensIn: null, tokensOut: null });
});
