import { extname } from "node:path";
import type { Component } from "./profile.ts";

/** File extensions that identify documentation-only files (conservative prose set).
 *  Files with these extensions are excluded from the advisory sweep (they cannot break code). */
export const DOCS_EXTS = [".md", ".markdown", ".rst", ".adoc"] as const;

/** True iff `file` is a documentation-only file (extension-based, case-insensitive).
 *  Unowned docs files skip the advisory sweep — they cannot break a foreign stack. */
export function isDocsFile(file: string): boolean {
  return (DOCS_EXTS as readonly string[]).includes(extname(file).toLowerCase());
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

/** True if any of the component's path-globs matches `path`. */
export function matchesComponent(c: Component, path: string): boolean {
  return c.paths.some((g) => new Bun.Glob(g).match(path));
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
