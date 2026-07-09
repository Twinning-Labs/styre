/** Abstract capability tiers (DEC-AG-2): a step maps to a tier; config maps tier → model id
 *  per provider. deep = design/review, standard = implement, cheap = mechanical steps. */
export type Tier = "deep" | "standard" | "cheap";

const TIERS: Record<string, Tier> = {
  "design:dispatch": "deep",
  "design:review": "deep",
  review: "deep",
  "implement:dispatch": "standard",
  "checks:dispatch": "standard",
  "checks:classify": "standard",
  "checks:arbitrate": "deep",
  "design:extract": "cheap",
  "design:size": "cheap",
  "docs:revise": "cheap",
  "merge:pr-ensure": "cheap",
};

/** Resolve the tier for an agent handlerKey. implement escalates to deep on a loopback retry
 *  (control-loop §8 P4). Non-agent steps never dispatch. */
export function resolveTier(handlerKey: string, opts?: { loopback?: boolean }): Tier {
  if (handlerKey === "implement:dispatch" && opts?.loopback) {
    return "deep";
  }
  const tier = TIERS[handlerKey];
  if (tier === undefined) {
    throw new Error(`resolveTier: no tier for handlerKey '${handlerKey}'`);
  }
  return tier;
}
