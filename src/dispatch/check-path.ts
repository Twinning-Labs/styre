/** Canonical RED-first check filenames tie a committed test file to one AC by its BASENAME —
 *  `{ident}_ac{acId}_test.{ext}` (prompts/checks.md) — independent of directory. The runner resolves
 *  the authoritative test path from what the agent actually committed, not from the path it declared
 *  (ENG-296: write-vs-declare divergence). Pure; no I/O. */

/** The extension-less canonical basename for a check test, e.g. `ENG-294_ac1_test`. */
export function canonicalCheckBase(ident: string, acId: number): string {
  return `${ident}_ac${acId}_test`;
}

/** The last path segment (git paths are always forward-slash). */
function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** Normalize a path for comparison: backslashes → forward slashes, strip a leading `./`.
 *  The single source of this rule — the commit scope guard imports it so guard and resolver agree. */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True iff `path`'s basename is the canonical check filename for SOME acId in `acIds`. Matches any
 *  extension (single or multi-dot) by requiring the basename to start with `${base}.`. */
export function isCanonicalCheckPath(
  path: string,
  ident: string,
  acIds: Iterable<number>,
): boolean {
  const b = basename(path);
  for (const acId of acIds) {
    if (b.startsWith(`${canonicalCheckBase(ident, acId)}.`)) return true;
  }
  return false;
}

/** The single committed added path whose basename is the canonical check filename for `acId`.
 *  `null` when zero match OR ≥2 match (ambiguous → caller falls back / reports uncovered). */
export function matchAuthoredTest(
  addedPaths: string[],
  ident: string,
  acId: number,
): string | null {
  const prefix = `${canonicalCheckBase(ident, acId)}.`;
  const hits = addedPaths.filter((p) => basename(p).startsWith(prefix));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** The authoritative test path for `acId`: (a) the canonically-named committed file (divergence-proof
 *  override); else (b) the declared path if it was itself committed — compared after `normPath` so a
 *  `./`-prefixed or backslashed declaration still matches, returning git's added form; else (c) `null`. */
export function resolveAuthoredTestPath(
  addedPaths: string[],
  ident: string,
  acId: number,
  declaredTestFile: string,
): string | null {
  const canonical = matchAuthoredTest(addedPaths, ident, acId);
  if (canonical !== null) return canonical;
  const target = normPath(declaredTestFile);
  return addedPaths.find((p) => normPath(p) === target) ?? null;
}
