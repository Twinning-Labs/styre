import { expect, test } from "bun:test";
import { githubChecks } from "../../src/integrations/adapters/github-checks.ts";

test("githubChecks throws a clear setup error when no token is available", () => {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "";
  try {
    expect(() => githubChecks({ repoPath: "/tmp/does-not-matter" })).toThrow(/token/i);
  } finally {
    if (prev === undefined)
      // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
      delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});
