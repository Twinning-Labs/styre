# WO-5: file-identity routing + full run-all safety — Implementation Plan (v2, post independent review)

> **For agentic workers:** REQUIRED SUB-SKILL — **superpowers:subagent-driven-development**. Steps use checkbox (`- [ ]`). TDD: failing test → see it fail → implement → see it pass → lint + typecheck + full suite → commit. The full suite must be **green after each task** (the task ordering guarantees it).

**Goal:** route changed files to stacks by **file identity** (extension + path), not folder alone — and apply the **run-more-when-unsure** safety rule so the *mixed-diff silent under-verify* (freeze §3, the cardinal sin) is actually killed. Concretely this WO does three things: (a) **interleaving fix** — a `.py` under `src/` routes to Python, not a co-located `["**"]` frontend; (b) **mixed-diff safety** — a diff containing *any* unowned non-docs file runs **every** gate (so an unowned `config.yaml` riding alongside an owned `billing.py` can no longer slip through ungated); (c) **docs-skip** — an unowned docs file (`.md`/`.rst`) does **not** trigger run-all (so a README edit doesn't run a full polyglot suite).

## Decisions folded in (operator, post-review)

- **D1 — extensions materialized at setup + `schemaVersion` bump (NOT a code-only map).** Each component gets a resolved `extensions: string[]` field, populated **at the deterministic scan** from its detected `kind` via the `EXTENSIONS_BY_KIND` authoring map — *before* the agent can refine `kind`. Routing reads `c.extensions`. This **closes the agent-kind-drift hole** (the agent relabelling `python→django` can't silently un-map routing) and makes the **profile self-describe its routing** (honors freeze §9.1/§10/§12/§13 #3 seam-versioning). `schemaVersion` 2 → **3**; old v2 profiles are hard-rejected with a "re-run `styre setup`" message (the existing v1 posture).
- **D2 — full safety rule + docs-skip (run-all on ANY non-docs unowned file).** Not just on a fully-unowned diff. This is what actually kills the mixed-diff cardinal sin. The **named global-file SET** (specific filenames beyond the docs heuristic) and the **T1 budget/over-budget branch** remain **WO-6**.

## Open risk carried (freeze §13 #1 / T1)

Run-all now fires on *any* non-docs unowned file (lockfiles, `config.yaml`, `go.mod`, `Dockerfile`), so in a polyglot repo it is plausibly the **modal** verify path and is **un-costed** (B3 tracks agent $, not verify compute). WO-5 ships the safety-first version (operator T1 = safety wins); the docs-skip removes the worst waste (README → full run-all). The cost must be **measured** and given an over-budget branch in **WO-6**. Stated, not solved here.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome. Use `bun test` · `bun run lint` · `bun run typecheck`.

---

## Design

### Identity model (Task 2)
- **`ComponentSchema` gains `extensions: z.array(z.string()).default([])`** (lowercased, leading-dot, e.g. `[".py", ".pyi"]`). `schemaVersion` → `z.literal(3)`. `parseProfile` rejects a `schemaVersion: 2` profile with a friendly "re-run `styre setup`" error (mirror the existing v1 `commands` rejection at `profile.ts:96`).
- **`EXTENSIONS_BY_KIND`** (authoring source, in `components.ts`):
  ```ts
  const NODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"];
  const JVM_EXTS = [".java", ".kt", ".kts", ".scala", ".groovy"];
  export const EXTENSIONS_BY_KIND: Record<string, readonly string[]> = {
    rust: [".rs"], node: NODE_EXTS, sveltekit: [...NODE_EXTS, ".svelte"],
    python: [".py", ".pyi"], go: [".go"],
    "jvm-maven": JVM_EXTS, "jvm-gradle": [...JVM_EXTS, ".gradle"],
    // ruby/php arrive with WO-3: ruby [".rb",".rake",".gemspec"], php [".php"]
  };
  ```
  Audited safe: no extension is assigned to a wrong language family while missing from its right one → a map error can only ever cause **over**-verify, never under (review item 2, clean-green). Deliberately **unowned** → run-all (safe): `.json .yaml .yml .toml .xml .sql .sh .css .html .lock .mod`, extensionless files (`Dockerfile`, `Makefile`), dotfiles.
- **Materialize at scan:** in `runRegistry` (`detect-components.ts`), after a `LangDef` emits a component, set `extensions: [...(EXTENSIONS_BY_KIND[c.kind] ?? [])]` from the **detected** kind. `LangDef.detect` impls are unchanged (the engine attaches extensions). `mergeComponents` (`discover-schema.ts`) must **preserve the scan component's `extensions`** (the agent cannot set or override them).
- **`matchesComponent(c, file)` = `extMatches(c, file) && c.paths.some(g => new Bun.Glob(g).match(file))`** where `extMatches`:
  - `c.extensions` empty → **`true`** (path-only fallback: custom/unmapped-kind components and bare test fixtures keep today's behavior — no regression);
  - else lowercased `extname(file)` ∈ `c.extensions` (a no-extension file → `""` → not in any set → no match).
  `paths` is kept (monorepo instance-scoping + display + the `isSafePath` Invariant-2 backstop). Note: a manifest listed in its own component's `paths` (e.g. `package.json`, `Cargo.toml`) is now **vestigial for routing** — `.json`/`.toml` are unowned, so manifest changes go through the run-all safety path (intended).

### The verify safety algorithm (Task 1 — the meat)
Rewrite the `verify:check` body around the diff (`handlers.ts:356-482`). `isDocsFile(f)` = `extname(f).toLowerCase()` ∈ `{.md, .markdown, .rst, .adoc}` (conservative — clearly-prose only; a no-ext `CHANGELOG` is *not* treated as docs → runs-all, safe over-verify).

```
changed = diff(base..head)
if changed.length === 0            → error "empty-diff"            (unchanged)
if components.length === 0         → error "no-components-detected" (unchanged intent)

owned          = changed.filter(f => components.some(c => matchesComponent(c, f)))
realImpacted   = impactedComponents(components, owned)        // components genuinely owning a changed file
unownedNonDocs = changed.filter(f => !owned.includes(f) && !isDocsFile(f))

toRun = unownedNonDocs.length > 0 ? components : realImpacted   // SAFETY: any non-docs unowned → run ALL
if unownedNonDocs.length > 0:
    insertSignal(type="untested-merge-risk", note="unowned non-docs files ran all gates: <list>")
    // untested-merge-risk is the ONLY signal the PR-body composer reads (handlers.ts:132) → it reaches the human

if toRun.length === 0:               // pure-docs (or docs-only) diff — no code gate applies
    if unit.behavioral → fail "behavioral-no-code"   // a behavioral unit must touch source
    else               → pass + informational note "docs-only change, no code gates ran"
else:
    run toRun commands (existing three-way resolve: has-command / {unavailable} / absent)
    // A1 behavioral test-file gate over realImpacted ONLY (NOT the run-all-expanded set) — fixes the spurious-fail bug
    for c in realImpacted with a real test command:
        inComponent = owned.filter(f => matchesComponent(c, f))
        if unit.behavioral && !inComponent.some(f => isTestFile(f, c.testFilePattern)):
            fail "behavioral-no-test" (c)
```

Why this is correct + safe: an unowned **non-docs** file (the `config.yaml` in a `[billing.py, config.yaml]` diff) forces `toRun = all` → it can no longer ride along ungated (**kills the mixed-diff cardinal sin**). The A1 gate runs only over `realImpacted` (genuinely-owned components), so the run-all-added components don't spuriously demand a test file (**fixes review item 3b**). The run-all note is an `untested-merge-risk` signal, so it actually reaches the human (**fixes review item 3**).

---

### Task 1 — the verify safety algorithm (run-all-on-any-non-docs-unowned + docs-skip + A1-over-realImpacted)

*Done first: under today's path-only `matchesComponent`, "unowned" only arises from a path mismatch, so this is fully testable now and stays green when Task 2 makes ext-mismatches produce more unowned files.*

**Files:** Modify `src/dispatch/handlers.ts` (the `verify:check` body) + add `isDocsFile` (in `components.ts` next to the routing helpers, exported, with `DOCS_EXTS`). Test: `test/dispatch/verify-routing.test.ts` (rework + add).

- [ ] **Step 1: Write/adjust the failing tests** (read `handlers.ts:356-482` + `verify-routing.test.ts` first). With path-only matching, use **path mismatches** to create unowned files against a scoped component `{kind:"x", paths:["app/**"]}`:
  - diff `["other/svc.go"]` (unowned non-docs) → **runs all components** + an `untested-merge-risk` signal is recorded (assert the **signal type**, not just "not thrown").
  - diff `["README.md"]` (docs only) → **no run-all**, non-behavioral unit **passes** with no code gates (no error, no untested-merge-risk).
  - diff `["README.md"]` + behavioral unit → `behavioral-no-code` fail.
  - mixed `["app/main.x", "other/cfg.yaml"]` → app component runs AND run-all triggers (the `.yaml` is unowned non-docs); A1 gate evaluated only for `app`.
  - Keep: empty-diff → error; zero-components → error. Rework the existing "no-component-match → error" test to the new contract.
- [ ] **Step 2: Run — FAIL.** `bun test test/dispatch/verify-routing.test.ts`
- [ ] **Step 3: Implement** the algorithm above in `handlers.ts`; add `isDocsFile`/`DOCS_EXTS` to `components.ts`. Emit the run-all note via `insertSignal(... "untested-merge-risk" ...)` (match the existing untested-merge-risk emission at `handlers.ts:419-423`/`461-468`; never `console.log`). Preserve empty-diff + zero-components errors.
- [ ] **Step 4: PASS** + full suite + lint + typecheck. (Existing tests: app-kind `["**"]` fixtures path-match everything → no unowned → unchanged; the reworked no-match test now asserts the new contract.)
- [ ] **Step 5: Commit** — `feat(verify): run-all-on-unowned-non-docs safety rule + docs-skip (WO-5)`

### Task 2 — file-identity matching (extensions materialized at setup; `matchesComponent` = ext AND path)

**Files:** `src/dispatch/profile.ts` (schema v3 + `extensions` + parseProfile reject), `src/dispatch/components.ts` (`EXTENSIONS_BY_KIND`, `extMatches`, `matchesComponent`), `src/setup/detect-components.ts` (materialize in `runRegistry`), `src/setup/discover-schema.ts` (`mergeComponents` preserves `extensions`). Tests: `test/dispatch/components.test.ts`, `test/dispatch/profile.test.ts`, `test/setup/detect-components.test.ts`, `test/setup/discover-schema.test.ts`.

- [ ] **Step 1: Write the failing tests** — `components.test.ts`: interleaving (`.py` under `src/` → python not sveltekit; `.svelte` → sveltekit not python), foreign-ext (`config.yaml`/`Dockerfile` → no mapped-kind match), empty-extensions component → path-only fallback (no regression), path still scopes the instance. `profile.test.ts`: a `schemaVersion: 2` profile is rejected with the re-run message; a v3 profile with `extensions` parses. (Use the existing fixtures' style.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:** add `extensions` to `ComponentSchema` + bump `schemaVersion` to `z.literal(3)` + the parseProfile v2 rejection; add `EXTENSIONS_BY_KIND`/`extMatches`; rewrite `matchesComponent` to ext-AND-path reading `c.extensions` (empty → path-only); materialize `extensions` in `runRegistry` from the detected kind; make `mergeComponents` carry the scan component's `extensions`.
- [ ] **Step 4: PASS**, then **full suite**. Expected updates (verify, don't assume): `detect-components.test.ts` (the matrix — components now carry `extensions`; update the asserted shapes); `profile.test.ts` (v3). **Most routing e2e + the `lang/*.test.ts` are unaffected** — the lang tests call `LangDef.detect` directly (extensions are added by the *engine*, not the def), and the verify e2e fixtures use unmapped kinds (`app`/`backend`/…) → path-only fallback. Any real breakage = a fixture feeding a *mapped*-kind component a wrong-extension file; fix by giving the fixture a realistic source extension, **intent preserved** — do not weaken assertions. The new ext-driven unowned files are handled by Task 1.
- [ ] **Step 5:** `bun test && bun run lint && bun run typecheck` green.
- [ ] **Step 6: Commit** — `feat(routing): file-identity matching via materialized extensions + schemaVersion 3 (WO-5)`

---

## Self-review notes (author)

- **Four routing consumers re-express for free** (verify routing `handlers.ts:362`; implement Bash allowlist `scopedRunnersForFiles`→`handlers.ts:314`; A1 gate `handlers.ts:473`; implement `test_command` `prompt-vars.ts:98` — fallback-protected) — all go through `matchesComponent`. One change updates all four.
- **Map safety property is guaranteed** (review item 2, audited): no cross-contamination → no under-verify from the map; all omissions fall to run-all.
- **Agent-kind-drift closed** by materializing `extensions` at scan from the detected kind; the agent can relabel `kind` for display, routing reads the frozen `c.extensions`.
- **Seam:** `schemaVersion` 3 bump makes the profile self-describe routing (the freeze's intended seam revision); old v2 profiles re-run setup (existing posture). Update freeze §9.1/§13 #3 to "shipped as a v3 bump" once landed.
- **Named residuals (coarse-rung limits, not under-verify-via-map):** (a) owned-extension *tooling* files (`vite.config.ts`) route to their stack only, losing today's incidental cross-stack fan-out — a narrow rung-3 limit; a WO-6 explicit global-set can list such files. (b) manifests in `paths` are vestigial for routing (changes go through run-all). (c) staleness for narrow-path profiles is softened from a hard error to run-all + the untested-merge-risk note.
- **Out of scope (WO-6 / later):** the explicit named global-file SET, the T1 over-budget branch, rung-2 manifest-association, rung-3 import-inference, persisted materialized graph (commercial). Ruby/PHP ext entries arrive with WO-3.
- **Cost (T1):** docs-skip removes the worst waste; the over-budget branch + measurement is WO-6 (freeze §13 #1). No silent narrowing.
