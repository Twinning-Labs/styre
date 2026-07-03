# Provisioning: making `styre run` ready its own verify environment

**Status:** Design (brainstorm output), revised after two independent Opus reviews (adversarial + architecture). Implementation plan is a separate cycle.
**Date:** 2026-07-03
**Scope of this doc:** the design + seams of provisioning as a styre capability, building only the general provisioner for the Python and Node stacks now.

---

## 1. The problem (the disease, not the symptom)

Run against real repos (surfaced by styre-bench on SWE-bench Python + Multi-SWE-bench TS eval images), styre:

1. designs and implements a **correct** fix (verified: astropy-12907 got the exact gold fix; darkreader-7241 got the right anchored regex), then
2. tries to **verify** it, but its detected test command can't run — the environment isn't ready (`tox`/`pytest` deps not installed; `node_modules` absent), then
3. **correctly refuses to open a PR for unverified code** (the "ground truth over self-report" / "loop-not-halt" invariants working), and so
4. **blocks and delivers nothing**.

This is a **real styre deployment failure**, not a benchmark artifact: in both real deployment modes — commercial CI/cloud (`styre run` is *the* CI/cloud/fleet primitive) and OSS on a fresh checkout — styre meets environments that need provisioning. If it can't provision, it produces correct code and fails to deliver it.

The cure is to give styre the **provisioning capability as one of its own parts**, so `styre run` readies its verify environment under its own control. **Provisioning is NOT a new top-level stage** (DS-2: no ad-hoc stages) — it is a sub-step inside `implement`, run once **before the first `verify:check`**.

## 2. Goal & non-goals

**Goal:** before its first verify, `styre run` makes its **detected** verify command runnable against the **worktree source**, for the common case, via a general capability that serves real developers and the bench alike.

**Non-goals (this cycle):** stacks beyond **Python and Node**; a formal swappable provider contract (§7); the commercial managed-substrate; the separate "can't-verify → deliver nothing" behavior (§12).

## 3. Decisions (frozen; revised per review)

1. **The capability lives in styre core** — every downloader gets it. NOT bench-specific; there is **no "image-aware" provider** (eval images are ordinary Python/Node environments). styre core must **never** know about any benchmark (detect environments; never hardcode names).
2. **`styre setup` detects and records the bootstrap into the EXISTING `prepare` field** (schema v3, reserved for this workstream — WO-12); **`styre run` executes it** deterministically, as a `provision` step before the first verify. **No parallel field is added** (review P0-1).
3. **Provisioning never overrides the detected verify command** (review F1/F2/P1-2). It makes that command runnable and ensures the **worktree source** is what gets tested. "Reuse" means *skip a redundant install when the env is already ready*, never *swap the command* or *test an installed copy*.
4. **Runner-owned and deterministic — not the agent via Bash.** Preserves move-4 capability isolation. **Caveat stated honestly (review F6):** this runs arbitrary lockfile/`setup.py` code (postinstall scripts, build backends) **without** the operator command-approval gate that `verify`/`build` commands pass through (`src/cli/setup.ts:141`). It is a *checkpoint relocation*, contained by the sandbox, not an isolation *gain*. See §6.
5. **Provisioning is a PROBED effect, not an exactly-once journaled step** (review P0-2). Its idempotency is the run-time readiness probe (§5), re-evaluated against the actual (possibly fresh-on-resume) worktree every time. See §9.
6. **No formal provider seam now** (§7). Provisioning is plain styre logic; the commercial plane wraps the whole run and optimizes via infrastructure. The future seam is a deferred config override — **deferred, not unnecessary** (review F7).
7. **Open-core boundary:** provisioning *logic* = OSS (commodity, in core). Managed *infrastructure* = commercial plane, wrapping the run. The `prepare`-field evolution stays **additive/optional** so it does not bump `schemaVersion` or force re-setup (review P2).
8. **styre change + re-pin accepted** — curing the disease outweighs keeping `a2406a4` frozen.

## 4. Architecture — where it lives and what changes

Provisioning rides on styre's existing per-language detectors (`src/setup/lang/*.ts`), which already emit `{build,test,check}` commands and (for node/php/ruby) a `prepare` string. This is a real, named surface — **not** merely "a detector responsibility" (review F4):

**Files that change:**
- `src/dispatch/profile.ts` — evolve the existing optional `prepare` field to carry the bootstrap (kept additive/optional). No second field.
- `src/setup/lang/python.ts` — build the bootstrap (0% today: emits no `prepare`).
- `src/setup/lang/node.ts` — replace the current hardcoded, non-deterministic `prepare: "npm install"` with lockfile-aware `npm ci`/`yarn`/`pnpm`.
- `src/setup/detect-components.ts` — the safety backstop must cover the (now run-executed) command; a network-install string needs the same `isCommandSafe` gate the other commands get.
- `src/daemon/resolver.ts` — a new `provision` `StepDescriptor` in the (currently closed) union, sequenced before the first `verify:check` in the implement branch.
- `src/dispatch/handlers.ts` — register the `provision` step in `buildDispatchRegistry` + its handler (probe-then-install). **Not** folded into `verify:check` (which is documented read-only, `handlers.ts:83` — burying a mutating install there erodes that boundary and re-runs on every check).
- `docs/architecture/control-loop.md` + `minimal-loop.md` — a step-catalog entry for `provision` (it is a step, not a stage).

**Flow:** `styre setup` runs each detector → records `prepare` per component. `styre run`, at the new `provision` step (before first verify), **probes** each impacted component's env (§5) and installs only what's missing, deterministically, runner-owned.

**Why detect at setup but execute at run:** setup is the "understand the repo" phase, so *detecting how to install* fits there; the environment is ephemeral per-run, so *installing* happens at run time. Note (review F3): what setup records is only the **static, knowable** part (the install command); the readiness decision is **purely run-time** (§5) and never a second copy of the verify command — verify keeps reading `commands.test`, avoiding two writers of the same fact (single-SoT).

## 5. What "make it runnable + test the worktree source" means

styre's verify runs the component's `commands.test` in the worktree (`src/dispatch/handlers.ts:453`, cwd `worktreePath/dir`). Provisioning's job at run time, per impacted component:

1. **Probe readiness against the actual worktree:** is the detected command runnable *and* does it exercise the worktree source? (Node: `node_modules/` present and the test script resolves. Python: the test runner present **and** the worktree is what's imported — i.e. editable/source, not a separately-installed copy.)
2. **If ready → skip** (the reuse case; also how a plane pre-warm is consumed).
3. **If not ready → install** what the *detected command* needs, ensuring the worktree source is under test:
   - **Node:** lockfile install (`npm ci`/`yarn --frozen-lockfile`/`pnpm i --frozen-lockfile`). Tests resolve from local `node_modules` + source — no wrong-artifact risk.
   - **Python:** make the detected command runnable. If it is a source-building harness (`tox`/`nox`), install that harness (`pip install tox`) and let it build from source — **do not** substitute a bare runner. If it is bare `pytest`, ensure the worktree is `pip install -e .` (editable) so `import <pkg>` resolves to the worktree, not an installed copy.

**The load-bearing correctness rule (review F1/F2):** the reuse probe must distinguish *"this HEAD's source is under test"* from *"some installed copy is under test."* "importable + runner present" is **not** sufficient (a non-editable install passes it while importing the wrong bytes). Where the probe cannot prove the worktree source is under test, it must **fall through to install (editable)**, never assume ready. When in doubt, install.

**Honest limitation:** for Python-scientific repos whose real command is a heavy harness (`tox -e …-alldeps`), the correct path is a full rebuild — **slow and itself failure-prone**. We accept correct-but-slow over fast-but-wrong. The pre-built conda env cannot be safely shortcut without losing the harness's fidelity (env vars, markers, test selection) or testing an installed copy. This is a real constraint, honestly measured, not a solved problem.

## 6. Capability isolation — stated honestly

Provisioning is a **runner step**; the agent never installs deps (that is why it correctly hit "npm ci requires approval"). This keeps move-4 isolation for the *agent*. But it is not a security *gain* overall (review F6): the install commands run arbitrary network-fetched code (postinstall scripts, build backends, C-extension compiles) **outside** the operator sign-off gate that `verify`/`build`/`check` commands pass (`src/cli/setup.ts:141`). Two honest options, to decide in the plan:
- (a) route the bootstrap command through the **same operator sign-off** the other commands get (headless/`--trust-agent-commands` then implies trusting it, as today for verify), or
- (b) state explicitly that provisioning runs unapproved install code and relies on the **sandbox** (container / commercial substrate) for containment.
Either way the doc must not call checkpoint-removal an isolation win.

## 7. The seam — minimal, and deferred (not dismissed)

No formal provider contract now. The commercial needs are met without a slot: **where** it runs = wherever the plane launches `styre run`; **faster** = a plane-mounted cache the probe (§5) consumes transparently; **pre-installed** = the plane provisions editable-to-HEAD and the §5 probe reads "ready" and skips.

But "no seam needed" was too strong (review F7): an **assume-ready flag is a *skip* switch**; it does not express *"run these bootstrap steps, these env vars, in this order"* — a bespoke monorepo bootstrap, a docker-compose service dep, an air-gapped `PIP_INDEX_URL` mirror. That is a **replace-provisioning** hook, a different and real future need. This design **defers** it (its one-field shape is left to the cycle that needs it) but does not claim it unnecessary. The pre-warm "for free" story holds **only** if the plane pre-installs editable-to-HEAD (else it inherits the §5 wrong-artifact trap) — stated so the plane contract is honest.

## 8. Scope this cycle

Build the bootstrap+probe for **Python and Node** only:
- **Node:** probe `node_modules` + script resolvability; else lockfile install. Verify via the detected script.
- **Python:** probe runner + worktree-under-test; else install the detected harness (`tox`) or `pip install -e .` for bare `pytest`. Verify via the detected command.
- Add the `provision` resolver step + handler + step-catalog entry.
- Go/Rust/JVM/Ruby/PHP follow the same template later (Ruby/PHP already emit a `prepare` string to build on).

## 9. Crash-resume & idempotency (review P0-2)

`styre run` can park (session-limit / out-of-credits, exit 75) and resume; resume **wipes and recreates** the worktree (`src/cli/park.ts`), so any installed deps are gone. Therefore provisioning **must not** be an exactly-once journaled `succeeded` step (which `recover.ts` would skip on replay, leaving verify to run in an empty tree). It is a **probed effect**: on every run/resume the `provision` handler re-runs the §5 readiness probe against the *current* worktree and installs if not ready. The probe is the CL-3 external-state check that makes the effect idempotent. **Cost:** every resume re-installs unless a plane-mounted cache satisfies the probe — acknowledged.

The provisioning *outcome* (probed-ready / installed / install-failed) is persisted by the runner as a step/signal (single-writer SoT, B2) — a distinct, reportable result, separate from a verify failure.

## 10. The bench's role

The bench **authors no provider**. It re-pins `styreCommit` and runs — styre provisions the eval images itself (node: `npm ci`; python: install `tox`, or editable + pytest), verifies with the detected command against the worktree source, and (on a correct fix) opens a PR. No diff-capture workaround. This measures the loop (job #2) *and* styre's real provisioning + delivery (job #1) honestly. Note: provisioning must ready **every impacted/integration component** (`handlers.ts:555,630`), so a polyglot repo does N installs.

## 11. Testing strategy

- **Unit (per detector):** ready-env present → skip (probe true); no env → correct install command (node: `npm ci` not `npm install`; python: `tox` install or editable); unknown stack → no `prepare` (degradation).
- **Unit (probe):** the readiness probe returns **false** for a non-editable/installed-copy Python env (the F1/F2 regression guard — this is the test that proves we don't verify the wrong bytes) and true only when the worktree source is under test.
- **Unit (provision step):** issues the right deterministic commands before verify; a bootstrap failure is a distinct outcome; re-running against a fresh worktree re-installs (resume idempotency).
- **Live (gated):** `styre run` on a bare Node repo and a venv/conda Python repo → provisions → verifies → (on a real fix) opens a PR.
- **Bench (integration):** the re-pinned bench takes ≥1 SWE-bench and ≥1 MSB instance from "blocked (env)" to verified + PR-opened.

## 12. Separate / deferred (named, not dropped)

- **styre's "can't-verify → silently block, deliver nothing"** is its own defect. Even with perfect provisioning, the exotic tail (§9 fallback) stays un-provisionable; styre should then deliver-with-caveat or escalate work-ready. **Provisioning alone does not close the reported failure for that tail** — the two fixes deliver full value only together (review minor). Separate fix.
- **Commercial managed substrate**, **the replace-provisioning override seam**, **Go/Rust/JVM/Ruby/PHP** — all deferred.

## 13. Open risks

- **Reuse-probe false positives** (the F1/F2 hazard) — mistaking an installed copy / partial env for "ready" → verifying the wrong bytes. **Highest risk.** Mitigation: the probe must assert worktree-source-under-test, and fall through to install when it cannot prove it. This predicate must be specified as an actual boolean over run-workspace state in the plan, per language — if it can't be, that language degrades to "install every run."
- **Heavy-harness cost/flakiness** (§5) — `tox` rebuilds are slow and can fail; accepted as honest signal, watched at the live gate.
- **Approval-gate removal** (§6) — resolve (a) vs (b) in the plan; do not ship silent unapproved installs without a conscious choice.
- **Setup/run drift** — a `prepare` recorded at setup that doesn't fit the run workspace; mitigated because the run-time probe (§5/§9) re-decides readiness and only the static install command is carried.
- **(Closed, whole-branch review) Readiness is now content-aware, per package manager.** `isComponentReady` (Node/sveltekit) no longer trusts a bare marker-exists check: it compares the manager's completeness marker's mtime (npm `node_modules/.package-lock.json`, yarn `.yarn-state.yml`, pnpm `.modules.yaml` — all three checked) against the newest mtime among the manifest/lockfiles present (`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`). A manifest edited after the last install (e.g. a loopback dependency change that re-arms `provision` per §Task 9 / F-2) now correctly reads "stale" and reinstalls, instead of the marker silently reporting "ready" forever once written once. This also gives yarn/pnpm a real readiness cache for the first time (previously only npm's marker was checked, so yarn/pnpm always reinstalled).
- **(Narrowed, whole-branch review) The editable-install guard now matches by pattern, not exact string.** `isEditablePythonPrepare` matches any pip-editable invocation (`pip install -e .[dev]`, `pip install --editable .`, `python -m pip install -e .`, …), not only the literal `pip install -e .` — a config-overridden `prepare` string that still installs editable via pip is now guarded. **Residual, accepted gap:** a non-pip editable install supplied via the config-override seam (e.g. `poetry install`) does not match this pattern and is not guarded — narrower than "every editable install possible," but strictly broader than the single exact-string match it replaces. Closing the non-pip case is deferred to the replace-provisioning override seam (§7) if/when a real repo needs it.
