# Telemetry: derive list-price-equivalent cost for providers that don't report USD (ENG-356)

**Date:** 2026-07-22
**Ticket:** ENG-356 — derive cost for providers that don't report USD (codex) — estimate from tokens × pricing
**Branch:** `feat/eng-356-codex-cost-estimate`
**Builds on:** ENG-339 (unknown ≠ zero) + ENG-349 (`provider` on the summary) — see `docs/brainstorms/2026-07-21-telemetry-run-identity-and-cost-truth-design.md`

---

## 1. Problem

The telemetry stream is the commercial Control Plane's only view of spend (an open-core seam contract — `build-operations.md §5`). `claude` reports a real USD cost (`total_cost_usd` → `dispatch.cost_usd`); `codex` reports **none** — `parseCodexUsage` returns `costUsd: null` always (`codex.ts:64-77`). After ENG-339 a codex run *honestly* emits `cost_usd: null` (unknown ≠ zero), which is correct but leaves **every codex-provider run's spend unknowable**. This ticket derives an estimate from the token counts codex *does* report, times a per-model price table.

**The ticket's premise is partially stale.** It assumes codex reports only `tokens_in` / `tokens_out` / `cache_read` and that `cache_create` "is always null." Ground truth (§2) shows codex 0.145.0 **also reports `cache_write_input_tokens`** — a field `parseCodexUsage` currently discards — and cache-writes were **78% of a real run's cost**. Fixing the parser is therefore in-scope, not optional (D2).

---

## 2. Ground truth (captured, not assumed)

Ground-truth-over-self-report (CLAUDE.md) applies to the parser's correctness and the token semantics. Both were settled by capturing a real `codex exec --json` run (API-key auth, `gpt-5.6-sol`, read-only sandbox against this repo) — not by reading docs or asking codex. One run that executed **three** shell tool-calls (ls + two file reads) emitted **exactly one** terminal `turn.completed`:

```json
{ "input_tokens": 51599, "cached_input_tokens": 36339,
  "cache_write_input_tokens": 15248, "output_tokens": 267, "reasoning_output_tokens": 0 }
```

Three facts fall out, each load-bearing:

1. **One `turn.completed` per `exec`, cumulative** — *consistent with this one sample* (three tool-call rounds → one rolled-up usage record). `parseCodexUsage`'s "return on the first `turn.completed`" is therefore fine here, and no summation rewrite is needed. **This is an n=1 inference, not a proof:** it doesn't rule out codex ever emitting a second terminal record (continuation / compaction / retry). Low risk because the parser *already* returns-on-first (`codex.ts:89`, pre-existing, unchanged by this ticket) — so the existing token capture and the new estimate share the exposure equally; if a multi-record case ever surfaces it undercounts both, and is a follow-up, not a regression here.

2. **codex reports cache-writes.** `cache_write_input_tokens: 15248` — a field the parser drops (`cacheCreate` hardcoded `null`). The ticket's + `codex.ts:70,77`'s + the wire doc §4's claim that codex has no cache-write metric is **false** for 0.145.0. This is the [[verify-by-design-nulls]] pattern: a null "by design" that is knowable-but-unread at the real call site → a defect.

3. **`input_tokens` is the total; its parts are a partition.** `36339 (cached) + 15248 (cache_write) + 12 (fresh) = 51599`. So the codex decomposition is `input_tokens = cached_input_tokens + cache_write_input_tokens + fresh`. **This differs from claude**, whose `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` are already **disjoint** (no subtraction). The token-accounting convention is **provider-keyed, not model-keyed** — a single generic `deriveCost(usage, model)` would double-count codex's cached portion.

`output_tokens` is the **billed** output total **including reasoning** (confirmed against codex directly; `reasoning_output_tokens` is a subset breakdown). So reasoning is priced whole at the output rate, and **effort** (which only changes reasoning-token volume, not rate) needs no place in the pricing key.

---

## 3. Pricing (sourced, not guessed)

Published rates, USD per 1M tokens. Codex from OpenAI's model pages (`developers.openai.com/api/docs/models/gpt-5.6-{sol,terra,luna}`); claude from Anthropic's models table + caching pricing (cache-read = 0.1× input, cache-write = 1.25× input at the default 5-min ephemeral TTL).

| Model | input | cache-read | cache-write | output | convention |
|---|--:|--:|--:|--:|---|
| `gpt-5.6-sol` | 5.00 | 0.50 | 6.25 | 30.00 | codex (partition-subtract) |
| `gpt-5.6-terra` | 2.50 | 0.25 | 3.13 | 15.00 | codex |
| `gpt-5.6-luna` | 1.00 | 0.10 | 1.25 | 6.00 | codex |
| `claude-opus-4-8` | 5.00 | 0.50 | 6.25 | 25.00 | claude (disjoint) |
| `claude-sonnet-4-6` | 3.00 | 0.30 | 3.75 | 15.00 | claude |
| `claude-haiku-4-5-20251001` | 1.00 | 0.10 | 1.25 | 5.00 | claude |

The table stores **explicit ground-truth numbers per model**, not the family ratios (codex: cache-read = 0.1× in, cache-write = 1.25× in, output = 6× in) — those are a sanity check, never encoded, since ratios can drift per model. **Keys must match the runtime model id exactly** (D7); alias-vs-runtime-id drift is the most likely cause of a silent `null` estimate, so the table (and its tests) key on what dispatches actually carry. Two live drifts, both reconciled in this ticket:
- **codex preset (D9):** the shipped `CODEX_PRESET` is `gpt-5.4 / gpt-5.4-codex / gpt-5.4-codex-mini` (`agent-config.ts:34`) — **zero overlap** with the table, so the *default* codex config would yield `null` for every dispatch and AC#1 would not demonstrably pass. The test API key can't even access `gpt-5.4-codex`; the models that exist and were seen are `gpt-5.6-*`. So this ticket **updates `CODEX_PRESET` → `gpt-5.6-sol/luna/terra`**, aligning the default with the priced, real models.
- **claude cheap tier:** the binary default is the **date-suffixed** `claude-haiku-4-5-20251001` (not the bare alias) — so that is the table key, as listed above. (deep/standard = `claude-opus-4-8` / `claude-sonnet-4-6`, both present.)

**272K long-context tier (codex/OpenAI, provider-specific).** All three codex pages carry: requests with `input_tokens > 272000` bill at **2× input and 1.5× output for the entire request**. Since cache-read and cache-write are *defined* as multiples of the uncached input rate, they scale with it → **all three input-side rates ×2, output ×1.5** above the threshold (D6). The current-gen claude models in the table have **no** long-context premium (1M at standard pricing per Anthropic), so the tier is codex-only — another provider-keyed difference.

**Worked example** (the captured sol run, no tier): `fresh=12`, `cost = 12·5 + 36339·0.5 + 15248·6.25 + 267·30` (per-1M) = **$0.1215**, of which cache-write is **$0.095 (78%)**. Dropping cache-write (ticket-as-scoped) → 78% underestimate; pricing it as fresh input → 20% low on that component. This is why D2 is a hard dependency, not polish.

---

## 4. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Estimate semantics = "list-price-equivalent cost," not "money spent."** Documented as such on the wire spec. | Operator auth decides real spend: an API key bills real USD; a ChatGPT-subscription codex run has ~$0 marginal USD. A token×list-price number is comparable across providers and auth modes but is *not* "billed cost." Naming it honestly is the ENG-339 discipline extended. |
| D2 | **Fix `parseCodexUsage` to read `cache_write_input_tokens` → `cacheCreate` — in scope.** | Ground truth (§2.2): the field exists and is ~30% of input / 78% of cost. It's a hard dependency (can't price a token you never captured) **and** a standalone honesty bug (emitting `cache_create: null` = "unknown" when it's known). Corrects `codex.ts:70,77` and wire-doc §4. |
| D3 | **`deriveCost` is provider-keyed on the token-accounting convention, not just model-keyed.** codex: `fresh = input − cached − cache_write`, then price the four buckets; claude: buckets already disjoint, no subtraction. | §2.3 — one generic formula double-counts codex's cached portion. The partition rule is a property of the provider CLI, not the model id. |
| D4 | **Wire encoding = Option A + always-compute.** Add nullable `cost_usd_estimated` (dispatch + summary) computed whenever model + tokens are known, **for every provider including claude**. Reported `cost_usd` is never touched. Drop the ticket's proposed `cost_source` marker. | Reported `cost_usd` stays reported-only, so the summary's floor-sum of `cost_usd` never blends estimated + reported and `usage_coverage.cost_usd` stays meaningful. Computing claude's estimate alongside its real cost makes **claude a calibration harness** — estimated-vs-reported drift is observable, so the codex number is falsifiable. With two explicit nullable fields + coverage counts, `cost_source` is redundant. Additive-nullable ⇒ **no `SCHEMA_VERSION` bump** (stays 2). |
| D5 | **Derivation runs at emit time in `emitter.ts`, nothing stored on the dispatch row.** | It's a pure function of already-stored fields (`model`, tokens, run `provider`); `emitter.ts` already holds the DB. Honors "only the runner writes the SoT" (CLAUDE.md B2) and the ticket's own lean. Re-emitting under a newer binary re-prices — desirable, and avoids storing a historical estimate to re-price (which is explicitly OUT). |
| D6 | **Apply the 272K tier multiplier in `deriveCost`** (codex: input-side ×2, output ×1.5 when `input_tokens > 272000`); the cache-rate scaling is an inferred-not-verbatim reading, recorded as an auditable caveat. | The data (`input_tokens`) is in hand; ignoring a documented step-function is its own honesty gap. Large implement-stage contexts can cross 272K. |
| D7 | **Pricing table = in-binary default keyed by exact model id, operator-overridable, provenance-stamped.** Unknown model → `null` (never a guessed number). A `price_table_version` (or source-date) is recorded so an estimate is auditable. | Correct-by-default with no config; operators can correct drift. Exact-match-or-null honors "unknown → no estimate, never a wrong number" (ticket). Config override makes the estimate operator-dependent — a wrinkle for cross-operator aggregation, noted in the doc. |
| D9 | **Update `CODEX_PRESET` to the `gpt-5.6-*` model ids** (`agent-config.ts:34`), replacing the stale `gpt-5.4-*` defaults. | The shipped preset shares no model id with the price table, so the default codex config would emit `null` for every dispatch — AC#1 wouldn't pass out of the box. The `gpt-5.4-*` ids are stale (the test key couldn't even access `gpt-5.4-codex`); the real, priced models are `gpt-5.6-*`. A runtime-behavior change beyond pricing, taken deliberately so "default codex config produces an estimate" holds. |
| D8 | **All pricing *parameters* are configurable; the *convention* stays code.** Configurable via a `pricing` (top-level) config block (in-binary §3 table as zod defaults): per-model `{input, cacheRead, cacheWrite, output}` rates **and** the per-provider long-context tier `{threshold, inputMultiplier, outputMultiplier}`. **Not** configurable: the partition-subtract (codex) vs disjoint-bucket (claude) structure. | The rates + multipliers + 272K threshold are *pricing facts that drift* — exactly what a real invoice retunes; making them config means correcting them without a binary release ("reconfirm once we have real billing, then set it right"). The token-accounting **convention** is a *verified structural fact* (ground truth §2.3), not a pricing choice — a real invoice won't change whether `input_tokens` is a total (codex) or disjoint (claude); leaving it in code avoids a foot-gun where a mis-set convention silently double-counts. A fully data-driven formula engine is YAGNI. |

---

## 5. Design

### 5.1 Parser fix — `parseCodexUsage` (`codex.ts:63-101`) (D2)

Read `usage.cache_write_input_tokens` into the returned `cacheCreate` (currently hardcoded `null`). Type changes `cacheCreate: null` → `cacheCreate: number | null`. The `transportFailure`/empty paths keep `null`. No other codex-adapter change — the single-`turn.completed` assumption is confirmed correct (§2.1). Wire-doc §4's "codex … has no cache-write metric" sentence is corrected in the same PR.

### 5.2 Pricing table + `deriveCost` (new `src/telemetry/pricing.ts`)

```ts
// Numbers from §3 as zod DEFAULTS; operator-overridable via config (D8).
interface ModelRate { input: number; cacheRead: number; cacheWrite: number; output: number; }  // USD/token
interface TierRule  { threshold: number; inputMultiplier: number; outputMultiplier: number; }    // per-provider long-context tier
interface PricingConfig {
  version: string;                              // provenance stamp (D7); "builtin@2026-07-22" or operator-set
  rates: Record<string, ModelRate>;             // keyed by EXACT runtime model id; unknown ⇒ null estimate
  tiers: Record<string, TierRule>;              // per provider; codex ⇒ {272000, 2, 1.5}, claude ⇒ absent/none
}

type Convention = "codex-partition" | "claude-disjoint";  // CODE — verified structural fact (§2.3), not config (D8)
function conventionFor(provider: string): Convention { /* codex ⇒ partition, else disjoint */ }

// Pure. null when model unknown or the tokens the convention needs are absent.
function deriveCost(usage: Usage, model: string | null, provider: string, cfg: PricingConfig): number | null;
```

- **codex-partition:** `fresh = input − cached − cacheWrite`; `cost = fresh·input + cached·cacheRead + cacheWrite·cacheWrite + output·output`. If `input_tokens > tier.threshold`: input-side rates × `tier.inputMultiplier`, output × `tier.outputMultiplier` (D6). Multipliers/threshold come from `cfg.tiers[provider]` (D8). **`fresh < 0` is floored to 0 but emitted as a stderr diagnostic, not silently** (N3): the partition rests on n=1 evidence (§2.1), so a negative `fresh` is the one observable signal the convention is wrong — surface it rather than convert a broken assumption into a plausible-but-wrong number.
- **claude-disjoint:** `cost = input·input + cacheRead·cacheRead + cacheCreate·cacheWrite + output·output` (no subtraction). No tier rule configured for claude by default.
- **Null discipline:** unknown model → `null`. Missing a token the convention needs → `null` (never treat absent as 0). `provider`/`model` come from the run row + `dispatch.model` at the call site.
- **Config (D8):** the `PricingConfig` loads from a **new top-level `pricing`** key (NOT under `telemetry`, which is a `z.boolean()` PostHog flag — `runtime-config.ts:30`) via the standard precedence (CLAUDE.md: `--config` hermetic **XOR** per-project shallow-spread over global, then zod defaults = the §3 table). Only rates/tiers/threshold are tunable — `conventionFor` is code. The resolved `version` is stamped so a config-overridden estimate is auditable (§9).
- **Override granularity (N1):** config resolution is a **shallow per-top-level-key spread**, and a zod `.default()` only fills an *absent* key — so an operator override of `pricing.rates` **replaces the whole rates map**; any model omitted from the override becomes unpriced (→ `null`). "Retune one price" therefore means re-stating the full map. Document this in `configuration.md` and pin it with a test. *(Optional: deep-merge `rates` by model id so a partial override tops up the defaults — nicer ergonomics, but a deviation from the repo's shallow-spread norm; call it out if adopted.)*

### 5.3 Wire shape (v2, additive-nullable — no bump) (D4)

`events.ts`:
- `DispatchEvent`: add `cost_usd_estimated: z.number().nullable()`.
- `SummaryEvent`: add `cost_usd_estimated: z.number().nullable()` (floor-sum of the dispatches' estimates) and `usage_coverage.cost_usd_estimated: z.number()` (count of dispatches with a non-null estimate).
- No `cost_source`. No `SCHEMA_VERSION` change (stays 2).

### 5.4 Emitter (`emitter.ts`) (D5)

- `toDispatch`: `cost_usd_estimated: deriveCost({tokens_in, cache_read, cache_create, tokens_out}, r.model, ctx.provider)`. `cost_usd` unchanged (reported-only).
- `buildSummary`: `const est = aggregate(dispatches.map(d => deriveCost(...)))`; populate `cost_usd_estimated: est.value` and `usage_coverage.cost_usd_estimated: est.reported`. Reuses the existing floor-sum `aggregate()` — estimate aggregation inherits the same lower-bound-under-partial-coverage semantics as reported cost.
- claude dispatch ⇒ both `cost_usd` (reported) and `cost_usd_estimated` (derived) non-null; codex dispatch ⇒ `cost_usd` null, `cost_usd_estimated` non-null (known model+tokens) or null (unknown model).

### 5.5 Docs

- `docs/architecture/telemetry-export.md`: document `cost_usd_estimated` on dispatch + summary and `usage_coverage.cost_usd_estimated`; the **list-price-equivalent** definition + accuracy caveat (D1); the pricing-config block + `version` provenance and the parameters-configurable/convention-in-code split (D7/D8); the 272K tier and its inferred cache-scaling caveat (D6); **correct** §4's stale "codex has no cache-write metric" line (D2).
- `docs/architecture/configuration.md`: document the new `pricing` (top-level) config block (rates + per-provider tier rule), its zod defaults (§3), and that it feeds the estimate only — no effect on reported `cost_usd`.

---

## 6. Testing (`test/telemetry/`, `test/agent/providers/codex.test.ts`)

- **Parser (D2):** a `turn.completed` with `cache_write_input_tokens` yields non-null `cacheCreate`; absent field → `null`. (Extend the existing fixture at `codex.test.ts:73`.)
- **deriveCost codex:** the §3 sol sample yields ≈ `$0.1215`; the partition subtraction is exercised (cached+write ≈ input); unknown model → `null`; missing tokens → `null`.
- **deriveCost 272K:** `input_tokens > 272000` applies input ×2 / output ×1.5.
- **deriveCost claude:** disjoint buckets, no subtraction; a known claude model + tokens yields a plausible estimate.
- **Emitter:** a codex run emits `cost_usd: null` **and** non-null `cost_usd_estimated`; a claude run keeps its reported `cost_usd` untouched **and** carries a non-null `cost_usd_estimated`; unknown-model codex → both null. Summary floor-sums the estimate and reports `usage_coverage.cost_usd_estimated`.
- **Calibration (harness value):** for a claude dispatch with a captured `total_cost_usd`, `cost_usd_estimated` is within a documented tolerance of `cost_usd` (guards table/formula drift).
- Existing suite green (`bun test`, `bun run lint`).

---

## 7. Scope

**IN:** per-model pricing table + `deriveCost` (provider-keyed convention, 272K tier, unknown→null, observable `fresh<0` floor); **configurable rates + tier multipliers/threshold via a new top-level `pricing` block with §3 as zod defaults, convention in code (D8)**; **`CODEX_PRESET` → `gpt-5.6-*` (D9)**; the `parseCodexUsage` cache-write fix (D2); `cost_usd_estimated` + coverage on dispatch/summary, emit-time (D4/D5); always-compute incl. claude; wire-spec + configuration-doc updates incl. the corrected codex cache-write claim; the tests above (incl. a config-override test that pins the wholesale-replace behavior).

**OUT:** making the codex CLI report cost; re-pricing historical runs (presentation-time derivation moots it); any `SCHEMA_VERSION` bump (additive-nullable avoids it); a `cost_source` marker (D4 makes it redundant); building plane-side ingest.

---

## 8. Acceptance criteria

- [ ] The **default** codex config (post-D9 `CODEX_PRESET`) emits a **non-null derived cost** (dispatch + summary) for known model + tokens, in `cost_usd_estimated`, never in `cost_usd` — i.e. AC passes out of the box, not only for a hand-authored `gpt-5.6-*` config.
- [ ] An unknown model → `cost_usd_estimated: null` (no fabricated number).
- [ ] A claude run's reported `cost_usd` is unchanged; it **also** carries a `cost_usd_estimated` (calibration).
- [ ] Estimated vs reported is distinguishable on the wire (separate nullable fields; no `cost_source`) and documented.
- [ ] codex `cache_write_input_tokens` is captured (`cacheCreate` non-null) and priced; the stale "no cache-write metric" claims are corrected.
- [ ] Pricing-table location/ownership decided + documented; provenance (`version`) auditable; 272K tier documented with its cache-scaling caveat.
- [ ] Rates + tier multipliers/threshold are operator-configurable (both providers) with the §3 table as zod defaults; the token-accounting convention is code, not config; a config override changes the estimate and is reflected in the stamped `version`.
- [ ] Wire spec documents the estimate, its **list-price-equivalent** meaning, and the accuracy caveat.
- [ ] No `SCHEMA_VERSION` bump. Existing suite green.

---

## 9. Provenance & caveats (for the wire spec)

- **List-price-equivalent, not billed** (D1) — token×list-price; real USD depends on operator auth (API key vs subscription). Summing `cost_usd_estimated` across providers/auth mixes "spent" and "would-have-spent"; that's the defined unit, stated plainly.
- **Table drift + config (D7/D8)** — a stale price silently mis-estimates; the resolved pricing `version` (built-in date or operator-set) is stamped so an estimate is auditable. Because rates/multipliers are operator-configurable, the estimate is operator-dependent — a wrinkle for cross-operator aggregation on the plane; the `version` stamp is what lets a consumer tell built-in-default estimates from config-overridden ones. The retune path is deliberate: when real invoices arrive, correct config, not code.
- **272K cache-scaling** (D6) is inferred from the rate-derivation structure, not stated verbatim by OpenAI — reversible if billing proves otherwise.
- **Lower bound under partial coverage** — the summary estimate is a floor-sum (a dispatch with an unknown model contributes nothing), same semantics as reported cost; `usage_coverage.cost_usd_estimated` signals it.

---

## 10. Independent review — resolutions

An independent, code-grounded review (2026-07-22) verified the core mechanism sound: the `parseCodexUsage` diagnosis and localized fix, the disjoint-vs-partition contrast, the additive-nullable wire encoding (no `SCHEMA_VERSION` bump — confirmed against the dispatch_id precedent), the emit-time feasibility (`RunCtx.provider` + `DispatchRow.model`, no SoT write — honors B2), the config *precedence mechanics*, the stale wire-doc line, and **all the arithmetic** (`51599` partition, `$0.12154`, 78.4% cache-write share) — all exact. One blocking defect and four notes were raised; resolutions folded in above:

- **B1 (blocking) — config key collision.** The doc originally nested pricing under `telemetry`, which is already `z.boolean()` (`runtime-config.ts:30`, the PostHog flag) — a nested object there is a hard zod failure, not a silent strip. **Resolved:** moved to a **new top-level `pricing`** key (D8, §5.2). Overloading `telemetry` (a different subsystem — PostHog adoption vs the wire export) is also avoided.
- **N2 → D9 — shipped preset vs table mismatch.** `CODEX_PRESET` (`gpt-5.4-*`, `agent-config.ts:34`) shares no model id with the `gpt-5.6-*` table, so the *default* codex config would emit `null` for every dispatch and AC#1 wouldn't demonstrably pass. **Resolved (operator decision):** this ticket updates `CODEX_PRESET` → `gpt-5.6-sol/luna/terra` (D9, §3), aligning the default with the priced, actually-available models; the AC now explicitly requires the *default* config to produce an estimate.
- **N1 — partial-override ergonomics.** Shallow per-key spread + `.default()` on absent keys means a `pricing.rates` override replaces the whole map (omitted models → unpriced). **Resolved:** documented in §5.2 + `configuration.md`, pinned by a config-override test; optional per-model deep-merge noted as a deviation to call out if adopted.
- **N3 — silent `fresh<0` floor.** Flooring the codex partition remainder at 0 would mask the one detectable signal that the (n=1) convention is wrong. **Resolved:** the floor now emits a stderr diagnostic (§5.2), consistent with ground-truth-over-self-report.
- **N4 — n=1 overclaim.** "One `turn.completed` per `exec`" was stated as settled from a single sample. **Resolved:** §2.1 softened to a disclosed one-sample inference; exposure is shared with the pre-existing return-on-first parser, so a future multi-record case is a follow-up, not a regression here.
- **N5 (no action) — 272K cache-scaling + cross-provider summing** were already honestly caveated (§9); the reviewer accepted them as reasoned, disclosed assumptions.
