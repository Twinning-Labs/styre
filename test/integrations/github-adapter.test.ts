import { expect, test } from "bun:test";
import { parseGitHubRemote } from "../../src/integrations/adapters/github.ts";

test("parseGitHubRemote: SSH form with .git", () => {
  expect(parseGitHubRemote("git@github.com:owner/repo.git")).toEqual({
    owner: "owner",
    repo: "repo",
  });
});

test("parseGitHubRemote: SSH form without .git", () => {
  expect(parseGitHubRemote("git@github.com:owner/repo")).toEqual({
    owner: "owner",
    repo: "repo",
  });
});

test("parseGitHubRemote: HTTPS form with .git", () => {
  expect(parseGitHubRemote("https://github.com/owner/repo.git")).toEqual({
    owner: "owner",
    repo: "repo",
  });
});

test("parseGitHubRemote: HTTPS form without .git", () => {
  expect(parseGitHubRemote("https://github.com/owner/repo")).toEqual({
    owner: "owner",
    repo: "repo",
  });
});

test("parseGitHubRemote: HTTPS with trailing slash and whitespace", () => {
  expect(parseGitHubRemote("  https://github.com/owner/repo/  \n")).toEqual({
    owner: "owner",
    repo: "repo",
  });
});

test("parseGitHubRemote: ssh:// scheme form", () => {
  expect(parseGitHubRemote("ssh://git@github.com/owner/repo.git")).toEqual({
    owner: "owner",
    repo: "repo",
  });
});

test("parseGitHubRemote: a non-GitHub url returns null", () => {
  expect(parseGitHubRemote("https://gitlab.com/owner/repo.git")).toBeNull();
  expect(parseGitHubRemote("git@bitbucket.org:owner/repo.git")).toBeNull();
});

test("parseGitHubRemote: a malformed url returns null", () => {
  expect(parseGitHubRemote("")).toBeNull();
  expect(parseGitHubRemote("not-a-url")).toBeNull();
  expect(parseGitHubRemote("https://github.com/owner")).toBeNull();
});
