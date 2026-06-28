import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../../dispatch/profile.ts";
import type { LangDef } from "./types.ts";

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

export const pythonDef: LangDef = {
  kind: "python",
  detect(repoDir: string): Component[] {
    const hasPython = ["pyproject.toml", "setup.py", "requirements.txt"].some((m) =>
      existsSync(join(repoDir, m)),
    );
    if (!hasPython) return [];
    return [
      {
        name: "python",
        kind: "python",
        paths: ["**"],
        commands: { test: pythonTestCommand(repoDir) },
      },
    ];
  },
};
