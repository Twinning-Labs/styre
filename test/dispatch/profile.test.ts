import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComponentSchema,
  ProfileSchema,
  loadProfile,
  parseProfile,
} from "../../src/dispatch/profile.ts";

test("parses a v3 components profile", () => {
  const p = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/repo",
    schemaVersion: 3,
    components: [
      {
        name: "core",
        kind: "rust",
        paths: ["src-tauri/**"],
        commands: { test: "cargo test" },
        extensions: [".rs"],
      },
      {
        name: "fe",
        kind: "sveltekit",
        paths: ["src/**"],
        commands: { test: { unavailable: true } },
        extensions: [".ts", ".svelte"],
      },
    ],
    repoCommands: { integration: "playwright test" },
  });
  expect(p.schemaVersion).toBe(3);
  expect(p.components).toHaveLength(2);
  expect(p.components[0].extensions).toEqual([".rs"]);
  expect(p.components[1].extensions).toEqual([".ts", ".svelte"]);
  expect(p.components[1].commands.test).toEqual({ unavailable: true });
  expect(p.repoCommands.integration).toBe("playwright test");
});

test("schemaVersion 2 profile is rejected with re-run message", () => {
  expect(() => parseProfile({ slug: "demo", targetRepo: "/tmp/repo", schemaVersion: 2 })).toThrow(
    /schemaVersion 2.*re-run.*styre setup/i,
  );
});

test("hard-fails on a legacy flat-commands profile", () => {
  expect(() =>
    parseProfile({ slug: "demo", targetRepo: "/tmp/repo", commands: { test: "true" } }),
  ).toThrow(/legacy flat .commands/i);
});

test("parseProfile fills defaults for optional fields", () => {
  const p = parseProfile({ slug: "demo", targetRepo: "/tmp/demo" });
  expect(p.slug).toBe("demo");
  expect(p.defaultBranch).toBe("main");
  expect(p.checksSystem).toBe("none");
  expect(p.components).toEqual([]);
  expect(p.repoCommands).toEqual({});
  expect(p.promptVars).toEqual({});
});

test("parseProfile keeps provided values", () => {
  const p = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/demo",
    defaultBranch: "trunk",
    checksSystem: "github",
    components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "bun test" } }],
    promptVars: { stack: "bun" },
  });
  expect(p.defaultBranch).toBe("trunk");
  expect(p.checksSystem).toBe("github");
  expect(p.components[0].commands.test).toBe("bun test");
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

// ─── WO-3 Task 1: prepare round-trip (genuinely red until ComponentSchema adds the field) ──

test("prepare field on a component round-trips through parseProfile", () => {
  const p = parseProfile({
    slug: "s",
    targetRepo: "/r",
    components: [
      {
        name: "ruby",
        kind: "ruby",
        paths: ["**"],
        commands: { test: "bundle exec rspec" },
        prepare: "bundle install",
      },
    ],
  });
  expect(p.components[0].prepare).toBe("bundle install");
});

test("testFilePattern on a component is optional and parses when present", () => {
  const p1 = parseProfile({ slug: "s", targetRepo: "/r" });
  expect(p1.components).toHaveLength(0);
  const p2 = parseProfile({
    slug: "s",
    targetRepo: "/r",
    components: [{ name: "app", kind: "app", paths: ["**"], testFilePattern: "\\.spec\\." }],
  });
  expect(p2.components[0].testFilePattern).toBe("\\.spec\\.");
});

describe("runtimeContext", () => {
  test("a v3 profile (no runtimeContext) validates as all-unknown", () => {
    const p = parseProfile({ slug: "demo", targetRepo: "/tmp/demo" });
    expect(p.schemaVersion).toBe(3);
    expect(p.runtimeContext.topology.type).toBe("unknown");
    expect(p.runtimeContext.data.presence).toBe("unknown");
    expect(p.runtimeContext.documentation.presence).toBe("unknown");
    expect(p.runtimeContext.releasePackaging.mechanism).toBe("unknown");
    expect(p.runtimeContext.data.migrationTool).toBeUndefined();
    expect(p.runtimeContext.observability.presence).toBe("unknown");
    expect(p.runtimeContext.configSecrets.presence).toBe("unknown");
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

test("ComponentSchema round-trips an optional dir", () => {
  const c = ComponentSchema.parse({ name: "svc", kind: "go", paths: ["svc/**"], dir: "svc" });
  expect(c.dir).toBe("svc");
});

test("a component without dir parses (dir undefined)", () => {
  const c = ComponentSchema.parse({ name: "go", kind: "go", paths: ["**"] });
  expect(c.dir).toBeUndefined();
});

test("ComponentSchema rejects a traversal dir (parse-boundary safety, WO-9 Task 2)", () => {
  expect(() =>
    ComponentSchema.parse({ name: "svc", kind: "go", paths: ["svc/**"], dir: "../.." }),
  ).toThrow();
});

test("ComponentSchema rejects an absolute dir", () => {
  expect(() =>
    ComponentSchema.parse({ name: "svc", kind: "go", paths: ["svc/**"], dir: "/etc" }),
  ).toThrow();
});

test("ComponentSchema accepts a safe nested dir", () => {
  const c = ComponentSchema.parse({
    name: "svc",
    kind: "go",
    paths: ["svc/**"],
    dir: "services/api",
  });
  expect(c.dir).toBe("services/api");
});

test("parseProfile rejects a hand-edited profile with a traversal dir on a component", () => {
  expect(() =>
    parseProfile({
      slug: "demo",
      targetRepo: "/tmp/repo",
      components: [{ name: "svc", kind: "go", paths: ["svc/**"], dir: "../.." }],
    }),
  ).toThrow();
});
