# WO-3: Ruby + PHP detectors + the detect-only `prepare` command class — Implementation Plan (v2, post independent review)

> **For agentic workers:** REQUIRED SUB-SKILL — **superpowers:subagent-driven-development**. Steps use checkbox (`- [ ]`). TDD: failing test → see it fail → implement → see it pass → lint + typecheck + full suite → commit. Suite green after each task.

**Goal:** close the three remaining ⬜ items in WO-3 — the first-class **Ruby** and **PHP** `LangDef`s and the **detect-only `prepare`** command class — authored **clean in the WO-5 file-identity model** (each new stack ships its `EXTENSIONS_BY_KIND` entry, so `.rb`/`.php` route by identity, not path-only). Phase-3 sequencing (work-order Part E): WO-5/6 landed, so WO-3 is built on the new routing primitive and never needs folder-glob rework.

**Freeze refs:** §9 (first-class set = the 5 + Ruby + PHP), the `prepare` line — *"`prepare`/install is detect-only. Setup detects+stores a config-aware `prepare` command but does **not** run it; running install + provisioning toolchains is the separate downstream environment workstream"* (freeze line 121). Work-order WO-3 (lines 108–110).

## Review status (v2)

Independently reviewed by three code-grounded agents (feasibility / adversarial / scope): all **SHIP-WITH-FIXES**. **Decision A (separate `prepare` field) approved unanimously** — the adversarial reviewer traced every consumer of `commands`/`Component` and could construct no path that executes/leaks/agent-authors a separate `prepare` field, and confirmed the alternative's footguns are *real* code paths (`realRunnerCommands:92` would push `composer install` into the implement allowlist; `mergeComponents:41` would let the agent author `commands.prepare`). **Operator decisions baked:** (B) `prepare` breadth = **Ruby + PHP + Node**; (Ruby no-signal) = **signal-gated ladder** (no vacuous `rake test`). Six review fixes folded in (§"Review fixes folded in" below).

## Scope

In:
1. **Ruby `LangDef`** — `Gemfile` manifest; **signal-gated** rspec→rake ladder; `testFilePattern`; `EXTENSIONS_BY_KIND["ruby"] = [".rb", ".rake", ".gemspec"]`; `prepare: "bundle install"`; registry wire; unrooted-manifest warning entry.
2. **PHP `LangDef`** — `composer.json` manifest; Pest-before-phpunit ladder; `testFilePattern`; `EXTENSIONS_BY_KIND["php"] = [".php"]`; `prepare: "composer install"`; registry wire; unrooted-manifest warning entry.
3. **The detect-only `prepare` command class** — a separate `Component.prepare?: string` field, detected + stored, **never run by styre** (not a verify gate, not in the implement Bash allowlist, agent-unauthorable). Populated for Ruby, PHP, **and Node** (`npm install`) per operator Decision B.

Out (explicitly):
- **Running `prepare`** — env provisioning / toolchain install is the downstream *environment* workstream (freeze line 121; WO-12). This WO only **detects + stores**. **Consequence to state loudly:** Ruby/PHP verify gates are **inert until WO-12** — without `prepare`-install, `bundle exec rspec` / `./vendor/bin/phpunit` won't resolve in the worktree (PHP's `./vendor/bin/X` is 100% absent → exit 127 → loud fail). "Detector landed" ≠ "verify works"; do not read a green Ruby/PHP detector as a working verify path.
- **`prepare` for the 4 *other* existing stacks (rust/python/go/jvm)** — deferred to a flagged fast-follow (operator Decision B chose Ruby+PHP+**Node**; Node is in-scope this WO). Python (pip/poetry/pdm/uv) and JVM (mvnw/gradlew offline-resolve) installs are config-ambiguous and deserve their own care.
- **Non-root / multi-module Ruby/PHP** — root-only N=1 (same shape as Python/Go/JVM today). Subdir-only manifests get the existing §5.4 loud warning. Multi-module is WO-8/WO-9.
- **Lint/build gates for Ruby/PHP** — no compile step; rubocop/php-cs-fixer/phpstan are outside the bounded first-class command set (test + prepare only, mirroring Python's test-only shape). The operator-confirm ladder (`resolveCommands`) still lets a human add `check` later.

**Tech Stack:** TypeScript, Bun, Biome. `bun test` · `bun run lint` · `bun run typecheck`.

---

## Decision A (BAKED) — `prepare` is a separate `Component.prepare?: string` field

Approved unanimously by review. Rationale (four axes; axes 2–3 are *verified code paths*, not hypothetical):
1. **Never a gate.** Verify/sweep/hard-gates are all check-type-keyed (`commandFor(c, checkType)`); a `commands.prepare` key would be run by a future "enumerate check-types from `Object.keys(commands)`" consumer. A separate field is immune.
2. **No implement-allowlist leak.** `realRunnerCommands` (`components.ts:89-97`) sweeps every `commands` value into the implement Bash allowlist. A separate field stays out.
3. **Agent-unauthorable.** `DiscoverSchema.commands` is `Record<string,string>` and `mergeComponents` does `commands: {...s.commands, ...p.commands}` — a `commands.prepare` key could be agent-authored/overridden. A separate field (absent from `DiscoverSchema`, read only from the scan `s.prepare`) stays deterministic-only.
4. **Honest typing.** `commands` is the check-type map; `prepare` is a distinct *class* (the freeze's word).

**Plumbing (verified complete by feasibility — `mergeComponents` is the ONLY field-by-field rebuild; all other Component sites spread `...c` and preserve `prepare`; no `schemaVersion` bump since the field is optional):**
- `src/dispatch/profile.ts` — `ComponentSchema`: add `prepare: z.string().optional()`.
- `src/setup/detect-components.ts` `runRegistry` — extend the Invariant-1 safety loop: `if (c.prepare !== undefined && !isCommandSafe(c.prepare)) throw …` (machine-channel backstop; the loop currently iterates `c.commands` only). Passthrough is automatic (`{...c, paths, extensions}`).
- `src/setup/discover-schema.ts` `mergeComponents` — carry `...(s.prepare ? { prepare: s.prepare } : {})` (the field-by-field literal at `:37-44` would otherwise drop it; mirrors the `extensions`/`testFilePattern` carry already there).
- `src/cli/setup.ts` — the "SECURITY-BEARING CONFIRM" block (`:147`, prints `Object.entries(c.commands)`) must also print a **`prepare: <cmd> (stored, not run)`** line, so a persisted command appears on the "FULL final command list" sign-off screen (review fix #3).
- `ComponentDraft = Omit<Component,"extensions">` (`types.ts:5`) already includes `prepare` once it's on `Component` — detectors emit it directly.

---

### Task 1 — Ruby `LangDef` + ext map + `testFilePattern` + registry + unrooted warning + the shared `prepare` plumbing

Ruby is the first `prepare` emitter, so the **Decision-A shared plumbing above lands in this task.**

**Files:** new `src/setup/lang/ruby.ts`; `src/dispatch/profile.ts` (`prepare` field); `src/setup/detect-components.ts` (Invariant-1 `prepare` check; `TARGETED_LANG_MANIFESTS` += `["ruby", ["Gemfile"]]`); `src/dispatch/components.ts` (`EXTENSIONS_BY_KIND` += `ruby`); `src/setup/registry.ts` (wire `rubyDef`); `src/setup/discover-schema.ts` (`prepare` carry); `src/cli/setup.ts` (print `prepare`). Tests: new `test/setup/lang/ruby.test.ts`; extend `test/dispatch/components.test.ts`, `test/setup/discover.test.ts`, `test/dispatch/profile.test.ts`, `test/cli/setup.test.ts` (or wherever the confirm block is tested).

**Detector shape — signal-gated ladder (operator decision):**
```ts
export function rubyTestCommand(repoDir: string): Component["commands"] {
  // rspec → rake → (no signal → omit; resolveCommands degrades to untested-merge-risk)
  if (existsSync(join(repoDir, ".rspec")) || existsSync(join(repoDir, "spec")))
    return { test: "bundle exec rspec" };
  if (existsSync(join(repoDir, "Rakefile")))
    return { test: "bundle exec rake test" };
  return { test: { unavailable: true } };   // no signal → never fabricate a vacuous gate
}
export const rubyDef: LangDef = {
  kind: "ruby",
  detect(repoDir) {
    if (!existsSync(join(repoDir, "Gemfile"))) return [];
    return [{ name: "ruby", kind: "ruby", paths: ["**"],
      commands: rubyTestCommand(repoDir),
      testFilePattern: "(^|/)(spec|test)/.*_(test|spec)\\.rb$",  // anchored (whole-branch crux, symmetric with PHP): A1 credits a *_spec.rb/*_test.rb only under spec/|test/ — where bare rspec/rake actually discovers it; a co-located test fails A1 LOUD, not vacuously green
      prepare: "bundle install" }];
  },
};
```
*No-signal note:* emitting `{ test: { unavailable: true } }` honors the operator's "never claim verified if a gate couldn't run" choice and surfaces `untested-merge-risk` at verify. **Trade-off flagged for the implementation review:** a pre-set `{unavailable:true}` is *skipped* by `resolveCommands` (`:23`), so an **interactive** operator is not prompted to supply a test command (they'd edit `profile.json`); the alternative — omitting the `test` key — would let interactive setup prompt while headless still degrades to unavailable. Plan ships the operator's literal choice (`{unavailable:true}`); confirm at crux whether interactive-prompt is preferred.

- [ ] **Step 1: Failing tests.**
  - `ruby.test.ts`: no `Gemfile` → `[]`; `Gemfile` + `.rspec` → `test: "bundle exec rspec"`; `Gemfile` + `spec/` dir → `bundle exec rspec`; `Gemfile` + `Rakefile` (no rspec) → `bundle exec rake test`; `Gemfile` only (no rspec, no Rakefile) → `test: { unavailable: true }`. Every case: `prepare: "bundle install"`, `testFilePattern: "_(test|spec)\\.rb$"`, `kind: "ruby"`, `paths: ["**"]`.
  - `components.test.ts`: a `ruby` component routes `src/a.rb` / `x.rake` / `y.gemspec` via `matchesComponent`; does **not** match `a.py`.
  - `profile.test.ts`: a `Component` with `prepare` round-trips through `parseProfile` (genuinely red — zod strips `prepare` until the schema add).
  - `discover.test.ts`: `mergeComponents` **preserves** the scanned `prepare`; an agent proposal cannot introduce `prepare` (not in `DiscoverSchema`) — genuinely red until the carry lands.
  - `detect-components`/engine test: a detector emitting `prepare: "x && y"` **throws** the Invariant-1 engine error (`&&` ∈ FORBIDDEN) — genuinely red until the backstop extension.
  - confirm-block test: the approval screen prints a `prepare:` stored-not-run line.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `ruby.ts` + the Decision-A plumbing + `ruby` ext entry + registry + unrooted entry.
- [ ] **Step 4: PASS** + full suite + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(setup): Ruby LangDef + detect-only prepare command class (WO-3)`

### Task 2 — PHP `LangDef` + ext map + `testFilePattern` + registry + unrooted warning

**Files:** new `src/setup/lang/php.ts`; `components.ts` (`EXTENSIONS_BY_KIND` += `php`); `registry.ts` (wire `phpDef`); `detect-components.ts` (`TARGETED_LANG_MANIFESTS` += `["php", ["composer.json"]]`). Tests: new `test/setup/lang/php.test.ts`; extend `components.test.ts`.

**Detector shape — Pest-before-phpunit (composer dep OR `tests/Pest.php`):**
```ts
function usesPest(repoDir: string): boolean {
  if (existsSync(join(repoDir, "tests", "Pest.php"))) return true;   // review fix: config-file signal
  try {
    const j = JSON.parse(readFileSync(join(repoDir, "composer.json"), "utf8"));
    return Boolean(j.require?.["pestphp/pest"] ?? j["require-dev"]?.["pestphp/pest"]);
  } catch { return false; }   // malformed composer.json → fall through to phpunit
}
export const phpDef: LangDef = {
  kind: "php",
  detect(repoDir) {
    if (!existsSync(join(repoDir, "composer.json"))) return [];
    return [{ name: "php", kind: "php", paths: ["**"],
      commands: { test: usesPest(repoDir) ? "./vendor/bin/pest" : "./vendor/bin/phpunit" },
      testFilePattern: "(^|/)tests?/.*Test\\.php$",   // anchored: A1 only credits a *Test.php under tests/|test/ — where bare phpunit actually discovers it; a co-located test fails A1 LOUD, not vacuously green (see Task-2 crux reversal below)
      prepare: "composer install" }];
  },
};
```
*Script-runner note (review fix #2):* **both** `./vendor/bin/pest` and `./vendor/bin/phpunit` are `./`-prefixed → `isScriptRunner` true → `resolveCommands:38-41` emits the "shell script — Bash scope cannot be tightened" warning **for every PHP component**, not just Pest. State this and assert it in both test cases.

- [ ] **Step 1: Failing tests.**
  - `php.test.ts`: no `composer.json` → `[]`; `composer.json` (no pest dep, no `tests/Pest.php`) → `./vendor/bin/phpunit`; `pestphp/pest` in `require` → `./vendor/bin/pest`; `pestphp/pest` in `require-dev` → `./vendor/bin/pest`; `tests/Pest.php` present (no composer dep) → `./vendor/bin/pest`; malformed `composer.json` → still detected, defaults to phpunit. Every case: `prepare: "composer install"`, `testFilePattern: "(^|/)tests?/.*Test\\.php$"` (anchored — see review-fix #1). Assert the script-runner warning fires for **both** the pest and phpunit branches (via `resolveCommands`). Plus a durable `isTestFile` contract: `tests/FooTest.php` → true, `src/CalculatorTest.php` → **false** (the cardinal-sin guard).
  - `components.test.ts`: `php` component routes `src/a.php` (incl. `src/CalculatorTest.php`, which matches by the `.php` **extension** — `testFilePattern` is not consulted by `matchesComponent`); does **not** match `a.rb`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `php.ts` + `php` ext entry + registry + unrooted entry.
- [ ] **Step 4: PASS** + full suite + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(setup): PHP LangDef + file-identity extensions + prepare (WO-3)`

### Task 3 — Node `prepare` + the inertness contract proof

The Decision-A plumbing landed in Task 1; this task adds Node `prepare` (Decision B) and proves the class is genuinely inert.

**Files:** `src/setup/lang/node.ts` (add `prepare: "npm install"` to each emitted component). Tests: `test/setup/lang/node.test.ts`; `test/dispatch/components.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `node.test.ts`: each emitted Node/SvelteKit component carries `prepare: "npm install"` (genuinely red until added).
  - `components.test.ts` — **the inertness contract:** `realRunnerCommands` / `scopedRunnersForFiles` of a component with `prepare: "npm install"` (+ `commands.test`) returns **only** the check-type command — `prepare` is **absent** from the implement Bash allowlist. *(Regression guard — passes pre-change because no field is read; keep it as the durable contract that `prepare` never leaks, not a red→green step.)*
- [ ] **Step 2: Run** (node.test red; the allowlist guard already green — that's expected).
- [ ] **Step 3: Implement** Node `prepare`.
- [ ] **Step 4: PASS** + full suite + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(setup): Node prepare (npm install) + inertness contract (WO-3)`

---

## Review fixes folded in

1. **Explicit per-stack `testFilePattern`: PHP `"(^|/)tests?/.*Test\\.php$"` + Ruby `"_(test|spec)\\.rb$"`** (adversarial #2, then **revised by the Task-2 Opus crux + operator decision**) — A1's `DEFAULT_TEST_FILE` matches PSR `*Test.php` only via a `tests/` dir anchor, so an explicit pattern was needed. The plan first chose the *broad* `Test\\.php$`; the Task-2 crux found that broad pattern + bare `./vendor/bin/phpunit` (which discovers only `tests/`) opens a **silent vacuous pass** — A1 credits a co-located `src/CalculatorTest.php` that phpunit never runs → green having executed nothing. **Operator reversed to the anchored form** (`(^|/)tests?/.*Test\\.php$`): A1 credits only a `*Test.php` under `tests/`|`test/`, where bare phpunit actually runs it; a co-located-only test fails A1 **loud** rather than passing vacuously — honoring "silent under-verify = cardinal sin; loud over-verify = acceptable." Commit `fix(setup): anchor PHP testFilePattern…`. **Then the whole-branch review found the SAME vector in Ruby** (bare `rspec`/`rake test` discover `spec/`|`test/` only); operator chose to anchor Ruby symmetrically → `(^|/)(spec|test)/.*_(test|spec)\\.rb$` (commit `fix(setup): anchor Ruby testFilePattern…`). Both stacks now carry a durable `isTestFile` contract test incl. the cardinal-sin guard (a co-located test → `false`). (`testFilePattern` is carried by `mergeComponents:42`.)
2. **PHP script-runner warning fires for both branches** (feasibility) — pinned in both `php.test.ts` cases; stated that all PHP components are un-tightenable in the implement Bash scope.
3. **`prepare` shown at the operator approval gate** (adversarial #3) — `cli/setup.ts:147` extended to print a `prepare:` stored-not-run line.
4. **"Ruby/PHP verify inert until WO-12" stated loudly** (adversarial #4) — in Scope/Out; PHP's `./vendor/bin/X` is a hard-absent path without install.
5. **Ruby no-signal → `{ unavailable: true }`** (adversarial #1, operator decision) — no fabricated `rake test`; surfaces `untested-merge-risk`.
6. **PHP Pest detection also counts `tests/Pest.php`** (open-Q4) — config-file signal in addition to the composer dep.

## Self-review notes

- **File-identity first (the Phase-3 contract):** both detectors ship their `EXTENSIONS_BY_KIND` entry in the same task as the detector — no path-only window, no folder-glob rework. The adversarial reviewer confirmed the agent-kind-drift hole is closed for the new kinds (extensions materialized at scan, carried verbatim by `mergeComponents:44`, independent of agent `kind` drift).
- **`prepare` inert by construction (Decision A):** invisible to every gate path (check-type-keyed), absent from the implement allowlist (`realRunnerCommands` iterates `commands` only), agent-unauthorable (not in `DiscoverSchema`), machine-safety-checked (extended Invariant 1), and now **shown at the sign-off gate**. Task 3's allowlist test is the durable contract.
- **Mirrors landed shapes:** root-only N=1 + test-only = the Python/Go shape; optional-field + `mergeComponents`-carry + Invariant-1-backstop = the `extensions` precedent (WO-5). Low novelty.
- **Test ladders are signal-gated + operator-correctable:** Ruby never fabricates a vacuous gate; PHP defaults to phpunit (fails *loud* — 127 without install, not a vacuous pass). `resolveCommands` lets a human correct either.
- **Documented residual gaps (not silent drops):** gemspec-only gems without a `Gemfile` aren't detected (Gemfile is the app standard); a `Rakefile` whose `test` task is empty can still vacuously pass (bounded — there's at least a Rakefile expressing intent; operator-correctable); python/go/jvm/rust `prepare` deferred to a flagged fast-follow.
- **No `schemaVersion` bump:** `prepare` is optional/additive; existing v3 profiles parse unchanged.
