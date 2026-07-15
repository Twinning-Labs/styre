# Per-language runtime-context scan

**Date:** 2026-07-15
**Status:** Design approved; plan next
**Branch:** `feat/polyglot-runtime-scan`

## Problem

`detectRuntimeContext` (`src/setup/detect-runtime.ts`) is Node-biased by construction.
Its primary input is `readPkgDeps`, which reads **only** `package.json`, and nearly every
capability signal (`data` / `caching` / `observability` / `configSecrets`, plus the
dep-derived slice of `releasePackaging`) is an npm-package-name lookup against that dep map
(`has(deps, [...])`). Non-Node stacks get only a handful of language-agnostic file-marker
checks (`alembic.ini`, `Cargo.toml`, Tauri config, generic `migrations/` dirs, `mkdocs.yml`,
`docs/`) and otherwise fall through to `unknown`.

Styre has first-class **component** detectors for 7 languages (Rust, Node, Python, Go,
JVM-Maven/Gradle, Ruby, PHP), but the **runtime-context** scan only understands one of them.

## Why it still (mostly) works today, and what the scan is actually for

The runtime scan is **not** control-flow. Its output (`profile.runtimeContext`) does exactly
two things downstream:

1. **Seeds prose context** into the design/extract agent prompts, via `runtimeVars`
   (`src/dispatch/prompt-vars.ts`) → `runtime_*` template vars.
2. **Drives a coverage gate**: `validateCdotImpact` (`src/dispatch/extract-schema.ts`)
   requires the extract agent to write `cdotImpact.<section>.analysis` for any of
   `data / caching / observability / configSecrets / documentation` whose `presence` is
   `present` **or** `unknown`. (`releasePackaging` and `topology` are not gated.)

Because the gate treats `present` and `unknown` identically, a *missed* dimension degrades
to "unknown → agent still forced to look", not silent omission. And the deterministic scan
**never emits `absent`** — `flag()` returns only `present` or `unknown`. Finally, a mandatory
LLM **enrichment** pass (`src/setup/enrich.ts`) reads the actual repo and fills every
dimension the scan left `unknown` (merge rule in `mergeScanAndEnrichment`: scan wins unless
scan is `unknown`, then the agent proposal is used).

**Consequence:** the Node bias is already partially compensated by enrichment. So the goal of
this work is **not** correctness — it is to provide **deterministic ground-truth flags the
enrichment LLM cannot override** for the other 6 languages, reducing reliance on a
nondeterministic, cost-bearing, failure-prone LLM pass for facts we can read straight from a
manifest.

## Decisions (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| **Goal** | Deterministic ground truth (LLM-unoverridable flags), not cheaper setup or richer prompts per se |
| **Language scope** | All 7 component-supported languages: Node (existing) + Rust, Python, Go, JVM, Ruby, PHP |
| **Architecture** | Split mechanism / knowledge / orchestration (Approach C) |
| **Dimension scope** | Dep-table tri-state dims (`data`, `caching`, `observability`, `configSecrets`) for all 7 langs, **plus** deterministic `releasePackaging.mechanism` from manifest type. `topology` and `documentation` left as-is. |

Approaches considered and rejected:
- **A — parallel per-language registry** (mirror the `LangDef` component registry with a
  `RuntimeSignalDef` per language). Consistent with the existing pattern, but adds a second
  language list to keep in sync with the component registry.
- **B — fold runtime signals into the component detectors.** One manifest walk, but couples
  command-detection and capability-sensing into one unit, bloats `ComponentDraft`, and forces
  repo-level signals into a per-manifest shape. Rejected.

## Invariants to preserve (load-bearing)

- **Never guess `absent`.** Keep `flag()` present/unknown-only semantics. An unrecognized dep
  might be a library the tables don't know yet; leaving it `unknown` keeps enrichment as the
  backstop. Only a false-`absent` would be genuinely lossy — so we never emit it.
- **No schema change.** `TriStateSchema` / `DataStateSchema` / `RuntimeContext` in
  `src/dispatch/profile.ts` are unchanged. We fill existing fields better; we do not add
  fields. (Avoids the dual-`schema.sql` edit requirement entirely — no SQL touched.)
- **No downstream pipeline change.** `enrich.ts`, `mergeScanAndEnrichment`, and
  `validateCdotImpact` are untouched. The scan simply returns more `present` values, which win
  over LLM proposals via the existing merge precedence.
- **Runtime scan does not depend on component-detection internals.** It does its own manifest
  walk (reusing the shared `findManifests` helper), so the two subsystems stay decoupled.

## Architecture (Approach C: mechanism / knowledge / orchestration)

New directory `src/setup/runtime/`, replacing the monolithic `detect-runtime.ts`.

### 1. `deps/` — mechanical dep parsers (one per manifest format)

Each parser is fail-soft (parse error → empty set, matching `readPkgDeps`) and adds **no new
heavy dependencies** — it uses regex/section parsing consistent with the existing code
(`rust.ts`/`python.ts` already regex TOML; `php.ts` uses `JSON.parse`).

| Parser | Reads | Extracts |
| --- | --- | --- |
| `node` | `package.json` | reuse existing `readPkgDeps` (`dependencies` + `devDependencies`) |
| `cargo` | `Cargo.toml` | `[dependencies]` / `[dev-dependencies]` / `[build-dependencies]` keys |
| `python` | `pyproject.toml`, `requirements.txt` | `[project].dependencies` + `[project.optional-dependencies]` + `[tool.poetry.dependencies]`; requirements lines with version specifiers stripped |
| `go` | `go.mod` | `require (...)` block + single-line `require`s (module paths) |
| `ruby` | `Gemfile` | `gem "…"` lines |
| `php` | `composer.json` | `require` / `require-dev` keys |
| `jvm` | `pom.xml`, `build.gradle[.kts]` | pom `<groupId>`/`<artifactId>`; gradle `implementation "g:a:v"` lines |

A `parseManifestDeps(path)` dispatcher, keyed by filename, returns a **normalized
dep-identifier set**.

> **Correctness trap — identifier form differs per ecosystem.** npm name (`prisma`) vs. crate
> name (`diesel`) vs. go module path (`gorm.io/gorm`) vs. maven coordinate
> (`org.hibernate:hibernate-core`) vs. composer vendor/package (`doctrine/orm`). The signal
> tables MUST store the same form the corresponding parser emits. This is documented per
> language and covered by parser tests.

### 2. `tables.ts` — the curated knowledge (data-driven)

The existing Node tables move here alongside the new ones. Shape:

```ts
SIGNAL_TABLES: { [dimension]: { [language]: string[] } }
```

Illustrative (not exhaustive) entries:

- `data.python = ["sqlalchemy", "django", "alembic", "psycopg2", "asyncpg", "peewee", "tortoise-orm"]`
- `data.go = ["gorm.io/gorm", "github.com/jmoiron/sqlx", "entgo.io/ent"]`
- `data.rust = ["diesel", "sqlx", "sea-orm"]`
- `data.ruby = ["activerecord", "sequel"]`
- `data.php = ["doctrine/orm", "illuminate/database"]`
- `data.jvm = ["org.hibernate:*", "org.springframework.data:*"]`
- `observability.go = ["go.uber.org/zap", "github.com/sirupsen/logrus", "go.opentelemetry.io/otel"]`

Matching is exact by default, with **prefix/glob** support for JVM group wildcards
(`org.springframework.data:*`). This one file is the real maintenance surface; extending to an
8th language later is a table edit, not a new module.

### 3. `markers.ts`, `release.ts`, and the orchestrator

- **`markers.ts`** — generalize the language-agnostic file-marker checks beyond Node:
  migration dirs per ecosystem (`prisma/migrations`, alembic `versions/`, rails `db/migrate`,
  django/go `migrations/`), `.env.example`, docs markers, `mkdocs.yml`. (These largely exist
  already; this broadens them.)
- **`release.ts`** — `releasePackaging.mechanism` precedence:
  1. explicit release config first — `semantic-release` (dep/`.releaserc`), Tauri → `installer`;
  2. else, if **exactly one** language manifest type is present, infer from it: `Cargo.toml`→`cargo`,
     `go.mod`→`go-module`, `Gemfile`→`gem`, `composer.json`→`composer`, `pom.xml`→`maven`,
     `pyproject.toml` with a `[build-system]` → `pypi`;
  3. else (polyglot / ambiguous) → `unknown` (never guess).
- **Orchestrator (`index.ts`)** — `findManifests` (reuse `src/setup/manifests.ts`) → parse each
  manifest → match its deps against the tables per dimension → run marker checks → infer release
  → merge into one `RuntimeContext`.

### Merge / polyglot semantics

A repo can be polyglot (e.g. Node frontend + Python backend), so contributions from **all**
manifests are aggregated, never one-language-wins:

- Each dimension is `present` if **any** language table match **or** marker hit; else `unknown`.
  Never `absent`.
- `detail` = deduped list of matched library identifiers across languages.
- `data.migrationTool` derivation (currently prisma/alembic/drizzle/knex) is extended
  per language, best-effort (free-text field); if multiple, the most specific recognized tool
  wins.
- `topology` and `documentation` keep their existing logic.

## Testing

- **Per parser** — fixture manifests → assert extracted dep sets, including identifier-form
  edge cases (go module paths, maven coordinates, requirements version specifiers).
- **Per matching** — small fixture repos → assert expected `present` dims + details.
- **Polyglot fixture** — Node + Python repo → both contribute; merged detail.
- **Invariant test** — a repo whose deps are all unrecognized → dims stay `unknown`, never
  `absent`.
- **Release inference** — single-language repo → correct mechanism; polyglot/ambiguous →
  `unknown`.

## Risks

- **Curated tables lag real ecosystems.** Acceptable: enrichment backstops anything the tables
  miss; the tables only need to cover common libraries. They are versioned in one file for easy
  extension.
- **Identifier-form mismatch (go/maven/composer).** The main bug class; mitigated by
  co-designing each parser with its table and by explicit per-language parser tests.

## Downstream references (unchanged, for context)

- `src/dispatch/profile.ts` — `RuntimeContext` schema (7 dims; tri-state + enums).
- `src/dispatch/prompt-vars.ts` — `runtimeVars` → prompt injection.
- `src/dispatch/extract-schema.ts` — `validateCdotImpact` coverage gate.
- `src/setup/enrich.ts`, `src/setup/enrichment-schema.ts`, `src/setup/merge.ts` — LLM
  enrichment + merge precedence (the backstop this design leans on).
