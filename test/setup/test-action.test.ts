import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "../../src/dispatch/profile.ts";
import { resolveTestAction, withTestActions } from "../../src/setup/test-action.ts";

/** A repo whose test script hides its framework behind `npm run` — the darkreader shape. */
function repoWithScripts(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-test-action-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));
  return dir;
}

describe("resolveTestAction (ENG-399 blocker 2 — npm run indirection)", () => {
  test("follows `npm run <script>` into package.json to find jest", () => {
    // darkreader__darkreader-7241 exactly: the component command is `npm run test:ci`, and the
    // framework is only named one level down. frameworkFor's regex saw `npm run test:ci` and
    // returned null, so the check could not be attempted and the run escalated at design.
    const dir = repoWithScripts({
      test: "jest --config=tests/jest.config.js",
      "test:ci": "jest --config=tests/jest.config.js --runInBand",
    });
    const action = resolveTestAction(dir, "npm run test:ci");
    expect(action?.framework).toBe("jest");
  });

  test("keeps the WRAPPER as the launcher, not the resolved script body (blocker 3)", () => {
    // The wrapper carries the repo's own `--config`. darkreader has no root jest config and a
    // three-project tests/jest.config.js, so bare `jest` loads none of the ts-jest/jsdom setup.
    const dir = repoWithScripts({ "test:ci": "jest --config=tests/jest.config.js --runInBand" });
    const action = resolveTestAction(dir, "npm run test:ci");
    expect(action?.launcher).toBe("npm run test:ci --");
    expect(action?.launcher).not.toBe("jest");
  });

  test("appends the `--` separator for npm, and omits it for pass-through runners", () => {
    const dir = repoWithScripts({ t: "vitest run" });
    expect(resolveTestAction(dir, "npm run t")?.launcher).toBe("npm run t --");
    expect(resolveTestAction(dir, "pnpm run t")?.launcher).toBe("pnpm run t");
    expect(resolveTestAction(dir, "yarn t")?.launcher).toBe("yarn t");
    expect(resolveTestAction(dir, "bun run t")?.launcher).toBe("bun run t");
  });

  test("a command that already names the framework is used verbatim", () => {
    const dir = repoWithScripts({});
    expect(resolveTestAction(dir, "vitest run")).toEqual({
      framework: "vitest",
      launcher: "vitest run",
    });
  });

  test("`ts-jest` in a script body does not masquerade as the jest runner", () => {
    // A transform named in a config line is not an invocation. Guards a lazy /jest/ match.
    const dir = repoWithScripts({ t: "echo ts-jest" });
    expect(resolveTestAction(dir, "npm run t")).toBeNull();
  });

  test("returns null rather than guessing when the script names no framework", () => {
    // darkreader's `test:inject: node tests/inject/run.js` is genuinely un-inferable. Recording
    // a guess here would reinstate the confident-but-wrong inference this replaces.
    const dir = repoWithScripts({ "test:inject": "node tests/inject/run.js" });
    expect(resolveTestAction(dir, "npm run test:inject")).toBeNull();
  });

  test("does not follow a second hop", () => {
    const dir = repoWithScripts({ a: "npm run b", b: "jest" });
    expect(resolveTestAction(dir, "npm run a")).toBeNull();
  });

  test("an absent or malformed package.json resolves nothing instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "styre-test-action-empty-"));
    expect(resolveTestAction(dir, "npm run test")).toBeNull();
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(resolveTestAction(dir, "npm run test")).toBeNull();
  });
});

describe("withTestActions", () => {
  const base: Component = {
    name: "frontend",
    kind: "node",
    paths: ["src/**"],
    commands: { test: "npm run test:ci" },
    extensions: [],
  };

  test("attaches to node components with a resolvable test command", () => {
    const dir = repoWithScripts({ "test:ci": "jest --config=tests/jest.config.js" });
    const [out] = withTestActions(dir, [base]);
    expect(out?.testAction).toEqual({ framework: "jest", launcher: "npm run test:ci --" });
  });

  test("resolves inside a non-root component `dir`", () => {
    const root = mkdtempSync(join(tmpdir(), "styre-test-action-ws-"));
    mkdirSync(join(root, "packages", "ui"), { recursive: true });
    writeFileSync(
      join(root, "packages", "ui", "package.json"),
      JSON.stringify({ scripts: { t: "vitest run" } }),
    );
    const [out] = withTestActions(root, [
      { ...base, dir: "packages/ui", commands: { test: "npm run t" } },
    ]);
    expect(out?.testAction?.framework).toBe("vitest");
  });

  test("leaves non-node components untouched", () => {
    const dir = repoWithScripts({ test: "jest" });
    const [out] = withTestActions(dir, [{ ...base, kind: "python" }]);
    expect(out?.testAction).toBeUndefined();
  });

  test("leaves a component with no test command untouched", () => {
    const dir = repoWithScripts({ test: "jest" });
    const [out] = withTestActions(dir, [{ ...base, commands: {} }]);
    expect(out?.testAction).toBeUndefined();
  });
});
