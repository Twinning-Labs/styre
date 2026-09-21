import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandValue } from "../../dispatch/profile.ts";
import { findManifests } from "../manifests.ts";
import type { ComponentDraft, LangDef } from "./types.ts";

/** §5.3 runner detection: tox > nox > pytest-config > default. Root-level config only. */
export function pythonTestCommand(repoDir: string): CommandValue {
  if (
    existsSync(join(repoDir, "django", "__init__.py")) &&
    existsSync(join(repoDir, "tests", "runtests.py"))
  )
    return "python3 ./tests/runtests.py --parallel 1";
  if (hasToxConfig(repoDir))
    return {
      unresolved:
        "tox configuration found; select the test environments explicitly with tox -e <names>.",
    };
  if (existsSync(join(repoDir, "noxfile.py")))
    return {
      unresolved:
        "nox configuration found; select the test sessions explicitly with nox -s <names>.",
    };
  if (existsSync(join(repoDir, "pytest.ini"))) return "python3 -m pytest";
  const pp = join(repoDir, "pyproject.toml");
  if (existsSync(pp)) {
    try {
      if (/\[tool\.pytest/.test(readFileSync(pp, "utf8"))) return "python3 -m pytest";
    } catch {
      // unreadable pyproject — fall through to default
    }
  }
  for (const file of [
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "requirements-test.txt",
    "pyproject.toml",
  ]) {
    const path = join(repoDir, file);
    if (
      existsSync(path) &&
      /(?:["'\s\[,]|^)pytest(?:["'\s>=<~!\],]|$)|\[tool:pytest\]/m.test(readFileSync(path, "utf8"))
    )
      return "python3 -m pytest";
  }
  return {
    unresolved:
      "No declared Python test framework. Select an existing runner or an explicit test-authoring workflow.",
  };
}

export function pythonPrepare(repoDir: string): string | undefined {
  if (hasToxConfig(repoDir)) return "pip install tox";
  if (existsSync(join(repoDir, "noxfile.py"))) return "pip install nox";
  if (
    existsSync(join(repoDir, "pyproject.toml")) ||
    existsSync(join(repoDir, "setup.py")) ||
    existsSync(join(repoDir, "setup.cfg"))
  )
    return "pip install -e .";
  if (existsSync(join(repoDir, "requirements.txt"))) return "pip install -r requirements.txt";
  return undefined;
}

function hasToxConfig(repoDir: string): boolean {
  if (["tox.ini", "tox.toml"].some((name) => existsSync(join(repoDir, name)))) return true;
  const cfg = join(repoDir, "setup.cfg");
  if (
    existsSync(cfg) &&
    /^\s*\[(?:tox:tox|testenv(?::[^\]]+)?)\]\s*(?:[#;].*)?$/m.test(readFileSync(cfg, "utf8"))
  )
    return true;
  const pp = join(repoDir, "pyproject.toml");
  if (!existsSync(pp)) return false;
  const parsed = Bun.TOML.parse(readFileSync(pp, "utf8"));
  const tool = "tool" in parsed ? parsed.tool : undefined;
  return typeof tool === "object" && tool !== null && "tox" in tool;
}

/** The importable module name for a python component, used by `provision`'s post-install
 *  worktree-source check (Task 5). Preference order: `pyproject.toml` `[project]` `name` (PEP
 *  621), else `pyproject.toml` `[tool.poetry]` `name` (Poetry projects commonly have no
 *  `[project]` table at all) — both `-` normalized to `_` as pip/setuptools do at install time —
 *  else the sole top-level directory containing `__init__.py` (flat layout), else the sole
 *  `src/<pkg>/__init__.py` directory (src layout); else `undefined` (the check is then treated
 *  as underivable by the caller — never silently skipped, see provision.ts Fix B). */
export function pythonImportName(repoDir: string): string | undefined {
  const pp = join(repoDir, "pyproject.toml");
  if (existsSync(pp)) {
    try {
      const content = readFileSync(pp, "utf8");
      const project = content.match(/\[project\]([\s\S]*?)(?=\n\[|$)/);
      const projectName = project?.[1].match(/name\s*=\s*["']([^"']+)["']/);
      if (projectName) return projectName[1].replace(/-/g, "_");
      const poetry = content.match(/\[tool\.poetry\]([\s\S]*?)(?=\n\[|$)/);
      const poetryName = poetry?.[1].match(/name\s*=\s*["']([^"']+)["']/);
      if (poetryName) return poetryName[1].replace(/-/g, "_");
    } catch {
      // unreadable/unparsable pyproject — fall through to the directory scans
    }
  }
  // A literal distribution name is only a hint: confirm a matching source directory.
  // This resolves setup.py projects with additional test/tool packages without executing setup.py.
  const setup = join(repoDir, "setup.py");
  if (existsSync(setup)) {
    const literal = /^\s*name\s*=\s*["']([A-Za-z0-9_-]+)["']\s*,?\s*$/m
      .exec(readFileSync(setup, "utf8"))?.[1]
      .replace(/-/g, "_");
    if (literal)
      for (const base of [repoDir, join(repoDir, "src")]) {
        if (!existsSync(base)) continue;
        const matching = readdirSync(base, { withFileTypes: true }).filter(
          (e) =>
            e.isDirectory() &&
            e.name.toLowerCase() === literal.toLowerCase() &&
            existsSync(join(base, e.name, "__init__.py")),
        );
        if (matching.length === 1) return matching[0].name;
      }
  }
  try {
    const candidates = readdirSync(repoDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(join(repoDir, e.name, "__init__.py")));
    if (candidates.length === 1) return candidates[0].name;
  } catch {
    // unreadable repoDir — fall through to the src-layout scan
  }
  const srcDir = join(repoDir, "src");
  if (existsSync(srcDir)) {
    try {
      const candidates = readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => existsSync(join(srcDir, e.name, "__init__.py")));
      if (candidates.length === 1) return candidates[0].name;
    } catch {
      // unreadable src/ dir — no name to offer
    }
  }
  return undefined;
}

const PY_ROOT_MANIFESTS = ["pyproject.toml", "setup.py", "requirements.txt"];
const PY_MODULE_ANCHORS = ["pyproject.toml", "setup.py"]; // nested-module anchors (NOT requirements.txt)

export const pythonDef: LangDef = {
  kind: "python",
  detect(repoDir: string): ComponentDraft[] {
    const out: ComponentDraft[] = [];
    // Root component: existing 3-name trigger (incl requirements.txt), unchanged.
    if (PY_ROOT_MANIFESTS.some((m) => existsSync(join(repoDir, m)))) {
      out.push({
        name: "python",
        kind: "python",
        paths: ["**"],
        commands: { test: pythonTestCommand(repoDir) },
        prepare: pythonPrepare(repoDir),
      });
    }
    // Nested modules: a subdir with pyproject.toml or setup.py (dedup by dir).
    const dirs = new Set<string>();
    for (const m of PY_MODULE_ANCHORS) {
      for (const rel of findManifests(repoDir, m)) {
        const dir = rel.slice(0, -m.length).replace(/\/$/, "");
        if (dir !== "") dirs.add(dir);
      }
    }
    for (const dir of [...dirs].sort()) {
      out.push({
        name: dir.replace(/\//g, "-"),
        kind: "python",
        dir,
        paths: [`${dir}/**`],
        commands: { test: pythonTestCommand(join(repoDir, dir)) },
        prepare: pythonPrepare(join(repoDir, dir)),
      });
    }
    return out;
  },
};
