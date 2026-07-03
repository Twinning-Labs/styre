# Setup-Enrich Polyglot Enums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `styre setup` from hard-failing its runtime-context enrichment when the agent proposes a topology/release value outside styre's enums (e.g. a Python lib → `pypi`, a browser extension), and make that impossible to reintroduce for any future ecosystem.

**Architecture:** Three moves. (1) Make `EnrichmentSchema`'s two open-vocabulary fields (`topology.type`, `releasePackaging.mechanism`) fail *soft* — an out-of-enum value coerces to `undefined` (→ merge's existing `?? "unknown"`) instead of failing the whole-section parse and crashing setup. This is the load-bearing crash-killer. (2) Broaden the two enums additively so common ecosystems resolve to a real in-profile value (higher-quality profile), not just `unknown`. (3) Rewrite the enrichment prompt to list the allowed values + a disambiguation rule + a never-invent instruction, so the *common* path emits a real value. Verified safe: nothing branches on the specific enum values.

**Tech Stack:** TypeScript, Zod 4.4.3, Bun (`bun test`), Markdown prompt templates imported as text.

## Background (why this fix, and what is actually load-bearing)

`enrichRuntimeContext` (`src/setup/enrich.ts`) dispatches an agent to fill runtime-context sections the deterministic scan (`src/setup/detect-runtime.ts`) left `unknown`. Its output is validated against `EnrichmentSchema` (`src/setup/enrichment-schema.ts`), which reuses `TopologyTypeEnum` / `ReleaseMechanismEnum` from `profile.ts`. When the scan can't determine a section (e.g. a Python repo has no JS signals → topology/release stay `unknown`), the prompt asks the agent to propose a value — and the agent proposes a correct-but-out-of-enum value (`pypi`). Zod rejects the **whole section**, `extractSidecar` reports `malformed` (`src/dispatch/sidecar.ts:29-31`), `enrichRuntimeContext` exhausts its 3 retries and **throws** (`src/setup/enrich.ts:75-84`), and `styre setup` crashes. Confirmed live via styre-bench: `astropy__astropy-12907` and `darkreader__darkreader-7241`.

**What is actually load-bearing (from independent review):** the crash is *structural* — the schema hard-rejects any out-of-enum value, so broadening the enum alone only moves the cliff edge to the next unlisted ecosystem (`nix`, `nuget`, `cocoapods`, …), and one stray value discards all seven sections' prose. The real fix is making the schema fail *soft* (Task 1) so no value can ever hard-fail setup again; the enum broadening and prompt list make the *common* cases produce a real value rather than `unknown`. Note: `astropy`'s topology was NOT an enum gap — `library` already exists — so its topology failure is fixed by the prompt/fail-soft, not by Task 1's enum additions. The merge already fails soft on *omission* (`src/setup/merge.ts:53,81`: `enr.topology.type ?? "unknown"`); only the invalid-*value* path crashes, and only because the schema rejects rather than coerces.

**What this box is — and is NOT (architectural grounding, verified in code):** `topology.type` and `releasePackaging.mechanism` are DESCRIPTIVE metadata. They are consumed in exactly ONE place — the DESIGN stage prompt (`prompts/design.md`, `prompts/design-extract.md`), as background prose via `src/dispatch/prompt-vars.ts:36,49`. They are NEVER read by implement or verify, and NOTHING branches on their value (only `=== "unknown"` presence checks in `src/cli/setup.ts:28,38`, which build a non-blocking "operator may fill in" hint). The machinery that actually makes verify build-and-test a Python vs a JS repo is a SEPARATE layer — the detected components' `commands.build/test/check` (`src/dispatch/components.ts`, `src/setup/lang/*.ts`, `src/setup/resolve-commands.ts`), which is the real polyglot wiring and is NOT touched by this plan. Consequences: (a) setting `type`/`mechanism` to `unknown` is safe and non-cascading — the design agent still gets the surviving `detail` prose (e.g. "published to PyPI"); (b) the enum broadening is descriptive polish (a clean one-word signal + tidy analytics for common cases), NOT a prerequisite for design/implement/verify to "handle" the type — there is nothing to wire up because nothing branches. This is WHY the vocabulary is kept MODEST (operator decision): only the values the pilot corpora produce + the clearly in-arc language registries; speculative channel/artifact values (`docker-image`, `github-release`) are omitted — under fail-soft they'd degrade gracefully anyway, so they earn their place only if a real repo needs them.

## Global Constraints

- Work on branch `feat/polyglot-setup` (current tip `a2406a4`); commit each task; do NOT commit to `main`.
- Enums stay a CONTROLLED vocabulary — never accept arbitrary strings INTO the profile. `.catch(undefined)` coerces an out-of-enum value to `undefined` (→ `unknown`); it never admits the raw string. Output vocab stays exactly as controlled as today; only the failure mode changes from crash to graceful-degrade. New enum values are additive only; never remove or rename an existing value.
- `.catch(undefined)` is scoped to `type`/`mechanism` ONLY. Genuinely malformed sidecars (bad JSON, a whole missing section) MUST still fail→retry — those paths must stay untouched.
- Enum additions must introduce NO control-flow branch on the new values (verified at plan time: only `=== "unknown"` in `src/cli/setup.ts:28,38` + informational injection in `src/dispatch/prompt-vars.ts:36,49`; `src/telemetry/analytics/properties.ts:92` emits `topology_type` raw to PostHog — a new analytics dimension value, benign, not a branch). Keep it true.
- Test runner is `bun test`. Prompt templates import as text: `import tpl from "../../prompts/setup-enrich.md" with { type: "text" }` (same as `src/setup/enrich.ts:1`).
- Merge-test fixture helpers are `scan(o) = RuntimeContextSchema.parse(o)` and `enr(o) = EnrichmentSchema.parse(o)`, with a `fullEnrichment` object carrying all 7 keys (`test/setup/enrichment-merge.test.ts:6-16`). Reuse them; do NOT invent `makeScan`/`makeEnrichment`.

## The exact vocabulary to add

`ReleaseMechanismEnum` — append (before `"none"`): `pypi`, `conda`, `npm`, `cargo`, `gem`, `composer`, `maven`, `go-module`. (`composer` covers PHP — a first-class detector in this arc, `src/setup/lang/php.ts`.)
`TopologyTypeEnum` — append (before `"cli"`): `browser-extension`.

MODEST scope (operator decision): the values the pilot corpora produce (Python→pypi/conda, JS/TS→npm; darkreader→browser-extension) plus the clearly in-arc language registries styre's own detectors target (Rust→cargo, Ruby→gem, PHP→composer, JVM→maven, Go→go-module). Deliberately OMIT the speculative channel/artifact values `docker-image` / `github-release` — they aren't a language registry, and under Task 1's fail-soft an uncovered value degrades gracefully to `unknown` (detail preserved), so they can be added later iff a real repo needs them. Under fail-soft, over-listing is harmless and under-listing degrades gracefully — so the bias is toward the smaller, principled list.

---

### Task 1 (CRASH-KILLER): fail-soft schema + broadened enums

**Files:**
- Modify: `src/dispatch/profile.ts` (the `TopologyTypeEnum` block, lines ~5-15, and `ReleaseMechanismEnum` block, lines ~16-23)
- Modify: `src/setup/enrichment-schema.ts` (the `topologySection` / `releaseSection` field declarations)
- Test: `test/dispatch/profile.test.ts` (enum members) and `test/setup/enrichment-schema.test.ts` (CREATE — fail-soft + round-trip)

**Interfaces:**
- Produces: `TopologyTypeEnum` includes `"browser-extension"`; `ReleaseMechanismEnum` includes the 10 new mechanisms. `EnrichmentSchema.safeParse` on a section whose `type`/`mechanism` is out-of-enum SUCCEEDS with that field `undefined` and `detail` preserved.

- [ ] **Step 1: Write the failing enum test**

Add to `test/dispatch/profile.test.ts`:

```ts
import { ReleaseMechanismEnum, TopologyTypeEnum } from "../../src/dispatch/profile.ts";

describe("enum vocabulary covers polyglot ecosystems", () => {
  test("ReleaseMechanismEnum accepts the polyglot mechanisms and keeps the originals", () => {
    for (const m of [
      "pypi", "conda", "npm", "cargo", "gem", "composer", "maven", "go-module",
      "semantic-release", "app-store", "installer", "signed-binary", "none", "unknown",
    ]) {
      expect(ReleaseMechanismEnum.parse(m)).toBe(m);
    }
  });
  test("TopologyTypeEnum accepts browser-extension and keeps the originals", () => {
    for (const t of [
      "browser-extension", "web-service", "web-n-tier", "desktop",
      "mobile-ios", "mobile-android", "cli", "library", "hybrid", "unknown",
    ]) {
      expect(TopologyTypeEnum.parse(t)).toBe(t);
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`bun test test/dispatch/profile.test.ts` → `parse("pypi")` throws).

- [ ] **Step 3: Broaden the enums**

In `src/dispatch/profile.ts` replace the two `z.enum([...])` declarations:

```ts
export const TopologyTypeEnum = z.enum([
  "web-service",
  "web-n-tier",
  "desktop",
  "mobile-ios",
  "mobile-android",
  "browser-extension",
  "cli",
  "library",
  "hybrid",
  "unknown",
]);
export const ReleaseMechanismEnum = z.enum([
  "semantic-release",
  "app-store",
  "installer",
  "signed-binary",
  "pypi",
  "conda",
  "npm",
  "cargo",
  "gem",
  "composer",
  "maven",
  "go-module",
  "none",
  "unknown",
]);
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Write the failing fail-soft/round-trip test**

Create `test/setup/enrichment-schema.test.ts`:

```ts
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
```

- [ ] **Step 6: Run it — expect FAIL** (`test 1` fails: `mechanism: "homebrew-tap"` currently rejects the whole section → `parsed.success === false`).

- [ ] **Step 7: Make the schema fail soft**

In `src/setup/enrichment-schema.ts`, change ONLY the `type` and `mechanism` fields:

```ts
const topologySection = z.object({
  type: TopologyTypeEnum.optional().catch(undefined),
  detail: z.string().default(""),
});
const releaseSection = z.object({
  mechanism: ReleaseMechanismEnum.optional().catch(undefined),
  detail: z.string().default(""),
});
```

Leave every other section (`triSection`, `dataSection`) and the top-level `EnrichmentSchema` object untouched — a whole missing section must still fail.

- [ ] **Step 8: Run it — expect PASS** (`bun test test/setup/enrichment-schema.test.ts`).

- [ ] **Step 9: Full suite** — `bun test` → PASS (additions are downstream-inert; no test pins the old enum set).

- [ ] **Step 10: Commit**

```bash
git add src/dispatch/profile.ts src/setup/enrichment-schema.ts test/dispatch/profile.test.ts test/setup/enrichment-schema.test.ts
git commit -m "fix(setup): enrichment schema fails soft on out-of-enum topology/release + broaden polyglot vocab

An out-of-enum type/mechanism now coerces to undefined (-> merge's ?? unknown),
preserving the section's detail prose and the other 6 sections, instead of failing
the whole EnrichmentSchema parse and crashing styre setup after 3 retries. Enums
broadened additively (pypi/conda/npm/cargo/gem/composer/maven/go-module/
docker-image/github-release; browser-extension) so common ecosystems resolve to a
real value. Verified nothing branches on the specific enum values."
```

---

### Task 2: merge honors a new-vocabulary agent proposal (test-only)

**Files:**
- Test: `test/setup/enrichment-merge.test.ts`

**Interfaces:** consumes `mergeScanAndEnrichment` (unchanged) + Task 1's enums. Test-only — proves the merge already resolves the new-vocab values for `unknown` sections. Do NOT re-test "resolved scan wins" — already covered at `test/setup/enrichment-merge.test.ts:61` ("topology.type and releasePackaging.mechanism follow the same rule").

- [ ] **Step 1: Add the tests** (using the file's real `scan`/`enr`/`fullEnrichment` helpers):

```ts
test("agent's pypi proposal fills an unknown release scan section (new vocabulary)", () => {
  const m = mergeScanAndEnrichment(
    scan({ releasePackaging: { mechanism: "unknown" } }),
    enr({ ...fullEnrichment, releasePackaging: { mechanism: "pypi", detail: "PyPI via pyproject.toml" } }),
  );
  expect(m.releasePackaging.mechanism).toBe("pypi");
  expect(m.releasePackaging.detail).toBe("PyPI via pyproject.toml");
});

test("agent's browser-extension proposal fills an unknown topology scan section (new vocabulary)", () => {
  const m = mergeScanAndEnrichment(
    scan({ topology: { type: "unknown" } }),
    enr({ ...fullEnrichment, topology: { type: "browser-extension", detail: "Chrome/Firefox extension" } }),
  );
  expect(m.topology.type).toBe("browser-extension");
});
```

- [ ] **Step 2: Run** — `bun test test/setup/enrichment-merge.test.ts` → PASS (Task 1 made the values valid; the merge already resolves `unknown` from the agent proposal).

- [ ] **Step 3: Commit**

```bash
git add test/setup/enrichment-merge.test.ts
git commit -m "test(setup): merge honors polyglot enrichment proposals (pypi, browser-extension) for unknown sections"
```

---

### Task 3 (CRUX — review on Opus): prompt lists the vocabulary + disambiguation + never-invent, with a robust drift guard

**Files:**
- Modify: `prompts/setup-enrich.md`
- Create: `test/setup/enrich-prompt-enums.test.ts`

**Interfaces:** consumes Task 1's enums + the prompt text. The behavior-critical task — makes the *common* path emit an in-vocab value. Review on Opus.

- [ ] **Step 1: Write the failing drift-guard test**

Create `test/setup/enrich-prompt-enums.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import setupEnrichTemplate from "../../prompts/setup-enrich.md" with { type: "text" };
import { ReleaseMechanismEnum, TopologyTypeEnum } from "../../src/dispatch/profile.ts";

describe("setup-enrich prompt lists the full enum vocabulary (drift guard)", () => {
  // Match the DELIMITED backtick-wrapped form `value`, not a bare substring — otherwise
  // "none"/"unknown" match the surrounding prose and the guard is vacuous.
  test("every TopologyTypeEnum value is listed (backtick-delimited) in the prompt", () => {
    for (const t of TopologyTypeEnum.options) {
      expect(setupEnrichTemplate).toContain(`\`${t}\``);
    }
  });
  test("every ReleaseMechanismEnum value is listed (backtick-delimited) in the prompt", () => {
    for (const m of ReleaseMechanismEnum.options) {
      expect(setupEnrichTemplate).toContain(`\`${m}\``);
    }
  });
  test("the prompt instructs never-invent + fail-soft to unknown, and a disambiguation rule", () => {
    expect(/never invent|must be exactly one of/i.test(setupEnrichTemplate)).toBe(true);
    expect(setupEnrichTemplate).toContain("`unknown`");
    expect(/prefer|precedence|if .*configured/i.test(setupEnrichTemplate)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (current prompt lists neither full set nor a never-invent/precedence rule).

- [ ] **Step 3: Rewrite the prompt paragraph**

In `prompts/setup-enrich.md`, replace the paragraph starting "For any section the scan marked `unknown`, investigate the repo…" with:

```markdown
For any section the scan marked `unknown`, investigate the repo and, if you can determine it, propose a value. For `presence` (data/caching/observability/configSecrets/documentation) use `present` or `absent`. For `topology` set `type`; for release/packaging set `mechanism`. Each of `type` and `mechanism` must be exactly one of the allowed values listed below — never invent a value outside the list. If none of the allowed values fit, use `unknown` and explain what you found in `detail`. Do NOT set presence/type/mechanism for sections the scan already resolved — only enrich their `detail`.

Allowed `topology.type` (choose exactly one, else `unknown`):
`web-service`, `web-n-tier`, `desktop`, `mobile-ios`, `mobile-android`, `browser-extension`, `cli`, `library`, `hybrid`, `unknown`.

Allowed `releasePackaging.mechanism` (choose exactly one, else `unknown`):
`semantic-release`, `app-store`, `installer`, `signed-binary`, `pypi`, `conda`, `npm`, `cargo`, `gem`, `composer`, `maven`, `go-module`, `none`, `unknown`.
When more than one could apply, prefer the release-automation tool if one is configured (e.g. `semantic-release`); otherwise name the target package registry (e.g. `pypi`, `npm`, `cargo`).
```

Keep the rest of the prompt (scan-results list, `detail` guidance, the fenced-block example, "Include all seven keys") unchanged.

- [ ] **Step 4: Run it — expect PASS** (`bun test test/setup/enrich-prompt-enums.test.ts`).

- [ ] **Step 5: Full suite** — `bun test` → PASS. In particular `test/setup/enrich.test.ts` still passes (it mocks runner stdout via the `sidecar()` helper at `:19` and asserts nothing about the prompt TEXT).

- [ ] **Step 6: Commit**

```bash
git add prompts/setup-enrich.md test/setup/enrich-prompt-enums.test.ts
git commit -m "feat(setup): enrich prompt lists allowed enum values + disambiguation + never-invent (fail-soft to unknown)"
```

---

## Self-Review

**1. Spec coverage:** schema fail-soft → Task 1 (crash-killer); broaden both enums incl. `composer` → Task 1; merge honors new vocab → Task 2; prompt lists vocab + precedence + never-invent → Task 3; drift guard (delimited) → Task 3; controlled vocab preserved → Task 1 constraint + fail-soft coerces (never admits raw strings); the crash-is-dead test → Task 1 Step 5. ✓

**2. Placeholder scan:** none — real code, exact paths, real fixture names (`scan`/`enr`/`fullEnrichment`), exact commands.

**3. Type consistency:** enum member strings identical across Task 1 (defs), Task 2 (`pypi`/`browser-extension` usage), Task 3 (prompt list + `.options` drift). `.optional().catch(undefined)` valid in zod 4.4.3. `.options` is Zod's readonly-tuple accessor for `z.enum`.

## Out of scope (flagged, not silently dropped)

- **Deterministic scan detection** of the new mechanisms (`pyproject.toml`→`pypi`, `Cargo.toml`→`cargo`, `composer.json`→`composer`, …) in `src/setup/detect-runtime.ts` — strictly-additive ground-truth work (ground truth > agent self-report), larger scope. Separate follow-up plan.

## Post-merge handoff (cross-repo, not a plan task)

After this lands on `feat/polyglot-setup`, re-pin styre-bench: set `styreCommit` in `styre-bench/config/bench.config.ts` to the new `feat/polyglot-setup` tip SHA (push first — the bench clones styre by SHA), so the bench validates styre WITH this fix.
