/** Model tiers (F1 / build-operations §4): design/review = Opus, implement = Sonnet,
 *  cheap formalize/docs/pr-ensure = Haiku. */
export const MODELS = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
} as const;

const TIERS: Record<string, string> = {
  "design:dispatch": MODELS.opus,
  "design:review": MODELS.opus,
  review: MODELS.opus,
  "implement:dispatch": MODELS.sonnet,
  "design:extract": MODELS.haiku,
  "docs:revise": MODELS.haiku,
  "merge:pr-ensure": MODELS.haiku,
};

/** Resolve the model id for an agent handlerKey. Implement escalates to Opus on a loopback
 *  retry (control-loop §8 P4). Non-agent steps (verify/merge:push/released) never dispatch. */
export function resolveModel(handlerKey: string, opts?: { loopback?: boolean }): string {
  if (handlerKey === "implement:dispatch" && opts?.loopback) {
    return MODELS.opus;
  }
  const model = TIERS[handlerKey];
  if (model === undefined) {
    throw new Error(`resolveModel: no model tier for handlerKey '${handlerKey}'`);
  }
  return model;
}
