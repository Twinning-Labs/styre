import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileSchema, loadProfile, parseProfile } from "../../src/dispatch/profile.ts";

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

test("testFilePattern is optional and parses when present", () => {
  expect(parseProfile({ slug: "s", targetRepo: "/r" }).testFilePattern).toBeUndefined();
  expect(
    parseProfile({ slug: "s", targetRepo: "/r", testFilePattern: "\\.spec\\." }).testFilePattern,
  ).toBe("\\.spec\\.");
});

describe("runtimeContext", () => {
  test("a legacy profile (no runtimeContext) validates as all-unknown", () => {
    const p = parseProfile({ slug: "demo", targetRepo: "/tmp/demo" });
    expect(p.schemaVersion).toBe(1);
    expect(p.runtimeContext.topology.type).toBe("unknown");
    expect(p.runtimeContext.data.presence).toBe("unknown");
    expect(p.runtimeContext.documentation.presence).toBe("unknown");
    expect(p.runtimeContext.releasePackaging.mechanism).toBe("unknown");
    expect(p.runtimeContext.data.migrationTool).toBeUndefined();
  });

  test("a populated v1 runtimeContext round-trips", () => {
    const p = parseProfile({
      slug: "demo",
      targetRepo: "/tmp/demo",
      runtimeContext: {
        topology: { type: "web-service", detail: "node api" },
        data: { presence: "present", detail: "postgres", migrationTool: "prisma" },
        documentation: { presence: "present", detail: "docs/" },
      },
    });
    expect(p.runtimeContext.topology.type).toBe("web-service");
    expect(p.runtimeContext.data.migrationTool).toBe("prisma");
    expect(p.runtimeContext.documentation.presence).toBe("present");
    // unspecified sections still default to unknown
    expect(p.runtimeContext.caching.presence).toBe("unknown");
  });

  test("rejects an invalid presence value", () => {
    expect(() =>
      ProfileSchema.parse({
        slug: "d",
        targetRepo: "/t",
        runtimeContext: { data: { presence: "maybe" } },
      }),
    ).toThrow();
  });
});
