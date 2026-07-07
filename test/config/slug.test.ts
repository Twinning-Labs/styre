import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deriveSlug, discoverRepoRoot, parseGitHubRemote } from "../../src/config/slug.ts";

test("parseGitHubRemote handles SSH/HTTPS and rejects non-GitHub", () => {
  expect(parseGitHubRemote("git@github.com:owner/repo.git")).toEqual({
    owner: "owner",
    repo: "repo",
  });
  expect(parseGitHubRemote("https://github.com/owner/repo")).toEqual({
    owner: "owner",
    repo: "repo",
  });
  expect(parseGitHubRemote("https://gitlab.com/o/r.git")).toBeNull();
});

test("deriveSlug uses the origin repo name, else the dir basename", () => {
  const noRemote = mkdtempSync(join(tmpdir(), "styre-slug-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: noRemote });
  expect(deriveSlug(noRemote)).toBe(basename(noRemote)); // no origin → basename
  const withRemote = mkdtempSync(join(tmpdir(), "styre-slug-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: withRemote });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/widget.git"], {
    cwd: withRemote,
  });
  expect(deriveSlug(withRemote)).toBe("widget");
});

test("discoverRepoRoot returns the toplevel and throws off-repo", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-root-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  expect(discoverRepoRoot(repo).endsWith(basename(repo))).toBe(true);
  const notRepo = mkdtempSync(join(tmpdir(), "styre-notrepo-"));
  expect(() => discoverRepoRoot(notRepo)).toThrow(/no git repo/);
});
