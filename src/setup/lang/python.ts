import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findManifests } from "../manifests.ts";
import type { ComponentDraft, LangDef } from "./types.ts";

/** §5.3 runner detection: tox > nox > pytest-config > default. Root-level config only. */
export function pythonTestCommand(repoDir: string): string {
  if (existsSync(join(repoDir, "tox.ini"))) return "tox";
  if (existsSync(join(repoDir, "noxfile.py"))) return "nox";
  if (existsSync(join(repoDir, "pytest.ini"))) return "pytest";
  const pp = join(repoDir, "pyproject.toml");
  if (existsSync(pp)) {
    try {
      if (/\[tool\.pytest/.test(readFileSync(pp, "utf8"))) return "pytest";
    } catch {
      // unreadable pyproject — fall through to default
    }
  }
  return "python -m pytest";
}

export function pythonPrepare(repoDir: string): string | undefined {
  const test = pythonTestCommand(repoDir);
  if (test === "tox") return "pip install tox";
  if (test === "nox") return "pip install nox";
  if (
    existsSync(join(repoDir, "pyproject.toml")) ||
    existsSync(join(repoDir, "setup.py")) ||
    existsSync(join(repoDir, "setup.cfg"))
  )
    return "pip install -e .";
  if (existsSync(join(repoDir, "requirements.txt"))) return "pip install -r requirements.txt";
  return undefined;
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
