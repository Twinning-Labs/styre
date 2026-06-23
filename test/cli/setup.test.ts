import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, unknownRuntimeSections } from "../../src/cli/setup.ts";
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

test("re-running setup preserves an operator-resolved section", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");

  runSetup({ repo, out }); // first probe → caching unknown
  // operator fills caching by hand:
  const p = JSON.parse(readFileSync(out, "utf8"));
  p.runtimeContext.caching = { presence: "present", detail: "redis (operator)" };
  writeFileSync(out, JSON.stringify(p));

  const { profile } = runSetup({ repo, out }); // re-run merges
  expect(profile.runtimeContext.caching.presence).toBe("present");
  expect(profile.runtimeContext.caching.detail).toBe("redis (operator)");
});

test("--reprobe discards operator edits", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  runSetup({ repo, out });
  const p = JSON.parse(readFileSync(out, "utf8"));
  p.runtimeContext.caching = { presence: "present", detail: "redis (operator)" };
  writeFileSync(out, JSON.stringify(p));
  const { profile } = runSetup({ repo, out, reprobe: true });
  expect(profile.runtimeContext.caching.presence).toBe("unknown");
});

test("unknownRuntimeSections lists only the unknown flags", () => {
  const p = parseProfile({
    slug: "d",
    targetRepo: "/t",
    runtimeContext: {
      topology: { type: "web-service" },
      data: { presence: "present" },
      caching: { presence: "unknown" },
      observability: { presence: "unknown" },
      documentation: { presence: "present" },
    },
  });
  const u = unknownRuntimeSections(p);
  expect(u).toContain("caching");
  expect(u).toContain("observability");
  expect(u).toContain("configSecrets"); // defaulted unknown
  expect(u).not.toContain("data");
  expect(u).not.toContain("topology");
});
