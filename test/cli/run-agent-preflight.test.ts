import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImpl } from "../../src/cli/run.ts";

// Mirrors test/cli/run-preflight.test.ts's harness: run the unwrapped runImpl (bypassing `guard`
// so the throw is observable) with telemetry off and isolated XDG dirs. `state` is where a park
// dump WOULD land — the test asserts nothing is written there.
async function invokeRun(args: Record<string, unknown>, xdg: string, state: string): Promise<void> {
  const prev = {
    t: process.env.STYRE_TELEMETRY,
    c: process.env.XDG_CONFIG_HOME,
    s: process.env.XDG_STATE_HOME,
  };
  process.env.STYRE_TELEMETRY = "0";
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.XDG_STATE_HOME = state;
  process.exitCode = 0;
  try {
    await runImpl({ args: { _: [], ...args } as never });
  } finally {
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.t === undefined) delete process.env.STYRE_TELEMETRY;
    else process.env.STYRE_TELEMETRY = prev.t;
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.c === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.c;
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.s === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev.s;
  }
}

// A profile whose toolchain preflight PASSES (build/test run `sh`, which exists) — so the run
// reaches the agent-CLI probe rather than failing earlier on a missing build tool.
function writeProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-agentpf-prof-"));
  const path = join(dir, "profile.json");
  writeFileSync(
    path,
    JSON.stringify({
      slug: "agentpf-test",
      targetRepo: dir,
      components: [
        {
          name: "api",
          kind: "custom",
          paths: ["**"],
          commands: { build: "sh -c true", test: "sh -c true", check: { unavailable: true } },
        },
      ],
    }),
  );
  return path;
}

// A hermetic runtime config whose agent.command points at a guaranteed-absent binary.
function writeBadAgentConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-agentpf-cfg-"));
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

test("run: a missing agent CLI throws before dispatch (exit 69 error) and writes no dump", async () => {
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  const state = mkdtempSync(join(tmpdir(), "styre-state-"));
  const profile = writeProfile();
  const config = writeBadAgentConfig();
  await expect(invokeRun({ ticket: "ENG-1", profile, config }, xdg, state)).rejects.toThrow(
    /not installed or not on PATH/,
  );
  // No SoT dump: parkDir would write under <XDG_STATE_HOME>/styre/… — nothing was created.
  expect(existsSync(join(state, "styre"))).toBe(false);
});
