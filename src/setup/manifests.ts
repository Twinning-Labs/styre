import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SKIP = new Set([
  "node_modules",
  "target",
  ".git",
  "dist",
  "build",
  ".svelte-kit",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".nox",
  "vendor",
  ".gradle",
  ".mvn",
  "Pods",
]);

/** Bounded-depth walk collecting manifest paths (relative to repoDir). */
export function findManifests(repoDir: string, name: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const abs = join(dir, entry);
      const r = rel === "" ? entry : `${rel}/${entry}`;
      if (entry === name) found.push(r);
      else if (statSync(abs).isDirectory()) walk(abs, r, depth + 1);
    }
  };
  walk(repoDir, "", 0);
  return found;
}

/** Invariant 2 helper — a repo-derived workspace member string is safe iff non-empty, not absolute,
 *  has no `..`/`.`/empty segment (after trim), and its first segment is not a `*` glob. */
export function safeMember(m: string): boolean {
  const t = m.trim();
  if (t === "" || t.startsWith("/")) return false;
  const segs = t.split("/").map((s) => s.trim());
  if (segs.some((s) => s === ".." || s === "." || s === "")) return false;
  return !/^\*/.test(segs[0] ?? "");
}

/** Invariant 2 engine backstop — an emitted path glob is safe iff not absolute, no `..`/`.`/empty
 *  segment, and not unanchored (`^*`) EXCEPT the lone structural `**` (a sole-stack root). */
export function isSafePath(g: string): boolean {
  const t = g.trim();
  if (t === "" || t.startsWith("/")) return false;
  const segs = t.split("/").map((s) => s.trim());
  if (segs.some((s) => s === ".." || s === "." || s === "")) return false;
  if (/^\*/.test(segs[0] ?? "")) return t === "**";
  return true;
}
