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

/** Everything before the last `/`; "" for a bare basename. */
function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** The final extension segment of a path's basename (after its last `.`), or "" if none.
 *  `__init__.py` → "py", `x.tests.ts` → "ts", `.gitignore`/`Makefile` → "" (dotfiles/no-dot = no ext). */
function finalExt(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1);
}

/** Per-directory cap on auto-admitted support files (covers Python's `__init__.py` + `conftest.py`). */
const CHECK_SUPPORT_CAP = 2;

/** True iff `path` is a legitimate support file to auto-admit into a `styre_checks/` directory
 *  (ENG-323): (1) its immediate parent dir is named `styre_checks`; (2) that same dir holds a
 *  canonical `{ident}_ac<id>_test.*` file in `addedNewPaths` (this dispatch's new files); (3) it shares
 *  the final extension of SOME co-located canonical check; (4) it is within `CHECK_SUPPORT_CAP` of the
 *  same-dir, same-ext, non-canonical new files (lexicographic tie-break → deterministic + retry-stable).
 *  Does NOT re-admit a canonical test (that is `isCanonicalCheckPath`'s job). Inputs are assumed
 *  normalized (forward-slash, no `./`). Pure; no I/O. */
export function isCheckSupportFile(
  path: string,
  addedNewPaths: string[],
  ident: string,
  acIds: Iterable<number>,
): boolean {
  const dir = dirname(path);
  if (basename(dir) !== "styre_checks") return false;
  const ids = [...acIds];
  const ext = finalExt(path);
  if (ext === "") return false;
  const canonicalSiblings = addedNewPaths.filter(
    (p) => dirname(p) === dir && isCanonicalCheckPath(p, ident, ids),
  );
  if (!canonicalSiblings.some((p) => finalExt(p) === ext)) return false;
  const supportCandidates = addedNewPaths
    .filter(
      (p) => dirname(p) === dir && finalExt(p) === ext && !isCanonicalCheckPath(p, ident, ids),
    )
    .sort();
  const rank = supportCandidates.indexOf(path);
  return rank !== -1 && rank < CHECK_SUPPORT_CAP;
}
