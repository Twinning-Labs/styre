import type { CoarseResult } from "./check-selector.ts";

/** The deterministic prior's verdict (§3). It NEVER outputs `assertion` — an assertion-failed check
 *  is by definition ambiguous (may be a proxy-absence) and always reaches the adjudicator. */
export type PriorVerdict =
  | { kind: "settled-red"; redClass: "absence" | "environmental" }
  | { kind: "adjudicate-red" }
  | { kind: "adjudicate-green" };

// A clean own-symbol import/name error = the code-under-test lacks a symbol the test names = absence
// of the target behavior. A bare `No module named` is deliberately EXCLUDED — a whole missing module
// is ambiguous (third-party env gap vs absent new module), so it goes to the adjudicator.
// Intentionally Python-only signatures. The prior only self-resolves the unambiguous cases; a
// Go/JS own-symbol error simply doesn't match and degrades to the adjudicator (§9 — a prior miss
// never mislabels, it just defers). A bare `ModuleNotFoundError: No module named 'Z'` is NOT here
// (whole-module-missing is absence-vs-environmental ambiguous → adjudicator decides).
const OWN_SYMBOL_ABSENCE = /cannot import name |NameError: name /i;

/** Settle only the unambiguous cases (§3); everything else is the adjudicator's judgment. A miss on
 *  the own-symbol shortcut degrades to `adjudicate-red`, never a silent mislabel (the prior is never
 *  an override). */
export function classifyPrior(p: { coarse: CoarseResult; rawOutput: string }): PriorVerdict {
  if (p.coarse === "error") return { kind: "settled-red", redClass: "environmental" };
  if (p.coarse === "green") return { kind: "adjudicate-green" };
  // coarse === "red"
  if (OWN_SYMBOL_ABSENCE.test(p.rawOutput)) return { kind: "settled-red", redClass: "absence" };
  return { kind: "adjudicate-red" };
}
