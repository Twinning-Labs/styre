import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonDef } from "../../../src/setup/lang/python.ts";

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

test("python: nested-only pyproject.toml → no component (root-only detection)", () => {
  const root = fixture({ "src/pyproject.toml": "[project]\n" });
  expect(pythonDef.detect(root)).toHaveLength(0);
});
