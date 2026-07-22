# ENG-356 Codex Cost Estimate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a nullable, list-price-equivalent `cost_usd_estimated` on the telemetry stream — derived from token counts × a configurable per-model price table — for providers that report no USD (codex) and also for claude (as a calibration cross-check), without touching the provider-reported `cost_usd`.

**Architecture:** A pure `deriveCost(usage, model, provider, cfg)` in a new `src/telemetry/pricing.ts` prices a dispatch using a provider-keyed token-accounting *convention* (codex: `input_tokens` is a partition of cached + cache-write + fresh, so subtract; claude: buckets are already disjoint). Rates + long-context tier multipliers are operator-configurable via a new top-level `pricing` config block (the built-in table is the zod default); the convention stays in code. The estimate is computed at **emit time** in `emitter.ts` from already-stored dispatch fields — nothing is written to the SoT. A companion parser fix makes codex's `cache_write_input_tokens` (previously discarded) available to price.

**Tech Stack:** TypeScript on Bun, embedded SQLite, zod 4.4.3.

## Global Constraints

- **Never commit to `main`.** All work is on `feat/eng-356-codex-cost-estimate` (already checked out).
- **Three distinct verification commands — they check different things. Run all three:**
  - `bun test` — the suite.
  - `bun run lint` → `biome check .` — **lint/format only, NOT a typechecker.**
  - `bun run typecheck` → `tsc --noEmit` — **the only type check.** The repo's baseline is currently clean (exit 0); keep it clean.
- **Additive-nullable wire change only — do NOT bump `SCHEMA_VERSION`** (stays `2`).
- **`z.number().nullable()` requires the key to be PRESENT.** Adding a field to an event schema therefore **breaks every existing event literal** in tests until they add the key. Task 5 enumerates all four.
- **Only the runner writes the SoT.** The estimate is a presentation-time derivation in `emitter.ts`; add **no** dispatch column, no `schema.sql` change.
- **Rates are USD per 1,000,000 tokens** (matching published price sheets); `deriveCost` divides by `1e6`.
- **Unknown model → `null`.** Never a guessed number. A token the convention needs but is `null` → `null` (never treated as `0`).
- **Keys match the exact runtime model id** (e.g. `claude-haiku-4-5-20251001`, not the bare alias).
- **Biome bans the comma operator and assignment-in-expression.** For stderr/stdout shims in tests, use the repo's existing block-bodied + cast form (`test/telemetry/events.test.ts:138-142`). Do not add `@ts-expect-error` to those shims — the assignment is bivariantly legal, so the directive is *unused* and `tsc` errors with TS2578.
- **Biome `organizeImports` is on.** Put `node:*` builtins first (see `test/helpers/db.ts:1-10`); `bun run format` auto-fixes.
- Design source of truth: `docs/brainstorms/2026-07-22-eng-356-codex-cost-estimate-design.md`.

---

### Task 1: Parser fix — codex reports cache-writes

`parseCodexUsage` hardcodes `cacheCreate: null` and never reads `cache_write_input_tokens`, which codex 0.145.0 *does* emit (ground truth: ~30% of input tokens / 78% of a run's cost). Capture it. Self-contained honesty fix + hard dependency for pricing.

**Files:**
- Modify: `src/agent/providers/codex.ts` (return type at `:70`; `turn.completed` branch `:89-97`, the `cacheCreate: null,` at `:96`)
- Test: `test/agent/providers/codex.test.ts`

**Interfaces:**
- Produces: `parseCodexUsage(stdout)` return type widens `cacheCreate: null` → `cacheCreate: number | null`; on a `turn.completed`, `cacheCreate` is `usage.cache_write_input_tokens` or `null` if absent.

- [ ] **Step 1: Write the failing tests**

Add to `test/agent/providers/codex.test.ts` (`parseCodexUsage` is already imported):

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

- [ ] **Step 3: Implement**

In `src/agent/providers/codex.ts`, in the return-type annotation of `parseCodexUsage` (line 70) change `cacheCreate: null;` to:

```ts
  cacheCreate: number | null;
```

In the `if (obj.type === "turn.completed")` branch (line 96) change `cacheCreate: null,` to:

```ts
        cacheCreate: num(usage.cache_write_input_tokens),
```

Leave the `empty` constant's `cacheCreate: null` (line 77) unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/agent/providers/codex.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both clean. (`AgentRunResult.cacheCreate` is `number | null` at `src/agent/runner.ts:29`, so the widened type stays assignable at the `...usage` spreads in `codex.ts:194/204/214`.)

- [ ] **Step 6: Commit**

```bash
git add src/agent/providers/codex.ts test/agent/providers/codex.test.ts
git commit -m "fix(codex): capture cache_write_input_tokens into cacheCreate (ENG-356)"
```

---

### Task 2: Pricing module — table, config schema, `deriveCost`

**Files:**
- Create: `src/telemetry/pricing.ts`
- Test: `test/telemetry/pricing.test.ts`

**Interfaces:**
- Produces: `PricingConfigSchema` (zod, fully defaulted), `type PricingConfig`, `DEFAULT_PRICING_CONFIG`, `interface DispatchUsage { tokensIn, tokensOut, cacheRead, cacheCreate: number|null }`, `deriveCost(usage, model: string|null, provider: string, cfg?: PricingConfig): number | null`.

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
  expect(deriveCost(u(51599, 267, 36339, 15248), "gpt-5.6-sol", "codex")).toBeCloseTo(0.1215395, 6);
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
  const cost = deriveCost(u(1000, 50, 600, 300), "gpt-5.6-luna", "codex");
  expect(cost).toBeCloseTo((100 * 1.0 + 600 * 0.1 + 300 * 1.25 + 50 * 6.0) / 1e6, 10);
});

test("codex fresh<0 floors to 0 and emits a stderr diagnostic", () => {
  const orig = process.stderr.write.bind(process.stderr);
  let warned = "";
  process.stderr.write = ((s: string) => {
    warned += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    const cost = deriveCost(u(800, 10, 500, 400), "gpt-5.6-luna", "codex");
    expect(cost).toBeCloseTo((0 * 1.0 + 500 * 0.1 + 400 * 1.25 + 10 * 6.0) / 1e6, 10);
    expect(warned).toContain("partition remainder negative");
  } finally {
    process.stderr.write = orig;
  }
});

test("claude disjoint: no subtraction (buckets already separate)", () => {
  const cost = deriveCost(u(1000, 200, 400, 100), "claude-opus-4-8", "claude");
  expect(cost).toBeCloseTo((1000 * 5.0 + 400 * 0.5 + 100 * 6.25 + 200 * 25.0) / 1e6, 10);
});

test("codex 272K tier: input-side ×2, output ×1.5 (strict >, boundary excluded)", () => {
  expect(deriveCost(u(272000, 100, 0, 0), "gpt-5.6-terra", "codex")).toBeCloseTo(
    (272000 * 2.5 + 100 * 15.0) / 1e6,
    10,
  );
  expect(deriveCost(u(272001, 100, 0, 0), "gpt-5.6-terra", "codex")).toBeCloseTo(
    (272001 * 2.5 * 2 + 100 * 15.0 * 1.5) / 1e6,
    10,
  );
});

test("an explicit cfg overrides the built-in rates", () => {
  const cfg = PricingConfigSchema.parse({
    rates: { "gpt-5.6-sol": { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 } },
  });
  expect(deriveCost(u(100, 10, 0, 0), "gpt-5.6-sol", "codex", cfg)).toBeCloseTo(
    (100 * 1 + 10 * 1) / 1e6,
    10,
  );
});

test("DEFAULT_PRICING_CONFIG has all six models + the codex tier", () => {
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
  expect(PricingConfigSchema.parse({}).version).toBe("builtin@2026-07-22");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/telemetry/pricing.test.ts`
Expected: FAIL — module `src/telemetry/pricing.ts` does not exist.

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
  return tokensIn * inRate + (cacheRead ?? 0) * crRate + (cacheCreate ?? 0) * cwRate + tokensOut * outRate;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/telemetry/pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry/pricing.ts test/telemetry/pricing.test.ts
git commit -m "feat(telemetry): pricing table + deriveCost (provider-keyed, 272K tier) (ENG-356)"
```

---

### Task 3: Wire the `pricing` config block into runtime config

**Must** be a new top-level key — `telemetry` is already `z.boolean()` (`runtime-config.ts:30`, the PostHog flag), so nesting under it is a hard zod failure.

**Files:**
- Modify: `src/config/runtime-config.ts` (add import; add field after `:30`)
- Test: `test/config/pricing-config.test.ts` (create)

**Interfaces:**
- Consumes: `PricingConfigSchema` (Task 2).
- Produces: `RuntimeConfig` gains `pricing: PricingConfig`, always populated.

- [ ] **Step 1: Write the failing tests**

Create `test/config/pricing-config.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../../src/config/runtime-config.ts";

test("default runtime config carries the built-in pricing table", () => {
  expect(DEFAULT_RUNTIME_CONFIG.pricing.rates["gpt-5.6-sol"]).toBeDefined();
  expect(DEFAULT_RUNTIME_CONFIG.pricing.tiers.codex.threshold).toBe(272000);
  expect(DEFAULT_RUNTIME_CONFIG.pricing.version).toBe("builtin@2026-07-22");
});

test("a pricing.rates override REPLACES the whole rates map (shallow, wholesale) — N1", () => {
  const cfg = RuntimeConfigSchema.parse({
    pricing: { rates: { "gpt-5.6-sol": { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 } } },
  });
  expect(cfg.pricing.rates["gpt-5.6-sol"].input).toBe(1);
  // Models omitted from the override are GONE (→ null estimate). Pins the documented behavior.
  expect(cfg.pricing.rates["claude-opus-4-8"]).toBeUndefined();
  // tiers/version, unspecified, still default:
  expect(cfg.pricing.tiers.codex.threshold).toBe(272000);
});

// Regression guard, NOT a fail-then-pass assertion — this already throws today because
// `telemetry` is a boolean. It exists so a future refactor can't silently re-nest pricing.
test("nesting pricing under telemetry is rejected (telemetry is a boolean)", () => {
  expect(() => RuntimeConfigSchema.parse({ telemetry: { pricing: {} } })).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/config/pricing-config.test.ts`
Expected: FAIL on tests 1 and 2 — `DEFAULT_RUNTIME_CONFIG.pricing` is `undefined`, so `.rates` throws. (Test 3 passes already; see its comment.)

- [ ] **Step 3: Add the config block**

In `src/config/runtime-config.ts`, add the import after the existing `AgentConfigSchema` import:

```ts
import { PricingConfigSchema } from "../telemetry/pricing.ts";
```

Then immediately after the `telemetry: z.boolean().default(true),` line (`:30`) add:

```ts
  // ENG-356: list-price-equivalent cost-estimate pricing. Top-level (NOT under `telemetry`, which is
  // the PostHog on/off boolean). Numbers/multipliers are operator-tunable; the built-in table is the
  // default. The token-accounting convention lives in code (telemetry/pricing.ts), not here.
  pricing: PricingConfigSchema.default(() => PricingConfigSchema.parse({})),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/config/pricing-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck + lint (no import cycle)**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all clean. (`config/runtime-config` → `telemetry/pricing` is a leaf edge: `pricing.ts` imports only `zod`.)

- [ ] **Step 6: Commit**

```bash
git add src/config/runtime-config.ts test/config/pricing-config.test.ts
git commit -m "feat(config): add top-level pricing block for cost estimates (ENG-356)"
```

---

### Task 4: Align `CODEX_PRESET` with the priced models (D9)

The shipped preset is `gpt-5.4-*`, sharing no id with the table — so the *default* codex config would emit `null` for every dispatch and AC#1 would not pass. Those ids are stale (the test API key couldn't even access `gpt-5.4-codex`).

**Files:**
- Modify: `src/config/agent-config.ts:34` (`CODEX_PRESET.models`)
- Test: `test/config/preset-priced.test.ts` (create)

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

In `src/config/agent-config.ts` line 34, replace the `CODEX_PRESET.models` line with (cost-ordered: sol=deep, terra=standard, luna=cheap):

```ts
  models: { deep: "gpt-5.6-sol", standard: "gpt-5.6-terra", cheap: "gpt-5.6-luna" },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config/preset-priced.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `bun test && bun run typecheck && bun run lint`
Expected: clean. (Verified: no test asserts the literal `gpt-5.4*` ids — `grep -rn "gpt-5.4" test/` returns nothing.)

- [ ] **Step 6: Commit**

```bash
git add src/config/agent-config.ts test/config/preset-priced.test.ts
git commit -m "feat(config): point CODEX_PRESET at priced gpt-5.6-* models (ENG-356 D9)"
```

---

### Task 5: Wire schema + emitter — emit `cost_usd_estimated`

**Schema and emitter ship together in one commit.** Splitting them leaves an intermediate commit where `toDispatch`/`buildSummary` return literals missing a now-required key (`tsc` errors in `src/`) and every real run writes a stderr schema-validation diagnostic per event.

**Files:**
- Modify: `src/telemetry/events.ts` (`DispatchEvent.cost_usd` `:53`; `SummaryEvent.cost_usd` `:86`; `usage_coverage.cost_usd` `:93`)
- Modify: `src/telemetry/emitter.ts` (`toDispatch` `:62`, `cost_usd:` `:88`; `buildSummary` `:109`, `cost_usd: cost.value` `:137`, `usage_coverage` `:144`; `createTelemetryEmitter` `:160`; `flushNew` emit `:198`; `emitSummary` `:205-207`)
- Modify: `src/daemon/run-ticket.ts:82`, `src/cli/run.ts:244`
- Modify (existing literals — **required**, see Global Constraints): `test/telemetry/events.test.ts` (summary `:10-42`, dispatch `:46-72`, stdoutSink summary `:144-175`), `test/cli/run-analytics.test.ts:7-38`
- Modify: `test/helpers/db.ts` (optional `provider`)
- Test: `test/telemetry/emitter.test.ts`

**Interfaces:**
- Consumes: `deriveCost`, `DEFAULT_PRICING_CONFIG`, `PricingConfig`, `PricingConfigSchema` (Task 2).
- Produces: `DispatchEvent` + `SummaryEvent` gain `cost_usd_estimated: number | null`; `SummaryEvent` gains `pricing_version: string`; `usage_coverage` gains `cost_usd_estimated: number`. `createTelemetryEmitter(sink, pricing?)` and `buildSummary(db, ticketId, result, pricing?)` take an optional `PricingConfig` (default `DEFAULT_PRICING_CONFIG`). `toDispatch(r, ctx, pricing)` takes a required third param (module-private, one caller).
- `makeTestDb(opts?: { provider?: string })` seeds the run row with that provider (default `"claude"`).

- [ ] **Step 1: Add the `provider` option to the test DB helper**

In `test/helpers/db.ts`, change the first overload signature and the implementation signature, and thread it into `insertRun`:

```ts
/** Migrate a fresh tmp DB, open it, and seed one project + one ticket + one run.
 *  `provider` sets the run row's provider (default "claude"). Caller must db.close(). */
export function makeTestDb(opts?: { provider?: string }): {
  db: Database;
  projectId: number;
  ticketId: number;
};
/** Migrate a fresh tmp DB without seeding any rows. The caller is responsible for db.close(). */
export function makeTestDb(opts: { seedTicket: false }): {
  db: Database;
  projectId: undefined;
  ticketId: undefined;
};
export function makeTestDb(opts?: { seedTicket?: boolean; provider?: string }): {
  db: Database;
  projectId: number | undefined;
  ticketId: number | undefined;
} {
```

and in the seeding branch replace the `insertRun` call with:

```ts
    insertRun(db, {
      runId: "test-run-0001",
      startedAt: nowUtc(),
      provider: opts?.provider ?? "claude",
    });
```

- [ ] **Step 2: Write the failing tests**

Add to `test/telemetry/emitter.test.ts` (`insertDispatch`, `completeDispatch`, `nextSeq`, `makeTestDb`, `createTelemetryEmitter`, `TelemetryEvent` are already imported; add `nowUtc` and `PricingConfigSchema`):

```ts
import { PricingConfigSchema } from "../../src/telemetry/pricing.ts";
import { nowUtc } from "../../src/util/time.ts";
```

```ts
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
    outcome: "clean-success",
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
    expect(ev.cost_usd_estimated).toBeCloseTo(
      (1000 * 5.0 + 400 * 0.5 + 100 * 6.25 + 200 * 25.0) / 1e6,
      8,
    );
  }
  db.close();
});

test("calibration: a claude run's estimate tracks its reported cost within tolerance", () => {
  const { db, ticketId } = makeTestDb();
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "K1",
    seq: nextSeq(db, ticketId),
    model: "claude-opus-4-8",
  });
  // What an API-key `claude` CLI would report for these tokens at list price.
  const reported = (120_000 * 5.0 + 800_000 * 0.5 + 40_000 * 6.25 + 6_000 * 25.0) / 1e6;
  completeDispatch(db, d.id, {
    outcome: "clean-success",
    costUsd: reported,
    tokensIn: 120_000,
    tokensOut: 6_000,
    cacheRead: 800_000,
    cacheCreate: 40_000,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "K1");
  if (ev?.type === "dispatch" && ev.cost_usd !== null && ev.cost_usd_estimated !== null) {
    // Guards gross table/formula drift: estimate within 1% of the provider-reported figure.
    expect(Math.abs(ev.cost_usd_estimated - ev.cost_usd) / ev.cost_usd).toBeLessThan(0.01);
  } else {
    throw new Error("expected both reported and estimated cost");
  }
  db.close();
});

test("codex run: cost_usd null, cost_usd_estimated non-null; summary floor-sum + coverage", () => {
  const { db, ticketId } = makeTestDb({ provider: "codex" });
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "X1",
    seq: nextSeq(db, ticketId),
    model: "gpt-5.6-sol",
  });
  completeDispatch(db, d.id, {
    outcome: "clean-success",
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
    expect(s.pricing_version).toBe("builtin@2026-07-22");
  }
  db.close();
});

test("codex unknown model: cost_usd_estimated null", () => {
  const { db, ticketId } = makeTestDb({ provider: "codex" });
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "U1",
    seq: nextSeq(db, ticketId),
    model: "gpt-9.9-unknown",
  });
  completeDispatch(db, d.id, {
    outcome: "clean-success",
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

test("the emitter HONORS an injected pricing config (not just the built-in default)", () => {
  const { db, ticketId } = makeTestDb({ provider: "codex" });
  const sink: TelemetryEvent[] = [];
  const cfg = PricingConfigSchema.parse({
    version: "operator-test",
    rates: { "gpt-5.6-sol": { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 } },
  });
  const emitter = createTelemetryEmitter((e) => sink.push(e), cfg);
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "O1",
    seq: nextSeq(db, ticketId),
    model: "gpt-5.6-sol",
  });
  completeDispatch(db, d.id, {
    outcome: "clean-success",
    tokensIn: 1000,
    tokensOut: 100,
    cacheRead: 0,
    cacheCreate: 0,
    endedAt: nowUtc(),
  });
  emitter.flushNew(db, ticketId);
  const ev = sink.find((e) => e.type === "dispatch" && e.dispatch_id === "O1");
  if (ev?.type === "dispatch") {
    // All-1.0 rates → (1000 + 100)/1e6. Would be ~0.008 under the built-in sol rates.
    expect(ev.cost_usd_estimated).toBeCloseTo(1100 / 1e6, 10);
  }
  emitter.emitSummary(db, ticketId, {
    outcome: "pr-ready",
    iterations: 1,
    stage: "merge",
    status: "done",
  });
  const s = sink.find((e) => e.type === "summary");
  if (s?.type === "summary") expect(s.pricing_version).toBe("operator-test");
  db.close();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: FAIL — `cost_usd_estimated` / `pricing_version` are not emitted (`undefined`).

- [ ] **Step 4: Add the schema fields**

In `src/telemetry/events.ts`:

After `DispatchEvent`'s `cost_usd: z.number().nullable(),` (`:53`) add:

```ts
  cost_usd_estimated: z.number().nullable(),
```

After `SummaryEvent`'s `cost_usd: z.number().nullable(),` (`:86`) add:

```ts
  cost_usd_estimated: z.number().nullable(),
  // Provenance of the price table used for cost_usd_estimated (built-in date or operator-set),
  // so a consumer can tell default estimates from config-overridden ones.
  pricing_version: z.string(),
```

Inside `SummaryEvent.usage_coverage`, after `cost_usd: z.number(),` (`:93`) add:

```ts
    cost_usd_estimated: z.number(),
```

Do **not** change `SCHEMA_VERSION`.

- [ ] **Step 5: Update the emitter**

In `src/telemetry/emitter.ts`, add the import after the `events.ts` import:

```ts
import { DEFAULT_PRICING_CONFIG, deriveCost, type PricingConfig } from "./pricing.ts";
```

Change `toDispatch` (`:62`) to take `pricing` and emit the field — signature becomes:

```ts
function toDispatch(r: DispatchRow, ctx: RunCtx, pricing: PricingConfig): TelemetryEvent {
```

and after its `cost_usd: r.cost_usd,` (`:88`) add:

```ts
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
```

Change `buildSummary` (`:109`) signature to:

```ts
export function buildSummary(
  db: Database,
  ticketId: number,
  result: RunResult,
  pricing: PricingConfig = DEFAULT_PRICING_CONFIG,
): TelemetryEvent {
```

After the existing `const cc = aggregate(...)` line (`:118`) add:

```ts
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
```

In the returned object, after `cost_usd: cost.value,` (`:137`) add:

```ts
    cost_usd_estimated: estCost.value,
    pricing_version: pricing.version,
```

and inside `usage_coverage`, after `cost_usd: cost.reported,` (`:144`) add:

```ts
      cost_usd_estimated: estCost.reported,
```

Change `createTelemetryEmitter` (`:160`) signature to:

```ts
export function createTelemetryEmitter(
  sink: TelemetrySink,
  pricing: PricingConfig = DEFAULT_PRICING_CONFIG,
): {
```

(rest of the return type unchanged). In `flushNew` (`:198`) change the emit line to:

```ts
        if (d.ended_at !== null) sink(toDispatch(d, c, pricing));
```

and in `emitSummary` (`:205-207`):

```ts
    emitSummary(db, ticketId, result) {
      sink(buildSummary(db, ticketId, result, pricing));
    },
```

- [ ] **Step 6: Update the two production callers**

`src/daemon/run-ticket.ts:82`:

```ts
  const emitter = createTelemetryEmitter(opts.emit ?? noopSink, opts.config.pricing);
```

`src/cli/run.ts:244`:

```ts
      buildSummary(db, out.ticketId, out, runtimeConfig.pricing) as Extract<
        TelemetryEvent,
        { type: "summary" }
      >,
```

- [ ] **Step 7: Update the four existing event literals (REQUIRED — nullable ≠ optional)**

`z.number().nullable()` requires the key to be present, so every hand-written event literal must gain the new keys or `parse` throws / `tsc` errors:

- `test/telemetry/events.test.ts:10-42` (summary literal) — add `cost_usd_estimated: null,` and `pricing_version: "builtin@2026-07-22",` at the top level, and `cost_usd_estimated: 0,` inside its `usage_coverage` (`:28-35`).
- `test/telemetry/events.test.ts:46-72` (dispatch literal) — add `cost_usd_estimated: null,`.
- `test/telemetry/events.test.ts:144-175` (the `stdoutSink({...})` summary literal) — same additions as the first summary.
- `test/cli/run-analytics.test.ts:7-38` (`const parked: SummaryEvent = {...}`) — same additions as the first summary.

- [ ] **Step 8: Run the full suite**

Run: `bun test`
Expected: PASS — including the four updated literals and all new emitter tests.

- [ ] **Step 9: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both clean. If Biome flags import order in the test file, run `bun run format` (builtins first, per `test/helpers/db.ts:1-10`).

- [ ] **Step 10: Commit**

```bash
git add src/telemetry/events.ts src/telemetry/emitter.ts src/daemon/run-ticket.ts src/cli/run.ts \
  test/telemetry/events.test.ts test/telemetry/emitter.test.ts test/cli/run-analytics.test.ts \
  test/helpers/db.ts
git commit -m "feat(telemetry): emit cost_usd_estimated + pricing_version (both providers) (ENG-356)"
```

---

### Task 6: Docs — wire spec + configuration reference

**Files:**
- Modify: `docs/architecture/telemetry-export.md` (dispatch table `:127`; summary table `:173`; `usage_coverage` rows `:180`; §4 stale claim `:231-234`)
- Modify: `docs/architecture/configuration.md`

- [ ] **Step 1: Dispatch field table (§3.2)** — add after the `cost_usd` row:

```md
| `cost_usd_estimated` | number \| null | yes | derived at emit time — see §4 |
```

- [ ] **Step 2: Summary field table (§3.4)** — add after the summary `cost_usd` row:

```md
| `cost_usd_estimated` | number \| null | yes | floor-sum of dispatch `cost_usd_estimated` — see §4 |
| `pricing_version` | string | no | provenance of the price table used (built-in date or operator-set) |
```

and after the `usage_coverage.cost_usd` row:

```md
| `usage_coverage.cost_usd_estimated` | number | no | count of dispatches with a non-null derived estimate |
```

- [ ] **Step 3: §4 — replace the stale codex claim and add the estimate contract**

Replace the sentence at `:231-234` asserting codex "has no cache-write metric" / "`cache_create: null` by construction" with:

```md
- **`provider` explains the systematic `cost_usd` gap.** The `codex` adapter never reports a USD
  `cost_usd` (its CLI emits none), so every `codex` dispatch has `cost_usd: null`; a ticket run
  entirely on `codex` shows `usage_coverage.cost_usd === 0`. It **does** report token usage
  including `cache_write_input_tokens` (→ `cache_create`) and `cached_input_tokens` (→ `cache_read`).
  `claude` reports `cost_usd`.

- **`cost_usd_estimated` — a derived, list-price-equivalent cost.** For any dispatch with a known
  model id and the token counts its provider's accounting convention needs, the exporter derives an
  estimate = tokens × a per-model price table (USD/1M tokens), floor-summed on the summary with its
  own `usage_coverage.cost_usd_estimated` count. It is populated for **both** providers (for
  `claude` it sits beside the reported `cost_usd` as a calibration cross-check); an unknown model or
  a missing needed token yields `null` (never a guessed number). **It is a *list-price-equivalent*
  figure, not billed spend:** real USD depends on operator auth (an API key bills list price; a
  subscription has ~$0 marginal cost), so summing `cost_usd_estimated` across providers/auth mixes
  "spent" and "would-have-spent." The table + long-context multipliers are operator-configurable
  (the `pricing` config block — see `configuration.md`); `pricing_version` on the summary stamps
  which table produced the estimate. Reported `cost_usd` is never overwritten by an estimate.
```

- [ ] **Step 4: `configuration.md` — document the `pricing` block**

Add a subsection for the new top-level `pricing` key: `version` (provenance stamp, surfaced as `pricing_version` on the telemetry summary), `rates` (per-model `{input, cacheRead, cacheWrite, output}` in USD per 1M tokens), `tiers` (per-provider `{threshold, inputMultiplier, outputMultiplier}`). State explicitly:
- it feeds the `cost_usd_estimated` estimate only — **no effect on reported `cost_usd`**;
- it is a **new top-level key**, deliberately *not* under the boolean `telemetry`;
- because config resolution is a **shallow per-top-level-key spread**, an override of `pricing.rates` **replaces the entire rates map** — any model omitted becomes unpriced (`null` estimate), so a "retune one price" edit must restate the full map;
- the token-accounting convention is **not** configurable (it lives in `src/telemetry/pricing.ts`).

- [ ] **Step 5: Verify + build**

Run:
```bash
grep -n "no cache-write metric" docs/architecture/telemetry-export.md || echo "stale line removed OK"
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
- [ ] `bun run typecheck` — clean (**the only type check**; baseline was clean before this work).
- [ ] `bun run lint` — clean.
- [ ] `bun run build` — single-binary build succeeds.
- [ ] `grep 'SCHEMA_VERSION = ' src/telemetry/events.ts` → still `2`.
- [ ] Push the branch and open a **draft** PR into `main` (never merge). Do not auto-merge.

## Spec-coverage map (self-review)

| Brainstorm decision / AC | Task |
|---|---|
| D2 parser reads `cache_write_input_tokens` | 1 |
| D3 provider-keyed convention (codex partition / claude disjoint) | 2 |
| D6 272K tier; N3 observable `fresh<0` floor | 2 |
| D7 built-in table, exact-model-id keys, unknown→null, `version` stamp | 2 |
| D1 list-price-equivalent semantics | 2 + 6 (doc) |
| D8 configurable rates/multipliers, convention in code; N1 wholesale-replace | 3 |
| D9 `CODEX_PRESET` → `gpt-5.6-*` (default config priced; AC#1 out-of-box) | 4 |
| D4 additive-nullable `cost_usd_estimated` + coverage, no bump | 5 |
| D4/D5 always-compute both providers, emit-time, reported `cost_usd` untouched | 5 |
| §9 provenance auditable **on the wire** (`pricing_version`) | 5 + 6 |
| §6 claude calibration test (estimate vs reported tolerance) | 5 |
| Wire-spec + config-doc update; correct stale codex claim | 6 |
