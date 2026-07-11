# Verify-gate redesign (Option B) — detector/build gate + test-pinning gate

**Status:** Design (brainstorm output) — approaches approved by the operator (detector gate = **A+B**, test gate = **T-min**); pending written-spec review + independent review. Isolated on branch `feat/verify-gates` (off `main`), deliberately separate from the CL-BASELINE `inconclusive` work on `feat/verify-differential-brainstorm`.
**Date:** 2026-07-06
**Scope:** two load-bearing verify-gate changes surfaced by the bench (darkreader-7241, astropy-12907) and the §13 "gate model reconsidered" analysis — (1) stop gating on packaging builds; gate a real typecheck instead; (2) strengthen the test gate from "a test file exists" to "the agent's new test actually depends on the change." Plus a lighter third piece (pre-warm) sketched for later. **Does NOT build** the CL-BASELINE `inconclusive` verdict (Option A, deferred — its review found soundness gaps and unproven residual value).
**Builds on:**
- `docs/brainstorms/2026-07-05-verification-as-differential-inference-design.md` §13 (the gate model reconsidered) — this doc is the Option-B execution of that analysis.
- `docs/design/2026-06-30-polyglot-setup-verify-frozen-design.md` — the detector registry, the deferred method-level TIA rung, the pilot-gated CI-reading, the T1 cost fulcrum.
- `CLAUDE.md` invariants: ground truth over self-report; loop-not-halt; over-verify-never-under-verify.

---

## 0. Why this, not CL-BASELINE

The two bench blocks each have a **cheaper, higher-certainty fix** than the general `inconclusive` verdict:
- **darkreader** blocked because styre hard-gates on `npm run build` — a *release-packaging* step the project's own CI never runs. Fix: don't gate packaging; gate a real typecheck. **Detector-side, no control-loop change.**
- The agent also wrote **junk placeholder tests** that styre's A1 gate ("a test file exists") waved through. Fix: require the agent's new test to actually depend on the change. **A strengthened test gate.**
- **astropy** blocked on a slow harness — a *provisioning* problem (pre-warm), not a verdict problem.

The two gates fix **two different darkreader problems** and are independently valuable. CL-BASELINE's unique residual value (a *genuine* pre-existing failure) is unproven by the bench and its `inconclusive` verdict has soundness gaps (it just relocates the block to the project's CI, has no resolver "third state," and the OSS headless path has no human before the PR). So Option B ships the cheap, certain wins first.

---

## 0b. External evidence — competitor scan (2026-07-07)

A wide scan of open-source SWE agents and CI test-impact tools (sources in the 2026-07-07 changelog entry) corroborates this design's direction:
- **The winning agent pattern is a reproduction test (fail→pass) + a base-passing regression subset — never the whole hidden suite** (Agentless, Moatless, SpecRover). That is exactly T-min's shape (the agent's test must go *red* on the base) sitting on the "over-verify, never under-verify" floor.
- **"Don't gate on packaging builds" matches the field:** a build failure is a hard block *"by convention, not construction"* — agents lean on prompt discipline; almost none gate structurally on a packaging build. Option B's typecheck-not-packaging is the principled version.
- **Baseline-diffing is real but lives in the CI platform** (GitLab new-vs-fixed, Datadog/Trunk flaky quarantine) and needs flakiness handling (re-run N, quarantine) to be sound — reinforcing the deferral of the heavyweight CL-BASELINE differential until method-level TIA + flakiness are solved (§9.1/§9.3 of the differential doc).
- **Ground truth over self-report** is the field's north star (Devin/Codex push the verdict to real CI) *because* a model that writes and grades its own test is contaminated — the honest ceiling on T-min (it raises the floor, not the ceiling).

---

## 1. The two deep-dives (what the code actually does)

### 1.1 Detector / build gate

- `build` is emitted by only **5 of 8** detectors (node, rust, go, jvm-maven, jvm-gradle). **Python/Ruby/PHP emit no build** — tests are the only compile/execution gate.
- The compiled languages are already fine as type-gates: `cargo build`, `go build ./...`, `mvn -q -DskipTests compile` are compiles; only **gradle** (`gradle build -x test`) also does jar/dist **assembly**.
- **The whole problem is node.** `node.ts` stores the literal string `"npm run build"` and runs it *blindly* — it never sees whether the script is `tsc` (typecheck), `vite`/`rollup`/`webpack` (bundler), or `electron-builder`/`zip` (packager). No detector synthesizes a native typecheck (`tsc --noEmit`, `cargo check`, `go vet`), and only node emits `check` — and only when a script is *literally named* `check`.
- **Gate-hardness (traced):** `build` runs **only** at `verify:integration`, where it is a **HARD gate** across every component (a non-zero exit throws → loopback), *if* a real command resolves (`{unavailable}` is skipped). So a node packaging build is a hard merge gate today. `test` is hard at both `verify:check` and `verify:integration`. `check` is hard at `verify:check` when real, advisory when `{unavailable}` (the reviewer-only degrade — this is why darkreader's `check:{unavailable}` didn't block).
- **CI-reading** (which would reveal darkreader gates on `test:ci`+`lint`, not `build`) is read **only** to detect `checksSystem: github|none` — contents are never parsed. It is the frozen design's *preferred* answer but **pilot-gated and unbuilt** (§13 #4 of the frozen doc).

### 1.2 Test / pinning gate

- `behavioral` is an **agent self-classification** at `design:extract`, gated only for internal consistency (a `test_plan` must be present) — never re-derived from ground truth. So the escape for un-pinnable work is untrustworthy: an agent can dodge a pinning gate by declaring `behavioral=0`.
- **A1 today** = whole-suite test command green **AND** ≥1 owned changed file classifies as a test file (a path regex, `isTestFile`). It never runs, names, or isolates the added test. Test *goodness* is deliberately the reviewer's job (S5).
- Test identification is **file-level only** — styre can tell *which files* are test files, but not which test *case/function* was added, nor added-vs-modified, nor whether the test is new at all.
- **No test-selection and no test-output parsing exist anywhere** — every stack runs a whole-suite alias yielding one exit code. So "run just the new test" and "know *why* it failed" are both net-new, per-language, for all 7 stacks.
- **No base-tree run exists** — `base_sha` is used only as a diff endpoint, never a checkout target.
- Sharpest obstacle for a naive fix-pinning gate: on the base tree a *new-feature* test fails by **compile/import error** (the symbol doesn't exist yet), not assertion — and styre can't tell them apart. (Softened for the bench: astropy/darkreader are **bugfixes** → clean assertion failures.)

---

## 2. Design 1 — Detector / build gate (A + B) `[APPROVED approach]`

**Principle:** a build gate is defensible only as a *check-only compile* (a typecheck), never as packaging. Where a language's `test` already compiles, the typecheck is additive (it also covers untested code); where it doesn't (JS test runners transpile without typechecking), the typecheck is the *only* static net.

**Per-language changes (setup/detector time):**

| Lang | Change |
|---|---|
| **node/TS** (the core) | Read the `build` **script body** (the detector already parses `package.json` scripts). Classify: `tsc`-only → typecheck (keep as a gate); contains `webpack`/`rollup`/`vite`/`esbuild`/`electron`/`parcel`/`zip`/`next build` → bundler/packager. For the *check* slot prefer a script named `typecheck`/`check`; else synthesize `tsc --noEmit` when `tsconfig.json` exists. |
| **rust** (B) | `cargo check` instead of `cargo build` — same type signal, cheaper. |
| **go** | Keep `go build ./...` (typecheck-equivalent); optionally add `go vet` as an additive check. |
| **jvm-maven** | Already `mvn compile` (compile-only) — no change. |
| **jvm-gradle** (B) | Compile-only task (`classes` / `compileJava` / `compileKotlin`) instead of `gradle build -x test` — drops jar/dist assembly. |
| **python/ruby/php** | No build slot — unchanged. Native typecheckers (`mypy`/`sorbet`/`phpstan`) are not ecosystem-guaranteed → **deferred**, not in scope. |

**Gate-hardness rule (the darkreader fix, by construction):**
- A **real typecheck** (a `tsc`/`check` script, synthesized `tsc --noEmit`, `cargo check`, `go build`, `mvn compile`, gradle compile-only) → **hard gate**, as today.
- An **opaque or packaging build** → **advisory only**: it may run, a red result is surfaced in the PR body (via the existing advisory-sweep / `untested-merge-risk`-style path), but it **never hard-blocks a merge**. `[operator decision: advisory, not fully-ungated]`

**Deferred (named):** CI-reading (learn the project's actual gates — the frozen design's pilot-gated north star); native typecheckers for Python/Ruby/PHP.

---

## 3. Design 2 — Test-pinning gate (T-min: the junk-catcher) `[APPROVED approach]`

**Goal (narrowed, honestly):** *not* "prove the test is good" (the reviewer's job) but **"prove the agent's new test actually depends on the change"** — catch darkreader's tautological `expect(true).toBe(true)`.

**The mechanic (whole-suite delta on the base — no test-selection, no output-parsing):**
1. **Legibility precondition:** run the whole test suite on the **base tree** (`base_sha`, provisioned). If it is **not green**, the base is illegible → the pinning check is **skipped/advisory** (surface a caveat; do not false-fail — you cannot attribute redness on a broken base). *(This reuses the "legible base" idea and inherits its cost.)*
2. **Split the unit's cumulative diff** into test-file changes vs source changes — file-level path classification (`isTestFile`), which styre already has.
3. **Apply the test-file changes *only* onto the base** (checkout `base_sha`, then take just the test files from HEAD) — base + new test, *without* the source fix.
4. **Run the whole suite** on that tree.
5. **Verdict:**
   - suite **red** → the new test fails without the fix → it **pins the change** → **PASS the gate**. *(Red for any reason — assertion or compile-error — proves dependence, so the compile-on-base ambiguity is moot here.)*
   - suite **green** → the test passes without the fix → it **pins nothing** → **FAIL the gate** → route to implement: *"your test passes without your change; make it exercise the change."* (A new atlas row, sibling to I5.)

**When it runs:** as the strengthened behavioral test gate (extends A1), for `behavioral=1` units, on the unit's cumulative diff, after the normal (HEAD) test passes.

**What it catches / doesn't:**
- **Catches:** tautological / no-op / unrelated tests that pass on the base (darkreader). This is the one failure mode where a pinning check is strictly additive.
- **Does NOT catch (stays the reviewer's job):** a test that *does* fail-without-fix but asserts the *wrong* thing (test-gaming). T-min raises the floor, not the ceiling.
- **Escape hatch limit (named):** the gate only fires for `behavioral=1`, which is agent self-classified and untrustworthy — an agent can dodge by declaring `behavioral=0`. Tightening that classification is **out of scope** here (a separate follow-on).

**Cost (honest):** two extra base runs per behavioral unit (base-suite legibility + base+test-only). For heavy harnesses (astropy) this is expensive — the same base-run cost / T1 fulcrum that made us defer CL-BASELINE. Mitigations for the plan: cache the base-suite-green result per `base_sha`; only run for behavioral units; consider whether the base+test-only run can reuse the legibility run's environment.

**Shared primitive:** T-min needs a **base-run** capability (checkout `base_sha` into a provisioned worktree + run a command) that does not exist today. This is the same primitive CL-BASELINE would have needed — building it here is reusable if Option A is ever revisited.

---

## 4. Pre-warm (the simpler third piece) — sketch, not yet deep-dived

Not deep-dived this session (operator: "pre-warming should be simpler"). Sketch for a later, lighter spec: extend the `provision` step so a heavy harness pre-builds its environments under the 15-min `PROVISION_TIMEOUT_MS` (e.g. `tox --notest` / `tox -e <envs> --recreate --notest`), so the subsequent `verify` run reuses them and stays under the 10-min `VERIFY_TIMEOUT_MS`. This is what actually rescues astropy (a green→green verify over a pre-warmed env), consistent with the conda-denial (you still run real tox, just pre-built). Firm up separately.

---

## 5. Open questions / risks / deferred

1. **★ Base-run cost (T-min).** Two base suite runs per behavioral unit re-raises the T1 fulcrum. Must be measured + cached; heavy harnesses are the worst case (and overlap with the pre-warm work).
2. **Behavioral self-classification.** T-min's escape (`behavioral=0`) is agent self-report; tightening it (ground-truth behavioral detection) is a named follow-on, not in scope.
3. **node build-script classification** is a heuristic (token match on the script body). A build script that both typechecks and bundles is ambiguous → default to advisory (never hard-block) — the safe direction.
4. **Deferred:** CI-reading (frozen design's pilot); native typecheckers (mypy/phpstan); the full fix-pinning gate (T-full — test-selection + output-parsing per stack); tightening behavioral classification; and CL-BASELINE `inconclusive` (Option A).
5. **Invariants held:** typecheck-as-gate + T-min are both ground-truth (exit codes), deterministic, and *raise* the over-verify bar (T-min catches junk the current gate ships); the advisory demotion of packaging builds is the only relaxation, and it is exactly the false-block the §13 analysis identified.

---

## 6. Evidence appendix (deep-dive, file:line)

**Detector gate:** `build` emitted only by node/rust/go/jvm (`src/setup/lang/{node.ts:32-34, rust.ts:64/76, go.ts:15, jvm.ts:15/35}`); python/ruby/php emit none (`python.ts:93/111`, `ruby.ts:22`, `php.ts:30`). node stores literal `"npm run build"`, never inspects the body. Only node emits `check`, on a literal `check` script (`node.ts:34`). `resolve-commands.ts:4,30-35` forces build/test/check → `{unavailable}` headless (darkreader's `check:{unavailable}`). Gate sites: `verify:integration` runs `build`+`test` per component, first non-zero throws (`handlers.ts:809-858`, `:815`, `:856`); `verify:check` three-way resolution (`:644-745`), `{unavailable}`→reviewer-only degrade (`:679-699`). CI touched only at `detect.ts:40-53` (existence, not contents).

**Test gate:** `behavioral` set by agent at extract (`extract-schema.ts:11,123-128`), persisted `handlers.ts:238`. A1 gate `handlers.ts:718-744` (whole-suite green + `isTestFile` presence over owned files). `isTestFile` = path regex (`test-file.ts:4-12`). Diff is file-level (`worktree.ts:55-70`). Whole-suite commands, one exit code, no selection/parsing anywhere (`run-command.ts:26-51`; grep for selection syntax → zero). No base-checkout run (`base_sha` only a diff endpoint, `handlers.ts:338`). Deferred TIA rung: frozen design `:219,228`.

---

## 7. Changelog
- *2026-07-07 (v2)* — added §0b external-evidence note from a wide open-source competitor scan (SWE-agent, OpenHands, Aider, Agentless, Moatless, SpecRover; jest `--findRelatedTests`, pytest-testmon, Ekstazi, Google TAP/Meta predictive selection; GitLab/Datadog/Trunk baseline+flaky handling). Corroborates typecheck-not-packaging, T-min's repro+base-passing shape, and the deferral of the heavyweight CL-BASELINE differential (baseline-diffing is real but CI-layer and needs flakiness handling). No design change — evidence only. (Scan run during the 2026-07-07 design-loop-convergence brainstorm; the operator chose to *align* today's SWE-bench re-run findings with this existing design rather than supersede it.)
- *2026-07-06 (v1)* — Option B design after two code-grounded deep-dives (detector gate, test gate). Operator approved detector = A+B (typecheck-not-packaging; opaque build advisory; cargo check; gradle compile-only) and test = T-min (junk-catcher: test-only-on-base must go red, over a legible base). Pre-warm sketched for a separate lighter spec. CL-BASELINE (Option A) and the full fix-pinning gate (T-full) deferred.
