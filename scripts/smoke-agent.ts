// Manual smoke (NOT run in CI): exercises the REAL configured provider via resolveAgentRunner.
// Usage: bun run scripts/smoke-agent.ts <path-to-git-repo> [codex]
// Requires the configured agent CLI installed + authenticated (default provider: claude).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentRunner } from "../src/agent/resolve.ts";
import { resolveTier } from "../src/agent/tiers.ts";
import { CODEX_PRESET, DEFAULT_AGENT_CONFIG, modelForTier } from "../src/config/agent-config.ts";
import { allowlistFor } from "../src/dispatch/tool-allowlists.ts";
import { ensureWorktree } from "../src/dispatch/worktree.ts";

const repo = process.argv[2];
if (!repo) {
  throw new Error("usage: bun run scripts/smoke-agent.ts <git-repo-path> [codex]");
}
const provider = process.argv[3]; // optional: "codex"
const config = provider === "codex" ? CODEX_PRESET : DEFAULT_AGENT_CONFIG;
const runner = resolveAgentRunner(config);
const wt = join(mkdtempSync(join(tmpdir(), "styre-smoke-")), "wt");
ensureWorktree(repo, "feat/styre-smoke", wt);
const result = await runner.run({
  prompt: "Create a file HELLO.txt containing the word styre. Do not commit.",
  model: modelForTier(config, resolveTier("implement:dispatch")),
  allowedTools: allowlistFor("implement:dispatch"),
  cwd: wt,
  timeoutMs: 5 * 60 * 1000,
  onSpawn: (pid) => console.log("agent pid:", pid),
});
console.log("completed:", result.completed, "exit:", result.exitCode, "timedOut:", result.timedOut);
console.log("usage:", {
  costUsd: result.costUsd,
  tokensIn: result.tokensIn,
  tokensOut: result.tokensOut,
});
console.log("stdout (first 500):", result.stdout.slice(0, 500));
