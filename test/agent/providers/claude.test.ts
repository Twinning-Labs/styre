import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  assistantText,
  buildClaudeArgs,
  claudeAgentRunner,
  parseClaudeJson,
} from "../../../src/agent/providers/claude.ts";
import { extractSidecar } from "../../../src/dispatch/sidecar.ts";

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

test("parseClaudeJson extracts usage incl. cache tokens, tolerating missing fields", () => {
  const good = parseClaudeJson(
    JSON.stringify({
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 2,
      },
    }),
  );
  expect(good.costUsd).toBe(0.5);
  expect(good.tokensIn).toBe(10);
  expect(good.cacheRead).toBe(7);
  expect(good.cacheCreate).toBe(2);
  // cache fields absent → null (not every response reports them)
  const noCache = parseClaudeJson(JSON.stringify({ usage: { input_tokens: 1 } }));
  expect(noCache.cacheRead).toBeNull();
  expect(noCache.cacheCreate).toBeNull();
  const bad = parseClaudeJson("not json");
  expect(bad).toEqual({
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cacheRead: null,
    cacheCreate: null,
  });
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
  // ENG-164: timeout path must classify as transient with no reset date
  expect(r.cause).toBe("transient");
  expect(r.resetAt).toBeNull();
});

test("run classifies spawn failure as transient (non-existent command)", async () => {
  const r = await claudeAgentRunner("/nonexistent-styre-claude-cli").run({
    ...runInput,
    timeoutMs: 5000,
  });
  expect(r.completed).toBe(false);
  expect(r.timedOut).toBe(false);
  // ENG-164: spawn failure goes through the catch branch → transportFailure → cause: "transient"
  expect(r.cause).toBe("transient");
  expect(r.resetAt).toBeNull();
});

test("assistantText unwraps the envelope result field, falling back to raw", () => {
  const raw = JSON.stringify({ result: "hello\nworld", usage: { input_tokens: 1 } });
  expect(assistantText(raw)).toBe("hello\nworld");
  // no result field → raw passthrough (never the string "undefined")
  const noResult = JSON.stringify({ usage: { input_tokens: 1 } });
  expect(assistantText(noResult)).toBe(noResult);
  expect(assistantText("not json")).toBe("not json");
});

test("a claude success carrying a sidecar block yields extractable stdout (regression)", async () => {
  const sidecar = `\`\`\`styre-sidecar\n${JSON.stringify({ n: 5 })}\n\`\`\``;
  // real claude wraps assistant text (incl. the fenced block) inside the json envelope's `result`
  const envelope = JSON.stringify({ result: `done\n${sidecar}`, usage: { input_tokens: 1 } });
  const cli = fakeCli("claude-sidecar", `cat <<'EOF'\n${envelope}\nEOF`);
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(true);
  const parsed = extractSidecar(r.stdout, z.object({ n: z.number() }));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.n).toBe(5);
});
