import { describe, expect, test } from "bun:test";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";
import { extractSidecar } from "../../src/dispatch/sidecar.ts";
import { EnrichmentSchema } from "../../src/setup/enrichment-schema.ts";
import { mergeScanAndEnrichment } from "../../src/setup/merge.ts";

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

  test("out-of-enum PRESENCE coerces to undefined too (crash class closed for all enum fields, not just type/mechanism)", () => {
    // Whole-branch-review gap: presence had no `.catch`, so a wild presence ("likely") would
    // fail-parse → malformed → 3-retry crash, exactly like the original mechanism bug.
    const parsed = EnrichmentSchema.safeParse({
      ...full,
      caching: { presence: "likely", detail: "seems cached" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.caching.presence).toBeUndefined(); // coerced, not admitted
      expect(parsed.data.caching.detail).toBe("seems cached"); // prose survives
    }
  });

  test("a genuinely malformed section (bad type for detail) still FAILS — fail-soft coerces enum VALUES only, never structural corruption", () => {
    const parsed = EnrichmentSchema.safeParse({ ...full, caching: { detail: 123 } });
    expect(parsed.success).toBe(false);
  });
});

// Crux-review hardening (#1): pin the "fail-soft is SCOPED to enum fields" boundary so a future
// leniency edit (e.g. making sections .optional()/.partial()) can't silently turn a truncated
// agent response into a SUCCESSFUL parse — that would erode the transport-failure→retry contract
// (a missing/garbled section must stay `malformed` → re-dispatch, never become a written profile).
describe("EnrichmentSchema: structural corruption STILL fails (fail-soft never reaches whole sections)", () => {
  test("a whole missing required section (releasePackaging) fails the parse", () => {
    const { releasePackaging: _omit, ...missing } = full;
    expect(EnrichmentSchema.safeParse(missing).success).toBe(false);
  });

  test("a whole missing required section (topology) fails the parse", () => {
    const { topology: _omit, ...missing } = full;
    expect(EnrichmentSchema.safeParse(missing).success).toBe(false);
  });

  test("a non-object / empty-object input fails the parse", () => {
    expect(EnrichmentSchema.safeParse("not an object").success).toBe(false);
    expect(EnrichmentSchema.safeParse(null).success).toBe(false);
    expect(EnrichmentSchema.safeParse({}).success).toBe(false);
  });
});

// Crux-review hardening (#2): the actual crash path, end-to-end. Before the fail-soft fix, an
// out-of-enum mechanism made `extractSidecar` return {reason:"malformed"}, which drove the 3-retry
// crash. This proves the trigger is dead through the REAL extractSidecar → merge path, not just at
// the schema boundary — and that a confident scan value still wins (scan stays ground truth).
describe("crash-is-dead E2E: an out-of-enum agent sidecar completes setup (extractSidecar → merge)", () => {
  const sidecar = (json: string) => `Here you go.\n\`\`\`styre-setup-enrich\n${json}\n\`\`\`\n`;

  test("mechanism 'homebrew-tap' → extractSidecar ok (not malformed) → merge yields unknown, detail preserved, neighbor intact", () => {
    const stdout = sidecar(
      JSON.stringify({
        ...full,
        releasePackaging: { mechanism: "homebrew-tap", detail: "distributed via a homebrew tap" },
        topology: { type: "web-service", detail: "api server" },
      }),
    );
    const parsed = extractSidecar(stdout, EnrichmentSchema, { fence: "styre-setup-enrich" });
    expect(parsed.ok).toBe(true); // the crash trigger: this was `malformed` before the fix
    if (!parsed.ok) return;

    const scan = RuntimeContextSchema.parse({ releasePackaging: { mechanism: "unknown" } });
    const merged = mergeScanAndEnrichment(scan, parsed.value);
    expect(merged.releasePackaging.mechanism).toBe("unknown"); // coerced → setup completes
    expect(merged.releasePackaging.detail).toContain("homebrew"); // agent prose survives
    expect(merged.topology.type).toBe("web-service"); // valid neighbor intact
  });

  test("a confident scan mechanism still wins over a coerced-to-undefined agent proposal (scan = ground truth)", () => {
    const stdout = sidecar(
      JSON.stringify({ ...full, releasePackaging: { mechanism: "homebrew-tap", detail: "x" } }),
    );
    const parsed = extractSidecar(stdout, EnrichmentSchema, { fence: "styre-setup-enrich" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const scan = RuntimeContextSchema.parse({
      releasePackaging: { mechanism: "semantic-release" },
    });
    const merged = mergeScanAndEnrichment(scan, parsed.value);
    expect(merged.releasePackaging.mechanism).toBe("semantic-release"); // scan wins over coercion
  });
});
