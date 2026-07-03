import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "../../src/dispatch/profile.ts";
import {
  isComponentReady,
  planProvision,
  sourceCheckCommand,
} from "../../src/dispatch/provision.ts";
import { isCommandSafe } from "../../src/setup/command-safety.ts";
import { runCommand } from "../../src/util/run-command.ts";

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

// ─── Task 5: sourceCheckCommand (worktree-source-under-test) ────────────────────

describe("sourceCheckCommand", () => {
  test("python editable + known import name -> a check whose command carries the name and cwd", () => {
    const check = sourceCheckCommand("python", "pip install -e .", "/tmp/worktree", "pkg");
    expect(check).not.toBeNull();
    expect(check?.command).toContain("pkg");
    expect(check?.command).toContain("/tmp/worktree");
    expect(check?.command).toContain(check?.scriptName ?? "");
    expect(check?.script).toContain("find_spec");
  });

  test("node kind -> null (no python source-shadowing risk)", () => {
    expect(sourceCheckCommand("node", "npm ci", "/tmp/worktree", "pkg")).toBeNull();
  });

  test("python but prepare is not editable-install -> null", () => {
    expect(
      sourceCheckCommand("python", "pip install -r requirements.txt", "/tmp/worktree", "pkg"),
    ).toBeNull();
  });

  test("python editable but no known import name -> null", () => {
    expect(sourceCheckCommand("python", "pip install -e .", "/tmp/worktree", undefined)).toBeNull();
  });

  test("the generated command is isCommandSafe (no shell metacharacters)", () => {
    const check = sourceCheckCommand(
      "python",
      "pip install -e .",
      "/tmp/some worktree",
      "pkg-name",
    );
    expect(check).not.toBeNull();
    expect(isCommandSafe(check?.command ?? "")).toBe(true);
  });
});

// ─── Task 5 §11 regression: detect a worktree-shadowing install ─────────────────

describe("sourceCheckCommand regression: shadowed copy is detected", () => {
  // Live-gated (needs a real `python` on PATH). The pure-shape assertions above run
  // unconditionally; this proves the generated check actually catches the F-1 disease end to end.
  (process.env.RUN_LIVE === "1" ? test : test.skip)(
    "a module resolving OUTSIDE the worktree cwd makes the check exit non-zero",
    async () => {
      const worktree = tmpDir("styre-prov-shadow-worktree-");
      const shadowRoot = tmpDir("styre-prov-shadow-outside-");
      // The "shadowing" package: importable, but its origin is NOT under the worktree — e.g. a
      // pre-installed/conda copy sitting earlier on sys.path than the (never-actually-run-here)
      // editable install would be.
      mkdirSync(join(shadowRoot, "shadow_pkg"), { recursive: true });
      writeFileSync(join(shadowRoot, "shadow_pkg", "__init__.py"), "");

      const check = sourceCheckCommand("python", "pip install -e .", worktree, "shadow_pkg");
      expect(check).not.toBeNull();
      if (!check) return;
      writeFileSync(join(worktree, check.scriptName), check.script);

      const prevPythonPath = process.env.PYTHONPATH;
      process.env.PYTHONPATH = shadowRoot;
      try {
        const result = await runCommand(check.command, { cwd: worktree, timeoutMs: 10_000 });
        expect(result.exitCode).not.toBe(0);
      } finally {
        if (prevPythonPath === undefined) Reflect.deleteProperty(process.env, "PYTHONPATH");
        else process.env.PYTHONPATH = prevPythonPath;
      }
    },
  );
});
