import { expect, test } from "bun:test";
import type { Component } from "../../src/dispatch/profile.ts";
import { resolveCommands } from "../../src/setup/resolve-commands.ts";

// rust has all three must-haves resolved (check=unavailable); fe is only missing test + check.
// This ensures prompts target fe.test and fe.check, not rust (which is already fully resolved).
const base = (): Component[] => [
  {
    name: "rust",
    kind: "rust",
    paths: ["src-tauri/**"],
    commands: { build: "cargo build", test: "cargo test", check: { unavailable: true } },
  },
  { name: "fe", kind: "sveltekit", paths: ["src/**"], commands: { build: "vite build" } },
];

test("operator supplies a missing test command", () => {
  const answers = ["bun test"];
  const { components } = resolveCommands(base(), {
    interactive: true,
    ask: () => answers.shift() ?? null,
  });
  const fe = components.find((c) => c.name === "fe");
  expect(fe?.commands.test).toBe("bun test");
});

test("operator declines → unavailable + warning; non-interactive missing also unavailable", () => {
  const { components, warnings } = resolveCommands(base(), { interactive: true, ask: () => "" });
  const fe = components.find((c) => c.name === "fe");
  expect(fe?.commands.test).toEqual({ unavailable: true });
  expect(warnings.some((w) => /fe.*test/i.test(w))).toBe(true);
});

test("script-runner commands trigger a warning", () => {
  const comps: Component[] = [
    {
      name: "sidecar",
      kind: "node",
      paths: ["sidecar/**"],
      commands: {
        build: "bash build.sh",
        test: { unavailable: true },
        check: { unavailable: true },
      },
    },
  ];
  const { warnings } = resolveCommands(comps, { interactive: false, ask: () => null });
  expect(warnings.some((w) => /bash build\.sh/.test(w))).toBe(true);
});

test("non-interactive missing command becomes unavailable without prompting", () => {
  const { components, warnings } = resolveCommands(base(), { interactive: false, ask: () => null });
  const fe = components.find((c) => c.name === "fe");
  expect(fe?.commands.test).toEqual({ unavailable: true });
  expect(fe?.commands.check).toEqual({ unavailable: true });
  // Warnings emitted for both missing must-haves
  expect(warnings.some((w) => /fe.*test/i.test(w))).toBe(true);
  expect(warnings.some((w) => /fe.*check/i.test(w))).toBe(true);
});

test("answer 'none' is treated as decline → unavailable", () => {
  const { components } = resolveCommands(base(), { interactive: true, ask: () => "none" });
  const fe = components.find((c) => c.name === "fe");
  expect(fe?.commands.test).toEqual({ unavailable: true });
});

test("already-present commands are not re-prompted", () => {
  const askCalls: string[] = [];
  resolveCommands(base(), {
    interactive: true,
    ask: (q) => {
      askCalls.push(q);
      return "";
    },
  });
  // rust has build+test already and check=unavailable (skipped); fe is missing test+check → 2 prompts
  expect(askCalls.length).toBe(2);
});
