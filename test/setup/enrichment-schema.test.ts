import { describe, expect, test } from "bun:test";
import { EnrichmentSchema } from "../../src/setup/enrichment-schema.ts";

const full = {
  topology: { detail: "" },
  data: { detail: "" },
  caching: { detail: "" },
  observability: { detail: "" },
  configSecrets: { detail: "" },
  documentation: { detail: "" },
  releasePackaging: { detail: "" },
};

describe("EnrichmentSchema fails SOFT on an out-of-enum type/mechanism (crash-killer)", () => {
  test("out-of-enum mechanism coerces to undefined; detail + valid neighbor survive; parse succeeds", () => {
    const parsed = EnrichmentSchema.safeParse({
      ...full,
      releasePackaging: { mechanism: "homebrew-tap", detail: "brew formula" },
      topology: { type: "web-service", detail: "api" },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.releasePackaging.mechanism).toBeUndefined(); // coerced, not admitted
    expect(parsed.data.releasePackaging.detail).toBe("brew formula"); // prose survives
    expect(parsed.data.topology.type).toBe("web-service"); // valid neighbor intact
  });

  test("out-of-enum topology.type coerces to undefined, section otherwise intact", () => {
    const parsed = EnrichmentSchema.safeParse({
      ...full,
      topology: { type: "game-console", detail: "a console app" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.topology.type).toBeUndefined();
      expect(parsed.data.topology.detail).toBe("a console app");
    }
  });

  test("a new-vocabulary value (pypi / browser-extension) round-trips", () => {
    const parsed = EnrichmentSchema.safeParse({
      ...full,
      releasePackaging: { mechanism: "pypi", detail: "PyPI" },
      topology: { type: "browser-extension", detail: "Chrome/Firefox extension" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.releasePackaging.mechanism).toBe("pypi");
      expect(parsed.data.topology.type).toBe("browser-extension");
    }
  });

  test("a genuinely malformed section (bad type for detail) still FAILS (fail-soft is scoped to type/mechanism only)", () => {
    const parsed = EnrichmentSchema.safeParse({ ...full, caching: { detail: 123 } });
    expect(parsed.success).toBe(false);
  });
});
