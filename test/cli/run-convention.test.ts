import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/cli/run.ts";

function realRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-conv-repo-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}
// A minimal profile whose must-have commands are resolved (assertResolved passes) is overkill here;
// these tests stop BEFORE assertResolved matters by asserting the profile-resolution error/branch.

async function invoke(args: Record<string, unknown>, cwd: string, xdg: string): Promise<unknown> {
  const prev = { t: process.env.STYRE_TELEMETRY, x: process.env.XDG_CONFIG_HOME, c: process.cwd() };
  process.env.STYRE_TELEMETRY = "0";
  process.env.XDG_CONFIG_HOME = xdg;
  process.chdir(cwd);
  try {
    return await runCommand.run?.({
      rawArgs: [],
      cmd: runCommand,
      args: { _: [], ...args } as never,
    });
  } finally {
    process.env.STYRE_TELEMETRY = prev.t;
    if (prev.x === undefined)
      // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.x;
    process.chdir(prev.c);
  }
}

test("run with no --profile and no conventional profile → run-setup error", async () => {
  const repo = realRepo(); // slug = basename(repo)
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  await expect(invoke({}, repo, xdg)).rejects.toThrow(/run `styre setup` first/);
});

test("run with no --profile outside a git repo → cd/pass-profile error", async () => {
  const notRepo = mkdtempSync(join(tmpdir(), "styre-notrepo-"));
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  await expect(invoke({}, notRepo, xdg)).rejects.toThrow(/not a git repo/);
});
