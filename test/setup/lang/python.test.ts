import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unrootedManifestWarnings } from "../../../src/setup/detect-components.ts";
import { pythonDef, pythonImportName, pythonPrepare } from "../../../src/setup/lang/python.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-python-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("python: pyproject.toml → one python component, default runner", () => {
  const root = fixture({ "pyproject.toml": "[project]\nname='x'\n" });
  const components = pythonDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("python");
  expect(c.kind).toBe("python");
  expect(c.paths).toEqual(["**"]);
  expect(c.commands.test).toBe("python -m pytest");
});

test("python: setup.py → one python component", () => {
  const root = fixture({ "setup.py": "" });
  const components = pythonDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].kind).toBe("python");
});

test("python: requirements.txt → one python component", () => {
  const root = fixture({ "requirements.txt": "pytest\n" });
  const components = pythonDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].commands.test).toBe("python -m pytest");
});

test("python: runner detection precedence tox > nox > pytest-config > default", () => {
  expect(
    pythonDef.detect(fixture({ "setup.py": "", "tox.ini": "[tox]\n" }))[0]?.commands.test,
  ).toBe("tox");
  expect(pythonDef.detect(fixture({ "setup.py": "", "noxfile.py": "" }))[0]?.commands.test).toBe(
    "nox",
  );
  expect(
    pythonDef.detect(fixture({ "setup.py": "", "pytest.ini": "[pytest]\n" }))[0]?.commands.test,
  ).toBe("pytest");
  expect(
    pythonDef.detect(fixture({ "pyproject.toml": "[tool.pytest.ini_options]\n" }))[0]?.commands
      .test,
  ).toBe("pytest");
  expect(pythonDef.detect(fixture({ "requirements.txt": "pytest\n" }))[0]?.commands.test).toBe(
    "python -m pytest",
  );
});

test("python: no python manifest → no components", () => {
  const root = fixture({ "README.md": "x" });
  expect(pythonDef.detect(root)).toHaveLength(0);
});

test("python: single root pyproject → one root component (unchanged)", () => {
  const root = fixture({ "pyproject.toml": "[project]\n" });
  expect(pythonDef.detect(root)).toEqual([
    {
      name: "python",
      kind: "python",
      paths: ["**"],
      commands: { test: "python -m pytest" },
      prepare: "pip install -e .",
    },
  ]);
});

test("python: subdir-only pyproject/setup.py → per-subdir dir-scoped components", () => {
  const root = fixture({ "services/a/pyproject.toml": "[project]\n", "services/b/setup.py": "" });
  const cs = pythonDef.detect(root).sort((x, y) => x.name.localeCompare(y.name));
  expect(cs.map((c) => [c.name, c.dir, c.paths[0]])).toEqual([
    ["services-a", "services/a", "services/a/**"],
    ["services-b", "services/b", "services/b/**"],
  ]);
});

test("python: root + nested → root ['**'] AND nested dir-scoped", () => {
  const root = fixture({ "pyproject.toml": "[project]\n", "libs/x/pyproject.toml": "[project]\n" });
  const cs = pythonDef.detect(root);
  expect(cs.find((c) => c.dir === undefined)?.paths).toEqual(["**"]);
  expect(cs.find((c) => c.dir === "libs/x")?.paths).toEqual(["libs/x/**"]);
});

test("python: a module with BOTH pyproject and setup.py → ONE component", () => {
  const root = fixture({ "svc/pyproject.toml": "[project]\n", "svc/setup.py": "" });
  expect(pythonDef.detect(root).filter((c) => c.dir === "svc")).toHaveLength(1);
});

test("python: subdir requirements.txt with no pyproject/setup.py → NOT a module, but warns", () => {
  const root = fixture({ "svc/requirements.txt": "flask\n" });
  expect(pythonDef.detect(root)).toEqual([]); // no module emitted
  expect(
    unrootedManifestWarnings(root).some((w) => w.includes("svc") && w.includes("requirements.txt")),
  ).toBe(true);
});

// ─── Task 2: pythonPrepare (test-command-matched) ────────────────────────────

describe("pythonPrepare", () => {
  test("tox -> pip install tox", () => {
    expect(pythonPrepare(fixture({ "tox.ini": "", "setup.py": "" }))).toBe("pip install tox");
  });
  test("nox -> pip install nox", () => {
    expect(pythonPrepare(fixture({ "noxfile.py": "" }))).toBe("pip install nox");
  });
  test("pytest+pyproject -> editable", () => {
    expect(pythonPrepare(fixture({ "pyproject.toml": "[tool.pytest.ini_options]\n" }))).toBe(
      "pip install -e .",
    );
  });
  test("requirements only -> requirements", () => {
    expect(pythonPrepare(fixture({ "requirements.txt": "requests\n" }))).toBe(
      "pip install -r requirements.txt",
    );
  });
  test("nothing installable -> undefined", () => {
    expect(pythonPrepare(fixture({ "main.py": "print(1)" }))).toBeUndefined();
  });
});

// ─── Task 5: pythonImportName ────────────────────────────────────────────────

describe("pythonImportName", () => {
  test("pyproject.toml [project] name -> normalized (- to _)", () => {
    const root = fixture({ "pyproject.toml": '[project]\nname = "my-pkg"\n' });
    expect(pythonImportName(root)).toBe("my_pkg");
  });

  test("sole top-level dir with __init__.py -> that dir's name", () => {
    const root = fixture({ "pkg/__init__.py": "" });
    expect(pythonImportName(root)).toBe("pkg");
  });

  test("neither a named pyproject nor a sole __init__.py dir -> undefined", () => {
    const root = fixture({ "README.md": "x" });
    expect(pythonImportName(root)).toBeUndefined();
  });

  test("pyproject.toml present but no [project] name -> falls back to the __init__.py dir", () => {
    const root = fixture({
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "pkg/__init__.py": "",
    });
    expect(pythonImportName(root)).toBe("pkg");
  });

  test("more than one top-level __init__.py dir -> undefined (ambiguous)", () => {
    const root = fixture({ "a/__init__.py": "", "b/__init__.py": "" });
    expect(pythonImportName(root)).toBeUndefined();
  });
});
