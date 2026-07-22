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

// Regression guard for the zod-4 `.default()` trap: `.default()` does NOT parse its argument, so
// a "simplification" from `.default(() => PricingConfigSchema.parse({}))` to `.default({})` would
// silently resolve `pricing` to `{}` — no rates, no tiers, every cost estimate `null`. This test
// would FAIL under that bad simplification and MUST stay in the suite.
test("a runtime config parsed with no `pricing` key still has populated rates + tiers maps", () => {
  const cfg = RuntimeConfigSchema.parse({});
  expect(Object.keys(cfg.pricing.rates).length).toBeGreaterThan(0);
  expect(Object.keys(cfg.pricing.tiers).length).toBeGreaterThan(0);
  expect(cfg.pricing.rates["gpt-5.6-sol"]).toBeDefined();
  expect(cfg.pricing.tiers.codex).toBeDefined();
});
