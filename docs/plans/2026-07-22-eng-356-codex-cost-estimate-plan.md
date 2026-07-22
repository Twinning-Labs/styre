# ENG-356 Codex Cost Estimate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a nullable, list-price-equivalent `cost_usd_estimated` on the telemetry stream — derived from token counts × a configurable per-model price table — for providers that report no USD (codex) and also for claude (as a calibration cross-check), without touching the provider-reported `cost_usd`.

**Architecture:** A pure `deriveCost(usage, model, provider, cfg)` in a new `src/telemetry/pricing.ts` prices a dispatch using a provider-keyed token-accounting *convention* (codex: `input_tokens` is a partition of cached + cache-write + fresh, so subtract; claude: buckets are already disjoint). Rates + long-context tier multipliers are operator-configurable via a new top-level `pricing` config block (the built-in §3 table is the zod default); the convention stays in code. The estimate is computed at **emit time** in `emitter.ts` from already-stored dispatch fields — nothing is written to the SoT. A companion parser fix makes codex's `cache_write_input_tokens` (previously discarded) available to price.

**Tech Stack:** TypeScript on Bun, embedded SQLite, zod for schema/config. Tests: `bun test`. Lint: `bun run lint`. Build: `bun run build`.

## Global Constraints

- **Never commit to `main`.** All work is on `feat/eng-356-codex-cost-estimate` (already checked out).
- **Additive-nullable wire change only — do NOT bump `SCHEMA_VERSION`** (stays `2`). New fields are `z.number().nullable()` (dispatch/summary top-level) or `z.number()` (a new fixed key inside the already-fixed `usage_coverage` object).
- **Only the runner writes the SoT.** The estimate is a presentation-time derivation in `emitter.ts`; add **no** new dispatch column and no `schema.sql` change.
- **Estimate semantics = "list-price-equivalent cost," not "money spent."** Rates are USD per **1,000,000 tokens** (matching published price sheets); `deriveCost` divides by `1e6`.
- **Unknown model → `null`.** Never a guessed number. Missing a token the convention needs → `null` (never treat a needed-but-null token as `0`).
- **Keys match the exact runtime model id** (e.g. `claude-haiku-4-5-20251001`, not the bare alias).
- **Docs kept current in the same PR** (`docs/architecture/telemetry-export.md`, `docs/architecture/configuration.md`).
- Design source of truth: `docs/brainstorms/2026-07-22-eng-356-codex-cost-estimate-design.md`.

---

### Task 1: Parser fix — codex reports cache-writes

`parseCodexUsage` hardcodes `cacheCreate: null` and never reads `cache_write_input_tokens`, which codex 0.145.0 *does* emit (ground truth: ~30% of input tokens / 78% of a run's cost). Capture it. This is a self-contained honesty fix (a knowable-but-unread field, emitted as `null`=unknown) and a hard dependency for pricing.

**Files:**
- Modify: `src/agent/providers/codex.ts:65-101` (`parseCodexUsage`)
- Test: `test/agent/providers/codex.test.ts`

**Interfaces:**
- Produces: `parseCodexUsage(stdout: string)` return type widens `cacheCreate: null` → `cacheCreate: number | null`; on a `turn.completed`, `cacheCreate` is `usage.cache_write_input_tokens` (number) or `null` if absent.

- [ ] **Step 1: Write the failing tests**

Add to `test/agent/providers/codex.test.ts` (import `parseCodexUsage` is already present):

```ts
test("parseCodexUsage reads cache_write_input_tokens into cacheCreate", () => {
  const line =
    '{"type":"turn.completed","usage":{"input_tokens":51599,"cached_input_tokens":36339,"cache_write_input_tokens":15248,"output_tokens":267}}';
  const u = parseCodexUsage(line);
  expect(u.cacheCreate).toBe(15248);
  expect(u.cacheRead).toBe(36339);
  expect(u.tokensIn).toBe(51599);
});

test("parseCodexUsage: absent cache_write_input_tokens → cacheCreate null", () => {
  const line =
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3,"cached_input_tokens":7}}';
  expect(parseCodexUsage(line).cacheCreate).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/agent/providers/codex.test.ts`
Expected: FAIL — first test gets `cacheCreate: null` (expected `15248`).

- [ ] **Step 3: Implement the parser change**

In `src/agent/providers/codex.ts`, widen the return type annotation of `parseCodexUsage` — change the `cacheCreate: null;` line in the return-type object to:

```ts
  cacheCreate: number | null;
```

Then in the `if (obj.type === "turn.completed")` branch, change the returned `cacheCreate: null,` to:

```ts
        cacheCreate: num(usage.cache_write_input_tokens),
```

Leave the top-of-function `empty` constant's `cacheCreate: null` unchanged (a stream with no `turn.completed` still yields `null`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/agent/providers/codex.test.ts`
Expected: PASS (both new tests + existing).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run lint`
Expected: clean (the return-type widening is assignable to `AgentRunResult.cacheCreate`, already `number | null`).

- [ ] **Step 6: Commit**

```bash
git add src/agent/providers/codex.ts test/agent/providers/codex.test.ts
git commit -m "fix(codex): capture cache_write_input_tokens into cacheCreate (ENG-356)"
```

---

### Task 2: Pricing module — table, config schema, `deriveCost`

The pure core: a configurable price table (built-in §3 defaults) and the provider-keyed derivation.

**Files:**
- Create: `src/telemetry/pricing.ts`
- Test: `test/telemetry/pricing.test.ts`

**Interfaces:**
- Produces:
  - `PricingConfigSchema` (zod) with fully-defaulted `version` / `rates` / `tiers`.
  - `type PricingConfig = z.infer<typeof PricingConfigSchema>`.
  - `DEFAULT_PRICING_CONFIG: PricingConfig` (= `PricingConfigSchema.parse({})`).
  - `interface DispatchUsage { tokensIn: number|null; tokensOut: number|null; cacheRead: number|null; cacheCreate: number|null }`.
  - `deriveCost(usage: DispatchUsage, model: string|null, provider: string, cfg?: PricingConfig): number | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/telemetry/pricing.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  DEFAULT_PRICING_CONFIG,
  deriveCost,
  PricingConfigSchema,
} from "../../src/telemetry/pricing.ts";

const u = (
  tokensIn: number | null,
  tokensOut: number | null,
  cacheRead: number | null,
  cacheCreate: number | null,
) => ({ tokensIn, tokensOut, cacheRead, cacheCreate });

test("codex sol sample prices to the ground-truth ~$0.1215", () => {
  const cost = deriveCost(u(51599, 267, 36339, 15248), "gpt-5.6-sol", "codex");
  expect(cost).toBeCloseTo(0.1215395, 6);
});

test("unknown model → null", () => {
  expect(deriveCost(u(100, 40, 0, 0), "gpt-9.9-nope", "codex")).toBeNull();
  expect(deriveCost(u(100, 40, 0, 0), null, "codex")).toBeNull();
});

test("codex: a null needed-token → null (never treated as 0)", () => {
  expect(deriveCost(u(null, 40, 0, 0), "gpt-5.6-sol", "codex")).toBeNull();
  expect(deriveCost(u(100, 40, null, 0), "gpt-5.6-sol", "codex")).toBeNull();
  expect(deriveCost(u(100, 40, 0, null), "gpt-5.6-sol", "codex")).toBeNull();
});

test("codex partition: fresh = input - cached - write, priced per-bucket", () => {
  // in=1000 (cached=600, write=300, fresh=100); luna: in 1.0, cr 0.1, cw 1.25, out 6.0 per 1M
  const cost = deriveCost(u(1000, 50, 600, 300), "gpt-5.6-luna", "codex");
  const expected =
    (100 * 1.0 + 600 * 0.1 + 300 * 1.25 + 50 * 6.0) / 1e6;
  expect(cost).toBeCloseTo(expected, 10);
});

test("codex fresh<0 floors to 0 and emits a stderr diagnostic", () => {
  const orig = process.stderr.write.bind(process.stderr);
  let warned = "";
  // @ts-expect-error test shim
  process.stderr.write = (s: string) => ((warned += s), true);
  try {
    // cached+write (900) > input (800) → fresh would be -100
    const cost = deriveCost(u(800, 10, 500, 400), "gpt-5.6-luna", "codex");
    const expected = (0 * 1.0 + 500 * 0.1 + 400 * 1.25 + 10 * 6.0) / 1e6;
    expect(cost).toBeCloseTo(expected, 10);
    expect(warned).toContain("partition remainder negative");
  } finally {
    process.stderr.write = orig;
  }
});

test("claude disjoint: no subtraction (buckets already separate)", () => {
  // opus: in 5.0, cr 0.5, cw 6.25, out 25.0 per 1M
  const cost = deriveCost(u(1000, 200, 400, 100), "claude-opus-4-8", "claude");
  const expected =
    (1000 * 5.0 + 400 * 0.5 + 100 * 6.25 + 200 * 25.0) / 1e6;
  expect(cost).toBeCloseTo(expected, 10);
});

test("codex 272K tier: input-side ×2, output ×1.5", () => {
  const under = deriveCost(u(272000, 100, 0, 0), "gpt-5.6-terra", "codex");
  const over = deriveCost(u(272001, 100, 0, 0), "gpt-5.6-terra", "codex");
  // terra: in 2.5, out 15.0 per 1M. fresh = full input (no cache).
  expect(under).toBeCloseTo((272000 * 2.5 + 100 * 15.0) / 1e6, 10);
  expect(over).toBeCloseTo((272001 * 2.5 * 2 + 100 * 15.0 * 1.5) / 1e6, 10);
});

test("DEFAULT_PRICING_CONFIG has all six §3 models + the codex tier", () => {
  const r = DEFAULT_PRICING_CONFIG.rates;
  for (const m of [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ]) {
    expect(r[m]).toBeDefined();
  }
  expect(DEFAULT_PRICING_CONFIG.tiers.codex.threshold).toBe(272000);
  // sanity: parse-empty round-trips through the schema
  expect(PricingConfigSchema.parse({}).version).toBe("builtin@2026-07-22");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/telemetry/pricing.test.ts`
Expected: FAIL — module `../../src/telemetry/pricing.ts` does not exist.

- [ ] **Step 3: Implement the pricing module**

Create `src/telemetry/pricing.ts`:

```ts
import { z } from "zod";

/** USD per 1,000,000 tokens (matches published price sheets; deriveCost divides by 1e6). */
const ModelRateSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
});
export type ModelRate = z.infer<typeof ModelRateSchema>;

/** Per-provider long-context tier: above `threshold` input tokens, scale the rates for the whole
 *  request. Codex/OpenAI publishes 2× input / 1.5× output above 272K; cache-read/write are defined
 *  as multiples of the uncached input rate, so they ride the input multiplier (see brainstorm §9). */
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
  rates: z.record(z.string(), ModelRateSchema).default(() => ({ ...BUILTIN_RATES })),
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
function conventionFor(provider: string): Convention {
  return provider === "codex" ? "codex-partition" : "claude-disjoint";
}

/** List-price-equivalent USD for one dispatch. `null` when the model is unpriced or a token the
 *  convention needs is absent (never treat a needed-but-null token as 0). Pure except for a stderr
 *  diagnostic when the codex partition remainder goes negative — the one observable signal that the
 *  (single-sample) convention is wrong; surface it rather than emit a plausible-but-wrong number. */
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
  const cr = cacheRead ?? 0;
  const cc = cacheCreate ?? 0;
  return tokensIn * inRate + cr * crRate + cc * cwRate + tokensOut * outRate;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/telemetry/pricing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry/pricing.ts test/telemetry/pricing.test.ts
git commit -m "feat(telemetry): pricing table + deriveCost (provider-keyed, 272K tier) (ENG-356)"
```

---

### Task 3: Wire the `pricing` config block into runtime config

Expose the pricing config so operators can retune rates/multipliers without a binary release. **Must** be a new top-level key — `telemetry` is already `z.boolean()` (the PostHog flag), so nesting under it is a hard zod failure.

**Files:**
- Modify: `src/config/runtime-config.ts`
- Test: `test/config/pricing-config.test.ts` (create)

**Interfaces:**
- Consumes: `PricingConfigSchema` from Task 2.
- Produces: `RuntimeConfig` gains `pricing: PricingConfig` (always populated via zod default); `DEFAULT_RUNTIME_CONFIG.pricing === DEFAULT_PRICING_CONFIG` shape.

- [ ] **Step 1: Write the failing tests**

Create `test/config/pricing-config.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../../src/config/runtime-config.ts";

test("default runtime config carries the built-in pricing table", () => {
  expect(DEFAULT_RUNTIME_CONFIG.pricing.rates["gpt-5.6-sol"]).toBeDefined();
  expect(DEFAULT_RUNTIME_CONFIG.pricing.version).toBe("builtin@2026-07-22");
});

test("a pricing.rates override REPLACES the whole rates map (shallow, wholesale) — N1", () => {
  const cfg = RuntimeConfigSchema.parse({
    pricing: { rates: { "gpt-5.6-sol": { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 } } },
  });
  expect(cfg.pricing.rates["gpt-5.6-sol"].input).toBe(1);
  // Models omitted from the override are GONE (→ null estimate). This pins the documented behavior.
  expect(cfg.pricing.rates["claude-opus-4-8"]).toBeUndefined();
  // tiers, unspecified, still default:
  expect(cfg.pricing.tiers.codex.threshold).toBe(272000);
});

test("nesting pricing under telemetry is rejected (telemetry is a boolean)", () => {
  expect(() => RuntimeConfigSchema.parse({ telemetry: { pricing: {} } })).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/config/pricing-config.test.ts`
Expected: FAIL — `pricing` is not on `RuntimeConfig` yet (`.pricing.rates` is `undefined`).

- [ ] **Step 3: Add the config block**

In `src/config/runtime-config.ts`, add the import at the top (after the existing `AgentConfigSchema` import):

```ts
import { PricingConfigSchema } from "../telemetry/pricing.ts";
```

Then inside `RuntimeConfigSchema` (e.g. immediately after the `telemetry: z.boolean().default(true),` line), add:

```ts
  // ENG-356: list-price-equivalent cost-estimate pricing. Top-level (NOT under `telemetry`, which is
  // the PostHog on/off boolean). Numbers/multipliers are operator-tunable; the §3 table is the
  // default. The token-accounting convention lives in code (telemetry/pricing.ts), not here.
  pricing: PricingConfigSchema.default(() => PricingConfigSchema.parse({})),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/config/pricing-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + lint (no import cycle)**

Run: `bun test && bun run lint`
Expected: PASS. (`config/runtime-config` → `telemetry/pricing` is acyclic: `pricing.ts` imports only `zod`.)

- [ ] **Step 6: Commit**

```bash
git add src/config/runtime-config.ts test/config/pricing-config.test.ts
git commit -m "feat(config): add top-level pricing block for cost estimates (ENG-356)"
```

---

### Task 4: Align `CODEX_PRESET` with the priced models (D9)

The shipped preset is `gpt-5.4-*`, which shares no id with the `gpt-5.6-*` table — so the *default* codex config would emit `null` for every dispatch and AC#1 would not pass. The `gpt-5.4-*` ids are stale (the test API key couldn't even access `gpt-5.4-codex`). Point the preset at the real, priced models.

**Files:**
- Modify: `src/config/agent-config.ts:34` (`CODEX_PRESET`)
- Test: `test/config/preset-priced.test.ts` (create)

**Interfaces:**
- Consumes: `DEFAULT_PRICING_CONFIG` (Task 2), `CODEX_PRESET` / `DEFAULT_AGENT_CONFIG` (agent-config).

- [ ] **Step 1: Write the failing test**

Create `test/config/preset-priced.test.ts`:

```ts
import { expect, test } from "bun:test";
import { CODEX_PRESET, DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_PRICING_CONFIG } from "../../src/telemetry/pricing.ts";

test("every default-preset model id is priced in the built-in table", () => {
  const rates = DEFAULT_PRICING_CONFIG.rates;
  for (const preset of [DEFAULT_AGENT_CONFIG, CODEX_PRESET]) {
    for (const tier of ["deep", "standard", "cheap"] as const) {
      const model = preset.models[tier];
      expect(rates[model], `${preset.provider}.${tier} = ${model} must be priced`).toBeDefined();
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config/preset-priced.test.ts`
Expected: FAIL — `codex.deep = gpt-5.4` is not in the table.

- [ ] **Step 3: Update the preset**

In `src/config/agent-config.ts`, change the `CODEX_PRESET.models` line to the priced ids (cost-ordered: sol=deep, terra=standard, luna=cheap):

```ts
  models: { deep: "gpt-5.6-sol", standard: "gpt-5.6-terra", cheap: "gpt-5.6-luna" },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config/preset-priced.test.ts`
Expected: PASS.

- [ ] **Step 5: Guard against a preset regression in the wider suite**

Run: `bun test`
Expected: PASS. (If any existing test asserts the literal `gpt-5.4*` preset ids, update it to the new ids — search: `grep -rn "gpt-5.4" test`.)

- [ ] **Step 6: Commit**

```bash
git add src/config/agent-config.ts test/config/preset-priced.test.ts
git commit -m "feat(config): point CODEX_PRESET at priced gpt-5.6-* models (ENG-356 D9)"
```

---

### Task 5: Wire schema — add `cost_usd_estimated` (additive, no bump)

**Files:**
- Modify: `src/telemetry/events.ts` (`DispatchEvent`, `SummaryEvent`)
- Test: `test/telemetry/events.test.ts`

**Interfaces:**
- Produces: `DispatchEvent` and `SummaryEvent` gain `cost_usd_estimated: number | null`; `SummaryEvent.usage_coverage` gains `cost_usd_estimated: number`. `SCHEMA_VERSION` stays `2`.

- [ ] **Step 1: Write the failing tests**

Add to `test/telemetry/events.test.ts` (it already imports `SCHEMA_VERSION` / `TelemetryEventSchema`; if not, add `import { SCHEMA_VERSION, TelemetryEventSchema } from "../../src/telemetry/events.ts";`):

```ts
test("dispatch event carries nullable cost_usd_estimated (additive, schema still 2)", () => {
  expect(SCHEMA_VERSION).toBe(2);
  const base = {
    schema_version: 2 as const,
    type: "dispatch" as const,
    run_id: "r",
    dispatch_id: "D1",
    ticket_id: 1,
    work_unit_id: null,
    seq: 1,
    stage: null,
    kind: null,
    model: "gpt-5.6-sol",
    provider: "codex",
    trigger: null,
    effort: null,
    exit_code: 0,
    predecessor_dispatch_id: null,
    outcome: null,
    branch_head_sha: null,
    started_at: null,
    ended_at: "t",
    duration_ms: null,
    tokens_in: 100,
    tokens_out: 40,
    cache_read: 60,
    cache_create: 15,
    cost_usd: null,
    cost_usd_estimated: 0.12,
  };
  // zod STRIPS unknown keys, so this asserts the field SURVIVES parsing (present on output),
  // which genuinely fails before the schema has it (stripped → undefined) and passes after.
  const parsed = TelemetryEventSchema.parse(base) as Record<string, unknown>;
  expect(parsed.cost_usd_estimated).toBe(0.12);
  const parsedNull = TelemetryEventSchema.parse({
    ...base,
    cost_usd_estimated: null,
  }) as Record<string, unknown>;
  expect(parsedNull.cost_usd_estimated).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/telemetry/events.test.ts`
Expected: FAIL — before the field is added, zod strips the unknown `cost_usd_estimated` key, so `parsed.cost_usd_estimated` is `undefined` (assertion expects `0.12`).

- [ ] **Step 3: Add the fields**

In `src/telemetry/events.ts`:

In `DispatchEvent`, immediately after `cost_usd: z.number().nullable(),` add:

```ts
  cost_usd_estimated: z.number().nullable(),
```

In `SummaryEvent`, immediately after `cost_usd: z.number().nullable(),` add:

```ts
  cost_usd_estimated: z.number().nullable(),
```

In `SummaryEvent.usage_coverage`'s object, immediately after `cost_usd: z.number(),` add:

```ts
    cost_usd_estimated: z.number(),
```

Do **not** change `SCHEMA_VERSION`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/telemetry/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/events.ts test/telemetry/events.test.ts
git commit -m "feat(telemetry): add nullable cost_usd_estimated to dispatch+summary (ENG-356)"
```

---

### Task 6: Emitter — compute the estimate at emit time

Thread the `PricingConfig` into the emitter and populate `cost_usd_estimated` on dispatch + summary (floor-sum + coverage), for both providers. Reported `cost_usd` is untouched.

**Files:**
- Modify: `src/telemetry/emitter.ts` (`toDispatch`, `buildSummary`, `createTelemetryEmitter`, `emitSummary` closure)
- Modify: `src/daemon/run-ticket.ts:82` (pass `opts.config.pricing`)
- Modify: `src/cli/run.ts:244` (pass `runtimeConfig.pricing`)
- Test: `test/telemetry/emitter.test.ts`

**Interfaces:**
- Consumes: `deriveCost`, `DEFAULT_PRICING_CONFIG`, `PricingConfig` (Task 2); the new event fields (Task 5).
- Produces: `createTelemetryEmitter(sink, pricing?)` and `buildSummary(db, ticketId, result, pricing?)` gain an optional `PricingConfig` (default `DEFAULT_PRICING_CONFIG`) — existing callers/tests keep working.

- [ ] **Step 1: Write the failing tests**

Add to `test/telemetry/emitter.test.ts` (add these imports at the top):

```ts
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { nowUtc } from "../../src/util/time.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Then the tests:

```ts
/** A codex-provider run DB (makeTestDb hardcodes provider="claude"). */
function makeCodexDb() {
  const path = join(mkdtempSync(join(tmpdir(), "styre-cx-")), "styre.db");
  migrate(path);
  const db = openDb(path);
  const projectId = insertProject(db, { slug: "p", targetRepo: "/tmp/repo" });
  const ticketId = insertTicket(db, { projectId, ident: "ENG-9" });
  insertRun(db, { runId: "run-codex-1", startedAt: nowUtc(), provider: "codex" });
  return { db, ticketId };
}

test("claude run: reported cost_usd untouched AND cost_usd_estimated computed", () => {
  const { db, ticketId } = makeTestDb(); // provider = claude
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "C1",
    seq: nextSeq(db, ticketId),
    model: "claude-opus-4-8",
  });
  completeDispatch(db, d.id, {
    costUsd: 0.25,
    tokensIn: 1000,
    tokensOut: 200,
    cacheRead: 400,
    cacheCreate: 100,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "C1");
  expect(ev?.type).toBe("dispatch");
  if (ev?.type === "dispatch") {
    expect(ev.cost_usd).toBeCloseTo(0.25); // reported, untouched
    const expected = (1000 * 5.0 + 400 * 0.5 + 100 * 6.25 + 200 * 25.0) / 1e6;
    expect(ev.cost_usd_estimated).toBeCloseTo(expected, 8);
  }
  db.close();
});

test("codex run: cost_usd null, cost_usd_estimated non-null; summary floor-sum + coverage", () => {
  const { db, ticketId } = makeCodexDb();
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "X1",
    seq: nextSeq(db, ticketId),
    model: "gpt-5.6-sol",
  });
  completeDispatch(db, d.id, {
    // no costUsd → cost_usd stays null (codex reports none)
    tokensIn: 51599,
    tokensOut: 267,
    cacheRead: 36339,
    cacheCreate: 15248,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "X1");
  if (ev?.type === "dispatch") {
    expect(ev.cost_usd).toBeNull();
    expect(ev.cost_usd_estimated).toBeCloseTo(0.1215395, 6);
  }
  emitter.emitSummary(db, ticketId, {
    outcome: "pr-ready",
    iterations: 1,
    stage: "merge",
    status: "done",
  });
  const s = sink.find((e) => e.type === "summary");
  if (s?.type === "summary") {
    expect(s.cost_usd).toBeNull(); // no dispatch reported USD
    expect(s.cost_usd_estimated).toBeCloseTo(0.1215395, 6);
    expect(s.usage_coverage.cost_usd_estimated).toBe(1);
  }
  db.close();
});

test("codex unknown model: cost_usd_estimated null", () => {
  const { db, ticketId } = makeCodexDb();
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "U1",
    seq: nextSeq(db, ticketId),
    model: "gpt-9.9-unknown",
  });
  completeDispatch(db, d.id, {
    tokensIn: 100,
    tokensOut: 40,
    cacheRead: 0,
    cacheCreate: 0,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "U1");
  if (ev?.type === "dispatch") expect(ev.cost_usd_estimated).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: FAIL — `cost_usd_estimated` is not emitted yet (`undefined`).

- [ ] **Step 3: Implement the emitter wiring**

In `src/telemetry/emitter.ts`:

Add the import (after the `events.ts` import):

```ts
import { deriveCost, DEFAULT_PRICING_CONFIG, type PricingConfig } from "./pricing.ts";
```

Change `toDispatch`'s signature and body to take + use `pricing`, and add the field (after `cost_usd: r.cost_usd,`):

```ts
function toDispatch(r: DispatchRow, ctx: RunCtx, pricing: PricingConfig): TelemetryEvent {
  return {
    // ...unchanged fields...
    cost_usd: r.cost_usd,
    cost_usd_estimated: deriveCost(
      {
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        cacheRead: r.cache_read,
        cacheCreate: r.cache_create,
      },
      r.model,
      ctx.provider,
      pricing,
    ),
  };
}
```

Change `buildSummary`'s signature to take `pricing` (default), compute the estimate aggregate, and add the two fields:

```ts
export function buildSummary(
  db: Database,
  ticketId: number,
  result: RunResult,
  pricing: PricingConfig = DEFAULT_PRICING_CONFIG,
): TelemetryEvent {
  const ctx = runCtx(db);
  // ...existing lines through `const cc = aggregate(...)` unchanged...
  const estCost = aggregate(
    dispatches.map((d) =>
      deriveCost(
        {
          tokensIn: d.tokens_in,
          tokensOut: d.tokens_out,
          cacheRead: d.cache_read,
          cacheCreate: d.cache_create,
        },
        d.model,
        ctx.provider,
        pricing,
      ),
    ),
  );
  // ...in the returned object, after `cost_usd: cost.value,` add:
  //   cost_usd_estimated: estCost.value,
  // ...and inside usage_coverage, after `cost_usd: cost.reported,` add:
  //   cost_usd_estimated: estCost.reported,
}
```

Concretely, in the returned summary object add `cost_usd_estimated: estCost.value,` next to `cost_usd: cost.value,`, and add `cost_usd_estimated: estCost.reported,` inside `usage_coverage` next to `cost_usd: cost.reported,`.

Change `createTelemetryEmitter` to accept + thread `pricing`:

```ts
export function createTelemetryEmitter(
  sink: TelemetrySink,
  pricing: PricingConfig = DEFAULT_PRICING_CONFIG,
): { /* ...unchanged return type... */ } {
```

Inside `flushNew`, change the dispatch emit line to pass `pricing`:

```ts
        if (d.ended_at !== null) sink(toDispatch(d, c, pricing));
```

Inside `emitSummary`, thread `pricing`:

```ts
    emitSummary(db, ticketId, result) {
      sink(buildSummary(db, ticketId, result, pricing));
    },
```

- [ ] **Step 4: Update the two production callers**

In `src/daemon/run-ticket.ts` (line 82) change:

```ts
  const emitter = createTelemetryEmitter(opts.emit ?? noopSink, opts.config.pricing);
```

In `src/cli/run.ts` (line ~244) change the `buildSummary` call to pass the resolved pricing:

```ts
      buildSummary(db, out.ticketId, out, runtimeConfig.pricing) as Extract<
        TelemetryEvent,
        { type: "summary" }
      >,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: PASS (new + existing — the existing summary test's `cost_usd` / `cache_*` assertions are unaffected).

- [ ] **Step 6: Full suite + lint + build**

Run: `bun test && bun run lint && bun run build`
Expected: PASS. (`opts.config` is `RuntimeConfig`, so `.pricing` is always populated; `runtimeConfig` is in scope at `cli/run.ts:244`.)

- [ ] **Step 7: Commit**

```bash
git add src/telemetry/emitter.ts src/daemon/run-ticket.ts src/cli/run.ts test/telemetry/emitter.test.ts
git commit -m "feat(telemetry): emit cost_usd_estimated (both providers) at emit time (ENG-356)"
```

---

### Task 7: Docs — wire spec + configuration reference

Keep the two maintained references current (repo rule): document the new field + its meaning, correct the now-false codex cache-write claim, and document the new config block.

**Files:**
- Modify: `docs/architecture/telemetry-export.md`
- Modify: `docs/architecture/configuration.md`

**Interfaces:** none (doc-only). No test; verification is the grep checks + `bun run build`.

- [ ] **Step 1: Update `telemetry-export.md` — dispatch field table (§3.2)**

Add a row after the `cost_usd` row:

```md
| `cost_usd_estimated` | number \| null | yes | derived at emit time — see §4 |
```

- [ ] **Step 2: Update `telemetry-export.md` — summary field table (§3.4)**

Add a row after the summary `cost_usd` row:

```md
| `cost_usd_estimated` | number \| null | yes | floor-sum of dispatch `cost_usd_estimated` — see §4 |
```

And add a `usage_coverage` sub-row after `usage_coverage.cost_usd`:

```md
| `usage_coverage.cost_usd_estimated` | number | no | count of dispatches with a non-null derived estimate |
```

- [ ] **Step 3: Update `telemetry-export.md` §4 — the estimate contract + correct the stale codex line**

In §4, **replace** the stale sentence stating codex "never reports `cost_usd` or `cache_create` … no cache-write metric … every `codex` dispatch has `cost_usd: null` and `cache_create: null` by construction" with the corrected fact and add the estimate contract. Use this text:

```md
- **`provider` explains the systematic `cost_usd` gap.** The `codex` adapter never reports a USD
  `cost_usd` (its CLI emits none), so every `codex` dispatch has `cost_usd: null`; a ticket run
  entirely on `codex` shows `usage_coverage.cost_usd === 0`. It **does** report token usage
  including `cache_write_input_tokens` (→ `cache_create`) and `cached_input_tokens` (→ `cache_read`),
  so tokens are present. `claude` reports `cost_usd`.

- **`cost_usd_estimated` — a derived, list-price-equivalent cost.** For any dispatch with a known
  model id and the token counts its provider's accounting convention needs, the exporter derives an
  estimate = tokens × a per-model price table (USD/1M tokens), and floor-sums it on the summary with
  its own `usage_coverage.cost_usd_estimated` count. It is populated for **both** providers (for
  `claude` it sits beside the reported `cost_usd` as a calibration cross-check); an unknown model or
  a missing needed token yields `null` (never a guessed number). **It is a *list-price-equivalent*
  figure, not billed spend:** real USD depends on operator auth (an API key bills list price; a
  subscription has ~$0 marginal cost), so summing `cost_usd_estimated` across providers/auth mixes
  "spent" and "would-have-spent." The price table + long-context multipliers are operator-configurable
  (the `pricing` config block; see `configuration.md`); the built-in table is stamped with a
  `version` so a config-overridden estimate is auditable. Reported `cost_usd` is never overwritten by
  an estimate.
```

- [ ] **Step 4: Update `configuration.md` — document the `pricing` block**

Add a subsection documenting the new top-level `pricing` key: `version` (provenance stamp), `rates` (per-model `{input, cacheRead, cacheWrite, output}` in USD/1M tokens), and `tiers` (per-provider `{threshold, inputMultiplier, outputMultiplier}`). State explicitly: it feeds the `cost_usd_estimated` estimate only (no effect on reported `cost_usd`); it is a **new top-level key**, not under the boolean `telemetry`; and — because config resolution is a **shallow per-top-level-key spread** — an override of `pricing.rates` **replaces the entire rates map**, so any model omitted from the override becomes unpriced (`null` estimate). The token-accounting convention is not configurable (it lives in code).

- [ ] **Step 5: Verify the stale line is gone and build is green**

Run:
```bash
grep -n "no cache-write metric\|cache_create: null.*by construction" docs/architecture/telemetry-export.md || echo "stale line removed OK"
bun run build
```
Expected: "stale line removed OK" and a clean build.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/telemetry-export.md docs/architecture/configuration.md
git commit -m "docs: document cost_usd_estimated + pricing config; correct codex cache-write claim (ENG-356)"
```

---

## Final verification (after all tasks)

- [ ] `bun test` — full suite green.
- [ ] `bun run lint` — clean.
- [ ] `bun run build` — single-binary build succeeds.
- [ ] Manual sanity: `SCHEMA_VERSION` is still `2` (`grep 'SCHEMA_VERSION = ' src/telemetry/events.ts`).
- [ ] Push the branch and open a **draft** PR into `main` (never merge). Do not auto-merge.

## Spec-coverage map (self-review)

| Brainstorm decision / AC | Task |
|---|---|
| D2 parser reads `cache_write_input_tokens` | Task 1 |
| D3 provider-keyed convention (codex partition / claude disjoint) | Task 2 (`deriveCost`) |
| D6 272K tier (input ×2 / output ×1.5), observable `fresh<0` floor (N3) | Task 2 |
| D7 in-binary default table, exact-model-id keys, unknown→null, `version` stamp | Task 2 |
| D1 list-price-equivalent semantics | Task 2 + Task 7 (doc) |
| D8 configurable rates/multipliers, convention in code; N1 wholesale-replace | Task 3 |
| D9 `CODEX_PRESET` → `gpt-5.6-*` (default config is priced; AC#1 out-of-box) | Task 4 |
| D4 additive-nullable `cost_usd_estimated` (dispatch+summary+coverage), no bump | Task 5 |
| D4/D5 always-compute both providers, emit-time, reported `cost_usd` untouched | Task 6 |
| Wire-spec + config-doc update; correct stale codex claim | Task 7 |
