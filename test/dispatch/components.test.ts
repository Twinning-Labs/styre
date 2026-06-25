import { expect, test } from "bun:test";
import {
  commandFor,
  impactedComponents,
  isScriptRunner,
  isUnavailable,
  realRunnerCommands,
  scopedRunnersForFiles,
} from "../../src/dispatch/components.ts";
import type { Component } from "../../src/dispatch/profile.ts";

const rust: Component = {
  name: "core",
  kind: "rust",
  paths: ["src-tauri/**", "crates/**"],
  commands: { test: "cargo test", build: "cargo build" },
};
const fe: Component = {
  name: "fe",
  kind: "sveltekit",
  paths: ["src/**"],
  commands: { build: "vite build", test: { unavailable: true } },
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
