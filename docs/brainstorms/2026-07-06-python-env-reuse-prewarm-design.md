# Python verify environment — readiness probe → reuse-or-pre-warm (the astropy fix)

**Status:** Design (brainstorm output) — direction approved by the operator (reuse-a-proven-env, else pre-warm; the reuse path runs the standard runner). Pending written-spec review + independent review, then plan. Part of **Option B** on branch `feat/verify-gates` (the pre-warm piece, reshaped by the deep-dive).
**Date:** 2026-07-06
**Scope:** make styre's Python verify run **fast and correct** on repos whose test harness rebuilds its own dependency environment (`tox`/`nox`) — the astropy-12907 block. Covers the readiness probe, the reuse path, the pre-warm fallback, and where it generalizes across stacks. **Does NOT** build test-selection/TIA (deferred — see §6 honest limit).
**Builds on:**
- `docs/brainstorms/2026-07-06-verify-gates-redesign-design.md` §4 (pre-warm sketch — this supersedes it) and the command matrix.
- `docs/brainstorms/2026-07-03-provisioning-design.md` — the `prepare`/provision step, the source-under-test probe (`SOURCE_CHECK_SCRIPT`), the conda-denial (which this **refines to a probe**, per §7.1 of the CL-BASELINE brainstorm).
- `CLAUDE.md` invariants: ground truth over self-report; capability isolation.

---

## 0. The problem the deep-dive actually found

astropy-12907 blocked because its detected test command `tox` was SIGKILLed at the 10-minute `VERIFY_TIMEOUT_MS` — but the deep-dive showed it's **two** problems, not one:

1. **`tox` rebuilds its dependency environments from source.** The slow part is installing numpy/scipy/pytest/etc into fresh virtualenvs — under the *verify* budget (10 min), where it times out. This is the dominant blocker.
2. **styre emits bare `tox`, which runs the *entire* `envlist`** — astropy's is `py{38,39,310,dev}-test{,-image,-recdeps,-alldeps,-oldestdeps,...}{,-cov}{,-clocale}` + `build_docs`/`linkcheck`/`codestyle` — **dozens of environments.** Nobody runs bare `tox` to verify a change; it's a full CI matrix.

Crucially, the SWE-bench image already ships a **ready, editable conda env** (`testbed`) for exactly this: verified `astropy.__file__ = /testbed/astropy/__init__.py`, `pip show astropy` → `Editable project location: /testbed`. It has every dependency built and is editable-linked to the worktree. **Reusing it dissolves both problems at once** — no rebuild (fixes #1), and running the runner directly means no `envlist` matrix (fixes #2).

---

## 1. The design — probe, then reuse or pre-warm

The unifying rule (generalizes styre's existing node `node_modules` readiness check):

> **Before installing/rebuilding anything, probe the *active* environment. If it provably runs the tests against the worktree, reuse it. Otherwise provision + pre-warm.**

### 1.1 The readiness probe (environment-agnostic — not conda-specific)

Run, against the active Python on PATH, styre's **existing** source-under-test check plus a runner check:
- **(a) worktree-under-test:** `import <pkg>` resolves to a file *under the worktree* (`SOURCE_CHECK_SCRIPT` — `find_spec(name).origin` is under `cwd`). This is the exact "is this env good, and does it test the right bytes" test styre already ships.
- **(b) runner present:** `python -c "import pytest"` succeeds.

If **both pass** → the env is ready (conda `testbed`, a venv, whatever's active) → **reuse**. If either fails → **provision + pre-warm**. styre never enumerates conda envs or knows about conda — it validates whatever is active. Deterministic, ground-truth, reuses existing machinery.

### 1.2 The reuse path (primary — the astropy fix)

When the probe passes, run the tests with the **standard runner in the ready env** — `python -m pytest` (in the repo dir, so it picks up the repo's `pytest.ini`/`pyproject` config) — **instead of** the detected harness (`tox`). Fast (no rebuild), correct (editable → worktree source is live), no matrix.

**This deliberately relaxes the frozen "don't substitute the harness" rule (provisioning §5)** — and the relaxation is justified, not assumed: that rule protected against running a bare runner in an *unproven* env. Here the probe *proves* the env tests the worktree, while bare `tox` runs a matrix nobody uses. Substitute **only when the probe passes.**

### 1.3 The pre-warm fallback (no ready env)

When the probe fails and the detected command is a rebuilding harness (`tox`/`nox`), move the env-build to the **provision** step (15-min `PROVISION_TIMEOUT_MS`), so the verify run reuses it:
- **Env-selection first:** bare `tox` is infeasible (the matrix). Pick a *single* env — parse `[tox]` `envlist`, expand factors, choose the simplest `py<host-version>-test` env (no extra factors). The gated test command becomes `tox -e <env>`, not bare `tox`.
- **Pre-warm:** `tox -e <env> --notest` at provision builds that one env's deps (+ the package) without running tests.
- **Verify:** `tox -e <env>` reuses the pre-warmed env; only the (fast) package reinstall + the tests run.
- Source-under-test on this path: astropy's `tox.ini` sets `isolated_build = true` + `changedir = .tmp` ("don't import from the source tree") — it tests an **installed sdist**, so the verify run must rebuild+reinstall the sdist to pick up the change (fast) while reusing the pre-warmed deps. The plan must confirm tox reinstalls the package per run (or force it).

*(For a fresh checkout with no conda/venv and no rebuilding harness — plain `pytest` — the existing `pip install -e .` prepare already handles it; nothing new needed.)*

---

## 2. Where the pieces live (against the code)

- `src/dispatch/provision.ts` — `isComponentReady(kind, dir)` today: node = marker check; python = always `false` (reinstall). **Change:** python probes the active env (§1.1) → ready ⇒ skip install. Reuses `SOURCE_CHECK_SCRIPT` + `pythonImportName` (both already in `provision.ts`/`python.ts`).
- The verify step must know **which command to run** when the env is reused (`python -m pytest`) vs not (`tox -e <env>`). This is a runtime command choice keyed on the probe result — the plan's main wiring question.
- `src/setup/lang/python.ts` — env-selection (parse `envlist`, pick `py<N>-test`) + the pre-warm command; a new optional `prewarm?` field (parallels `prepare`).
- The provision handler runs `prewarm` after `prepare`, under `PROVISION_TIMEOUT_MS`.

---

## 3. Generalization (why this isn't a conda hack)

Same "reuse-what's-built" pattern already exists / applies across stacks (see the command matrix): **node** already reuses `node_modules` (the marker check); **rust/go/jvm** reuse their own build caches automatically; **python** is the acute case (separate conda/venv env + a harness that rebuilds). This design makes `isComponentReady` a **probe** with per-stack implementations — node's marker and python's import-probe are two instances of one idea. Ruby/PHP (`bundle check`/composer) are later candidates.

---

## 4. Invariants held

- **Ground truth over self-report:** the reuse decision comes from a deterministic probe (exit codes), never agent judgment; the tests still come from the real runner.
- **Wrong-bytes safety (the original conda fear):** the probe **is** the guard — reuse only when `import <pkg>` provably resolves under the worktree. An env that shadows with a stale copy fails the probe → falls through to provision. This is "probe, don't assume," exactly the resolution the CL-BASELINE §7.1 called for.
- **Capability isolation:** probe + tests run runner-owned under `verifyEnv` (creds scrubbed), like every verify command.

---

## 5. Open questions / risks

1. **★ Reuse still runs the *whole* suite.** `python -m pytest` runs all tests — for a very large suite (astropy is thousands of tests) the *run* could itself approach/exceed the 10-min verify budget, even with no rebuild. Reuse fixes the *dominant* blocker (env-build timeout) and gets styre to actually running tests, but the full-suite run is the next lever — which points at **test-selection/TIA (deferred)** or a longer budget for a proven-env run. Honest limit: reuse makes astropy *runnable*, not guaranteed *fast enough*.
2. **Env-selection heuristic (pre-warm path).** Picking `py<host>-test` from a factor-expanded `envlist` is a real parser; a wrong pick runs the wrong env. Only matters when there's no ready env (astropy itself has one, so reuse skips this).
3. **tox source-under-test on the pre-warm path** (`isolated_build`/`changedir`): the verify run must reinstall the sdist to test the change; confirm/force per-run reinstall.
4. **Probe assumes an active env on PATH.** In the reuse case the SWE-bench image activates `testbed`; a deployment where the right env isn't active would fail the probe → provision (correct, just slower).
5. **Deferred:** test-selection/TIA; env-selection for nox; ruby/php readiness probes; native typecheckers.

---

## 6. Evidence appendix

- **astropy conda env (reuse target):** image `swebench/sweb.eval.arm64.astropy_1776_astropy-12907` — `testbed` conda env active; `import astropy` → `/testbed/astropy/__init__.py`; `pip show astropy` → `Editable project location: /testbed`. Editable-linked to the worktree ⇒ probe (a) passes.
- **The matrix problem:** `/testbed/tox.ini` `envlist` = `py{38,39,310,dev}-test{,-image,-recdeps,-alldeps,-oldestdeps,-devdeps,-numpy118..121,-mpl311}{,-cov}{,-clocale}` + `build_docs`/`linkcheck`/`codestyle`; `isolated_build = true`; `changedir = .tmp/{envname}` ("make sure we don't import astropy from the source tree").
- **Existing machinery to reuse:** `isComponentReady` (`src/dispatch/provision.ts` — node marker), `SOURCE_CHECK_SCRIPT` + `sourceCheckCommand` (`provision.ts` — the worktree-under-test probe), `pythonImportName` (`src/setup/lang/python.ts`), `PROVISION_TIMEOUT_MS = 15min` (`handlers.ts:92`), `VERIFY_TIMEOUT_MS = 10min` (`:91`).

## 7. Changelog
- *2026-07-06 (v1)* — reshaped the pre-warm sketch after the deep-dive: astropy's real fix is **reuse the ready editable conda env and run pytest** (dissolves both the env-rebuild timeout and the tox-matrix), with pre-warm (`tox -e <env> --notest` + env-selection) as the fallback when no ready env exists. Refines the conda denial to a **probe** (reuse only when worktree-under-test is proven). Named the honest limit: reuse makes the run *possible*, not guaranteed within the verify budget (→ test-selection deferred).
