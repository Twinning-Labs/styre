import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findManifests } from "../manifests.ts";
import {
  parseBuildGradle,
  parseCargoToml,
  parseComposerJson,
  parseGemfile,
  parseGoMod,
  parseGradleCatalog,
  parsePackageJson,
  parsePomXml,
  parsePyproject,
  parseRequirementsTxt,
} from "./parse.ts";

type Lang = "node" | "rust" | "python" | "go" | "ruby" | "php" | "jvm";

const MANIFESTS: { file: string; lang: Lang; parse: (c: string) => string[] }[] = [
  { file: "package.json", lang: "node", parse: parsePackageJson },
  { file: "Cargo.toml", lang: "rust", parse: parseCargoToml },
  { file: "pyproject.toml", lang: "python", parse: parsePyproject },
  { file: "requirements.txt", lang: "python", parse: parseRequirementsTxt },
  { file: "go.mod", lang: "go", parse: parseGoMod },
  { file: "Gemfile", lang: "ruby", parse: parseGemfile },
  { file: "composer.json", lang: "php", parse: parseComposerJson },
  { file: "pom.xml", lang: "jvm", parse: parsePomXml },
  { file: "build.gradle", lang: "jvm", parse: parseBuildGradle },
  { file: "build.gradle.kts", lang: "jvm", parse: parseBuildGradle },
  { file: "libs.versions.toml", lang: "jvm", parse: parseGradleCatalog },
];

/** Bound the per-language list so a huge monorepo can't bloat the enrichment prompt. */
const CAP_PER_LANG = 100;

/** Parse every supported manifest in the repo (depth ≤ 3, vendored dirs skipped) into a
 *  per-language, deduped, sorted, capped list of dependency identifiers. Fail-soft throughout. */
export function collectManifestDeps(repoDir: string): Record<string, string[]> {
  const acc = new Map<Lang, Set<string>>();
  for (const { file, lang, parse } of MANIFESTS) {
    let paths: string[];
    try {
      paths = findManifests(repoDir, file);
    } catch {
      continue;
    }
    for (const rel of paths) {
      let content: string;
      try {
        content = readFileSync(join(repoDir, rel), "utf8");
      } catch {
        continue;
      }
      const names = parse(content);
      if (names.length === 0) continue;
      let set = acc.get(lang);
      if (!set) {
        set = new Set<string>();
        acc.set(lang, set);
      }
      for (const n of names) set.add(n);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [lang, set] of acc) out[lang] = [...set].sort().slice(0, CAP_PER_LANG);
  return out;
}

/** Render the per-language map as prompt-ready markdown, or a placeholder when empty. */
export function renderManifestDeps(map: Record<string, string[]>): string {
  const langs = Object.keys(map).sort();
  if (langs.length === 0) return "(no dependency manifests detected)";
  return langs.map((l) => `- ${l}: ${(map[l] ?? []).join(", ")}`).join("\n");
}
