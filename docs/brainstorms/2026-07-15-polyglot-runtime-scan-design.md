# Manifest dependency lists as enrichment context

**Date:** 2026-07-15
**Status:** Design approved (v2, post independent review); plan next
**Branch:** `feat/polyglot-runtime-scan`

> **v2 note.** The original design (a per-language *deterministic* runtime scan with curated
> dep→dimension tables) was rejected by an independent adversarial review panel. This document
> now specifies the approach that survived. The rejected approach and *why* it was rejected are
> preserved at the end ("Superseded approach") so the decision trail stays legible.

## Problem

`detectRuntimeContext` (`src/setup/detect-runtime.ts`) is Node-biased by construction. Its only
input is `readPkgDeps`, which reads **only** `package.json`; every capability signal
(`data`/`caching`/`observability`/`configSecrets`) is an npm-package-name lookup against that
map. Non-Node stacks get only a few file-marker checks and otherwise fall through to `unknown`.

Styre has first-class **component** detectors for 7 languages (Rust, Node, Python, Go,
JVM-Maven/Gradle, Ruby, PHP), but the **runtime-context** scan only understands one of them.

## What the runtime scan is actually for (verified against code)

The runtime scan is **not** control-flow. `profile.runtimeContext` is read in exactly these
places:

1. `runtimeVars` (`src/dispatch/prompt-vars.ts:38`) → `runtime_*` prompt prose for design/extract.
2. `validateCdotImpact` (`src/dispatch/extract-schema.ts:60`) → coverage gate. It forces the
   extract agent to write `cdotImpact.<section>.analysis` for any of
   `data/caching/observability/configSecrets/documentation` whose `presence` is `present`
   **or** `unknown`. Only `absent` relaxes the gate.
3. `unknownRuntimeSections` (`src/cli/setup.ts:26`) → the operator NEEDS-INPUT nudge (reads the
   presences, `topology.type`, and `releasePackaging.mechanism`).
4. `enrichVars` (`src/setup/enrich.ts:25`) → seeds the mandatory enrichment LLM prompt.

Two facts drive this design:

- **`present` and `unknown` are treated identically by the only gate.** The deterministic scan
  can never emit `absent` (`flag()`, `detect-runtime.ts:24`). So a *missed* dimension degrades to
  "unknown → agent still forced to look", never a silent omission.
- **There is already a mandatory, language-agnostic LLM backstop.** `enrich.ts` runs on every
  setup, is given Read/Grep/Glob over the repo, and fills every dimension the scan left
  `unknown` (`mergeScanAndEnrichment`, `merge.ts:43`: scan wins unless `unknown`, then the agent
  proposal is used).

**Consequence:** the enrichment LLM already resolves non-Node repos. The residual gap is narrow:
the LLM occasionally **false-`absent`s** a capability that is genuinely present, because it had
to *discover* dependencies by globbing the repo rather than being handed them. That single
failure — a false-absent on a gated dimension for a non-Node language — is the only thing worth
closing, and it is closed by giving the LLM better input, not by second-guessing it
deterministically.

## Decision

**Feed the raw manifest dependency lists into the existing enrichment prompt as context.** Parse
each manifest for its dependency *names only* (no curated dimension tables, no identifier-form
normalization, no presence classification) and hand that list to the enrichment agent as
additional context. The LLM then matches dependencies to capability dimensions semantically —
which is exactly what suppresses false-absent.

This was chosen over a deterministic per-language scan (the original v1 design) because
determinism buys almost nothing here (the gate treats `present`==`unknown`; the LLM overwrites
prompt `detail` anyway) while a *wrong* deterministic `present` is unrecoverable (it beats the
LLM via `merge.ts:43`, beats an operator hand-edit on re-probe via `mergeTri`, and destroys the
gate's only `absent` relief valve). See "Superseded approach".

### What this design explicitly does NOT do

- **No curated dep→dimension tables** (no rot, no per-ecosystem maintenance surface).
- **No `releasePackaging.mechanism` inference** (dropped per decision — near-zero value at any
  consumer, and manifest-type inference produces outright-wrong labels: e.g. `Gemfile`→`gem` for
  every Rails app, `pyproject [build-system]`→`pypi` for every PEP-518 app).
- **No change to `detectRuntimeContext`.** The existing Node deterministic scan stays exactly as
  is. This design is **purely additive**: a new context input to the enrichment prompt.
- **No schema change, no gate change, no merge-precedence change.** The dependency list is
  ephemeral prompt input; it is not persisted as a `runtimeContext` field.

## Invariants preserved

- **Never assert `absent` from parsed deps.** The dep list is framed to the LLM as *incomplete
  evidence*: presence of a library is a signal; **absence from the list is NOT evidence a
  capability is missing** (the parser may not cover that manifest form). This keeps the
  enrichment prompt's existing "if unsure, leave `unknown`, never guess" discipline intact.
- **No new unrecoverable state.** Because nothing here emits a deterministic `present`, there is
  no false-`present` that the LLM or operator cannot override. The list only *informs* the LLM,
  which remains free to disagree with it.

## Architecture

New directory `src/setup/runtime-deps/` (additive; `detect-runtime.ts` untouched).

### 1. `deps/` — dependency-name parsers (names only, fail-soft)

Each parser returns a list of raw dependency identifiers for one manifest format; on any parse
error it returns `[]` (matching `readPkgDeps`'s fail-soft style). Because the **LLM** consumes
these (not an exact-string table match), the correctness bar is low: a junk identifier is cheap
(the model ignores it) and a missed one falls back to today's behavior (the model globs the
repo). This is the key simplification the pivot unlocks.

| Parser | Reads | How |
| --- | --- | --- |
| `node` | `package.json` | keys of `dependencies` + `devDependencies` (reuse `readPkgDeps`) |
| `cargo` | `Cargo.toml` | **`Bun.TOML.parse`**, keys of `[dependencies]`/`[dev-dependencies]`/`[build-dependencies]` |
| `python` | `pyproject.toml`, `requirements.txt` | **`Bun.TOML.parse`** for `[project].dependencies` (PEP 508 → leading name token) + `[tool.poetry.dependencies]` keys (filter `python`); requirements.txt: skip `-`/URL/`@` lines, take leading `[A-Za-z0-9._-]+` token |
| `go` | `go.mod` | `require` block + single-line requires (module paths) |
| `ruby` | `Gemfile` | `gem "…"` lines |
| `php` | `composer.json` | `JSON.parse`, keys of `require`/`require-dev` |
| `jvm` | `pom.xml`, `build.gradle[.kts]`, `gradle/libs.versions.toml` | pom: slice `<dependencies>` then per-`<dependency>` `groupId:artifactId`; gradle: `implementation`/`api` coordinate lines; `libs.versions.toml` via `Bun.TOML.parse` |

**Use `Bun.TOML.parse` (Bun 1.3.5, built-in, zero-dep) for all TOML** — do NOT hand-roll TOML
regex. (The v1 design wrongly cited `rust.ts`/`python.ts` as precedent for regex-parsing dep
tables; they only parse a single scalar / test section presence.)

A `parseManifestDeps(path)` dispatcher keyed by filename returns the name list. Parser fidelity
is best-effort: cover the common forms, don't chase every edge case — the LLM backstops misses.

### 2. `collectManifestDeps(repoDir)` — orchestrator

`findManifests` (reuse `src/setup/manifests.ts`, already skips vendored dirs, depth ≤ 3) → parse
each → return a per-language-labeled, deduped map, e.g.
`{ python: ["sqlalchemy", "alembic", …], node: ["prisma", …] }`. Deduplicate across manifests;
cap total size to bound prompt growth on large monorepos (see Risks).

### 3. Enrichment-prompt integration (the only touched pipeline surface)

- `enrichVars` (`src/setup/enrich.ts:25`) gains one field carrying the rendered dependency list.
- `prompts/setup-enrich.md` gains a section that presents the list with explicit framing:
  *"Dependencies found in the repo's manifests (may be incomplete). Use them to inform your
  capability assessment. A capability's libraries appearing here is positive evidence; their
  **absence from this list is not evidence the capability is missing** — investigate the repo as
  usual and leave `unknown` if you cannot tell."*

Nothing else in the pipeline changes: `validateCdotImpact`, `runtimeVars`,
`unknownRuntimeSections`, and `mergeScanAndEnrichment` are all untouched.

## Testing

- **Per parser** — fixture manifests → assert extracted name lists, incl. the known-tricky forms
  (`Bun.TOML` inline/sub-tables; PEP 508 strings; poetry `python` filtered out; requirements
  `-r`/`-e`/URL lines skipped; go module paths; pom `<plugin>`/`<parent>` excluded by
  `<dependencies>`-scoping; gradle version-catalog aliases resolved). Fail-soft: malformed
  manifest → `[]`.
- **Orchestrator** — polyglot fixture (node + python) → both languages present, deduped.
- **`enrichVars`** — includes the dependency-list field; empty repo → empty/omitted, prompt still
  renders.
- No gate/merge/schema tests needed (those surfaces are unchanged).

## Risks

- **Prompt bloat on large monorepos.** Many manifests × many deps could enlarge the enrichment
  prompt. Mitigate by deduping across manifests and capping total identifiers (a simple cap is
  fine; the list is a hint, not an exhaustive contract).
- **Parser junk / misses.** Low cost by construction: the LLM tolerates noise and falls back to
  repo investigation for anything missing. This is the whole point of the pivot — parser
  correctness is no longer load-bearing.

## Downstream references (unchanged, for context)

- `src/dispatch/profile.ts` — `RuntimeContext` schema (unchanged; nothing new persisted).
- `src/dispatch/extract-schema.ts` — `validateCdotImpact` gate (unchanged).
- `src/setup/merge.ts` — enrichment merge precedence (unchanged).
- `src/setup/enrich.ts`, `prompts/setup-enrich.md` — the only surfaces this design touches.

---

## Superseded approach (v1 — rejected by independent review)

**v1 proposed:** a deterministic per-language runtime scan — one dep parser per manifest **plus**
curated `dimension → { language → [library names] }` tables, matching parsed deps against the
tables to emit `present` flags for all 7 languages, plus `releasePackaging.mechanism` inferred
from manifest type. Architecture: mechanism/knowledge/orchestration split ("Approach C").

**Why it was rejected (independent adversarial panel, all findings code-grounded):**

1. **Optimized against the wrong failure.** v1's risk analysis only considered false-*absent*
   (backstopped by enrichment). But its new glob/module-path/coordinate matching across 6
   ecosystems raises the false-*present* rate — and a false-`present` is **unrecoverable**: it
   beats the LLM (`merge.ts:43`), beats an operator hand-edit on re-probe (`mergeTri`,
   `merge.ts:7`), and destroys the gate's only `absent` relief valve (`extract-schema.ts:74`),
   permanently forcing analysis for a capability the repo lacks.
2. **Weak premise.** Given the two consumers, a deterministic `present` buys ~nothing over
   `unknown` (gate treats them identically; LLM overwrites prompt detail). The curated tables are
   strongest exactly where the LLM is already reliable (common libs) and empty where it is weak
   (obscure libs) — a maintenance surface defending the cases that least need it.
3. **Two release rules outright wrong** for the common case: `Gemfile`→`gem` (every Rails app),
   `pyproject [build-system]`→`pypi` (every PEP-518 app). `releasePackaging` inference dropped.
4. **Factual errors in the doc:** "only two downstream consumers" (missed `unknownRuntimeSections`
   in `src/cli/setup.ts`, so "no pipeline change" was false); "rust.ts/python.ts already
   regex-parse TOML deps" (they parse a scalar / section presence, not dep tables).
5. **Self-inflicted mechanism.** "Regex TOML, no heavy deps" ignored that Bun 1.3.5 ships
   `Bun.TOML.parse`; and per-ecosystem identifier matching (Go `/v2` + sub-modules, Maven
   plugin/parent/BOM over-report, Gradle version catalogs in `libs.versions.toml`) was under-
   specified and would have silently under/over-fired.

The v2 approach above keeps the *goal that survived* — reduce LLM false-absent on non-Node repos
— while discarding the deterministic machinery that carried all the risk.
