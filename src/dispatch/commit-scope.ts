import { isCanonicalCheckPath, normPath } from "./check-path.ts";
import { ChecksOutputSchema } from "./checks-schema.ts";
import { isDocPath, isPlanPath } from "./docs-paths.ts";
import { ImplementOutputSchema } from "./implement-schema.ts";
import { extractSidecar } from "./sidecar.ts";

/** Given the agent's stdout, a predicate over each pending path: true ⇒ in scope (deliverable).
 *  `isNew` is true only for a brand-new untracked file. */
export type CommitScope = (output: string) => (path: string, isNew: boolean) => boolean;

/** implement: tracked edits always in scope; a new file must be declared in `new_files`. An absent/
 *  malformed sidecar ⇒ no declaration ⇒ any new file is out of scope (→ reject-and-retry, never a
 *  silent drop; the retry-feedback nudges the agent to declare it or delete it). */
export const implementScope: CommitScope = (output) => {
  const parsed = extractSidecar(output, ImplementOutputSchema);
  const declared = new Set(parsed.ok ? parsed.value.new_files.map(normPath) : []);
  return (path, isNew) => !isNew || declared.has(normPath(path));
};

/** checks: tracked edits in scope; a NEW file must be an authored test_file, a declared helper, OR a
 *  canonically-named RED-first test (`{ident}_ac{acId}_test.*`) for an in-scope AC — the last clause
 *  admits the file the agent actually wrote even when it declared a different path (ENG-296). Scratch
 *  files stay out of scope (reject-and-retry). On an UNPARSEABLE sidecar the scope DEFERS (allows
 *  everything) so the two call sites keep their existing post-commit failure semantics. */
export function checksScopeFor(ident: string, acIds: number[]): CommitScope {
  return (output) => {
    const parsed = extractSidecar(output, ChecksOutputSchema);
    if (!parsed.ok) return () => true;
    const declared = new Set<string>([
      ...parsed.value.checksAuthored.map((c) => normPath(c.test_file)),
      ...parsed.value.new_files.map(normPath),
    ]);
    return (path, isNew) =>
      !isNew || declared.has(normPath(path)) || isCanonicalCheckPath(normPath(path), ident, acIds);
  };
}

/** design:dispatch: everything (edit or new) must be under docs/plans/. */
export const planScope: CommitScope = () => (path) => isPlanPath(path);

/** docs:revise: everything must be under docs/. */
export const docScope: CommitScope = () => (path) => isDocPath(path);
