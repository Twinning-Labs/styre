import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "../../src/dispatch/profile.ts";
import { isComponentReady, planProvision } from "../../src/dispatch/provision.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function makeComponent(overrides: Partial<Component> = {}): Component {
  return {
    name: "web",
    kind: "node",
    paths: ["**/*.ts"],
    commands: {},
    extensions: [],
    ...overrides,
  };
}

describe("isComponentReady", () => {
  test("node: node_modules/.package-lock.json present -> ready", () => {
    const dir = tmpDir("styre-prov-ready-");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}");
    expect(isComponentReady("node", dir)).toBe(true);
  });

  test("node: bare node_modules/ dir with no completeness marker -> not ready", () => {
    const dir = tmpDir("styre-prov-partial-");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    expect(isComponentReady("node", dir)).toBe(false);
  });

  test("python: always not ready", () => {
    const dir = tmpDir("styre-prov-py-");
    expect(isComponentReady("python", dir)).toBe(false);
  });
});

describe("planProvision", () => {
  test('emits one action per prepare-bearing, not-ready component with cwd = join(worktree, dir ?? "")', () => {
    const worktree = tmpDir("styre-prov-plan-");
    // Ready node component (has the completeness marker) at the module root.
    const readyDir = join(worktree, "web");
    mkdirSync(join(readyDir, "node_modules"), { recursive: true });
    writeFileSync(join(readyDir, "node_modules", ".package-lock.json"), "{}");
    const readyComponent = makeComponent({
      name: "web",
      kind: "node",
      dir: "web",
      prepare: "npm ci",
    });

    // Not-ready node component at the repo root (no dir).
    const notReadyComponent = makeComponent({
      name: "root",
      kind: "node",
      prepare: "npm ci",
    });

    // Not-ready python component with prepare.
    const pythonComponent = makeComponent({
      name: "api",
      kind: "python",
      dir: "api",
      prepare: "pip install -e .",
    });

    // No-prepare component: always skipped regardless of readiness.
    const noPrepareComponent = makeComponent({
      name: "docs",
      kind: "node",
      dir: "docs",
    });

    const actions = planProvision(
      [readyComponent, notReadyComponent, pythonComponent, noPrepareComponent],
      worktree,
    );

    expect(actions).toEqual([
      { component: "root", command: "npm ci", cwd: join(worktree, "") },
      { component: "api", command: "pip install -e .", cwd: join(worktree, "api") },
    ]);
  });

  test("skips no-prepare and ready components entirely", () => {
    const worktree = tmpDir("styre-prov-skip-");
    const readyDir = join(worktree, "");
    mkdirSync(join(readyDir, "node_modules"), { recursive: true });
    writeFileSync(join(readyDir, "node_modules", ".package-lock.json"), "{}");
    const ready = makeComponent({ name: "web", kind: "node", prepare: "npm ci" });
    const noPrepare = makeComponent({ name: "docs", kind: "node" });

    expect(planProvision([ready, noPrepare], worktree)).toEqual([]);
  });
});
