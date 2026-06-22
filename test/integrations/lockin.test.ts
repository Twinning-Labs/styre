import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

test("@octokit is imported in exactly one adapter file (github.ts)", () => {
  const dir = join(import.meta.dir, "../../src/integrations/adapters");
  const importers = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /from\s+["']@octokit\//.test(readFileSync(join(dir, f), "utf8")));
  expect(importers).toEqual(["github.ts"]);
});
