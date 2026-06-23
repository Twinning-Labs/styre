# Profile Runtime Context (CDOT) — Design

**Date:** 2026-06-23
**Branch:** `feat/profile-runtime-context`
**Status:** Approved design, ready for implementation planning
**Carries forward (legacy Harness tickets):** ENG-165 (schema), ENG-168 (probe), ENG-170 (re-probe/migration), ENG-172 (design forcing-function), ENG-175 (work-unit invariants), and the documentation-as-SDLC slice of ENG-195.

---

## 1. Problem

Styre's project profile carries build/test/lint/typecheck commands and a little repo shape, but it is **blind to runtime context** — databases and migrations, caching, observability/telemetry, configuration/secrets/permissions, release/packaging, deployment topology, and documentation conventions. Because the profile is the per-project source of truth threaded into every design/implement/verify/review dispatch, that blindness propagates: the design stage never has to ask whether a change touches persistent data, needs a migration and rollback, requires cache invalidation, emits telemetry, or updates docs. These concerns ("CDOT" — caching, databases, observability, telemetry — plus documentation) are incidental, not systematic.

This design makes runtime context a **probed, profile-resident, daemon-gated** part of the loop, so the right concerns are forced onto every relevant change — and legitimately skipped on projects that don't have them (a CLI isn't made to invent a cache story).

## 2. Current state (grounding)

- **Profile** is a zod `ProfileSchema` (`src/dispatch/profile.ts`): `{ slug, targetRepo, defaultBranch, checksSystem, commands (flat map), promptVars, testFilePattern? }`. Stored at `~/.config/styre/<slug>/profile.json` (XDG), **not** in SQLite. No `schemaVersion`.
- **Produced** by `styre setup` → `probeProfile()` (`src/setup/probe.ts`, `src/setup/detect.ts`), which today only reads `package.json` scripts.
- **Consumed** by threading into zod-validated prompt templates via `promptVars` (design S1a/b/c, implement S2, review S5) and by verify (S3) reading `commands[checkType]`. `renderPrompt()` enforces a CL-PROFILE completeness gate.
- **Open-core seam:** the profile is a frozen public contract (build-operations.md §5). New fields are safe **only if** they carry zod `.default()` for back-compat.
- **Operator policy** lives in a separate `RuntimeConfig` layer (`src/config/runtime-config.ts`), never the profile. Profile = repo *shape* (what); RuntimeConfig = daemon *policy* (how).
- **Frozen loads to respect:** F4 (profile = source of build/test/tools/layout), A1 (verify gates on profile commands), DS-5 (`work_unit.kind` is open text from the profile's stack vocabulary — stack-agnostic, no hardcoded enums).

Two things translate differently from the legacy bash harness:
1. There is **no verbatim-append** of a markdown profile into prompts. Context reaches the agent through structured `promptVars`.
2. "Schema v3 markdown sections" becomes a **zod-schema extension**, not H2 markdown blocks.

## 3. Design decisions (approved)

| # | Decision | Choice |
|---|----------|--------|
| D1 | How machine-actionable is the runtime context? | **Hybrid** — a typed flag the daemon gates on **plus** a free-text `detail` blob for the agent, per section. Both flags and prose reach the design agent; flags additionally gate. |
| D2 | How hard does the daemon enforce? | **Profile-consistency gate** — daemon enforces (a) coverage of every flagged section and (b) migration-unit ordering. It does **not** judge analysis quality. |
| D3 | Low-confidence handling | **Tri-state** present/absent/`unknown`, default `unknown`. `styre setup` **bubbles up** every `unknown` to the operator to fill in; unresolved `unknown` (headless / skipped) is treated by the gate as **must-address**. |
| D4 | Probe method | **Hybrid probe** — deterministic signal-scan sets the presence **flags** (evidence-grounded ground truth); a setup-time agent dispatch writes the **detail** prose and proposes flags only where the scan was `unknown`. |
| D5 | Documentation | A first-class runtime-context section, gated like the others, but **soft-nudge when `absent`**. Wires into Styre's existing `needs_docs` flag / `docs:revise` step — no parallel docs path. |
| D6 | Versioning / re-probe | Add `schemaVersion`; re-running `styre setup` upgrades in place via **merge-preserving** re-probe (probe-confident wins; operator-resolved values survive an `unknown` re-probe). `--reprobe` regenerates clean. |

## 4. Data model (ENG-165)

Added to `ProfileSchema`, all with `.default()` so existing on-disk profiles still validate (legacy profile → `schemaVersion` absent, `runtimeContext` all-`unknown`).

```ts
// reusable sub-schema for the present/absent/unknown sections
const triState = z.object({
  presence: z.enum(['present', 'absent', 'unknown']).default('unknown'),
  detail:   z.string().default(''),          // prose for the agent
}).default({});

const dataState = triState.extend({
  migrationTool: z.string().optional(),      // free-text, e.g. "prisma", "alembic" (DS-5: no enum)
});

// added to ProfileSchema:
schemaVersion: z.number().int().default(1),

runtimeContext: z.object({
  topology: z.object({
    type: z.enum([
      'web-service', 'web-n-tier', 'desktop', 'mobile-ios',
      'mobile-android', 'cli', 'library', 'hybrid', 'unknown',
    ]).default('unknown'),
    detail: z.string().default(''),          // deployables, modules, app surfaces
  }).default({}),
  data:          dataState,                  // present/absent/unknown + detail + migrationTool?
  caching:       triState,
  observability: triState,                   // logging / tracing / metrics
  configSecrets: triState,                   // env vars, flags, entitlements/capabilities
  documentation: triState,                   // docs location, format, changelog/ADR/API-doc conventions
  releasePackaging: z.object({
    mechanism: z.enum([
      'semantic-release', 'app-store', 'installer',
      'signed-binary', 'none', 'unknown',
    ]).default('unknown'),
    detail: z.string().default(''),
  }).default({}),
}).default({}),
```

**Gateable flags:** `topology.type`, `data.presence`, `caching.presence`, `observability.presence`, `configSecrets.presence`, `documentation.presence`, `releasePackaging.mechanism`.
**Prose (`detail`):** consumed by the design agent as context.

Deliberate calls:
- `unknown` is the **default**, so a probe that emits nothing fails toward "must-address," not silent skip.
- `migrationTool` is **free-text**, honoring DS-5's stack-agnostic intent.
- **No per-`kind` command map** here — that is ENG-169 (interface-contract), a separate ticket. This slice is runtime *context*, not command routing.
- `topology` and `releasePackaging` use a type/mechanism enum (with `unknown`) rather than `triState`, because they aren't present/absent concepts.

## 5. Producer / probe (ENG-168)

`probeProfile()` is extended to populate the seven `runtimeContext` sections. It never reads secret files (keep the existing `.env*` / `secrets.env` exclusion — only `.env.example` *keys*, never values).

**Hybrid method (D4):**
1. **Deterministic signal-scan** sets presence flags from hard evidence (trustworthy for gating).
2. **Setup-time agent dispatch** writes the `detail` prose and proposes flags only where the scan returned `unknown`.

Illustrative signals (not exhaustive):

| Section | Hard signals → `present` + detail |
|---|---|
| topology | `package.json`→web/node; `Cargo.toml`+`tauri.conf.json`→desktop; `*.xcodeproj`/`Podfile`→mobile-ios; `build.gradle`+android→mobile-android; lib without app entrypoint→library; several→hybrid |
| data | `migrations/`, `prisma/schema.prisma`, `alembic.ini`, ORM/driver deps (prisma, drizzle, typeorm, sqlx, sqlalchemy, pg, better-sqlite3) → also sets `migrationTool` |
| caching | redis/ioredis/memcached deps, cache-header/CDN config |
| observability | logging libs (pino, winston), `@opentelemetry/*`, Sentry, Prometheus, Datadog |
| configSecrets | `process.env` usage, `.env.example` keys (not values), flag libs, Tauri capabilities / iOS entitlements |
| documentation | `docs/`, README, `mkdocs.yml`/docusaurus, `CHANGELOG.md`, ADR dir, typedoc/openapi config |
| releasePackaging | semantic-release config, `release.yml`, electron-builder/tauri bundle, fastlane, signing config |

**Confidence rule:** hard signal → `present` with detail; plausible-but-unconfirmed → `unknown`; `absent` only when the probe can be sure (default stays `unknown`).

**Bubble-up:** after probing, `styre setup` lists every `unknown` section and prompts the operator to resolve it (the legacy `<<NEEDS-INPUT:>>` behavior). Unresolved `unknown`s survive into the profile and are treated as must-address by the design gate — the headless safety net (`styre run` has no operator).

## 6. Design forcing function + work-unit invariants (ENG-172 + ENG-175)

The daemon threads the profile flags+prose into the design prompt (`promptVars`: `runtime_data_presence`, `runtime_data_detail`, …) so the agent knows, as ground truth, which concerns are live.

**Design output addition** (zod, in the design-extract schema):

```ts
cdotImpact: z.object({
  data:          dataImpact,  // schema change? migration path? rollback? zero-downtime?
  caching:       impact,      // what's cached, key shape, TTL, invalidation
  observability: impact,      // log levels + payload, metrics/spans, PII
  configSecrets: impact,      // env vars, flags, entitlements
  documentation: impact,      // which docs change
}),
// impact = { applies: boolean, analysis: z.string() }
//   applies:false → analysis must state the reason ("N/A — no cache, per profile")
//   applies:true  → analysis must be non-empty
//
// dataImpact = impact + { schemaChange: boolean }
//   schemaChange is the STRUCTURED signal the migration-ordering gate computes on —
//   the daemon must not infer "is this a schema change?" from prose.
```

**Profile-consistency gate** — deterministic daemon check, runs as a postcondition after design-extract and before design-review; failure → loopback to design:dispatch (bounded by loop counters; persistent failure escalates):

1. **Coverage** — for every profile section flagged `present` **or** `unknown`, the matching `cdotImpact` entry must be addressed (not blank). `absent` sections are not forced — except `documentation`, which still soft-nudges (D5).
2. **Migration ordering** — if `cdotImpact.data.schemaChange === true` (the structured signal, not prose), a migration work_unit (`kind` data/migration) must exist and domain-logic units must `depends_on` it.
3. **Docs routing** — if `documentation` applies, set the existing `needs_docs` flag (no new path). Verified hooks: `ticket.needs_docs` (`src/db/schema.sql:107`, "set by design (S1)"), `setNeedsDocs()` (`src/db/repos/ticket.ts:92`), and the resolver dispatch of the `docs:revise` step when `needs_docs === 1` (`src/daemon/resolver.ts:129-130`).

**Enforced vs prompted split** (consequence of D2 — daemon gates only what it can compute from state without judging quality):

| ENG-175 invariant | Where it lands | Why |
|---|---|---|
| Migration task ordered before domain logic | **Daemon-enforced** (gate rule 2) | State-computable graph check; no judgment. |
| Telemetry step on every task | **Prompt-level** | "Adequate telemetry?" needs quality judgment → would be gameable theater or self-scored grading (rejected by move 5). |
| Failure-mode→test map per boundary | **Prompt-level** | Needs knowing all boundaries + judging test adequacy. Not state-computable. Verify/S3 runs whatever tests exist as a backstop. |

The prompted concerns are not dropped — their **enforcement** is deferred to the review persona (ENG-176, out of scope), with verify/S3 as a ground-truth backstop. The daemon never grades analysis quality, only presence and structural consistency. This keeps the design true to "ground truth over self-report" and avoids subjective loopback churn / escalations.

## 7. Versioning & re-probe / migration (ENG-170)

- Add top-level `schemaVersion`. All new fields carry `.default()`, so an existing on-disk `profile.json` loads and validates (legacy → `schemaVersion` absent, `runtimeContext` all-`unknown`). No break for current users.
- "Re-backfill to v3" maps onto Styre's idempotent `styre setup`: re-running re-probes and upgrades the profile in place. Re-probe **is** the upgrade — no separate migration machinery.
- **Merge-preserving re-probe** so an idempotent re-run never destroys hand-entered context:
  - probe confident (`present` + hard signal) → probe wins (update flag + detail);
  - probe `unknown` but existing profile operator-resolved → keep existing;
  - `styre setup --reprobe` → full clean regeneration.

## 8. Testing strategy

- **Schema** — legacy `profile.json` (no `runtimeContext`) validates as all-`unknown`; v1 round-trips; `.default()`s apply. Guards the open-core seam.
- **Probe** — fixture repos (Node+Prisma+Redis, CLI, library, Tauri desktop) assert correct flags + the bubble-up list. Deterministic signal→flag scan unit-tested directly; agent-prose half mocked (hermetic tests).
- **Gate** — design-extract postcondition tests: blank flagged section → fail/loopback; schema change without ordered migration unit → fail; with one → pass; `documentation.applies` → `needs_docs` set. Matrix: `absent`→not forced, `unknown`→forced, docs-`absent`→soft-nudge only.
- **Re-probe merge** — operator-resolved value survives an `unknown` re-probe; probe-confident overwrites; `--reprobe` regenerates clean.
- **Back-compat** — existing consumers (prompt-vars, verify) unaffected when `runtimeContext` is present.

## 9. Out of scope (pointers)

- **ENG-169** — per-`kind` command routing / interface-contract types. Separate ticket.
- **ENG-176** — reviewer personas that *judge* telemetry/failure-map quality. Where the prompted invariants eventually harden.
- **ENG-177** — generalizing the **release stage** behavior. This spec only *probes* `releasePackaging` into the profile; it does not touch merge→released.
- Per-ticket `styre_config` — plane-owned, deferred (OSS/commercial boundary).
- `RuntimeConfig` is untouched — `runtimeContext` is repo *shape* (profile), never operator *policy*.

## 10. Open-core / invariant compliance

- **Profile seam stays stable** — additive fields only, all `.default()`-guarded.
- **DS-5 honored** — `migrationTool` and stack vocabulary stay free-text; no hardcoded stack enums beyond the coarse `topology.type`/`releasePackaging.mechanism` lists (which include `unknown`/`hybrid` escape hatches).
- **Ground truth over self-report** — the daemon gates only on state-computable facts; quality judgment is deferred to review.
- **Profile vs RuntimeConfig boundary** — preserved; nothing operator-policy enters the profile.
