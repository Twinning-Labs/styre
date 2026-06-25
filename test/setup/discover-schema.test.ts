import { expect, test } from "bun:test";
import type { Component } from "../../src/dispatch/profile.ts";
import { mergeComponents, probeCommandExists } from "../../src/setup/discover-schema.ts";

test("mergeComponents keeps scan's workspace paths but adopts agent's refined boundaries/commands", () => {
  const scan: Component[] = [
    {
      name: "rust-core",
      kind: "rust",
      paths: ["src-tauri/**", "crates/**"],
      commands: { test: "cargo test --workspace" },
    },
    {
      name: "frontend",
      kind: "node",
      paths: ["src/**", "static/**", "package.json"],
      commands: { build: "npm run build" },
    },
  ];
  const proposed: Component[] = [
    {
      name: "rust-core",
      kind: "rust",
      paths: ["src-tauri/**", "crates/**"],
      commands: { test: "cargo test --workspace", check: "cargo clippy --workspace" },
    },
    {
      name: "frontend",
      kind: "sveltekit",
      paths: ["src/**", "static/**", "package.json", "vite.config.js"],
      commands: { build: "vite build", check: "svelte-check" },
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
  const scan: Component[] = [{ name: "frontend", kind: "node", paths: ["src/**"], commands: {} }];
  const proposed: Component[] = [
    { name: "frontend", kind: "sveltekit", paths: ["src/**"], commands: {} },
    {
      name: "invented-backend",
      kind: "go",
      paths: ["server/**"],
      commands: { test: "go test ./..." },
    },
  ];
  const merged = mergeComponents(scan, proposed);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.name).toBe("frontend");
});

test("mergeComponents rejects unanchored agent globs (** prefix) but keeps scan anchors", () => {
  const scan: Component[] = [
    { name: "frontend", kind: "node", paths: ["src/**", "package.json"], commands: {} },
  ];
  const proposed: Component[] = [
    {
      name: "frontend",
      kind: "sveltekit",
      paths: ["src/**", "**/*.ts", "**/config.js"],
      commands: {},
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
    { name: "rust-core", kind: "rust", paths: ["src-tauri/**"], commands: { test: "cargo test" } },
    { name: "frontend", kind: "node", paths: ["src/**"], commands: {} },
  ];
  const proposed: Component[] = [
    { name: "frontend", kind: "sveltekit", paths: ["src/**"], commands: {} },
    // rust-core deliberately absent from agent proposal
  ];
  const merged = mergeComponents(scan, proposed);
  expect(merged).toHaveLength(2);
  const rust = merged.find((c) => c.name === "rust-core");
  expect(rust?.kind).toBe("rust"); // unchanged from scan
});

test("probeCommandExists is false for a missing binary", () => {
  expect(probeCommandExists(process.cwd(), "definitely-not-a-real-binary-xyz --help")).toBe(false);
  expect(probeCommandExists(process.cwd(), "git status")).toBe(true);
});
