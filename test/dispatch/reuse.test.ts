import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "../../src/dispatch/profile.ts";
import { resolvePythonInterpreter } from "../../src/dispatch/provision.ts";
import { pythonEnvReady, reuseAwareTestCommand } from "../../src/dispatch/reuse.ts";
import { runCommand } from "../../src/util/run-command.ts";

const fake = (results: Record<string, number>) => async (cmd: string) => ({
  exitCode: Object.entries(results).find(([k]) => cmd.includes(k))?.[1] ?? 0,
  stdout: "",
  stderr: "",
  timedOut: false,
});

test("pythonEnvReady true only when source-check AND collect-only both exit 0", async () => {
  expect(
    await pythonEnvReady(
      "/wt",
      "astropy",
      "python3",
      fake({ "styre-provision-check": 0, "--collect-only": 0 }),
    ),
  ).toBe(true);
  expect(
    await pythonEnvReady(
      "/wt",
      "astropy",
      "python3",
      fake({ "styre-provision-check": 1, "--collect-only": 0 }),
    ),
  ).toBe(false); // wrong bytes
  expect(
    await pythonEnvReady(
      "/wt",
      "astropy",
      "python3",
      fake({ "styre-provision-check": 0, "--collect-only": 1 }),
    ),
  ).toBe(false); // missing plugin
  expect(await pythonEnvReady("/wt", undefined, "python3", fake({}))).toBe(false); // no import name
});

test("reuseAwareTestCommand: ready python test → pytest with the resolved interp", async () => {
  // reuseAwareTestCommand derives importName via the REAL pythonImportName(absCwd) (fs-based, not
  // run-injected) — unlike pythonEnvReady, it takes no importName param. A literal placeholder cwd
  // like "/wt" doesn't exist, so pythonImportName("/wt") returns undefined and the probe would
  // short-circuit to false regardless of the faked runner. Use a real tmpdir with a resolvable
  // `pyproject.toml` `[project] name` so only the (faked) external commands are stubbed — the
  // decision logic under test — while importName resolution is exercised for real.
  const root = mkdtempSync(join(tmpdir(), "styre-reuse-cmd-"));
  try {
    writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "pkg"\n');
    const c: Component = {
      name: "python",
      kind: "python",
      paths: ["**"],
      commands: { test: "tox" },
      extensions: [],
    };
    const cmd = await reuseAwareTestCommand(
      c,
      "test",
      "tox",
      root,
      fake({ "styre-provision-check": 0, "--collect-only": 0 }),
    );
    expect(cmd).toBe(`${resolvePythonInterpreter()} -m pytest`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reuseAwareTestCommand: non-python / non-test unchanged (no python needed)", async () => {
  const node: Component = {
    name: "fe",
    kind: "node",
    paths: ["**"],
    commands: { test: "npm run test" },
    extensions: [],
  };
  expect(await reuseAwareTestCommand(node, "test", "npm run test", "/wt", fake({}))).toBe(
    "npm run test",
  );
  const py: Component = {
    name: "py",
    kind: "python",
    paths: ["**"],
    commands: { lint: "ruff" },
    extensions: [],
  };
  expect(await reuseAwareTestCommand(py, "lint", "ruff", "/wt", fake({}))).toBe("ruff");
});

// ─── RUN_LIVE-gated: real python, real editable install ────────────────────────

// `--break-system-packages` is required on PEP 668 "externally managed environment" pythons (e.g.
// Homebrew's) where a bare `pip install`/`uninstall` refuses to touch the system site-packages.
// It's a no-op flag on pythons without that marker (a venv, pyenv, etc.), so it's safe either way
// for this opt-in, install-then-uninstall live probe. `--user` is install-only (pip rejects it on
// `uninstall`: "no such option: --user").
const PIP_INSTALL_FLAGS = "--break-system-packages --user";
const PIP_UNINSTALL_FLAGS = "--break-system-packages";

describe("pythonEnvReady: real python env", () => {
  const live = process.env.RUN_LIVE === "1" ? test : test.skip;

  live("true when the package is editable-installed under the worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-reuse-live-"));
    const interp = resolvePythonInterpreter();
    let installedPytest = false;
    try {
      mkdirSync(join(root, "pkg"), { recursive: true });
      writeFileSync(join(root, "pkg", "__init__.py"), "");
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests", "test_x.py"), "def test_x():\n    assert True\n");
      writeFileSync(
        join(root, "setup.py"),
        "from setuptools import setup\nsetup(name='pkg', version='0.0.1', packages=['pkg'])\n",
      );

      const pytestCheck = await runCommand(`${interp} -m pytest --version`, {
        cwd: root,
        timeoutMs: 30_000,
      });
      if (pytestCheck.exitCode !== 0) {
        const installPytest = await runCommand(
          `${interp} -m pip install ${PIP_INSTALL_FLAGS} pytest`,
          { cwd: root, timeoutMs: 5 * 60 * 1000 },
        );
        expect(installPytest.exitCode).toBe(0);
        installedPytest = true;
      }

      const install = await runCommand(`${interp} -m pip install ${PIP_INSTALL_FLAGS} -e .`, {
        cwd: root,
        timeoutMs: 5 * 60 * 1000,
      });
      expect(install.exitCode).toBe(0);

      try {
        expect(await pythonEnvReady(root, "pkg", interp)).toBe(true);
      } finally {
        await runCommand(`${interp} -m pip uninstall -y ${PIP_UNINSTALL_FLAGS} pkg`, {
          cwd: root,
          timeoutMs: 60_000,
        });
        if (installedPytest) {
          await runCommand(`${interp} -m pip uninstall -y ${PIP_UNINSTALL_FLAGS} pytest`, {
            cwd: root,
            timeoutMs: 60_000,
          });
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  live("false when the package is not installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-reuse-live-uninstalled-"));
    try {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests", "test_x.py"), "def test_x():\n    assert True\n");

      const interp = resolvePythonInterpreter();
      expect(await pythonEnvReady(root, "not_a_real_pkg", interp)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
