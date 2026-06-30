import { basename, extname } from "node:path";
import type { Component } from "./profile.ts";

const NODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"] as const;
const JVM_EXTS = [".java", ".kt", ".kts", ".scala", ".groovy"] as const;

/** Authoritative map from component `kind` → file extensions that belong to it.
 *  Built at setup time and materialized into each `Component.extensions[]`.
 *  Kinds not in this map (custom/unknown) use empty extensions → path-only routing. */
export const EXTENSIONS_BY_KIND: Record<string, readonly string[]> = {
  rust: [".rs"],
  node: NODE_EXTS,
  sveltekit: [...NODE_EXTS, ".svelte"],
  python: [".py", ".pyi"],
  go: [".go"],
  "jvm-maven": JVM_EXTS,
  "jvm-gradle": [...JVM_EXTS, ".gradle"],
  ruby: [".rb", ".rake", ".gemspec"],
};

/** File extensions that identify documentation-only files (conservative prose set).
 *  Files with these extensions are excluded from the advisory sweep (they cannot break code). */
export const DOCS_EXTS = [".md", ".markdown", ".rst", ".adoc"] as const;

/** True iff `file` is a documentation-only file (extension-based, case-insensitive).
 *  Unowned docs files skip the advisory sweep — they cannot break a foreign stack. */
export function isDocsFile(file: string): boolean {
  return (DOCS_EXTS as readonly string[]).includes(extname(file).toLowerCase());
}

/** Basenames of clearly-non-build-affecting files (strict set — licence/attribution/git metadata only).
 *  Deliberately EXCLUDED: .editorconfig, .gitignore, .gitattributes, and all .json/.yaml/.toml/.lock/.mod
 *  — those are build-affecting and must remain swept. */
export const INERT_BASENAMES = new Set([
  "LICENSE",
  "LICENSE.txt",
  "NOTICE",
  "AUTHORS",
  "COPYING",
  ".mailmap",
]);

/** True iff `file` is inert: a docs file (by extension) OR a known-inert basename.
 *  Used both to skip the advisory sweep AND as the zero-gate pure-inert pass condition —
 *  the set must therefore contain ONLY files that can never flip any stack's gate. */
export function isInertFile(file: string): boolean {
  return isDocsFile(file) || INERT_BASENAMES.has(basename(file));
}

/** True if `cmd` is itself a shell invocation (`bash x.sh`, `./x`) — it cannot be tightly
 *  Bash-scoped via `Bash(cmd:*)`, so callers warn when one is used as a runner. */
export function isScriptRunner(cmd: string): boolean {
  return /^(?:bash|sh|zsh|\.\/)/.test(cmd.trim());
}

/** The real command string for a check-type on a component, or undefined when the slot is
 *  absent or explicitly `{ unavailable: true }`. */
export function commandFor(c: Component, checkType: string): string | undefined {
  const v = c.commands[checkType];
  return typeof v === "string" ? v : undefined;
}

/** True iff the component declares this check-type as explicitly unavailable. */
export function isUnavailable(c: Component, checkType: string): boolean {
  const v = c.commands[checkType];
  return typeof v === "object" && v.unavailable === true;
}

/** True iff `file`'s extension is in the component's `extensions[]`, or the component has no
 *  extensions (undefined or empty → path-only routing; treats custom/unknown kinds as unfiltered).
 *  Undefined-safe: a fixture without `extensions` is treated the same as `extensions: []`. */
export function extMatches(c: Component, file: string): boolean {
  const exts = c.extensions ?? [];
  if (exts.length === 0) return true;
  return exts.includes(extname(file).toLowerCase());
}

/** True iff the file is owned by the component: extension matches AND at least one path-glob matches. */
export function matchesComponent(c: Component, file: string): boolean {
  return extMatches(c, file) && c.paths.some((g) => new Bun.Glob(g).match(file));
}

/** Components whose paths the changed-file set touches (union — a file matching several
 *  components marks all of them). Order preserved from `components`. */
export function impactedComponents(components: Component[], files: string[]): Component[] {
  return components.filter((c) => files.some((f) => matchesComponent(c, f)));
}

/** Every real (string) command across all components — the scoped-union allowlist fallback. */
export function realRunnerCommands(components: Component[]): string[] {
  const out: string[] = [];
  for (const c of components) {
    for (const v of Object.values(c.commands)) {
      if (typeof v === "string") out.push(v);
    }
  }
  return [...new Set(out)];
}

/** Real commands of just the components a file set impacts — the implement Bash scope. */
export function scopedRunnersForFiles(components: Component[], files: string[]): string[] {
  return realRunnerCommands(impactedComponents(components, files));
}
