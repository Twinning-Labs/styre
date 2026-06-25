import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeProfile } from "../../src/setup/probe.ts";

/** A temp git repo with an origin remote + a package.json + a workflow. */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-probe-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  run(["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  return root;
}

test("probeProfile derives slug from the git remote and produces components + repoCommands", () => {
  const repo = gitRepo();
  const p = probeProfile(repo);
  expect(p.slug).toBe("widget"); // from git@github.com:acme/widget.git
  expect(p.targetRepo).toBe(repo);
  // package.json with scripts.test → node component with test command
  expect(p.components[0]?.commands.test).toBe("npm run test"); // no lockfile → npm
  expect(p.repoCommands).toEqual({}); // no repo-level commands from manifest scan
  expect(p.checksSystem).toBe("none"); // no .github/workflows
});

test("probeProfile honors overrides and falls back to dir basename for slug", () => {
  const bare = mkdtempSync(join(tmpdir(), "styre-bare-")); // not a git repo
  const p = probeProfile(bare, { slug: "custom", checksSystem: "external" });
  expect(p.slug).toBe("custom");
  expect(p.checksSystem).toBe("external");
  const p2 = probeProfile(bare); // no remote → basename
  const bareName = bare.split("/").at(-1) ?? "";
  expect(p2.slug).toBe(bareName);
  expect(p2.components).toEqual([]); // no package.json → no detected commands → empty components
  expect(p2.repoCommands).toEqual({}); // no repo-level commands
});
