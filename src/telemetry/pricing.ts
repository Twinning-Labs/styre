import { z } from "zod";

/** USD per 1,000,000 tokens (matches published price sheets; deriveCost divides by 1e6). */
const ModelRateSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
});
export type ModelRate = z.infer<typeof ModelRateSchema>;

/** Per-provider long-context tier: above `threshold` input tokens, scale rates for the whole
 *  request. Codex/OpenAI publishes 2× input / 1.5× output above 272K; cache-read/write are defined
 *  as multiples of the uncached input rate, so they ride the input multiplier (brainstorm §9). */
const TierRuleSchema = z.object({
  threshold: z.number(),
  inputMultiplier: z.number(),
  outputMultiplier: z.number(),
});

// Brainstorm §3 — published list prices, USD per 1M tokens.
const BUILTIN_RATES: Record<string, ModelRate> = {
  "gpt-5.6-sol": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 30.0 },
  "gpt-5.6-terra": { input: 2.5, cacheRead: 0.25, cacheWrite: 3.13, output: 15.0 },
  "gpt-5.6-luna": { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 6.0 },
  "claude-opus-4-8": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 },
};

const BUILTIN_TIERS: Record<string, z.infer<typeof TierRuleSchema>> = {
  codex: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
};

/** Operator-configurable pricing. Only the numbers are tunable — the token-accounting convention
 *  (codex partition-subtract vs claude disjoint) is a verified structural fact and stays in code. */
export const PricingConfigSchema = z.object({
  version: z.string().default("builtin@2026-07-22"),
  // zod 4's .default() does NOT parse its argument — .default({}) would yield an empty pricing
  // config (no rates/tiers => every estimate null, silently). Keep the thunk.
  rates: z.record(z.string(), ModelRateSchema).default(() => ({ ...BUILTIN_RATES })),
  // Same trap applies here — do NOT simplify to `.default(BUILTIN_TIERS)` or `.default({})`.
  tiers: z.record(z.string(), TierRuleSchema).default(() => ({ ...BUILTIN_TIERS })),
});
export type PricingConfig = z.infer<typeof PricingConfigSchema>;
export const DEFAULT_PRICING_CONFIG: PricingConfig = PricingConfigSchema.parse({});

export interface DispatchUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  cacheRead: number | null;
  cacheCreate: number | null;
}

type Convention = "codex-partition" | "claude-disjoint";
// ASSUMPTION: any provider other than "codex" is treated as claude-disjoint. This is a silent
// default, not a verified fact about that provider — if an operator ever adds a third provider's
// model to `pricing.rates`, its cost will be computed with the claude-disjoint token-accounting
// convention with no observable signal that the convention might be wrong for it.
function conventionFor(provider: string): Convention {
  return provider === "codex" ? "codex-partition" : "claude-disjoint";
}

/** List-price-equivalent USD for one dispatch. `null` when the model is unpriced or a token the
 *  convention needs is absent (never treat a needed-but-null token as 0). Pure except for a stderr
 *  diagnostic when the codex partition remainder goes negative — the one observable signal that the
 *  (single-sample) convention is wrong; surface it rather than emit a plausible-but-wrong number.
 *  NOTE: buildSummary re-derives every dispatch, so a bad row warns twice per run (flush + summary). */
export function deriveCost(
  usage: DispatchUsage,
  model: string | null,
  provider: string,
  cfg: PricingConfig = DEFAULT_PRICING_CONFIG,
): number | null {
  if (model === null) return null;
  const rate = cfg.rates[model];
  if (!rate) return null;
  const { tokensIn, tokensOut, cacheRead, cacheCreate } = usage;
  if (tokensIn === null || tokensOut === null) return null;

  const tier = cfg.tiers[provider];
  const over = tier !== undefined && tokensIn > tier.threshold;
  const im = over ? tier.inputMultiplier : 1;
  const om = over ? tier.outputMultiplier : 1;
  const inRate = (rate.input * im) / 1e6;
  const crRate = (rate.cacheRead * im) / 1e6;
  const cwRate = (rate.cacheWrite * im) / 1e6;
  const outRate = (rate.output * om) / 1e6;

  if (conventionFor(provider) === "codex-partition") {
    // input_tokens is the TOTAL: cached + cache_write + fresh (verified ground truth §2.3).
    if (cacheRead === null || cacheCreate === null) return null;
    let fresh = tokensIn - cacheRead - cacheCreate;
    if (fresh < 0) {
      process.stderr.write(
        `telemetry: codex partition remainder negative (model=${model}, in=${tokensIn}, ` +
          `cached=${cacheRead}, write=${cacheCreate}); flooring to 0 — pricing convention may be wrong\n`,
      );
      fresh = 0;
    }
    return fresh * inRate + cacheRead * crRate + cacheCreate * cwRate + tokensOut * outRate;
  }
  // claude-disjoint: input / cache_read / cache_creation are already non-overlapping buckets.
  // Symmetric with the codex branch above: a needed-but-null cache field → null, never treated as 0.
  if (cacheRead === null || cacheCreate === null) return null;
  return tokensIn * inRate + cacheRead * crRate + cacheCreate * cwRate + tokensOut * outRate;
}
