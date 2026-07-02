import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "../../src/dispatch/profile.ts";
import {
  DiscoverSchema,
  mergeComponents,
  probeCommandExists,
} from "../../src/setup/discover-schema.ts";

test("mergeComponents keeps scan's workspace paths but adopts agent's refined boundaries/commands", () => {
  const scan: Component[] = [
    {
      name: "rust-core",
      kind: "rust",
      paths: ["src-tauri/**", "crates/**"],
      commands: { test: "cargo test --workspace" },
      extensions: [],
    },
    {
      name: "frontend",
      kind: "node",
      paths: ["src/**", "static/**", "package.json"],
      commands: { build: "npm run build" },
      extensions: [],
    },
  ];
  const proposed: Component[] = [
    {
      name: "rust-core",
      kind: "rust",
      paths: ["src-tauri/**", "crates/**"],
      commands: { test: "cargo test --workspace", check: "cargo clippy --workspace" },
      extensions: [],
    },
    {
      name: "frontend",
      kind: "sveltekit",
      paths: ["src/**", "static/**", "package.json", "vite.config.js"],
      commands: { build: "vite build", check: "svelte-check" },
      extensions: [],
    },
  ];
  const merged = mergeComponents(scan, proposed);
  const fe = merged.find((c) => c.name === "frontend");
  expect(fe?.kind).toBe("sveltekit"); // agent refined the label
  expect(fe?.commands.check).toBe("svelte-check"); // agent added a command
  const rust = merged.find((c) => c.name === "rust-core");
  expect(rust?.paths).toEqual(expect.arrayContaining(["src-tauri/**", "crates/**"])); // anchor preserved
});

test("mergeComponents drops agent-proposed components not in scan (scan anchors existence)", () => {
  const scan: Component[] = [
    { name: "frontend", kind: "node", paths: ["src/**"], commands: {}, extensions: [] },
  ];
  const proposed: Component[] = [
    { name: "frontend", kind: "sveltekit", paths: ["src/**"], commands: {}, extensions: [] },
    {
      name: "invented-backend",
      kind: "go",
      paths: ["server/**"],
      commands: { test: "go test ./..." },
      extensions: [],
    },
  ];
  const merged = mergeComponents(scan, proposed);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.name).toBe("frontend");
});

test("mergeComponents rejects unanchored agent globs (** prefix) but keeps scan anchors", () => {
  const scan: Component[] = [
    {
      name: "frontend",
      kind: "node",
      paths: ["src/**", "package.json"],
      commands: {},
      extensions: [],
    },
  ];
  const proposed: Component[] = [
    {
      name: "frontend",
      kind: "sveltekit",
      paths: ["src/**", "**/*.ts", "**/config.js"],
      commands: {},
      extensions: [],
    },
  ];
  const merged = mergeComponents(scan, proposed);
  const fe = merged.find((c) => c.name === "frontend");
  // scan anchors preserved
  expect(fe?.paths).toContain("src/**");
  expect(fe?.paths).toContain("package.json");
  // unanchored agent globs dropped
  expect(fe?.paths).not.toContain("**/*.ts");
  expect(fe?.paths).not.toContain("**/config.js");
});

test("mergeComponents preserves a scan component the agent didn't mention", () => {
  const scan: Component[] = [
    {
      name: "rust-core",
      kind: "rust",
      paths: ["src-tauri/**"],
      commands: { test: "cargo test" },
      extensions: [],
    },
    { name: "frontend", kind: "node", paths: ["src/**"], commands: {}, extensions: [] },
  ];
  const proposed: Component[] = [
    { name: "frontend", kind: "sveltekit", paths: ["src/**"], commands: {}, extensions: [] },
    // rust-core deliberately absent from agent proposal
  ];
  const merged = mergeComponents(scan, proposed);
  expect(merged).toHaveLength(2);
  const rust = merged.find((c) => c.name === "rust-core");
  expect(rust?.kind).toBe("rust"); // unchanged from scan
});

test("mergeComponents rejects path-traversal globs (.. segment)", () => {
  const scan: Component[] = [
    { name: "frontend", kind: "node", paths: ["src/**"], commands: {}, extensions: [] },
  ];
  const proposed: Component[] = [
    {
      name: "frontend",
      kind: "node",
      paths: ["src/**", "src/../**", "../sibling/**"],
      commands: {},
      extensions: [],
    },
  ];
  const fe = mergeComponents(scan, proposed).find((c) => c.name === "frontend");
  expect(fe?.paths).toContain("src/**");
  expect(fe?.paths).not.toContain("src/../**");
  expect(fe?.paths).not.toContain("../sibling/**");
});

// ─── WO-3 Task 1: prepare plumbing ───────────────────────────────────────────

test("mergeComponents carries the scanned prepare field (genuinely red until carry lands)", () => {
  const scan: Component[] = [
    {
      name: "ruby",
      kind: "ruby",
      paths: ["**"],
      commands: { test: "bundle exec rspec" },
      extensions: [".rb", ".rake", ".gemspec"],
      prepare: "bundle install",
    } as Component,
  ];
  // Agent proposes the same component (no prepare field — DiscoverSchema strips it)
  const proposed: Component[] = [
    {
      name: "ruby",
      kind: "ruby",
      paths: ["**"],
      commands: { test: "bundle exec rspec" },
      extensions: [".rb", ".rake", ".gemspec"],
    },
  ];
  const merged = mergeComponents(scan, proposed);
  expect(merged).toHaveLength(1);
  // prepare must survive the merge even though agent proposal didn't carry it
  expect((merged[0] as Record<string, unknown>).prepare).toBe("bundle install");
});

test("DiscoverSchema strips prepare from agent proposal (agent-unauthorable, guard)", () => {
  // DiscoverSchema is a z.object() with strip mode: unknown keys are removed.
  const parsed = DiscoverSchema.parse({
    components: [
      {
        name: "ruby",
        kind: "ruby",
        paths: ["**"],
        commands: {},
        prepare: "rm -rf /",
      },
    ],
    repoCommands: {},
  });
  // prepare must NOT appear in the parsed proposal — it's not in DiscoverSchema
  expect((parsed.components[0] as Record<string, unknown>).prepare).toBeUndefined();
});

test("mergeComponents preserves scanned dir when the agent REFINES the component (rebuild path)", () => {
  const scan: Component[] = [
    { name: "svc", kind: "go", paths: ["svc/**"], commands: {}, extensions: [".go"], dir: "svc" },
  ];
  // agent proposes the same component by name → rebuild path → dir dropped WITHOUT the carry:
  const merged = mergeComponents(scan, [
    { name: "svc", kind: "go", paths: ["svc/**"], commands: {} } as unknown as Component,
  ]);
  expect(merged[0].dir).toBe("svc"); // GENUINELY RED without the carry; green with it
});

test("mergeComponents preserves scanned dir when the agent omits the component (bonus, green pre-change)", () => {
  const scan: Component[] = [
    { name: "svc", kind: "go", paths: ["svc/**"], commands: {}, extensions: [".go"], dir: "svc" },
  ];
  expect(mergeComponents(scan, [])[0].dir).toBe("svc"); // early-return branch — already safe
});

test("an agent proposal cannot introduce dir (not in DiscoverSchema)", () => {
  const parsed = DiscoverSchema.parse({
    components: [{ name: "svc", kind: "go", paths: ["svc/**"], commands: {}, dir: "../evil" }],
    repoCommands: {},
  });
  expect((parsed.components[0] as Record<string, unknown>).dir).toBeUndefined();
});

test("probeCommandExists is false for a missing binary", () => {
  expect(probeCommandExists(process.cwd(), "definitely-not-a-real-binary-xyz --help")).toBe(false);
  expect(probeCommandExists(process.cwd(), "git status")).toBe(true);
});

test("probeCommandExists: command injection in bin name does not execute and returns false", () => {
  // Create a fresh temp directory as both the repoDir and the target for a potential PWNED file.
  const dir = mkdtempSync(join(tmpdir(), "styre-injection-test-"));
  try {
    const pwned = join(dir, "PWNED");
    // This is the injection payload: split(/\s+/)[0] yields "foo$(touch${IFS}<dir>/PWNED)"
    // which under the old interpolated sh -c would expand and execute `touch <dir>/PWNED`.
    const maliciousBin = `foo$(touch\${IFS}${pwned})`;
    const result = probeCommandExists(dir, maliciousBin);
    // Must return false — no such binary exists.
    expect(result).toBe(false);
    // The injection must NOT have executed — PWNED file must not exist.
    expect(existsSync(pwned)).toBe(false);
  } finally {
    try {
      rmdirSync(dir);
    } catch {
      // cleanup best-effort
    }
  }
});
