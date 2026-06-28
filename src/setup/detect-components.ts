import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../dispatch/profile.ts";
import { isCommandSafe } from "./command-safety.ts";
import type { LangDef } from "./lang/types.ts";
import { findManifests, isSafePath } from "./manifests.ts";
import { REGISTRY } from "./registry.ts";

export { findManifests } from "./manifests.ts";

/** §5.3 runner detection: tox > nox > pytest-config > default. Root-level config only. */
function pythonTestCommand(repoDir: string): string {
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

/** Engine: run every def, enforce Invariant 1 (command backstop, loud) + Invariant 2 (path backstop). */
export function runRegistry(repoDir: string, registry: LangDef[]): Component[] {
  const out: Component[] = [];
  for (const def of registry) {
    for (const c of def.detect(repoDir)) {
      for (const [k, v] of Object.entries(c.commands)) {
        if (typeof v === "string" && !isCommandSafe(v))
          throw new Error(`engine: unsafe command for ${c.name}.${k}: ${v}`);
      }
      const paths = c.paths.filter(isSafePath);
      if (paths.length === 0) continue;
      out.push({ ...c, paths });
    }
  }
  return out;
}

/** Deterministic component skeleton: anchors the agent refine + the command ladder. */
export function detectComponents(repoDir: string): {
  components: Component[];
  repoCommands: Record<string, string>;
} {
  const components: Component[] = [];

  // --- Node/JS: one component per package.json (skip workspace-member packages already covered).
  for (const rel of findManifests(repoDir, "package.json")) {
    const dir = rel.replace(/package\.json$/, "").replace(/\/$/, "");
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(repoDir, rel), "utf8")) as {
        scripts?: Record<string, string>;
      };
    } catch {
      // Malformed package.json — skip this component rather than crashing styre setup.
      continue;
    }
    const scripts = pkg.scripts ?? {};
    const commands: Component["commands"] = {};
    if (scripts.build) commands.build = "npm run build";
    if (scripts.test) commands.test = "npm run test";
    if (scripts.check) commands.check = "npm run check";
    const isRoot = dir === "";
    const fe =
      existsSync(join(repoDir, "svelte.config.js")) || existsSync(join(repoDir, "vite.config.js"));
    components.push({
      name: isRoot ? "frontend" : dir.replace(/\//g, "-"),
      kind: isRoot && fe ? "sveltekit" : "node",
      // Co-located frontend: root package.json owns src/static, NOT a sibling rust src-tauri.
      paths: isRoot ? ["src/**", "static/**", "package.json"] : [`${dir}/**`],
      commands,
    });
  }

  // --- Python: root manifest → one component (single-module; multi-module deferred §5.4).
  const hasPython = ["pyproject.toml", "setup.py", "requirements.txt"].some((m) =>
    existsSync(join(repoDir, m)),
  );
  if (hasPython) {
    components.push({
      name: "python",
      kind: "python",
      paths: ["**"],
      commands: { test: pythonTestCommand(repoDir) },
    });
  }

  // --- Go: root go.mod → one component (single-module; multi-module/go.work deferred §5.4).
  if (existsSync(join(repoDir, "go.mod"))) {
    components.push({
      name: "go",
      kind: "go",
      paths: ["**"],
      commands: { build: "go build ./...", test: "go test ./..." },
    });
  }

  // --- JVM (single-module; multi-module reactor deferred §5.4). Prefer the repo's wrapper.
  if (existsSync(join(repoDir, "pom.xml"))) {
    const mvn = existsSync(join(repoDir, "mvnw")) ? "./mvnw" : "mvn";
    components.push({
      name: "jvm-maven",
      kind: "jvm-maven",
      paths: ["**"],
      commands: { build: `${mvn} -q -DskipTests compile`, test: `${mvn} -q test` },
    });
  }
  if (existsSync(join(repoDir, "build.gradle")) || existsSync(join(repoDir, "build.gradle.kts"))) {
    const gradle = existsSync(join(repoDir, "gradlew")) ? "./gradlew" : "gradle";
    components.push({
      name: "jvm-gradle",
      kind: "jvm-gradle",
      paths: ["**"],
      commands: { build: `${gradle} build -x test`, test: `${gradle} test` },
    });
  }

  return { components: [...components, ...runRegistry(repoDir, REGISTRY)], repoCommands: {} };
}

const TARGETED_LANG_MANIFESTS: Array<[string, string[]]> = [
  ["python", ["pyproject.toml", "setup.py", "requirements.txt"]],
  ["go", ["go.mod"]],
  ["jvm-maven", ["pom.xml"]],
  ["jvm-gradle", ["build.gradle", "build.gradle.kts"]],
];

/** §5.4 loud note: warn when a targeted-language manifest exists only in subdirs (no root match),
 *  so root-only detection's deferral is surfaced rather than silent. */
export function unrootedManifestWarnings(repoDir: string): string[] {
  const out: string[] = [];
  for (const [lang, names] of TARGETED_LANG_MANIFESTS) {
    if (names.some((n) => existsSync(join(repoDir, n)))) continue; // detected at root — fine
    for (const n of names) {
      const nested = findManifests(repoDir, n);
      if (nested.length > 0) {
        const dir = nested[0].replace(/\/?[^/]+$/, "") || ".";
        out.push(
          `⚠ ${n} found under ${dir}/ but not at repo root — multi-module detection deferred (§5.4); no ${lang} component emitted.`,
        );
        break;
      }
    }
  }
  return out;
}
