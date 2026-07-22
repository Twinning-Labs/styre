import { afterEach, expect, test } from "bun:test";

afterEach(() => {
  process.exitCode = 0;
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupImpl } from "../../src/cli/setup.ts";

// A hermetic runtime config whose agent.command points at a guaranteed-absent binary.
function writeBadAgentConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-setup-agentpf-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      agent: {
        provider: "claude",
        command: "styre-absent-agent-cli-xyz",
        models: { deep: "d", standard: "s", cheap: "c" },
      },
    }),
  );
  return path;
}

test("setup: a missing agent CLI fails the gate (exit 69 error) before invoking the agent", async () => {
  // Set the required env key so the EXISTING env-key gate passes and we reach the new CLI probe.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const repo = mkdtempSync(join(tmpdir(), "styre-setup-agentpf-repo-"));
  const config = writeBadAgentConfig();
  try {
    await expect(
      // explicit `repo` arg skips the in-place marker gate; explicit `config` is hermetic.
      setupImpl({ args: { _: [], repo, config } as never }),
    ).rejects.toThrow(/not installed or not on PATH/);
  } finally {
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
