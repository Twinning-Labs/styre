import { expect, test } from "bun:test";
import {
  DEFAULT_PRICING_CONFIG,
  PricingConfigSchema,
  deriveCost,
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

test("claude: a null needed cache token → null (never treated as 0)", () => {
  expect(deriveCost(u(1000, 200, null, 100), "claude-opus-4-8", "claude")).toBeNull();
  expect(deriveCost(u(1000, 200, 400, null), "claude-opus-4-8", "claude")).toBeNull();
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
