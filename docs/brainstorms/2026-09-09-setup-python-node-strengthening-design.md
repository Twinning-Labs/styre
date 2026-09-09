# Strengthening `styre setup` — Python and Node

**Status:** Design (brainstorm output), **v2** — restructured after an independent three-lens review (fact-check / adversarial / cross-doc alignment). The review **reversed this design's central decision**; see §3. Pending operator sign-off, then implementation plans (one per piece).
**Date:** 2026-09-09
**Scope:** what `styre setup` detects, what gets proven, where, and what is recorded — for **Python and Node/JS/TS only**, except where a change is structurally all-languages (§5.5).
**Deliberately reopens:** the polyglot detection freeze (`docs/brainstorms/2026-06-30-polyglot-setup-verify-frozen-design.md`), for these two stacks only. The freeze is what left `pythonDef` unable to emit a `check` command at all. A decision, not a side effect.
**Supersedes:** v1 of this document (same path, prior commit). v1's DEC-5 — "setup provisions and proves" — is **withdrawn as unsafe and incorrect** (§3.1).

---

## 1. Origin — what the 2026-09-08 astropy run actually exposed

styre produced the **correct fix** for `astropy__astropy-12907` (the blind A/B reviewer, unaware which candidate was styre's, recorded that both "make the identical correct core fix"). Its verification was worthless anyway.

```
⚠ python: no build command — styre cannot ground-truth-build this stack.
⚠ python: no check command — styre cannot ground-truth-check this stack.
test          fail    pytest --pyargs astropy docs
integration   fail    pytest --pyargs astropy docs
```

Three defects:

1. **A meaningless warning and a real one, at equal severity.** A pure Python library has nothing to build. "No check command" is a real gap — no fast deterministic gate exists, because `pythonDef` cannot emit one. Emitting both identically is how an operator learns to skim warnings.
2. **The only gate was slow and unreliable**, so a red result was both uninformative and unavoidable.
3. **Nothing validated the command.** `discover.ts:63` accepts an agent proposal on `isCommandSafe && probeCommandExists && trusted`. None of the three asks whether the command produces a usable signal.

**Correction to v1's origin story.** v1 claimed astropy's failure was a missing `[test]` extra in `pip install -e .`. That is unsupported: `pythonTestCommand` checks `tox.ini` **first** (`python.ts:7`), astropy ships one, so the detected command was `tox` and `pythonPrepare` returned `pip install tox` — the `pip install -e .` branch was never taken. Extras remain a real defect (D3) but were not astropy's cause.

**Defect 3 is the cause, and it is the cheapest thing here to fix.** That reordering drives §5.

## 2. What the current design is

`LangDef.detect(repoDir) → ComponentDraft[]` (`lang/types.ts:7-10`) is synchronous and filesystem-only. `resolveCommands` then fills unfilled `MUST_HAVE` slots with `{unavailable:true}` and warns.

Setup is **not** entirely side-effect free — `probeCommandExists` spawns `command -v` (`discover-schema.ts:68`). The accurate narrow statement: **setup never runs a candidate command to see whether it produces a usable signal.**

### 2.1 Verified defects

Each verified against `main`. Locations are as-checked; v1's citations drifted by 1–3 lines and are corrected here.

| # | Defect | Where | Layer |
|---|---|---|---|
| D1 | Python emits **only** `test`. Never build/lint/typecheck. | `lang/python.ts:93`, `:111` | detector |
| D2 | `pythonTestCommand` returns a bare runner from four `existsSync` calls. `pyproject.toml` is read only for `/\[tool\.pytest/` presence. No `testpaths`, no `addopts`, no `setup.cfg`, no uv/hatch/pdm. | `lang/python.ts:7-20` | detector |
| D3 | `pythonPrepare` emits `pip install -e .` with no extras; `[project.optional-dependencies]` is never read. | `lang/python.ts:22-34` | detector |
| D4 | **Node resolves the package manager then ignores it.** `nodePrepare` reads the lockfiles; commands hardcode `npm run`. | `lang/node.ts:7-12` vs `:32-34` | detector |
| D5 | Node reads three hardcoded script names. No lint, no typecheck, no `test:unit`. | `lang/node.ts:32-34` | detector |
| D6 | Node's root `paths` are hardcoded `["src/**","static/**","package.json"]` — Tauri/SvelteKit shaped. | `lang/node.ts:44` | detector |
| D7 | Workspace members are not skipped despite the comment saying so; `findManifests` has no workspace logic. Cost is duplicate/overlapping components. | `lang/node.ts:18`, `manifests.ts:24-38` | detector |
| D8 | `findManifests` walks to `maxDepth = 3`, missing e.g. `apps/web/packages/ui/package.json`. | `manifests.ts:24` | detector |
| D10 | Provision treats every Python component as never-ready, so `pip install -e .` runs on every provision — including over a prepared conda env. | `provision.ts:34` | run path |
| D11 | The environment-reuse probe runs at **verify** time, after provision already reinstalled. | `reuse.ts`, called only from `handlers.ts:1344`, `:1521`; resolver gates provision first at `resolver.ts:134-142` | run path |
| D12 | `tsc --noEmit` / `eslint .` fail `probeCommandExists` (devDependencies, not on PATH), so `discover.ts` **rejects** good agent proposals — silently, since neither warning branch fires for a probe-only failure. | `discover.ts:63-77`, `discover-schema.ts:55-68` | discovery |
| **D13** | **`src/setup/detect.ts` already contains `detectPackageManager` (incl. bun), `KNOWN_SCRIPTS = ["test","build","lint","typecheck"]`, and `detectCommands` emitting `` `${pm} run ${name}` `` — and `probe.ts` imports only `detectChecksSystem`. The better implementation is orphaned; `node.ts` reimplemented a worse one.** | `detect.ts:7-36` vs `probe.ts:6` | detector |
| **D14** | `frameworkFor` reverse-engineers the framework by regexing the command string and returns `null` for bare `npm test` (and for `pnpm run test:unit`). `null` → M2b records the AC check as coarse **`error`**. Node AC checks are broken today for the common case. | `check-selector.ts:50-62` | verify |
| **D15** | `nodePrepare` has **no `bun.lock` branch at all**, and `NODE_INSTALL_MARKERS` has no bun entry. Bun is unhandled end-to-end in prepare. | `lang/node.ts:7-12`, `provision.ts:18` | run path |

**Withdrawn from v1.** *D6's second half* — "`kind` flips to `sveltekit` even for nested packages" — is **false**: `node.ts:41` reads `kind: isRoot && fe ? …`, and the `isRoot &&` guard means a nested package never inherits it. *D9* — "`testFilePattern` unset means `isTestFile` has no pattern for these stacks" — is **false**: `test-file.ts:4-8`'s `DEFAULT_TEST_FILE` already covers `tests?/`, `specs?/`, `__tests__/`, `.test.`/`.spec.` (with `[cm]?[jt]sx?`), `_test.<ext>` and `test_*`.

## 3. What the review changed

### 3.1 DEC-5 is withdrawn — setup stays read-only

v1 decided setup would run `prepare` and prove every gate. That is **unsafe** and **incorrect**, on two independent grounds.

**Unsafe.** `styre setup` operates on the real repo, and `setup.ts:159` prints to the operator, verbatim: `prepare: ${c.prepare} (stored, not run)`. `probe.ts:16` documents it as "Pure of side effects except reading the repo." Executing `pip install -e .` (which runs arbitrary `setup.py`), `npm ci` (which **deletes** `node_modules`), or `uv sync` against the operator's ambient interpreter breaks that contract. The ordering cannot be repaired: the approval gate (`setup.ts:149-169`) shows the command list and requires `y`, but proving requires `prepare` to have already run — *before* the operator approved anything. And that gate is `if (interactive)`, so the bench path (`--trust-agent-commands`, headless, explicit repo argument) skips both it and the `.styre-disposable` marker check. The codebase built `assertInPlaceSafe` for exactly this hazard; v1 routed around it.

**Incorrect.** `probe.ts:22` sets `targetRepo = resolve(repoDir)`. Verify runs at `join(worktreePath, c.dir ?? "")` — a different path in the default (non-`--in-place`) mode. `pythonEnvReady`'s correctness property is that `import <name>` resolves **under `absCwd`**; a proof taken against `targetRepo` is *provably false* in the worktree. A `proven` flag recorded at setup is meaningless for the majority run mode, with no staleness model to catch it.

The Cursor/Factory research that motivated DEC-5 stands (§4). Its conclusion was transplanted into the wrong layer: it holds in `--in-place` mode, where `targetRepo` *is* the worktree — which is the case that was in mind. Placing the work in `provision` covers both modes.

**Consequences.** No `--no-prove` flag. **No `schemaVersion` bump** — proof results are per-run and belong in a signal, not `profile.json`. v1's claim that this touched both `schema.sql` copies was a category error: `schemaVersion` is a `profile.json` field (`profile.ts:116`) with **zero** occurrences in either `schema.sql`.

### 3.2 Other corrections carried in

- **`testpaths` is demoted from centrepiece.** pytest already reads `testpaths` from rootdir config when invoked with no path arguments, so the existing `python -m pytest` fallback honours it; transcribing it into the command string buys nothing functionally. And astropy's own `[tool:pytest]` declares `testpaths = "astropy" "docs"` — the same two paths as the failing command — so the agent most likely transcribed them and the "fix" would regenerate the broken command. **Requires verification against the real astropy tree before any implementation relies on it** (§9.1).
- **"Scoped" is struck from DEC-2.** Nothing consumes a collected count, and §7 rules out narrowing. Setup/proof establishes **runnable and non-empty**, not scoped.
- **The proposed `testFilePattern` additions are dropped.** They would be regressions: the proposed Node regex drops `test/` directories and `.mjs`/`.cjs`/`.mts`/`.cts`, all covered by the default. `php.ts` and `ruby.ts` narrow deliberately so A1 fails loud; adding patterns *tightens* A1 (`handlers.ts:1430-1437` → `behavioral-no-test` → loopback), which v1 presented as gap-filling.
- **§7.1's "only regression signal" is withdrawn** — this design adds a typecheck gate, which the differential doc explicitly nominates as "an optional typecheck as a whole-tree net for untested code."

## 4. Prior art — and what OSS can take

**Cursor** (`.cursor/environment.json`) runs `install` when a *Build* is created, ahead of agent start, and requires it to be **idempotent** because it runs for every build on possibly-prepared disk. **Factory** (Droid Computers) keeps whole environments persistent between sessions.

Both make the prepared environment a durable artifact built once. The true snapshot is assigned to the commercial plane by the differential doc's §10 ("managed environment provisioning"), and OSS `styre run` is one-shot with ephemeral state.

What OSS can take is the **idempotent, discover-before-rebuild** half — and the observation that **container mode already has the snapshot**: running in-place inside a SWE-bench image, the image *is* the prepared environment. That is exactly the case D10 currently breaks by reinstalling over it.

## 5. Four independent pieces

Each ships and reverts alone. They are ordered by value-per-risk, not by dependency.

### P1 — Detector improvements (pure, no execution, no schema change)

Fixes D1–D8, D13, D15. Pure functions over the filesystem, covered by the existing fixture-tree unit tests. Zero run-path blast radius. **Most of this document's value lives here**, and it is the piece that can land this week. Detail in §6.

### P2 — Command validation at discovery

Fixes D12 and **§1 defect 3 — astropy's actual cause**. When `discover.ts` is about to accept an agent-proposed command, run a bounded probe and reject it if it collects nothing. Two sub-parts:

- **Fix the probe first.** `probeCommandExists` special-cases `^npm run` (`discover-schema.ts:57`) and otherwise falls back to `command -v <first token>`. So `pnpm run lint` is accepted whenever `pnpm` exists, script or not; and `tsc --noEmit` is rejected though it is a valid devDependency invocation. The probe must understand every resolved manager's script list and `node_modules/.bin`.
- **Then add the emptiness gate.** Reject on "collects zero", never on "exits non-zero" — a command that runs and fails is exactly darkreader, and judging that is the differential design's job (§7).

Self-contained, roughly the size the review estimated, and the highest-value single change here.

### P3 — Discovery before build, inside `provision`

Fixes D10 and D11 together. `planProvision` consults the environment probe **before** emitting an install action; a component whose environment provably tests the worktree source is not reinstalled.

Path-correct by construction (it runs in the worktree the run will use), never stale (per run), no schema bump, and mutates nothing the operator owns. This is where v1's DEC-6 belongs.

#### P3.1 — Split the probe's two questions

`pythonEnvReady` currently ANDs two checks that answer different kinds of question, and the AND is what makes it brittle. They separate:

- **Q1 — the correctness precondition.** Does `import <name>` resolve to a file **under the component's dir**, checked from a tempdir outside it so `sys.path[0]` cannot false-pass a shadowed copy? This asks *am I editing what I am testing*. A `false` here means the environment is not usable for this worktree at all.
- **Q2 — the readiness observation.** Does the suite collect? This asks *will the tests run*. It is informative, not a correctness property.

**Only Q1 gates the reuse decision.** Q2 becomes an observation that feeds P4's proof and the verify-time picture. Joining them with AND conflated a hard requirement with a soft one, and let the soft one trigger the hard consequence.

#### P3.2 — A failing probe must not be destructive

The harm is asymmetric: **reusing a wrong environment produces wrong answers; reinstalling over a right one only costs time.** So Q1 stays strict — no thresholds, no partial credit — and what changes is the *consequence* of a negative answer.

| Q1 | Q2 | Action |
|---|---|---|
| pass | pass | Skip `prepare` entirely. Gate recorded `proven`. |
| pass | fail | **Bounded additive repair**, then re-ask Q2 once. Never a full rebuild — Q1 already proved the package is installed against this source, so what is missing is test dependencies or plugins, not the install. |
| fail | — | The environment does not test this source. Full build path, as today. |

The repair MUST be **additive, idempotent, and attempted exactly once**. Its exact form is manager-specific and is an implementation decision; the architectural constraint is that it adds what is missing rather than rebuilding what exists, and that a second failure records `unprovable` with the reason and continues (loop-not-halt) rather than retrying.

This is what removes the failure mode that made the original probe dangerous: a single uncollectable module can no longer cause `pip install -e .` to run over a correctly prepared conda environment.

### P4 — Proof as a provision postcondition

`provision` already runs a post-install source check (`SOURCE_CHECK_SCRIPT`). Extend it from "the import resolves" to "each declared gate starts and enumerates work." Per run, in the worktree, after install — the ordering already works and the failure surface already exists.

**The result is a signal, not a profile field.** That removes the staleness problem, the schema bump, and the two-writers hazard of v1's `proofs` record.

### P5 (separate, all-languages) — the gate contract

Three-state applicability (§5.5) and the `lint`/`typecheck` gate names are **not** Python/Node-scoped: `LangDef.gates` is a required field on all eight registry entries, and the consumers are global. Argued on its own merits, in its own document, because its blast radius is unrelated to P1–P4:

- `run.ts:56` `assertResolved` **throws** when a `MUST_HAVE` key is `undefined`. So `n/a` **cannot** mean "absent key" — every Python profile would fail at run start. It must mean a distinct recorded value, or the model is warning-suppression only.
- `resolve-commands.ts:4` and `run.ts:50` both hardcode `["build","test","check"]`.
- `preflight.ts` iterates `["build","test","check"]`, so ENG-332's exit-69 toolchain preflight is blind to new gates.
- `handlers.ts:1353-1370` (`verify:check`) **throws** on a check-type that is absent and not `{unavailable:true}` — and `prompts/design-extract.md:29` already offers `["lint"]` as an example check-type, so that throw is already armed.
- `{unavailable:true}` drives a PR-visible `untested-merge-risk` signal (`handlers.ts:1376-1424`). A gate that is "silent `n/a`" in setup must not still surface at merge.

### 5.5 The three-state model (P5's core)

| State | Meaning | Surfaced as |
|---|---|---|
| `n/a` | The stack has no such concept (`build` for a pure Python library). | Silent. |
| `absent` | Applicable, this repo has not configured it. | Informational and actionable. |
| `declared` | Detected. Proof (P4) resolves it at run time. | — |

**Applicability** is a property of the stack (`n/a` / `applicable` / `required`). **State** is per component. They are different fields that share the token `n/a`.

| | build | test | lint | typecheck |
|---|---|---|---|---|
| **python** | `n/a` | required | applicable | applicable |
| **node** | applicable | required | applicable | applicable |

A component with **zero** usable gates is a distinct, louder finding than any individual missing gate. **It must gate something** — a run-start refusal or a distinct exit code — or the model changes only the wording of text operators already skim.

## 6. Per-language detail (scope: P1)

### 6.1 Python

**Environment resolution** — drives `prepare` and the command prefix. Rows are additive to the existing tox/nox handling, which stays and is checked first (as today).

| Evidence | Manager | Prepare | Prefix |
|---|---|---|---|
| `tox.ini` / `noxfile.py` | tox / nox | `pip install tox` / `nox` (as today) | — |
| `uv.lock` | uv | `uv sync --frozen` | `uv run` |
| `poetry.lock` | poetry | `poetry install --sync` | `poetry run` |
| `pdm.lock` | pdm | `pdm install --check` | `pdm run` |
| `pyproject.toml` | pip | `pip install -e ".[<extra>]"` | `python -m` |
| `requirements*.txt` | pip | `pip install -r …` | `python -m` |

`<extra>` from `[project.optional-dependencies]`, preferring `test` > `tests` > `dev` (D3).

**test** — parse pytest config (`[tool.pytest.ini_options]`, `pytest.ini`, `setup.cfg [tool:pytest]`, `tox.ini [pytest]`) for **`addopts` and `testpaths` as recorded evidence**, not as a command rewrite (§3.2). Fall back as today.

**lint** — `[tool.ruff]` / `ruff.toml` → `ruff check .`; `.flake8` / `setup.cfg [flake8]` → `flake8`; `[tool.black]` → `black --check .`. `.pre-commit-config.yaml` noted, never used as a gate.

**typecheck** — `[tool.mypy]` / `mypy.ini` → `mypy .`; `[tool.pyright]` / `pyrightconfig.json` → `pyright`.

### 6.2 Node

**Start from `detect.ts`, not from scratch (D13).** `detectPackageManager` already handles bun/pnpm/yarn/npm and `detectCommands` already emits `` `${pm} run ${name}` `` over `["test","build","lint","typecheck"]`. The work is to **wire the orphan into `runRegistry` and extend it**, and to delete `node.ts`'s worse duplicate — not to write a third implementation.

Extensions needed: the `packageManager` (corepack) field as the first-priority signal; berry vs classic yarn; script preference ladders (`test` > `test:unit`, deliberately **not** `test:ci`, which routinely expects a server); config fallbacks (`vitest.config.*`, jest config, `biome.json`, `eslint.config.*`, `tsconfig.json`).

**Bun requires a marker first (D15).** Adding a `bun install` branch without adding bun's completeness marker to `NODE_INSTALL_MARKERS` makes `isComponentReady` return false forever — a **deterministic** reinstall-every-provision regression, not a risk. Marker before branch.

**Record `framework` alongside the manager (D14).** `frameworkFor` returning `null` for bare `npm test` makes every such Node AC check coarse `error`. Detection knows the framework when it resolved it from `vitest.config.*` or a script body; P4's proof knows it for certain because it invoked the list mode. Persisting it turns `frameworkFor` from a guess into a lookup. **This is the single largest Node correctness win available and v1 missed it entirely.**

**Paths** — derive from the package's own `files` field, else the source directories present (D6). The `sveltekit` `kind` behaviour is correct as-is and is not changed.

**Workspaces** — detect the root (`pnpm-workspace.yaml`, `workspaces`, `lerna.json` / `nx.json` / `turbo.json`); members become the components. Note that `safeMember` only *validates* — it rejects a member whose first segment is a glob. Expanding `packages/*` into a component list needs real filesystem expansion that **does not exist** in this repo today (rust's `collapseWorkspaceGlobs` collapses, it does not enumerate). That expansion is part of P1's cost.

## 7. Relationship to the differential design

`docs/brainstorms/2026-07-05-verification-as-differential-inference-design.md` owns baselining, attributed verdicts, and greenness. This design owns detection, discovery and runnability.

**That doc is dated pre-M4 and current code has overtaken it in three places:** its §7.6 reconcile routing no longer exists (`verify:integration` never throws on the suite verdict, `handlers.ts:1554`); its §7.2 deliver-with-caveat is shipped (`verify-report.ts:161`); its §13(2) test-pinning is shipped at AC-check granularity as `ac-check-red-first`. **The composition claim here is against the residual — gate-granular baselining — not the whole document.**

**This design takes over that doc's §11 env-probe follow-on** ("per-language source-under-test predicates — Python/Node first") via P3. That is a reassignment and it should be named: it **discharges the differential doc's §7.1 shipping blocker**, which is the strongest argument for doing this work first.

**Correction to v1's sequencing argument.** v1 claimed baselining a red-at-base gate "buys nothing." The differential doc says the opposite: red-on-base alone is "structural and sufficient" to demote the gate and stop looping the agent — its largest claimed win. The correct argument is that a **green** baseline is information-rich where a red one is "epistemically degraded," and that P1–P3 move astropy from the degraded branch to the rich one.

**Unadjudicated between the two docs, and blocking:** `reuseAwareTestCommand` returns a bare `${interp} -m pytest`, discarding whatever setup detected — on exactly the ready-conda path P3 targets. The differential doc's §7.1 *wants* that substitution; this design wants the detected command preserved. **Resolution proposed:** the reuse path substitutes the **interpreter/prefix only**, never the command. This must be agreed before P3 ships.

### 7.1 What none of this delivers

An AC check asks "did the intended behavior arrive?" — a specification check, authored independently of the fix (§11). A regression check asks "did I break something I was not supposed to touch?" Those are different questions.

styre has **two** regression instruments: the broad gate (behavioral, currently uninterpretable without a baseline) and a typecheck (type-level cross-breakage only — narrower, real, and the thing this design adds). Neither is made *interpretable* by detector work. `verify:integration` sweeps `["build","test"]` plus `repoCommands` — builds are already inside it, which is why darkreader's packaging build blocked.

Run-all remains the only safe regression policy **until** the differential design supplies the false-block defence. Narrowing the broad gate is out of scope; the differential doc treats "over-verify, never under-verify" as half a rule awaiting its mirror, not as vindicated.

## 8. Non-goals

- Narrowing the broad test gate, or any test-impact analysis.
- Baseline characterization or attributed verdicts.
- Any language other than Python and Node, except P5 which is structurally all-languages.
- A persistent environment snapshot across runs/machines (commercial plane).
- Changing `--trust-agent-commands`. P2 makes what it admits provable instead of removing it.
- **Packaging-vs-compile build discrimination.** The differential doc's §13(1) says styre "cannot yet tell them apart" and that gating on a packaging build was self-inflicted in darkreader. This design rebuilds the detector and does **not** teach it the distinction. Explicitly deferred, filed separately, and named here so the omission is not silent.

## 9. Open risks

1. **★ The astropy `testpaths` hypothesis is unverified.** §3.2's claim that astropy declares `testpaths = "astropy" "docs"` comes from review, not from inspecting the tree. If false, `testpaths` may be worth more than §3.2 allows. Verify before P1 relies on it either way.
2. **★ The env probe's false-positive blast radius widens under P3.** The differential doc's §9.6 calls mistaking a shadowing copy for a ready env "the highest correctness risk of the reuse path." Today a false positive costs one substituted pytest invocation; under P3 it **skips `prepare` entirely**. Inherited, worsened, and mitigated only by the tempdir-outside-the-worktree technique already in `reuse.ts`.
3. **The probe's all-or-nothing behaviour is addressed by P3.1/P3.2, not eliminated.** Splitting Q1 from Q2 and making a Q2 failure trigger a bounded additive repair removes the destructive path. What remains: an environment that passes Q1 but is genuinely broken for testing is now *reused* rather than rebuilt, so the failure surfaces later, at verify, and less directly. That is the accepted cost of the asymmetry argument in P3.2, and it should be watched on the first bench sweep. **The repair's exact per-manager form is undesigned** and is the main open implementation question in P3.
4. **A prior blocker recorded against this machinery did not reproduce.** A July note recorded `assertInPlaceIdentity` failing on astropy with the cause unresolved, and v1 of this design treated it as gating P3. The 2026-09-08 run on v0.13.2 ran `--in-place` against the astropy image and completed — that check is called at `run.ts:186` and throws on failure, so it did not fail. Whether it was fixed or merely does not reproduce is unknown. Not a blocker; recorded so the stale note is not resurrected.
5. **★ Baseline cost scales with gate count.** The differential doc's §9.2 prices baselining per gate. P5 raises gates from three to four with `lint` and `typecheck` newly applicable for both stacks. Neither document computes the product.
6. **P1 changes the bench's denominator.** `collect.ts:171`'s `isProbeProfile` reads `components[0].commands.test`, and `deriveTaxonomy` checks `probe` before `loop-exhausted` deliberately. Making Python always emit a runnable test command empties the `probe` bucket and shifts those runs to `loop-exhausted` — **post-change sweeps are not comparable to pre-change ones**, for reasons unrelated to the loop.
7. **Adding gate commands widens the agent's shell surface.** `realRunnerCommands` feeds `allowlistFor` as `Bash(<cmd>:*)` prefix rules (`handlers.ts:582`, `:988`). Small, but it is a capability-isolation change.
8. **Seam sequencing.** P5's gate vocabulary and the differential design's verdict-shape change are two independent breaks of the open-core contracts, currently unordered and mutually unaware.
9. **No lock, no reaping, no network budget.** `styre run` takes a run lock; setup takes none. Nothing reaps a setup-created `.venv`. P2's probe gains a network dependency with no timeout or failure taxonomy, and it is undesigned whether `SECURITY.md`'s credential stripping applies to it. Materially reduced by §3.1 (setup no longer installs), but not zero.

## 10. Testing

- **P1** extends the existing fixture-tree unit tests directly — one fixture per manager, per ladder rung, per workspace layout. Pure, so no integration cost.
- **P2** is testable with a stubbed runner for the accept/reject decision, plus one real probe test per manager.
- **P3** needs a real integration test: its correctness property (source-under-test, not a shadowing copy) is precisely what a stub cannot exercise. `pythonEnvReady`'s tempdir-outside-the-worktree technique is the pattern.
- **P4** asserts on the emitted signal, not on a profile field.
- **The bench is the acceptance test, with risk 5's caveat** — astropy should acquire lint/typecheck gates if configured and stop reinstalling over its conda env; darkreader should acquire the correct manager and a resolvable framework.

## 11. Corrections recorded

Claims made during this design's development that were wrong, recorded so they do not propagate:

- **"AC checks answer *did my change break something*."** They do not — they are specification checks (§7.1).
- **"The AC test is self-authored by the implement agent."** False. `checks:dispatch` (`handlers.ts:547`) is a separate agent dispatch authoring the checks after design and before implement; `implement:dispatch` (`:969`) **reads** `ac_check` at `:1002` for prompt context but never authors or modifies one. The styre-bench strategy doc still carries the wrong claim — ENG-394.
- **"Setup should provision and prove" (v1 DEC-5).** Withdrawn — unsafe and path-incorrect (§3.1).
- **"`schemaVersion` bump touches both `schema.sql` copies."** False; `schemaVersion` is a `profile.json` field with no SQLite presence. No bump is needed at all now.
- **"`testFilePattern` is unset, so `isTestFile` has no pattern for these stacks."** False; `DEFAULT_TEST_FILE` covers both.
- **"`kind` flips to `sveltekit` for nested packages."** False; guarded by `isRoot &&`.
- **"`assertInPlaceIdentity` has an open astropy failure blocking P3."** Stale. The note was from July; the 2026-09-08 run passed that check (§9.4).
