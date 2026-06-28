import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../dispatch/profile.ts";
import { isCommandSafe } from "./command-safety.ts";
import type { LangDef } from "./lang/types.ts";
import { findManifests, isSafePath } from "./manifests.ts";
import { REGISTRY } from "./registry.ts";

export { findManifests } from "./manifests.ts";

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
  return { components: [...runRegistry(repoDir, REGISTRY)], repoCommands: {} };
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
