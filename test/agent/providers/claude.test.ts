import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeArgs,
  claudeAgentRunner,
  parseClaudeJson,
} from "../../../src/agent/providers/claude.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "styre-claude-")));

/** Write an executable stand-in for the `claude` CLI that ignores its argv and runs `body`. */
function fakeCli(name: string, body: string): string {
  const path = join(cwd, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const runInput = { prompt: "hi", model: "m", allowedTools: ["Read"], cwd, timeoutMs: 5000 };

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

test("run captures a clean exit, parses usage, and journals the pid", async () => {
  const cli = fakeCli(
    "claude-ok",
    'echo \'{"total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":3}}\'',
  );
  let pid: number | undefined;
  const r = await claudeAgentRunner(cli).run({
    ...runInput,
    onSpawn: (p) => {
      pid = p;
    },
  });
  expect(r.completed).toBe(true);
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.costUsd).toBe(0.5);
  expect(typeof pid).toBe("number");
});

// M1: the timeout is a HARD bound — a process that ignores SIGTERM must still be killed and the
// call must return promptly (not hang on `proc.exited`).
test("run SIGKILLs and returns promptly on a process that traps SIGTERM and hangs", async () => {
  // trap '' TERM → ignore SIGTERM; then sleep far past the timeout. Only SIGKILL ends it.
  const cli = fakeCli("claude-hang", "trap '' TERM\nsleep 30");
  const start = Date.now();
  const r = await claudeAgentRunner(cli).run({ ...runInput, timeoutMs: 300 });
  const elapsed = Date.now() - start;
  expect(r.timedOut).toBe(true);
  expect(r.completed).toBe(false);
  expect(elapsed).toBeLessThan(5000); // returned on the timer, not after the 30s sleep
});
