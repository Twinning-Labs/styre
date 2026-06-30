# WO-5: file-identity routing + run-all safety — Implementation Plan (v3, two review rounds)

> **For agentic workers:** REQUIRED SUB-SKILL — **superpowers:subagent-driven-development**. Steps use checkbox (`- [ ]`). TDD: failing test → see it fail → implement → see it pass → lint + typecheck + full suite → commit. Full suite **green after each task**.

**Goal:** route changed files to stacks by **file identity** (extension + path), not folder alone, and apply the **run-more-when-unsure** safety rule so the mixed-diff *silent under-verify* (freeze §3, the cardinal sin) is killed. Three effects: (a) **interleaving fix** — `.py` under `src/` routes to Python, not a co-located `["**"]` frontend; (b) **mixed-diff safety** — a diff with any unowned non-docs file triggers a run of every *other* stack so the unowned change can't slip through silently; (c) **docs-skip** — an unowned docs file (`.md`/`.rst`) does not trigger the sweep.

## Decisions (operator) + the v2→v3 correctness fixes (two review rounds)

- **D1 — extensions materialized at setup + `schemaVersion` 2→3** (closes agent-kind-drift; profile self-describes routing; freeze §9.1/§10/§13 #3).
- **D2 — full safety rule + docs-skip** (kills the mixed-diff cardinal sin).
- **Algorithm fix (review S1/S2/S3) — hard gates vs advisory sweep.** The run-all must NOT feed the existing three-way resolve wholesale: that resolve throws a loud `absent` error for any *impacted* component lacking a command for a check-type (safe for forced `build/test/check`, but `verify_check_types` is unconstrained — e.g. `lint` — so run-all over all components would throw and **wedge the ticket**). Resolution, aligned with the freeze's T2 plane-split:
  - **Hard gates** run over **`realImpacted` only** (the stacks that own a changed file) — exactly today's three-way resolve + run + A1 behavioral gate. These can fail→loopback (the agent can iterate the code it touched to green).
  - **Advisory safety sweep:** when any unowned non-docs file is present, *also* run the **untouched** stacks' available gates as a precaution; their failures are **surfaced** (a new `ran-all-unowned` signal → a PR-body branch), **never a hard fail / loopback**. No `absent` error for swept stacks (skip missing commands). This kills the *silent* under-verify (the unowned change's effect is surfaced, never hidden) without wedging the agent on unrelated stacks' pre-existing red (review S3).
- **Compile fixes (review F1/F2/F3):** `LangDef.detect` returns `ComponentDraft` (extensions attached by the engine); `extMatches` is `undefined`-safe; five typed test fixtures gain `extensions: []`.

## Open risks carried

- **T1 cost (freeze §13 #1):** the advisory sweep runs untouched stacks on any unowned non-docs file — frequent in polyglot repos, un-costed. Docs-skip removes the worst waste; the over-budget branch + measurement is **WO-6**.
- **S4 residual (accepted):** executable doctests in `.md`/`.rst` are treated as docs → skipped (a narrow under-verify). Recorded; WO-6/rung-2 territory.

**Tech Stack:** TypeScript, Bun, Biome. `bun test` · `bun run lint` · `bun run typecheck`.

---

## Design

### Identity model (Task 2)
- **`ComponentSchema` gains `extensions: z.array(z.string()).default([])`**; `schemaVersion` → `z.literal(3).default(3)`. `parseProfile` adds a pre-parse `if (raw?.schemaVersion === 2) throw("…re-run styre setup to regenerate a schemaVersion-3 profile")`, mirroring the v1 `commands` rejection (`profile.ts:96`). (`.default(3)` only fires when the key is absent; a v2 profile carries `schemaVersion:2` → rejected. No silent upgrade.)
- **`LangDef.detect(): ComponentDraft[]`** where `type ComponentDraft = Omit<Component, "extensions">` (`lang/types.ts`). Detector impls are then genuinely unchanged. **`runRegistry`** (`detect-components.ts:22`, the `out.push({...c, paths})` site) attaches `extensions: [...(EXTENSIONS_BY_KIND[c.kind] ?? [])]` from the **detected** kind — before the agent runs. **`mergeComponents`** (`discover-schema.ts:37-44`) carries `extensions: s.extensions` (scan's; `DiscoverSchema` has no `extensions` field so the agent cannot set it). Post-merge `resolve-commands.ts:44`/`discover.ts:79` already `{...c}`-spread-preserve it.
- **`EXTENSIONS_BY_KIND`** (authoring source, `components.ts`):
  ```ts
  const NODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"];
  const JVM_EXTS = [".java", ".kt", ".kts", ".scala", ".groovy"];
  export const EXTENSIONS_BY_KIND: Record<string, readonly string[]> = {
    rust: [".rs"], node: NODE_EXTS, sveltekit: [...NODE_EXTS, ".svelte"],
    python: [".py", ".pyi"], go: [".go"],
    "jvm-maven": JVM_EXTS, "jvm-gradle": [...JVM_EXTS, ".gradle"],
  };
  ```
  Audited: no cross-contamination → a map error can only over-verify, never under. Unowned (→ sweep): `.json .yaml .yml .toml .xml .sql .sh .css .html .lock .mod`, extensionless, dotfiles.
- **`matchesComponent(c, file)` = `extMatches(c, file) && c.paths.some(g => new Bun.Glob(g).match(file))`**, with **undefined-safe** `extMatches`:
  ```ts
  export function extMatches(c, file) {
    const exts = c.extensions ?? [];           // undefined (fixtures) treated as []
    if (exts.length === 0) return true;          // unmapped/custom kind → path-only (no regression)
    return exts.includes(extname(file).toLowerCase());
  }
  ```

### The verify algorithm (Task 1)
`isDocsFile(f)` = `extname(f).toLowerCase()` ∈ `{.md, .markdown, .rst, .adoc}` (conservative prose-only; `CHANGELOG` with no ext is NOT docs → swept, safe).

```
changed = diff(base..head)
if changed.length === 0      → error "empty-diff"             (unchanged)
if components.length === 0   → error "no-components-detected"  (unchanged intent)

owned          = changed.filter(f => components.some(c => matchesComponent(c, f)))
realImpacted   = impactedComponents(components, owned)
unownedNonDocs = changed.filter(f => !owned.includes(f) && !isDocsFile(f))

// 1. HARD gates over realImpacted ONLY — today's three-way resolve (absent→loud error, unavailable→
//    untested-merge-risk), run loop, and the A1 behavioral test-file gate, all scoped to realImpacted.
if realImpacted.length > 0:  runHardGates(realImpacted)          // == current handlers.ts:388-481, input=realImpacted
elif unownedNonDocs.length === 0:                                 // pure-docs (or docs-only) diff
     unit.behavioral ? fail "behavioral-no-code" : pass + note "docs-only change, no code gates ran"

// 2. ADVISORY safety sweep — any unowned non-docs file → run the UNTOUCHED stacks' available gates,
//    surface failures, never wedge.
if unownedNonDocs.length > 0:
    for c in (components \ realImpacted), for each check-type in unit.verify_check_types:
        cmd = commandFor(c, checkType)
        if cmd === undefined: continue          // NO absent error for swept stacks (fixes S1)
        run cmd; on non-zero exit →
            insertSignal(type="ran-all-unowned", detail={component:c.name, checkType,
              note:"unowned files <list> triggered a precautionary run of this untouched stack, which failed — review"})
    // ran-all-unowned never fails the unit; it surfaces to the PR body (new renderPrBody branch).
```

Surfacing: add a `ran-all-unowned` branch to `renderPrBody` (`handlers.ts:132-150`) — a distinct section ("Precautionary runs on unowned-file changes — review") separate from "⚠ Untested stacks", with the component+checkType from `detail_json`. (Fixes S2: no inverted/`?`-line overload of `untested-merge-risk`.)

Why correct: every non-docs file is owned (→ hard-gated in its stack) or unowned (→ triggers the advisory sweep that surfaces any breakage) — **nothing rides through silently** (cardinal sin killed). Untouched stacks' pre-existing red is surfaced, not wedging (S3). The A1 gate stays over realImpacted, so no spurious `behavioral-no-test` (3b).

---

### Task 1 — the verify algorithm (hard gates over realImpacted + advisory sweep + docs-skip)

*First (under today's path-only matching, "unowned" arises only from path mismatch — fully testable now; stays green when Task 2 adds ext-mismatches).*

**Files:** `src/dispatch/handlers.ts` (the `verify:check` body + the `renderPrBody` `ran-all-unowned` branch); `src/dispatch/components.ts` (`isDocsFile`/`DOCS_EXTS`, exported). Test: `test/dispatch/verify-routing.test.ts`.

- [ ] **Step 1: Write/adjust failing tests** (read `handlers.ts:356-482`, `:132-150`, `verify-routing.test.ts` first). Use a scoped component `{kind:"x", paths:["app/**"]}` (path-only unowned):
  - diff `["app/main.x"(owned), "deploy/cfg.yaml"(unowned non-docs)]` + a 2nd component `{kind:"y", paths:["svc/**"], commands:{test:"<runnable>"}}` → app's hard gate runs; the **advisory sweep runs y**; a `ran-all-unowned` signal is recorded (assert the **type** + component); the unit is **not** failed by y. (And: y with a failing test → still not a unit hard-fail.)
  - diff `["other/svc.go"(unowned non-docs)]`, no owned → **no hard gate**, advisory sweep runs all, `ran-all-unowned` recorded, unit passes (no hard gate to fail).
  - diff `["README.md"]` → no sweep, non-behavioral passes; behavioral → `behavioral-no-code` fail.
  - Keep empty-diff + zero-components errors; rework the existing no-match test.
  - Add a `renderPrBody` test: a `ran-all-unowned` signal renders under its own section (not "Untested stacks").
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the algorithm; scope the existing three-way resolve to `realImpacted`; add the advisory sweep loop (skip absent commands; `insertSignal("ran-all-unowned", …)`); add the `renderPrBody` branch; add `isDocsFile`/`DOCS_EXTS`.
- [ ] **Step 4: PASS** + full suite + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(verify): hard-gate impacted + advisory run-all sweep on unowned files (WO-5)`

### Task 2 — file-identity matching (materialized extensions; `matchesComponent` = ext AND path)

**Files:** `src/dispatch/profile.ts` (schema v3 + `extensions` + parseProfile reject), `src/dispatch/components.ts` (`EXTENSIONS_BY_KIND`, undefined-safe `extMatches`, `matchesComponent`), `src/setup/lang/types.ts` (`ComponentDraft` return), `src/setup/detect-components.ts` (materialize in `runRegistry`), `src/setup/discover-schema.ts` (`mergeComponents` carries `extensions`). Tests: `components.test.ts`, `profile.test.ts`, and **add `extensions: []` to the five typed `: Component[]` fixtures**: `discover-schema.test.ts`, `prompt-vars.test.ts`, `components.test.ts`, `discover.test.ts`, `resolve-commands.test.ts`.

- [ ] **Step 1: Failing tests** — `components.test.ts`: interleaving (`.py`→python not sveltekit; `.svelte`→sveltekit not python), foreign-ext (`config.yaml`/`Dockerfile`→no mapped-kind match), `undefined`/empty extensions → path-only fallback, path scopes the instance. `profile.test.ts`: `schemaVersion:2` → rejected with the re-run message; v3 + `extensions` parses; update `expect(p.schemaVersion).toBe(2)` → `toBe(3)` (`:22,84,88`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** per Design: schema field + literal(3) + parseProfile reject; `ComponentDraft` on `LangDef.detect`; materialize in `runRegistry`; `mergeComponents` carry; `EXTENSIONS_BY_KIND` + undefined-safe `extMatches` + `matchesComponent`.
- [ ] **Step 4: PASS**, then **full suite + typecheck** (`tsc` catches the `: Component[]` fixture omissions — add `extensions:[]` to the five files). `detect-components.test.ts` asserts *subfields* (`kind`/`paths`/`commands`) so it's unaffected; `lang/*.test.ts` call `detect` directly (drafts, no extensions) — unaffected. The new ext-driven unowned files are handled by Task 1.
- [ ] **Step 5:** `bun test && bun run lint && bun run typecheck` green.
- [ ] **Step 6: Commit** — `feat(routing): file-identity via materialized extensions + schemaVersion 3 (WO-5)`

---

## Self-review notes

- **Four routing consumers re-express for free** (verify `handlers.ts:362`; implement allowlist `:314`; A1 gate `:473`; implement `test_command` `prompt-vars.ts:98`, fallback-protected) — all via `matchesComponent`.
- **Compile correctness** (review F1–F3): `ComponentDraft` return keeps detector impls valid; `extMatches` `undefined`-safe; five typed fixtures get `extensions:[]`; `tsc` is the gate that catches these (`bun test` strips types).
- **Algorithm correctness** (review S1–S4): hard gates over realImpacted (no spurious `absent` wedge); advisory `ran-all-unowned` sweep over untouched stacks (surfaced, non-wedging); distinct signal + composer branch (no `untested-merge-risk` overload); A1 over realImpacted; doctest-in-docs residual accepted.
- **Seam:** v3 bump makes the profile self-describe routing; old v2 → re-run setup. Update freeze §9.1/§13 #3 to "shipped" once landed.
- **Out of scope (WO-6/later):** the named global-file SET, the T1 over-budget branch, the cost measurement, rung-2/rung-3, persisted graph. Ruby/PHP ext entries with WO-3.
- **Named residuals:** owned-extension tooling files lose cross-stack fan-out (rung-3); manifests in `paths` vestigial for routing; staleness softened from hard-error to advisory sweep + note.
