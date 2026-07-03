import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import type { Component } from "../../src/dispatch/profile.ts";
import {
  diffTouchesManifest,
  isComponentReady,
  isValidImportName,
  planProvision,
  resetProvision,
  resetProvisionIfManifestTouched,
  resolvePythonInterpreter,
  sourceCheckCommand,
} from "../../src/dispatch/provision.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { isCommandSafe } from "../../src/setup/command-safety.ts";
import { runCommand } from "../../src/util/run-command.ts";
import { makeTestDb } from "../helpers/db.ts";

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

// ─── isValidImportName (Fix E) ───────────────────────────────────────────────

describe("isValidImportName", () => {
  test("accepts plain identifiers and dotted names", () => {
    expect(isValidImportName("pkg")).toBe(true);
    expect(isValidImportName("my_pkg")).toBe(true);
    expect(isValidImportName("_pkg")).toBe(true);
    expect(isValidImportName("pkg.sub")).toBe(true);
  });

  test("rejects names carrying shell metacharacters or an invalid leading char", () => {
    expect(isValidImportName('pkg"; rm -rf /')).toBe(false);
    expect(isValidImportName("pkg$HOME")).toBe(false);
    expect(isValidImportName("pkg`whoami`")).toBe(false);
    expect(isValidImportName("1pkg")).toBe(false);
    expect(isValidImportName("")).toBe(false);
  });
});

// ─── resolvePythonInterpreter (Fix D) ────────────────────────────────────────

describe("resolvePythonInterpreter", () => {
  test("resolves to python3 or python when one is on PATH, else throws", () => {
    // This environment-dependent function either returns one of the two known names or throws a
    // clear infra error — it must never silently return something else / undefined.
    try {
      const interp = resolvePythonInterpreter();
      expect(["python3", "python"]).toContain(interp);
    } catch (err) {
      expect(String(err)).toContain("no python3 or python interpreter");
    }
  });
});

// ─── sourceCheckCommand (Task 5 / Opus re-review Fix A/B/E) ─────────────────────

describe("sourceCheckCommand", () => {
  test("python editable + known import name -> a check whose command carries the name and cwd", () => {
    const check = sourceCheckCommand({
      component: "api",
      kind: "python",
      prepare: "pip install -e .",
      cwd: "/tmp/worktree",
      importName: "pkg",
      scriptDir: "/tmp/scriptdir",
      interp: "python3",
    });
    expect(check).not.toBeNull();
    expect(check?.command).toContain("pkg");
    expect(check?.command).toContain("/tmp/worktree");
    expect(check?.command).toContain(check?.scriptPath ?? "");
    expect(check?.command.startsWith("python3 ")).toBe(true);
    expect(check?.script).toContain("find_spec");
  });

  test("node kind -> null (no python source-shadowing risk)", () => {
    expect(
      sourceCheckCommand({
        component: "web",
        kind: "node",
        prepare: "npm ci",
        cwd: "/tmp/worktree",
        importName: "pkg",
        scriptDir: "/tmp/scriptdir",
        interp: "python3",
      }),
    ).toBeNull();
  });

  test("python but prepare is not editable-install -> null", () => {
    expect(
      sourceCheckCommand({
        component: "api",
        kind: "python",
        prepare: "pip install -r requirements.txt",
        cwd: "/tmp/worktree",
        importName: "pkg",
        scriptDir: "/tmp/scriptdir",
        interp: "python3",
      }),
    ).toBeNull();
  });

  test("the generated command is isCommandSafe (no shell metacharacters)", () => {
    const check = sourceCheckCommand({
      component: "api",
      kind: "python",
      prepare: "pip install -e .",
      cwd: "/tmp/some worktree",
      importName: "pkg_name",
      scriptDir: "/tmp/some scriptdir",
      interp: "python3",
    });
    expect(check).not.toBeNull();
    expect(isCommandSafe(check?.command ?? "")).toBe(true);
  });
});

// ─── Fix B: underivable/invalid import name escalates, never a silent skip ─────

describe("sourceCheckCommand: unresolvable import name escalates (Fix B)", () => {
  test("python editable + undefined import name -> throws (not null)", () => {
    expect(() =>
      sourceCheckCommand({
        component: "api",
        kind: "python",
        prepare: "pip install -e .",
        cwd: "/tmp/worktree",
        importName: undefined,
        scriptDir: "/tmp/scriptdir",
        interp: "python3",
      }),
    ).toThrow("provision: cannot verify worktree source (unresolvable import name) for api");
  });

  test("python editable + an import name failing the Fix E regex -> throws (not null)", () => {
    expect(() =>
      sourceCheckCommand({
        component: "api",
        kind: "python",
        prepare: "pip install -e .",
        cwd: "/tmp/worktree",
        importName: 'pkg"; rm -rf /',
        scriptDir: "/tmp/scriptdir",
        interp: "python3",
      }),
    ).toThrow(/cannot verify worktree source/);
  });

  test("non-editable / non-python shapes still legitimately return null, not throw", () => {
    expect(
      sourceCheckCommand({
        component: "web",
        kind: "node",
        prepare: "npm ci",
        cwd: "/tmp/worktree",
        importName: undefined,
        scriptDir: "/tmp/scriptdir",
        interp: "python3",
      }),
    ).toBeNull();
  });
});

// ─── Fix A: the probe runs OUTSIDE the worktree ──────────────────────────────

describe("sourceCheckCommand: probe script lives outside the worktree (Fix A)", () => {
  test("scriptPath is outside the given worktree cwd, and writing it lands no file inside the worktree", () => {
    const worktree = tmpDir("styre-prov-outside-worktree-");
    const scriptDir = tmpDir("styre-provcheck-");

    const check = sourceCheckCommand({
      component: "api",
      kind: "python",
      prepare: "pip install -e .",
      cwd: worktree,
      importName: "pkg",
      scriptDir,
      interp: "python3",
    });
    expect(check).not.toBeNull();
    if (!check) return;

    expect(check.scriptPath.startsWith(scriptDir)).toBe(true);
    expect(check.scriptPath.startsWith(worktree)).toBe(false);

    // Simulate exactly what the handler does: write the script to scriptPath, then assert the
    // worktree — the one thing under agent control — received no writes at all.
    expect(readdirSync(worktree)).toEqual([]);
    writeFileSync(check.scriptPath, check.script);
    expect(readdirSync(worktree)).toEqual([]);
  });
});

// ─── Task 5 §11 / Opus re-review regression: shadowed copies are detected ───────

describe("sourceCheckCommand regression: shadowed copy is detected", () => {
  // Live-gated (needs a real `python3`/`python` on PATH). The pure-shape assertions above run
  // unconditionally; these prove the generated check actually catches the disease end to end,
  // running from OUTSIDE the worktree as the fixed handler does.
  const live = process.env.RUN_LIVE === "1" ? test : test.skip;

  live("a module resolving OUTSIDE the worktree cwd makes the check exit non-zero", async () => {
    const worktree = tmpDir("styre-prov-shadow-worktree-");
    const shadowRoot = tmpDir("styre-prov-shadow-outside-");
    const scriptDir = tmpDir("styre-provcheck-shadow-");
    // The "shadowing" package: importable, but its origin is NOT under the worktree — e.g. a
    // pre-installed/conda copy sitting earlier on sys.path than the (never-actually-run-here)
    // editable install would be. Nothing of this name exists in the worktree at all.
    mkdirSync(join(shadowRoot, "shadow_pkg"), { recursive: true });
    writeFileSync(join(shadowRoot, "shadow_pkg", "__init__.py"), "");

    const interp = resolvePythonInterpreter();
    const check = sourceCheckCommand({
      component: "api",
      kind: "python",
      prepare: "pip install -e .",
      cwd: worktree,
      importName: "shadow_pkg",
      scriptDir,
      interp,
    });
    expect(check).not.toBeNull();
    if (!check) return;
    writeFileSync(check.scriptPath, check.script);

    const prevPythonPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = shadowRoot;
    try {
      const result = await runCommand(check.command, { cwd: worktree, timeoutMs: 10_000 });
      expect(result.exitCode).not.toBe(0);
    } finally {
      if (prevPythonPath === undefined) Reflect.deleteProperty(process.env, "PYTHONPATH");
      else process.env.PYTHONPATH = prevPythonPath;
    }
  });

  // THE Opus F-1 crux case: a flat-layout package dir sits INSIDE the worktree (as it would after
  // an agent writes source, whether or not `pip install -e .` actually wired it up correctly) AND
  // a same-named package sits OUTSIDE the worktree on PYTHONPATH (the "shadow" — what a plain
  // `import pkg` from a neutral location, with no worktree editable-install linkage in effect,
  // would actually resolve to). Pre-fix, the check script was written INTO the worktree and
  // invoked as `python "<worktree>/…"`, which makes CPython prepend the worktree itself to
  // sys.path[0] — so find_spec found the worktree's own pkg/ directly, via the script's location,
  // NOT via any real editable-install linkage, and PASSED regardless of the shadow. That is the
  // false pass this fix closes: the probe must resolve the name exactly as a real, neutral
  // `import <pkg>` would, with no worktree-because-that's-where-the-script-lives assist.
  live(
    "flat-layout: worktree/pkg/__init__.py + a same-named shadow on PYTHONPATH -> exits non-zero",
    async () => {
      const worktree = tmpDir("styre-prov-flatshadow-worktree-");
      const shadowRoot = tmpDir("styre-prov-flatshadow-outside-");
      const scriptDir = tmpDir("styre-provcheck-flatshadow-");

      mkdirSync(join(worktree, "pkg"), { recursive: true });
      writeFileSync(join(worktree, "pkg", "__init__.py"), "");
      mkdirSync(join(shadowRoot, "pkg"), { recursive: true });
      writeFileSync(join(shadowRoot, "pkg", "__init__.py"), "");

      const interp = resolvePythonInterpreter();
      const check = sourceCheckCommand({
        component: "api",
        kind: "python",
        prepare: "pip install -e .",
        cwd: worktree,
        importName: "pkg",
        scriptDir,
        interp,
      });
      expect(check).not.toBeNull();
      if (!check) return;
      writeFileSync(check.scriptPath, check.script);

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

// ─── Task 9: diffTouchesManifest + the manifest-touch re-provision hook ────────

describe("diffTouchesManifest", () => {
  test("true for a nested package.json", () => {
    expect(diffTouchesManifest(["foo/package.json"])).toBe(true);
  });
  test("true for a root pyproject.toml", () => {
    expect(diffTouchesManifest(["pyproject.toml"])).toBe(true);
  });
  test("true for a requirements-dev.txt (requirements*.txt)", () => {
    expect(diffTouchesManifest(["requirements-dev.txt"])).toBe(true);
  });
  test("true for other manifest/lockfile basenames", () => {
    for (const p of [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "poetry.lock",
      "Pipfile",
      "Pipfile.lock",
    ]) {
      expect(diffTouchesManifest([p])).toBe(true);
    }
  });
  test("false for ordinary source/doc files", () => {
    expect(diffTouchesManifest(["src/main.py", "README.md"])).toBe(false);
  });
  test("false for an empty changed-files list", () => {
    expect(diffTouchesManifest([])).toBe(false);
  });
  test("true when only one of several changed files is a manifest", () => {
    expect(diffTouchesManifest(["src/main.py", "README.md", "package.json"])).toBe(true);
  });
});

describe("resetProvisionIfManifestTouched", () => {
  async function succeedProvision(db: Parameters<typeof runStep>[0], ticketId: number) {
    await runStep(db, {
      ticketId,
      stepKey: "provision",
      stepType: "provision",
      effectful: true,
      execute: () => ({ ok: true }),
    });
  }

  test("a manifest-touching diff resets a succeeded provision step to pending (attempt 0)", async () => {
    const { db, ticketId } = makeTestDb();
    await succeedProvision(db, ticketId);
    expect(getByKey(db, ticketId, "provision")?.status).toBe("succeeded");

    resetProvisionIfManifestTouched(db, ticketId, ["src/main.py", "requirements.txt"]);

    const after = getByKey(db, ticketId, "provision");
    db.close();
    expect(after?.status).toBe("pending");
    expect(after?.attempt).toBe(0);
  });

  test("a non-manifest diff leaves a succeeded provision step untouched", async () => {
    const { db, ticketId } = makeTestDb();
    await succeedProvision(db, ticketId);

    resetProvisionIfManifestTouched(db, ticketId, ["src/main.py", "README.md"]);

    const after = getByKey(db, ticketId, "provision");
    db.close();
    expect(after?.status).toBe("succeeded");
  });

  test("no-op when there is no provision step yet, even with a manifest-touching diff", () => {
    const { db, ticketId } = makeTestDb();
    resetProvisionIfManifestTouched(db, ticketId, ["package.json"]);
    const after = getByKey(db, ticketId, "provision");
    db.close();
    expect(after).toBeNull();
  });
});

describe("resetProvision (shared by park's resume path and the manifest-touch hook)", () => {
  test("only resets a currently-succeeded provision step", async () => {
    const { db, ticketId } = makeTestDb();
    const run = runStep(db, {
      ticketId,
      stepKey: "provision",
      stepType: "provision",
      execute: () => {
        throw new Error("boom");
      },
    });
    await expect(run).rejects.toThrow("boom");

    resetProvision(db, ticketId);

    const after = getByKey(db, ticketId, "provision");
    db.close();
    expect(after?.status).toBe("failed");
  });
});
