import { expect, test } from "bun:test";
import {
  EXTENSIONS_BY_KIND,
  commandFor,
  extMatches,
  impactedComponents,
  isInertFile,
  isScriptRunner,
  isUnavailable,
  matchesComponent,
  realRunnerCommands,
  scopedRunnersForFiles,
} from "../../src/dispatch/components.ts";
import type { Component } from "../../src/dispatch/profile.ts";

const rust: Component = {
  name: "core",
  kind: "rust",
  paths: ["src-tauri/**", "crates/**"],
  commands: { test: "cargo test", build: "cargo build" },
  extensions: [".rs"],
};
const fe: Component = {
  name: "fe",
  kind: "sveltekit",
  paths: ["src/**"],
  commands: { build: "vite build", test: { unavailable: true } },
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts", ".svelte"],
};
const comps = [rust, fe];

test("impactedComponents unions across globs", () => {
  expect(impactedComponents(comps, ["src-tauri/lib.rs", "src/app.ts"]).map((c) => c.name)).toEqual([
    "core",
    "fe",
  ]);
  expect(impactedComponents(comps, ["README.md"])).toHaveLength(0);
});

test("commandFor / isUnavailable distinguish string vs unavailable", () => {
  expect(commandFor(rust, "test")).toBe("cargo test");
  expect(commandFor(fe, "test")).toBeUndefined();
  expect(isUnavailable(fe, "test")).toBe(true);
  expect(commandFor(rust, "lint")).toBeUndefined();
});

test("scopedRunnersForFiles narrows; realRunnerCommands unions; objects filtered", () => {
  expect(scopedRunnersForFiles(comps, ["src/app.ts"])).toEqual(["vite build"]);
  expect(realRunnerCommands(comps).sort()).toEqual(["cargo build", "cargo test", "vite build"]);
});

test("isScriptRunner flags shell invocations", () => {
  expect(isScriptRunner("bash build.sh")).toBe(true);
  expect(isScriptRunner("cargo test")).toBe(false);
});

// ─── Task 2: file-identity routing ───────────────────────────────────────────

test("EXTENSIONS_BY_KIND maps rust/node/sveltekit/python/go/jvm variants", () => {
  expect(EXTENSIONS_BY_KIND.rust).toContain(".rs");
  expect(EXTENSIONS_BY_KIND.node).toContain(".ts");
  expect(EXTENSIONS_BY_KIND.sveltekit).toContain(".svelte");
  expect(EXTENSIONS_BY_KIND.python).toContain(".py");
  expect(EXTENSIONS_BY_KIND.go).toContain(".go");
  expect(EXTENSIONS_BY_KIND["jvm-maven"]).toContain(".java");
  expect(EXTENSIONS_BY_KIND["jvm-gradle"]).toContain(".gradle");
});

test("extMatches: .py file matches python component, not sveltekit", () => {
  const python: Component = {
    name: "api",
    kind: "python",
    paths: ["src/**"],
    commands: {},
    extensions: [".py", ".pyi"],
  };
  const svelte: Component = {
    name: "fe",
    kind: "sveltekit",
    paths: ["src/**"],
    commands: {},
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts", ".svelte"],
  };
  expect(extMatches(python, "src/main.py")).toBe(true);
  expect(extMatches(svelte, "src/main.py")).toBe(false);
});

test("extMatches: .svelte file matches sveltekit, not python", () => {
  const python: Component = {
    name: "api",
    kind: "python",
    paths: ["src/**"],
    commands: {},
    extensions: [".py", ".pyi"],
  };
  const svelte: Component = {
    name: "fe",
    kind: "sveltekit",
    paths: ["src/**"],
    commands: {},
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts", ".svelte"],
  };
  expect(extMatches(svelte, "src/App.svelte")).toBe(true);
  expect(extMatches(python, "src/App.svelte")).toBe(false);
});

test("extMatches: foreign-ext files (config.yaml, Dockerfile) do not match mapped-kind components", () => {
  const python: Component = {
    name: "api",
    kind: "python",
    paths: ["**"],
    commands: {},
    extensions: [".py", ".pyi"],
  };
  const svelte: Component = {
    name: "fe",
    kind: "sveltekit",
    paths: ["**"],
    commands: {},
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts", ".svelte"],
  };
  // config.yaml has .yaml — not in python or sveltekit extensions
  expect(extMatches(python, "config.yaml")).toBe(false);
  expect(extMatches(svelte, "config.yaml")).toBe(false);
  // Dockerfile has no extension (extname returns "") — not in any mapped kind
  expect(extMatches(python, "Dockerfile")).toBe(false);
  expect(extMatches(svelte, "Dockerfile")).toBe(false);
});

test("extMatches: undefined or empty extensions → path-only fallback (always true)", () => {
  const noExts: Component = {
    name: "custom",
    kind: "custom",
    paths: ["**"],
    commands: {},
    extensions: [],
  };
  // Cast to test undefined-safety
  const undefinedExts = { ...noExts, extensions: undefined } as unknown as Component;
  expect(extMatches(noExts, "anything.yaml")).toBe(true);
  expect(extMatches(noExts, "Makefile")).toBe(true);
  expect(extMatches(undefinedExts, "anything.yaml")).toBe(true);
});

// ─── WO-6 Task 1: isInertFile ────────────────────────────────────────────────

test("isInertFile: true for license/notice/docs files", () => {
  expect(isInertFile("LICENSE")).toBe(true);
  expect(isInertFile("docs/x.md")).toBe(true);
  expect(isInertFile("sub/NOTICE")).toBe(true);
});

test("isInertFile: false for build-affecting files that must stay swept", () => {
  expect(isInertFile(".editorconfig")).toBe(false);
  expect(isInertFile(".gitignore")).toBe(false);
  expect(isInertFile("config.yaml")).toBe(false);
  expect(isInertFile("Cargo.lock")).toBe(false);
  expect(isInertFile("src/a.py")).toBe(false);
});

test("matchesComponent: path still scopes the component (ext matches but path doesn't)", () => {
  const python: Component = {
    name: "api",
    kind: "python",
    paths: ["api/**"],
    commands: {},
    extensions: [".py", ".pyi"],
  };
  // .py file but outside the path glob
  expect(matchesComponent(python, "frontend/utils.py")).toBe(false);
  // .py file inside the path glob
  expect(matchesComponent(python, "api/routes.py")).toBe(true);
});

// ─── WO-3 Task 1: Ruby file-identity routing ─────────────────────────────────

test("EXTENSIONS_BY_KIND has ruby entry with .rb/.rake/.gemspec", () => {
  expect(EXTENSIONS_BY_KIND.ruby).toContain(".rb");
  expect(EXTENSIONS_BY_KIND.ruby).toContain(".rake");
  expect(EXTENSIONS_BY_KIND.ruby).toContain(".gemspec");
});

test("ruby component routes .rb/.rake/.gemspec files; does not match .py", () => {
  const ruby: Component = {
    name: "ruby",
    kind: "ruby",
    paths: ["**"],
    commands: { test: "bundle exec rspec" },
    extensions: [".rb", ".rake", ".gemspec"],
  };
  expect(matchesComponent(ruby, "src/a.rb")).toBe(true);
  expect(matchesComponent(ruby, "x.rake")).toBe(true);
  expect(matchesComponent(ruby, "y.gemspec")).toBe(true);
  // must not match a Python file
  expect(matchesComponent(ruby, "a.py")).toBe(false);
});
