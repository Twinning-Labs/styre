/** Disposition of a unit's deterministic, file-granular completeness check. */
export type CompletenessDisposition =
  | "under-delivered" // a declared file was touched by no one → the unit's work is missing
  | "covered-by-sibling" // this unit changed nothing, but siblings already touched its declared files
  | "completed-by-self"; // this unit made changes and all its declared files are covered

export interface ScopeReconciliation {
  under: string[]; // declared − cumulativeTouched
  over: string[]; // ownTouched − declared
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
  const cum = new Set(cumulativeTouched);
  const decl = new Set(declared);
  return {
    under: declared.filter((f) => !cum.has(f)),
    over: ownTouched.filter((f) => !decl.has(f)),
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
