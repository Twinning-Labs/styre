import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "../../src/cli/setup.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-setup-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  return root;
}

test("runSetup probes and writes a valid profile to --out", () => {
  const repo = gitRepo();
  const out = join(mkdtempSync(join(tmpdir(), "styre-out-")), "profile.json");
  const { outPath, profile } = runSetup({ repo, out });
  expect(outPath).toBe(out);
  expect(profile.slug).toBe("widget");
  // The written file round-trips through parseProfile.
  expect(parseProfile(JSON.parse(readFileSync(out, "utf8"))).slug).toBe("widget");
});

test("runSetup defaults the path to configDir()/<slug>/profile.json", () => {
  const repo = gitRepo();
  const cfg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  try {
    const { outPath } = runSetup({ repo });
    expect(outPath).toBe(join(cfg, "styre", "widget", "profile.json"));
    expect(existsSync(outPath)).toBe(true);
  } finally {
    if (prev === undefined)
      // biome-ignore lint/performance/noDelete: process.env must be unset via delete; assigning undefined leaves the string "undefined"
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("runSetup refuses to overwrite an existing profile unless force", () => {
  const repo = gitRepo();
  const out = join(mkdtempSync(join(tmpdir(), "styre-out2-")), "profile.json");
  runSetup({ repo, out });
  expect(() => runSetup({ repo, out })).toThrow(/exists/i);
  expect(() => runSetup({ repo, out, force: true })).not.toThrow();
});
