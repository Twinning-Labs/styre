/** Disposition of a unit's deterministic, file-granular completeness check. */
export type CompletenessDisposition =
  | "under-delivered" // a declared file was touched by no one → the unit's work is missing
  | "covered-by-sibling" // this unit changed nothing, but siblings already touched its declared files
  | "completed-by-self"; // this unit made changes and all its declared files are covered

export interface ScopeReconciliation {
  under: string[]; // declared − cumulativeTouched
  over: string[]; // ownTouched − declared
}

/** Does a declared `files_to_touch` entry match an actual produced path?
 *  A declared entry may contain `<token>` placeholders (angle brackets, any inner text) for an
 *  artifact whose exact name is not known at design time — e.g. a changelog fragment named by an
 *  unborn PR number: `docs/changes/modeling/<id>.bugfix.rst`. Each `<token>` matches within a single
 *  path segment (`[^/]*` — any run of non-slash chars, never across `/`); every other character
 *  matches literally. A declared entry with no valid
 *  `<...>` token is matched by exact string equality (the pre-existing behavior). */
export function declaredMatches(declared: string, actual: string): boolean {
  if (!/<[^>]*>/.test(declared)) return declared === actual;
  const literals = declared.split(/<[^>]*>/g);
  const escaped = literals.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = `^${escaped.join("[^/]*")}$`;
  return new RegExp(pattern).test(actual);
}

/** Deterministic scope reconciliation. `under` asks "did ANYONE touch the declared file?"
 *  (cumulative, so a redundant unit whose sibling did the work is not flagged — the darkreader
 *  fix); `over` asks "did THIS unit touch a file it didn't declare?" (own diff — a cumulative
 *  `over` would flag every prior unit's files as this unit's over-reach). */
export function reconcileScope(
  declared: string[],
  cumulativeTouched: string[],
  ownTouched: string[],
): ScopeReconciliation {
  return {
    under: declared.filter((d) => !cumulativeTouched.some((t) => declaredMatches(d, t))),
    over: ownTouched.filter((t) => !declared.some((d) => declaredMatches(d, t))),
  };
}

/** Classify completeness from the reconciliation + whether the unit changed anything itself. */
export function classifyDisposition(
  under: string[],
  ownTouched: string[],
): CompletenessDisposition {
  if (under.length > 0) return "under-delivered";
  if (ownTouched.length === 0) return "covered-by-sibling";
  return "completed-by-self";
}
