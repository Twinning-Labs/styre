# Language stack registry — design (ENG-344)

**Date:** 2026-07-22
**Status:** design, awaiting review
**Ticket:** ENG-344 — "Language stack registry — one typed, code-consumed source for per-ecosystem facts"
**Motivating bug:** ENG-332 whole-branch review — prepare-provided test tools false-fail on a clean checkout.
**Related:** `docs/brainstorms/2026-07-19-toolchain-preflight-design.md` (ENG-332), which introduced the special-case this ticket retires.

---

## 1. Problem

The ENG-332 toolchain preflight shipped a bug because a load-bearing ecosystem fact was **tacit**. `php.ts:30` emits `test: "./vendor/bin/phpunit"` with `prepare: "composer install"` — the test tool is *produced by* the install step and absent on a clean checkout. That fact lived nowhere explicit, so the preflight probed `./vendor/bin/phpunit` before provision ran and false-failed on a clean clone — the exact CI/fleet scenario the feature targets.

ENG-332 fixed it narrowly: **"component has a `prepare` → probe only the `prepare` tool"** (`preflight.ts:22-31`). That is a workaround standing in for a fact.

The deeper problem is duplication. A repo-wide sweep found **per-ecosystem facts re-encoded across at least ten tables in seven modules**, and the drift the ticket predicts *has already happened*:

- `EXTENSIONS_BY_KIND` (`components.ts:10`) and `SOURCE_EXTS` (`check-rules.ts:4`) both answer "which extensions belong to this ecosystem" and **disagree today**: `SOURCE_EXTS` is missing `.svelte`, `.gradle`, `.groovy`, `.cts`, `.mts`.
- `MANIFEST_BASENAMES` (`provision.ts:192`) drives `diffTouchesManifest`, which re-arms `provision` when a dispatch edits a dependency manifest. It **omits `Gemfile` and `composer.json`** — both prepare-bearing ecosystems. Editing a `Gemfile` mid-run silently fails to re-install. This is a live bug.

Two tables, same fact, different answers. That is the bug class this ticket deletes.

## 2. The inventory (ground truth for the migration)

| # | Table | Location | Fact | Disposition |
|---|---|---|---|---|
| 1 | `EXTENSIONS_BY_KIND` | `components.ts:10` | kind → extensions | **fold** |
| 2 | `SOURCE_EXTS` | `check-rules.ts:4` | source extensions (deduped, dotless) | **fold** (derived) |
| 3 | `MANIFEST_BASENAMES` + `REQUIREMENTS_RE` | `provision.ts:192,205` | dependency manifests | **fold** |
| 4 | `NODE_MANIFEST_FILES` | `provision.ts:22` | node dependency manifests | **fold** (subset of 3) |
| 5 | `NODE_INSTALL_MARKERS` | `provision.ts:18` | install-completeness markers | **fold** |
| 6 | `resolvePythonInterpreter` | `provision.ts:180` | interpreter fallback order | **fold** |
| 7 | `TARGETED_LANG_MANIFESTS` | `detect-components.ts:59` | kind → detection anchors | **fold** |
| 8 | `SKIP` | `manifests.ts:4` | vendored/build dirs to skip | **fold** (+ generic residue) |
| 9 | `SWEEP_SKIP_DIRS` | `worktree.ts:255` | subset of 8 | **fold** |
| 10 | `MANIFESTS` | `runtime-deps/collect.ts:19` | file → lang → **parser fn** | **split**: mapping folds, parsers stay |
| 11 | `CHECK_RULES` | `check-rules.ts:349` | framework → match rules | **fold (PR 2)** |
| 12 | `binaryFor` / selector / exit-code switches | `check-selector.ts:120,200,391` | framework → binary, args, codes | **fold (PR 2)** |
| 13 | kind → framework switch | `check-selector.ts:54-79` | candidates + conditional pick | **split**: candidates fold, sniff stays |
| — | `detect-runtime.ts` dep-name lists | `detect-runtime.ts:39-98` | prisma/pino/sentry… | **out** — library knowledge, not ecosystem-invariant |
| — | `STACK_KEYWORDS` | `cli/setup.ts:54` | prose → stack bucket | **out** — NL matching, different concept |
| — | `ReleaseMechanismEnum` | `profile.ts:18` | kind → release mechanism | **out** — no second consumer |

## 3. Design

### 3.1 The load-bearing decision: two keys, not one

Full centralisation has one trap worth naming, because falling into it produces exactly the "god-table of embedded conditionals" the ticket forbids.

Some facts key on **`kind`** (extensions, manifests, install step, interpreters). Others key on **check framework** (`CHECK_RULES`, `binaryFor`, selector args, exit-code tables). And `kind → framework` is **1:many, resolved conditionally** — `check-selector.ts:56-63` picks vitest-or-jest by sniffing the test command, `:70-74` picks rspec-or-minitest the same way.

Collapsing framework facts into a kind-keyed table would require embedding those sniffs as data. So:

> **One module, two tables, one link field.** `STACKS` is keyed by `kind`; `CHECK_FRAMEWORKS` is keyed by `CheckFramework`; `StackFacts.checkFrameworks` (added in PR 2) lists a kind's *candidate* frameworks, and the conditional pick stays as detector logic.

### 3.2 Module

`src/dispatch/stack-registry.ts`. `EXTENSIONS_BY_KIND` already lives in `src/dispatch/components.ts` and `src/setup/detect-components.ts` imports it, so `dispatch` is the established home for shared per-kind data. It also avoids the `cli → setup` layer-crossing flagged in the ENG-332 design §5.

**The module imports nothing.** That is not a style preference — it is the mechanically-checkable statement of the data-vs-logic boundary (§5). A registry that cannot reach `node:fs` cannot branch on repo state.

`CheckFramework` **moves into** this module in PR 2 (it is language vocabulary, not selector implementation) and `check-selector.ts` imports it from here. Without that move, PR 2 would create the cycle `stack-registry → check-selector → check-rules → stack-registry`. PR 1 needs no reference to it (§3.4).

### 3.3 The type

```ts
export interface StackFacts {
  // — routing —
  /** File extensions owned by this kind. Empty ⇒ path-only routing. */
  extensions: readonly string[];
  // testFilePattern?: string;   — ADDED IN PR 2, not PR 1 (see §3.4)

  // — detection —
  /** Manifests whose presence at a path means "a component of this kind lives here". */
  detectAnchors: readonly string[];
  /** Vendored/build output dirs to skip when walking a repo. */
  ignoreDirs: readonly string[];

  // — dependency manifests —
  /** Basenames whose change means the dependency set may have changed. */
  manifests: readonly string[];
  /** RegExp source strings for manifests a fixed basename can't express (python's requirements*.txt). */
  manifestPatterns: readonly string[];

  // — install step —
  /** Dir the install writes into, relative to the component root. */
  installOutputDir?: string;
  /** Dirs, relative to the component root, where the install drops executables. */
  installBinDirs: readonly string[];
  /** Bare tool names the install step puts on PATH. */
  installProvidedTools: readonly string[];
  /** Files under installOutputDir whose presence + mtime prove the install completed. */
  installMarkers: readonly string[];

  // — runtime —
  /** Interpreter candidates in fallback order. */
  interpreters: readonly string[];

  // — link → the framework table — ADDED IN PR 2, not PR 1 (see §3.4) —
  // /** Candidate frameworks, ordered. The pick among them is detector logic, not data. */
  // checkFrameworks: readonly CheckFramework[];
}

export const STACKS: Record<string, StackFacts>;
export const GENERIC_IGNORE_DIRS: readonly string[]; // .git, dist, build — belong to no kind

/** Total. An unmodeled kind (kind is an unconstrained z.string()) yields conservative facts. */
export function stackFacts(kind: string): StackFacts;
```

Illustrative entries:

```ts
php: {
  extensions: [".php"],
  detectAnchors: ["composer.json"],
  ignoreDirs: ["vendor"],
  manifests: ["composer.json", "composer.lock"],
  manifestPatterns: [],
  installOutputDir: "vendor",
  installBinDirs: ["vendor/bin"],
  installProvidedTools: ["phpunit", "pest"],
  installMarkers: [],
  interpreters: ["php"],
  checkFrameworks: ["phpunit"],
},
python: {
  extensions: [".py", ".pyi"],
  detectAnchors: ["pyproject.toml", "setup.py", "requirements.txt"],
  ignoreDirs: [".venv", "venv", "__pycache__", ".tox", ".nox"],
  manifests: ["pyproject.toml", "setup.py", "setup.cfg", "poetry.lock", "Pipfile", "Pipfile.lock"],
  manifestPatterns: ["^requirements.*\\.txt$"],
  installBinDirs: [],
  installProvidedTools: ["pytest", "tox", "nox"],
  installMarkers: [],
  interpreters: ["python3", "python"],
  checkFrameworks: ["pytest"],
},
node: {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"],
  detectAnchors: ["package.json"],
  ignoreDirs: ["node_modules", ".svelte-kit"],
  manifests: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
  manifestPatterns: [],
  installOutputDir: "node_modules",
  installBinDirs: ["node_modules/.bin"],
  installProvidedTools: [],           // npm/pnpm/yarn are preconditions, not install output
  installMarkers: [".package-lock.json", ".yarn-state.yml", ".modules.yaml"],
  interpreters: ["node"],
  checkFrameworks: ["vitest", "jest"],
},
```

All 9 kinds get entries: `rust, node, sveltekit, python, go, jvm-maven, jvm-gradle, ruby, php`.

### 3.4 Fields deliberately NOT added

The ticket says *"start with the subset that has ≥2 real consumers — don't add speculative fields."* Applying that:

- **`hasInstallStep: boolean` — dropped.** Whether *this component* installs is `c.prepare !== undefined`, already on the component and already the gate in both `planProvision` (`provision.ts:57`) and the preflight. A per-kind boolean would be a second, weaker answer to a question the component already answers precisely. go/jvm/rust are expressed by empty `installBinDirs`/`installProvidedTools`/`installMarkers`.
- **Editable-install shadowing facts** (`EDITABLE_PIP_RE`, `SOURCE_CHECK_SCRIPT`) — python-only with a single consumer, and the script is a program, not a fact. Stays in `provision.ts`.
- **`checkFrameworks` and `testFilePattern` — deferred to PR 2.** Both are kind-keyed facts, but their only consumers live in the framework-keyed half. Adding them in PR 1 would be exactly the speculative field this rule forbids, and `checkFrameworks` would additionally drag the `CheckFramework` type move (§3.2) into a PR that has no use for it. They land in PR 2 alongside their consumers. Until then `testFilePattern` stays where it is, emitted by `php.ts:35` and `ruby.ts:29`.

## 4. Consumer migration

### 4.1 PR 1 — kind-keyed half

| Consumer | Today | After |
|---|---|---|
| `detect-components.ts:28` | `EXTENSIONS_BY_KIND[c.kind] ?? []` | `stackFacts(c.kind).extensions` |
| `detect-components.ts:59` | `TARGETED_LANG_MANIFESTS` | derived from `STACKS[*].detectAnchors` |
| `components.ts:10` | `EXTENSIONS_BY_KIND` export | deleted; `stackFacts(kind).extensions` |
| `manifests.ts:4` | `SKIP` literal set | union of `ignoreDirs` + `GENERIC_IGNORE_DIRS` |
| `worktree.ts:255` | `SWEEP_SKIP_DIRS` | same union (or its documented subset) |
| `provision.ts:33` | `kind !== "node" && kind !== "sveltekit"` | `facts.installMarkers.length === 0 → false` |
| `provision.ts:36-47` | `node_modules`, markers, manifest list | `installOutputDir`, `installMarkers`, `manifests` |
| `provision.ts:180` | `resolvePythonInterpreter()` | `resolveInterpreter(kind)` over `facts.interpreters` |
| `provision.ts:211` | `MANIFEST_BASENAMES` ∪ `REQUIREMENTS_RE` | union of all kinds' `manifests` + `manifestPatterns` |
| `check-rules.ts:29` | `SOURCE_EXTS` | derived: union of `extensions`, dots stripped |
| `runtime-deps/collect.ts:19` | `{file, lang, parse}` rows | file→kind from registry; **parser map stays local** |
| `preflight.ts:20-38` | prepare-bearing special-case | §4.2 |

### 4.2 The preflight rule

```
for each component c, facts = stackFacts(c.kind):
  if c.prepare: probe c.prepare
  for label in [build, test, check]:
    command = commandFor(c, label);  if absent, skip
    if installProvided(command, facts): skip     // provision supplies it
    else probe
```

`installProvided(command, facts)` — take the command's leading whitespace token, strip a leading `./`, then:
- true if it sits under any `facts.installBinDirs` entry, **or**
- true if it equals any `facts.installProvidedTools` entry.

Traced against every real detector output:

| kind | command | leading token | verdict |
|---|---|---|---|
| php | `./vendor/bin/phpunit` | `./vendor/bin/phpunit` | under `vendor/bin` → **skip** ✅ clean checkout passes |
| php | `composer install` (prepare) | `composer` | **probe** ✅ |
| python | `tox` / `nox` / `pytest` | same | in tools → **skip** ✅ |
| python | `python -m pytest` | `python` | **probe** ⚠️ new (§6.2) |
| python | `pip install -e .` (prepare) | `pip` | **probe** ✅ unchanged |
| node | `npm run test` | `npm` | **probe** ⚠️ restored (§6.1) |
| ruby | `bundle exec rspec` | `bundle` | **probe** ✅ new, and correct — `bundle` is a precondition, not install output |
| go / rust / jvm | `go test ./...`, `cargo build`, `mvn -q test` | — | **probe** ✅ unchanged |

The ENG-332 special-case is deleted for all 9 modeled kinds. It survives **only** as the unmodeled-kind fallback (§6.6).

### 4.3 PR 2 — framework-keyed half (separate ticket/PR)

Adds `CHECK_FRAMEWORKS: Record<CheckFramework, FrameworkFacts>` to the **same module**, carrying `binary`, selector args/precision, `selected-none` phrases, and exit-code semantics; migrates `check-selector.ts:120,200,391` and `check-rules.ts:349`; makes `check-selector.ts:54-79` read candidates from `checkFrameworks` and retain only the sniff.

**Sequencing note (refines the "author complete in PR 1" idea).** Authoring `CHECK_FRAMEWORKS` in PR 1 while `check-selector.ts` still holds its switches would *create* duplication — the very thing this ticket deletes — for the length of the window. So PR 1 authors the kind-keyed table only; PR 2 adds the framework table to the same file. The single-source-of-truth promise is preserved (one module) with **zero** duplication window.

## 5. The data-vs-logic boundary, made mechanical

AC 5 asks for a test that "the registry has no repo-specific branching". Prose can't assert that; these can:

1. **No functions.** Every value reachable in `STACKS` is a string, boolean, or readonly array of strings. A recursive walk asserts `typeof v !== "function"`. This is what keeps `runtime-deps`' parsers out.
2. **No imports.** The module's source text contains no `import` statement (in particular no `node:fs`, `node:path`). A registry that cannot read the filesystem cannot branch on repo state — this is the boundary, stated as an executable assertion.
3. **Exhaustive.** Every `kind` in `src/setup/registry.ts`'s `REGISTRY` has a `STACKS` entry, and (PR 2) every `checkFrameworks` entry is a `CHECK_FRAMEWORKS` key.
4. **Frozen.** `STACKS` and its arrays are deep-frozen, so no consumer can mutate shared facts.

## 6. Behavior changes (each needs a test)

Enumerated because "no behavior change" would be false, and reviewers should see the list rather than discover it.

1. **node regains its probes.** `npm run build|test|check` is probed again. This restores coverage the special-case silently dropped — including the exact case the ENG-332 design §7 listed as a wanted test: *"a node repo missing `npm` though `prepare` is `pnpm` → caught by probing `npm run …`"*. `probeCommandExists` also verifies the npm script exists in the cwd `package.json` (`discover-schema.ts:57-62`).
2. **`python -m pytest` now probes `python`.** On a python3-only machine with a working `pip` shim, this converts a mid-run verify death into a clean exit-69 at second zero. That is the fail-fast the feature exists for, but it is a *new early hard stop*. The bare-`pip`/`python` portability fix remains the ticket's named follow-up and will consume `facts.interpreters`.
3. **`diffTouchesManifest` gains `Gemfile` and `composer.json`** — fixes the live re-arm bug (§1). It also gains `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle*`, where the re-arm is a cheap no-op: those kinds have no `prepare`, so `planProvision` emits nothing (`provision.ts:57`).
4. **`moduleLeaf` gains `.svelte`, `.gradle`, `.groovy`, `.cts`, `.mts`** — closes the `SOURCE_EXTS` drift. `Button.svelte` now reduces to `button`. Affects check name-matching; needs a targeted test.
5. **`ignoreDirs`/`SKIP` must be set-EQUAL, not a superset.** (Corrected during planning — the first draft said "⊇", which is backwards: `SKIP` *prunes* the manifest walk, so a superset would skip more dirs and silently find fewer components.) `SKIP`'s `.git`, `dist`, `Pods` belong to no kind and move to `GENERIC_IGNORE_DIRS`; the rest decompose cleanly per kind (`target`→rust+jvm-maven, `testdata`→go, `.tox`/`.nox`/`.venv`/`venv`/`__pycache__`→python, `.svelte-kit`→node, `.gradle`/`build`→jvm-gradle, `.mvn`→jvm-maven, `vendor`→ruby+php, `node_modules`→node). A test asserts the derived union **equals** today's `SKIP` exactly.

   `SWEEP_SKIP_DIRS` (`worktree.ts:255`, today `.git` + `node_modules`) becomes `.git` + every kind's `installOutputDir` — which adds `vendor`. Behavior delta: `sweepScratch` no longer descends into a PHP `vendor/` tree looking for `styre_scratch/`. Correct and faster; needs a test.
6. **Unmodeled kinds keep the conservative path.** `kind` is an unconstrained `z.string()` (`profile.ts:98`), so custom kinds are legal. `stackFacts()` returns empty facts for them, which would probe everything and risk re-introducing the ENG-332 false-fail for an un-modeled ecosystem. So the preflight keeps "unmodeled kind **and** has `prepare` → probe prepare only" as an explicit, documented fallback. Combined with the §5.3 exhaustiveness test, it is unreachable for the 9 real kinds. This is a narrowing of the special-case, not a retention of it — AC 2 is met for every kind the registry models.

## 7. Adjacent findings (recorded, NOT fixed here)

- **`binaryFor` returns bare `jest`, `vitest`, `phpunit`** (`check-selector.ts:396,398,412`) — precisely the binaries that live under `node_modules/.bin` and `vendor/bin` and may not be on PATH. Its own docstring already carves out pytest for this reason ("not a bare `pytest` that may be absent"). Once `installBinDirs` exists, the fix is one line — but it is a checks-runner behavior change and belongs to PR 2 or its own ticket.
- **`runtime-deps` kind-vocabulary mismatch.** `collect.ts:17` uses a coarse `Lang` union with `"jvm"`, where the registry keys `jvm-maven`/`jvm-gradle`. The migration keeps a local coarsening map; the registry does not learn a second vocabulary.
- **`LangDef.kind` is unused by the engine** (`runRegistry` reads `c.kind` off each draft). It becomes the natural join key for the §5.3 exhaustiveness test.

## 8. Testing

- **Registry invariants** — the four assertions in §5.
- **Preflight** — the §4.2 table as cases; php and python clean-checkout still pass; go/jvm still probe build/test; node's `npm run test` is probed; ruby's `bundle exec rspec` is probed.
- **Provision** — `isComponentReady` unchanged for node/sveltekit (marker + mtime staleness) and still `false` for every other kind; `resolveInterpreter("python")` matches `resolvePythonInterpreter`'s old order and still throws when neither is present; `diffTouchesManifest` gains `Gemfile`/`composer.json` and keeps `requirements-dev.txt`.
- **Routing** — `EXTENSIONS_BY_KIND`'s existing assertions (`test/dispatch/components.test.ts:59-66,177-180,200-201`) re-pointed at the registry with identical expectations; `moduleLeaf` gains the five new extensions.
- **Walk** — derived ignore-dir union ⊇ today's `SKIP`.
- `bun run lint` + `bun test` green.

## 9. Acceptance criteria (ENG-344, PR 1)

- [ ] `src/dispatch/stack-registry.ts` exists, imports nothing, exports `STACKS` with entries for all 9 kinds and a total `stackFacts(kind)`.
- [ ] Preflight derives precondition-vs-install-provided from `installBinDirs`/`installProvidedTools`; the ENG-332 special-case is gone for every modeled kind (retained only as the documented unmodeled-kind fallback, §6.6). php/python clean-checkout pass; go/jvm still probe build/test.
- [ ] `EXTENSIONS_BY_KIND` and `SOURCE_EXTS` are both superseded by the registry; routing behavior unchanged except the four extensions §6.4 adds.
- [ ] Provision reads markers, install output dir, manifests, and interpreters from the registry; conditional detector logic untouched.
- [ ] `TARGETED_LANG_MANIFESTS`, `SKIP`, `SWEEP_SKIP_DIRS`, and `runtime-deps`' file→lang mapping all derive from the registry; the parser map stays local.
- [ ] The §5 boundary tests pass.
- [ ] `bun run lint` + `bun test` green.

## 10. Out of scope

- The framework-keyed half (§4.3) — PR 2 / follow-up ticket.
- Rewriting detector conditional logic (package-manager, test-runner, import-name selection).
- A standing prose dictionary as a parallel source of truth.
- Adding new languages.
- The bare-`pip`/`python` portability fix — it will consume `facts.interpreters`.
- `detect-runtime.ts` library-name lists, `STACK_KEYWORDS`, `ReleaseMechanismEnum`.

## 11. Refs

- Ticket: ENG-344. Motivating bug: ENG-332 whole-branch review.
- Prior design: `docs/brainstorms/2026-07-19-toolchain-preflight-design.md` §3A (the special-case), §9 (the pip/python follow-up).
- Code: `src/dispatch/{components,provision,check-rules,check-selector,worktree,profile}.ts`; `src/setup/{registry,detect-components,manifests,discover-schema}.ts`; `src/setup/runtime-deps/collect.ts`; `src/setup/lang/*.ts`; `src/cli/preflight.ts`.
