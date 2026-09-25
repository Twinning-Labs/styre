import { expect, test } from "bun:test";
import { resolveAgentRunner } from "../../src/agent/resolve.ts";
import { CODEX_PRESET, DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";

test("resolveAgentRunner returns a runner for claude and for codex", () => {
  expect(typeof resolveAgentRunner(DEFAULT_AGENT_CONFIG).run).toBe("function");
  expect(typeof resolveAgentRunner(CODEX_PRESET).run).toBe("function");
  expect(CODEX_PRESET.provider).toBe("codex");
});

test("resolveAgentRunner throws for an unregistered provider", () => {
  expect(() =>
    resolveAgentRunner({ provider: "nope", models: { deep: "d", standard: "s", cheap: "c" } }),
  ).toThrow();
});

test("the wired codex runner refuses before spawning anything, and says why (ENG-476)", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "styre-codex-refuse-"));
  const marker = join(dir, "codex-spawned.txt");
  // A command that WOULD leave a marker if it were ever executed.
  const cli = join(dir, "codex");
  await Bun.write(cli, `#!/bin/sh\ntouch '${marker}'\n`);
  (await import("node:fs")).chmodSync(cli, 0o755);
  const runner = resolveAgentRunner({ ...CODEX_PRESET, command: cli });
  const r = await runner.run({
    prompt: "x",
    model: "m",
    allowedTools: ["Read"],
    cwd: dir,
    timeoutMs: 5000,
  });
  expect(existsSync(marker)).toBe(false);
  expect(r.completed).toBe(false);
  expect(r.capabilities?.error).toContain("ENG-484");
});
