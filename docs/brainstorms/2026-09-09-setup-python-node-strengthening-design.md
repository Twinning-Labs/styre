# Strengthening `styre setup` — Python and Node

**Status:** Design (brainstorm output) — pending operator sign-off, then an implementation plan.
**Date:** 2026-09-09
**Scope:** what `styre setup` detects, what it proves, and what it records — for **Python and Node/JS/TS only**. Other languages in `REGISTRY` are untouched by this design and keep their current behaviour.
**Deliberately reopens:** the polyglot detection freeze (`docs/brainstorms/2026-06-30-polyglot-setup-verify-frozen-design.md`), for these two stacks only. The freeze is what left `pythonDef` structurally unable to emit a `check` command at all. This is a decision, not a side effect.
**Builds on / touches:**
- `docs/brainstorms/2026-07-05-verification-as-differential-inference-design.md` — the baseline/attribution design. **Still unsigned and unbuilt.** This design deliberately does NOT duplicate it (§7).
- `docs/brainstorms/2026-07-03-provisioning-design.md` — `prepare`, the source-under-test probe.
- `CLAUDE.md` invariants: ground truth over self-report, loop-not-halt, capability isolation.
- ENG-392 (setup accepts an unusable verify command). This design supersedes ENG-392's proposed mechanism — see §7.2.

---

## 1. Origin — what the 2026-09-08 astropy run exposed

styre ran `astropy__astropy-12907` end to end and produced the **correct fix** (the blind A/B reviewer, unaware which candidate was styre's, recorded that both candidates "make the identical correct core fix"). Its verification was nonetheless worthless, for reasons that are all in setup:

```
⚠ python: no build command — styre cannot ground-truth-build this stack.
⚠ python: no check command — styre cannot ground-truth-check this stack.
test          fail    pytest --pyargs astropy docs
integration   fail    pytest --pyargs astropy docs
```

Three distinct defects, none of which is a missing detector rule:

1. **A meaningless warning and a real one, emitted identically.** A pure Python library has nothing to build; demanding a build command manufactures a warning that can never be actioned. "No check command" is a genuine gap — no fast deterministic gate exists. Same severity today, which is how an operator learns to skim warnings.
2. **The only gate was slow and unreliable.** `pytest --pyargs astropy docs` includes docs and runs without the project's test extras installed, so it could not go green whatever styre did. There was no lint or typecheck gate because `pythonDef` cannot emit one.
3. **Nothing validated the command.** `discover.ts:60` accepts an agent-proposed command on three conditions — `isCommandSafe`, `probeCommandExists`, `trusted` — none of which asks whether the command produces a usable signal.

## 2. What the current design is

`LangDef.detect(repoDir) → ComponentDraft[]` is a **synchronous, pure function from the filesystem to command strings**. It stats files, reads a little config, and emits `{build, test, check}` plus a `prepare`. `resolveCommands` then fills any unfilled slot with `{unavailable: true}` and warns.

Nothing anywhere executes a candidate command, inspects the environment, or checks that what it emitted is worth running.

### 2.1 Verified defects in the two target detectors

| # | Defect | Evidence |
|---|---|---|
| D1 | Python emits **only** `test`. Never `build`, never `check`. | `python.ts` — `commands: { test: pythonTestCommand(repoDir) }` |
| D2 | `pythonTestCommand` returns a bare runner from four `existsSync` calls; never reads pytest config (`testpaths`, `addopts`), `setup.cfg [tool:pytest]`, or `tox.ini [pytest]`. Unaware of uv, hatch, pdm. | `python.ts:6-20` |
| D3 | `pythonPrepare` emits `pip install -e .` with **no extras**, so a project needing `.[test]` installs without its test dependencies. | `python.ts:22-33` |
| D4 | **Node detects the package manager and then ignores it.** `nodePrepare` resolves pnpm/yarn/npm from lockfiles; the commands hardcode `npm run`. | `node.ts:8-12` vs `:34-36` |
| D5 | Node reads exactly three hardcoded script names (`build`, `test`, `check`). No lint, no typecheck, no `test:unit`. | `node.ts:33-36` |
| D6 | Node's root `paths` are hardcoded `["src/**","static/**","package.json"]` — Tauri/SvelteKit shaped. `kind` flips to `sveltekit` on **repo-root** config files even when scoring a nested package. | `node.ts:38-46` |
| D7 | Workspace members are **not** skipped, despite the comment saying they are. Every `package.json` within depth 3 becomes a component; `uniquifyNames` then papers over the collisions. | `node.ts:18` comment vs `manifests.ts` `findManifests` |
| D8 | `findManifests` walks to `maxDepth = 3`, silently missing e.g. `apps/web/packages/ui/package.json`. | `manifests.ts:24` |
| D9 | `testFilePattern` is set only by `php.ts` and `ruby.ts`. **Neither Python nor Node sets it**, so `isTestFile` has no pattern for the two target stacks. | `handlers.ts:1432` |
| D10 | Provision treats every Python component as never-ready, so `pip install -e .` runs on every provision — including over a prepared conda env that already has the package correctly installed. | `provision.ts:33` |
| D11 | The environment-reuse probe runs at **verify** time, i.e. *after* provision already reinstalled. The cheap check follows the expensive one. | `reuse.ts` `reuseAwareTestCommand` |
| D12 | Direct tool invocations (`tsc --noEmit`, `eslint .`) fail `probeCommandExists` because they are devDependencies, not on PATH — so `discover.ts` **rejects** good agent proposals for these gates. | `discover.ts:60` |

## 3. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| DEC-1 | **Setup may execute commands** to prove what it detected. | Static rules alone produce more confident wrongness; the astropy command was unvalidated, not unrecognised. |
| DEC-2 | Setup proves **runnable and scoped**; verify proves **green**. | Green is volatile and expensive and already belongs to the differential design. Runnable is stable and cheap. |
| DEC-3 | Gate applicability is **per stack**, with three states. | `MUST_HAVE` applying uniformly is what produced the meaningless "python: no build command". |
| DEC-4 | Gates are explicit: `build`, `test`, `lint`, `typecheck`. | The vague `check` conflated two gates that behave differently. `commands` is already an open record, so the schema permits it. |
| DEC-5 | **Setup provisions and proves**, and `prepare` MUST be idempotent. A `--no-prove` flag skips the provision-and-prove pass for a fast read-only probe; proving is the DEFAULT so the weak path is never the one most runs get. | Matches how Cursor and Factory solve this (§4). The alternative leaves the unproven path as the default. |
| DEC-6 | **Discovery precedes build.** A prepared environment that provably tests the worktree source is reused; `prepare` becomes a no-op. | The astropy image ships a prepared conda env. Today provision reinstalls over it (D10). |

## 4. Prior art — how Cursor and Factory solve the same problem

Both make the **prepared environment a durable artifact built once and reused**, rather than reconstructing it per run.

- **Cursor** (`.cursor/environment.json`): agent-led setup, a saved **snapshot**, or a Dockerfile. The `install` script runs when a *Build* is created — ahead of time, in the background — not at each agent start, and it **must be idempotent** because it runs for every build and may run on already-prepared disk.
- **Factory** (Droid Computers): persistent environments that retain filesystem, configuration, credentials, local services and process state between sessions, so a droid resumes rather than reconstructs.

**What styre can take.** The true snapshot — a built environment reused across runs and machines — is already assigned to the commercial plane by the differential doc's §10 ("managed environment provisioning"). OSS `styre run` is one-shot with ephemeral state and structurally cannot own it. What OSS *can* take is the **pay-once, idempotent-install** half, plus the observation that **styre's container mode already has the snapshot**: when running in-place inside a SWE-bench image, the image *is* the prepared environment. That is exactly the case where provisioning and proving at setup costs almost nothing — and exactly the case D10 currently breaks.

## 5. The shared spine

### 5.1 Gate applicability — three states, not two

Two vocabularies are in play and both contain `n/a`; they are not the same field. **Applicability** is a property of the *stack* (`n/a` / `applicable` / `required`, declared by `LangDef.gates`). **State** is the per-component outcome below. A gate whose applicability is `n/a` has state `n/a`; every other applicability resolves to one of the remaining states.

| State | Meaning | Surfaced as |
|---|---|---|
| `n/a` | The stack has no such concept (`build` for a pure Python library). | Silent. Never mentioned. |
| `absent` | Applicable, this repo has not configured it (no linter). | Informational, and actionable — it says what adding one would buy. |
| `declared` → `proven` / `unprovable` | Detected. Proof then resolves it. | `unprovable` is loud, with the reason. |

**A component with zero proven gates is a separate, louder finding** than any individual missing gate: it means styre cannot verify that component at all. Today that is indistinguishable from the noise.

| | build | test | lint | typecheck |
|---|---|---|---|---|
| **python** | `n/a` | required | applicable | applicable |
| **node** | applicable | required | applicable | applicable |

Python's build analogue is `prepare` plus provision's existing import check; a separate build gate would be inventing work.

### 5.2 The ladder: declared → runnable → green

- **declared** (setup, static): config declares the gate, the tool resolves, the command is shell-safe and scoped to the component.
- **runnable** (setup, post-`prepare`): the command starts and finds work, with a count.
- **green** (verify, per run): owned by the differential design. **Not in this scope.**

### 5.3 Contract change

```ts
export type GateName = "build" | "test" | "lint" | "typecheck";
export type GateState = "n/a" | "absent" | "declared" | "proven" | "unprovable";

export interface LangDef {
  kind: string;
  /** Which gates mean anything for this stack (§5.1). */
  gates: Record<GateName, "n/a" | "applicable" | "required">;
  /** Static, filesystem-only. Unchanged in spirit. */
  detect(repoDir: string): ComponentDraft[];
  /** Post-prepare. MAY execute. Language-specific because scope is measured
   *  differently per runner. */
  prove?(c: Component, absDir: string, run: CmdRunner): Promise<GateProof[]>;
}
```

Detection stays pure and unit-testable exactly as today; proof is a separate phase. The two never entangle.

### 5.4 What gets recorded

Additive, not a rewrite. `commands` is unchanged, so `commandFor` and every existing consumer are untouched. Each component gains:

- `proofs: Record<GateName, GateProof>` — `{ state, collected?, durationMs?, provenAt, reason? }`
- `toolchain` — the resolved package manager / Python environment, so `prepare` and the gate commands **cannot drift apart again** (D4).

`schemaVersion` bumps to 4. Both `schema.sql` copies must move together (`src/db/` is authoritative; `docs/architecture/` is the doc).

### 5.5 Environment discovery precedes environment build

Two questions the current design collapses into one:

1. **Discover** — is there already a prepared environment that provably tests *this worktree's source*? A conda env baked into an image, a `.venv`, an existing editable install. This is a fact about the machine; no manifest declares it.
2. **Build** — only if discovery fails, resolve the manager and install.

Discovery goes first. On success, `prepare` is a **no-op**, which is simultaneously the D10 correctness fix and the idempotence property DEC-5 requires.

**Discovery and proof are the same operation.** `pythonEnvReady` (`reuse.ts`) already answers both: it proves `import <name>` resolves to a file under the worktree — run from a tempdir *outside* it, so CPython's `sys.path[0]` cannot false-pass a shadowed copy — and that `pytest --collect-only -q` exits 0. That is exactly the `proven` state. So the proof comes free from the probe that decides whether to skip `prepare`. This materially weakens the "proving is expensive" objection.

The work is to **promote `pythonEnvReady` from a verify-time command substitution into the general discovery step**, and to have provision consult it (fixing D10 and D11).

## 6. Per-language design

### 6.1 Python

**Environment ladder** (after discovery §5.5 fails):

| Evidence | Manager | Prepare (idempotent) | Prefix |
|---|---|---|---|
| `uv.lock` | uv | `uv sync --frozen` | `uv run` |
| `poetry.lock` | poetry | `poetry install --sync` | `poetry run` |
| `pdm.lock` | pdm | `pdm install --check` | `pdm run` |
| `environment.yml` | conda | existing reuse path | resolved interpreter |
| `pyproject.toml` | pip | `pip install -e ".[<extra>]"` | `python -m` |
| `requirements*.txt` | pip | `pip install -r …` | `python -m` |

`<extra>` is read from `[project.optional-dependencies]`, preferring `test` > `tests` > `dev`. This is D3, and it is the difference between astropy's suite being able to run and not.

**test** — parse pytest config wherever it lives (`[tool.pytest.ini_options]`, `pytest.ini`, `setup.cfg [tool:pytest]`, `tox.ini [pytest]`) and use `testpaths` to scope the command to the project's **own declaration of its suite**, rather than an agent's improvisation. Fall back to a discovered `tests/`/`test/` directory, then bare `python -m pytest`, then `python -m unittest discover`. Keep `tox`/`nox` detection but mark them slow at proof time — the differential doc records tox rebuilding its environments under the 10-minute verify timeout.

**lint** — `[tool.ruff]` or `ruff.toml` → `ruff check .`; `.flake8` / `setup.cfg [flake8]` → `flake8`; `[tool.black]` → `black --check .`. A `.pre-commit-config.yaml` is noted but never used as a gate (slow, usually wants network).

**typecheck** — `[tool.mypy]` / `mypy.ini` → `mypy .`; `[tool.pyright]` / `pyrightconfig.json` → `pyright`.

**testFilePattern** — `(^|/)(tests?/.*|test_.*|.*_test)\.py$` (D9).

### 6.2 Node

**Package manager** — resolution order, first match wins. `packageManager` (corepack) is first because it is the project's own declaration and survives a gitignored lockfile.

| Evidence | Manager | Install |
|---|---|---|
| `packageManager` field | as declared | per manager |
| `bun.lock` / `bun.lockb` | bun | `bun install --frozen-lockfile` |
| `pnpm-lock.yaml` | pnpm | `pnpm install --frozen-lockfile` |
| `yarn.lock` + `.yarnrc.yml` | yarn berry | `yarn install --immutable` |
| `yarn.lock` | yarn classic | `yarn install --frozen-lockfile` |
| `package-lock.json` | npm | `npm ci` |
| none | npm | `npm install` |

The resolved manager is recorded on the component (§5.4); `prepare` and every gate command read it from there (D4).

**Script ladders** with config fallbacks:

- **test** — `test` > `test:unit`. Deliberately **not** `test:ci` (routinely expects a server or CI env) and not `test:e2e`. Else `vitest.config.*` → `vitest run`; jest config → `jest`.
- **build** — `build`, else `absent`.
- **lint** — `lint` > `lint:js`, else `biome.json` → `biome check .`, else `eslint.config.*` / `.eslintrc*` → `eslint .`.
- **typecheck** — `typecheck` > `type-check` > `tsc`, else `tsconfig.json` → `tsc --noEmit`.

**Tool invocation must go through the manager's exec** (`pnpm exec tsc --noEmit`), because these are devDependencies. This also fixes D12: bare `tsc --noEmit` fails `probeCommandExists`, so `discover.ts` currently rejects correct agent proposals for exactly the fast gates this design is trying to add.

**Workspaces** — detect the root first (`pnpm-workspace.yaml`, package.json `workspaces`, `lerna.json` / `nx.json` / `turbo.json`). Members are the real components, each with its own `dir` and gates; the root is a component only if it has gates of its own rather than pure aggregation. `safeMember` already exists to validate the globs and is currently unused by Node. Resolving declared member globs also beats the blind walk, fixing D8.

**Paths and kind** — derive `paths` from the package's own `files` field if present, else the source directories that exist; decide `kind` from the component's own directory, not the repo root (D6).

**testFilePattern** — `(^|/)(__tests__/.*|.*\.(test|spec))\.(t|j)sx?$` (D9).

**Proof — an honest asymmetry.** Python gets a clean probe from `pytest --collect-only -q`. Node has **no universal equivalent**: Jest has `--listTests`, Vitest has a list mode, and the exact current flags must be verified during implementation rather than assumed. Where a list mode exists, use it. Where it does not, Node's test proof degrades to "the manager resolves the script and a bounded smoke start succeeds" — a weaker guarantee that MUST be recorded as weaker, never presented as equivalent. Lint and typecheck are fast enough that proving them *is* running them.

## 7. Relationship to the differential design

### 7.1 What this design cannot deliver

**Regression safety.** An AC check asks "did the intended behavior arrive?" — the red-first probe proves the test fails before the change, the post-implement rerun proves it flips. That is a *specification* check. A regression check asks "did I break something I was not supposed to touch?", which requires running tests the change did not target and comparing against a prior state.

So **the broad test gate is the only regression signal styre has**, and it is currently uninterpretable: there is an "after" run and no "before" run, so a red result cannot distinguish "I broke it" from "it was already broken." That is precisely why `verify:integration` is demoted to advisory (`handlers.ts:1556` — "record the (possibly-fail) result and RETURN normally").

This also retroactively justifies "over-verify, never under-verify": with no test-impact analysis and no baseline, run-all is the only safe regression policy available. **Narrowing the broad gate is out of scope and would be a reversal, not a fix.**

No amount of detector work makes that gate interpretable. Setup can make it **affordable** and **capable of being green**; making it **interpretable** is the differential design's job and is blocked on its sign-off.

### 7.2 Why setup should nonetheless go first

Baselining a gate that is red at base because test extras were never installed buys nothing: you record "red at base," the verdict degrades to caveat, and nothing improves. **Fixing the environment is what makes baselining productive.** astropy is the exact case — baseline it today and you learn the suite is red; fix extras and `testpaths` first and the baseline becomes a real reference frame.

This is also why this design **supersedes ENG-392's proposed mechanism.** ENG-392 proposed baselining at setup. Baselining belongs to the differential design at verify; setup's contribution is proving *runnable and scoped* (DEC-2). ENG-392 should be re-scoped to this design or closed in its favour.

## 8. Non-goals

- Narrowing the broad test gate, or any form of test-impact analysis. The differential doc calls method-level test isolation "the biggest gap" and the hardest-deferred rung.
- Baseline characterization, attributed verdicts, or anything that changes what a verify verdict *means*. That is the differential design, with M-D blast radius.
- Any language other than Python and Node.
- A persistent environment snapshot reused across runs and machines — assigned to the commercial plane by the differential doc's §10.
- Changing `--trust-agent-commands`. Headless autonomy needs it; this design makes what it admits provable instead of taking it away.

## 9. Open items and risks

1. **★ Node's proof is weaker than Python's** (§6.2). The per-framework list-mode flags must be verified against current Jest/Vitest during implementation, not assumed. Where no list mode exists the guarantee is genuinely weaker and must be recorded as such.
2. **★ Setup becomes stateful and slow in the cold-worktree case.** Discovery makes the container case nearly free (§4), but a cold developer machine pays the install once. A `--no-prove` escape exists, but the default path is the slow one — that is deliberate, and it should be measured on a real fixture before it calcifies.
3. **Idempotence is asserted, not enforced.** `npm ci` deletes `node_modules` by design; `isComponentReady`'s marker check guards re-running it, but bun's completeness marker is unverified and must be established during implementation.
4. **`schemaVersion` 4 touches both `schema.sql` copies** and every profile in the wild. Migration behaviour for schemaVersion-3 profiles must be decided: regenerate, or lazily upgrade.
5. **The three-state model changes warning output**, which operators and the bench's `probe` taxonomy both key on. `collect.ts`'s `isProbeProfile` reads `components[0].commands.test` — it will need to read `proofs` instead.
6. **Unverified assumption:** that `testpaths` is present and correct in the repos we care about. astropy has one; this should be spot-checked across a handful of SWE-bench Python instances before relying on it as the primary scoping mechanism.

## 10. Testing

- **Detection** stays pure, so the existing fixture-tree unit tests extend directly: one fixture per manager, per script ladder rung, per workspace layout.
- **Proof** is tested against a stubbed `CmdRunner` — no real installs in the unit suite.
- **Discovery** needs a real integration test, because its correctness property (source-under-test, not a shadowing copy) is precisely what a stub cannot exercise. `pythonEnvReady`'s existing tempdir-outside-the-worktree technique is the pattern.
- **The real test is the bench.** astropy should acquire a `testpaths`-scoped test command with extras installed, plus lint/typecheck gates if the repo configures them; darkreader should acquire the correct package manager. Both are directly observable in `profile.json`.

## 11. Corrections recorded

Two claims held earlier in this design conversation were wrong and are corrected here so they do not propagate:

- **"AC checks answer *did my change break something*."** They do not. They are specification checks (§7.1).
- **"The AC test is self-authored by the implement agent."** False against current code. `checks:dispatch` (`handlers.ts:547`) is a separate agent dispatch that authors the checks after design and before implement; `implement:dispatch` (`:969`) never touches `ac_check`. There is genuine author/implementer independence. The styre-bench strategy doc's §1 still carries the wrong claim and a stale citation — filed as ENG-394.
