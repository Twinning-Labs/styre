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
