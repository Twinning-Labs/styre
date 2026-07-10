/** The single source of truth for "what docs:revise may edit", shared by the commitGuard
 *  (enforcement) and the prompt (guidance) so they can never drift. Repo-root-scoped and
 *  fail-closed: a nested `src/docs/x` or `src/README.md` is NOT a doc path (a source file under a
 *  dir named `docs`, or a co-located README, must not be editable — it could change what the
 *  checks run and invalidate the carry-forward premise). */

const ROOT_DOCS_TREE = /^docs\//i; // repo-root docs/ directory only
const ROOT_DOC_FILE = /^(readme|changelog|contributing)[^/]*$/i; // repo-root, any extension
const MKDOCS = /^mkdocs\.yml$/i;

/** True iff `file` (a repo-root-relative path) is documentation styre may sync. */
export function isDocPath(file: string): boolean {
  const p = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (ROOT_DOCS_TREE.test(p)) return true;
  if (!p.includes("/") && (ROOT_DOC_FILE.test(p) || MKDOCS.test(p))) return true;
  return false;
}

/** Human-readable allowed-path list for the docs:revise prompt (kept in lockstep with isDocPath). */
export const DOC_PATHS_HINT =
  "the repo-root `docs/` directory tree, and the repo-root files README*, CHANGELOG*, " +
  "CONTRIBUTING*, and mkdocs.yml — nothing else (no source, tests, or config)";
