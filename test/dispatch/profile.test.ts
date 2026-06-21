import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, parseProfile } from "../../src/dispatch/profile.ts";

test("parseProfile fills defaults for optional fields", () => {
  const p = parseProfile({ slug: "demo", targetRepo: "/tmp/demo" });
  expect(p.slug).toBe("demo");
  expect(p.defaultBranch).toBe("main");
  expect(p.checksSystem).toBe("none");
  expect(p.commands).toEqual({});
  expect(p.promptVars).toEqual({});
});

test("parseProfile keeps provided values", () => {
  const p = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/demo",
    defaultBranch: "trunk",
    checksSystem: "github",
    commands: { test: "bun test" },
    promptVars: { stack: "bun" },
  });
  expect(p.defaultBranch).toBe("trunk");
  expect(p.checksSystem).toBe("github");
  expect(p.commands.test).toBe("bun test");
  expect(p.promptVars.stack).toBe("bun");
});

test("parseProfile rejects a missing required field", () => {
  expect(() => parseProfile({ slug: "demo" })).toThrow();
});

test("loadProfile reads + validates a JSON file", () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-profile-"));
  const path = join(dir, "profile.json");
  writeFileSync(path, JSON.stringify({ slug: "demo", targetRepo: "/tmp/demo" }));
  const p = loadProfile(path);
  expect(p.slug).toBe("demo");
});
