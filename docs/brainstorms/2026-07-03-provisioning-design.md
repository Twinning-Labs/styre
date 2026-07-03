# Provisioning: making `styre run` ready its own verify environment

**Status:** Design (brainstorm output). Reviewed → implementation plan is a separate cycle.
**Date:** 2026-07-03
**Scope of this doc:** the design + seams of provisioning as a styre capability, and the decision to build only the general provisioner covering the Python and Node stacks now.

---

## 1. The problem (the disease, not the symptom)

Run against real repos (surfaced by styre-bench on SWE-bench Python + Multi-SWE-bench TS eval images), styre:

1. designs and implements a **correct** fix (verified: astropy-12907 got the exact gold fix; darkreader-7241 got the right anchored regex), then
2. tries to **verify** it, but its detected test command can't run — the environment isn't ready (`tox`/`pytest` deps not installed; `node_modules` absent), then
3. **correctly refuses to open a PR for unverified code** (the "ground truth over self-report" / "loop-not-halt" invariants working), and so
4. **blocks and delivers nothing**.

This is a **real styre deployment failure**, not a benchmark artifact. In both real deployment modes — commercial CI/cloud (`styre run` is *the* CI/cloud/fleet primitive) and OSS on a fresh checkout — styre will meet environments that need provisioning. If it can't provision, it produces correct code and fails to deliver it.

The cure is not to prop styre up from the bench harness (that treats the symptom and tests a styre that doesn't exist in the wild). The cure is to give styre the **provisioning capability as one of its own parts**, so `styre run` genuinely goes: setup → **provision** → design → implement → verify → PR, under its own control.

## 2. Goal & non-goals

**Goal:** `styre run` readies its own verify environment before the first verify, for the common case, using a **general** capability that serves real developers and the bench alike.

**Non-goals (this cycle):**
- Not building stacks beyond **Python and Node** (the bench's corpora). Go/Rust/JVM/Ruby/PHP follow the same template later, incrementally.
- Not building a formal swappable "provider contract" (see §7 — YAGNI).
- Not building the commercial managed-substrate.
- Not fixing styre's separate "can't-verify → silently block, deliver nothing" behavior (see §12) — that is its own defect, tracked separately.

## 3. Decisions (frozen in the brainstorm)

1. **The capability lives in styre core** — every downloader gets it. It is NOT bench-specific, and there is **no "image-aware" provider**. The eval images are ordinary Python/Node environments a *general* provisioner handles. styre core must **never** know about any benchmark (detect environments; never hardcode names like SWE-bench's `testbed`).
2. **`styre setup` detects and records the bootstrap plan; `styre run` executes it**, deterministically, right before the first verify.
3. **C1 — the bootstrap plan and the verify command are a matched pair** from one environment analysis (see §5).
4. **Runner-owned and deterministic — not the agent via Bash.** The agent hitting "npm ci requires approval" was *correct*; capability isolation stays intact. The runner provisions.
5. **No formal provider seam now** (see §7). Provisioning is plain styre logic; the commercial plane wraps the whole run and optimizes via infrastructure, both transparent to styre. A trivial config override is the only future seam, deferred.
6. **Open-core boundary:** provisioning *logic* = OSS (commodity; in styre core). Managed *infrastructure* (cloud sandboxes, caching, hermetic reproducibility, fleet isolation) = commercial plane, which wraps the run rather than re-implementing provisioning.
7. **styre change + re-pin accepted** — curing the disease outweighs keeping `a2406a4` frozen. The bench re-pins to the styre commit that includes this.

## 4. Architecture — where it lives and how it flows

Provisioning rides on styre's **existing per-language detectors** (`src/setup/lang/{python,node,go,rust,jvm,ruby,php}.ts`), which already emit each component's `{build,test,check}` commands. It is NOT new machinery — it is an added responsibility on those detectors.

**Uniform per-ecosystem strategy.** Each language detector answers three questions (the shared layer only knows this *shape*; the specifics stay private to each detector — this is the guard against per-stack special-casing leaking into the core):

| | Question | Python example | Node example |
|---|---|---|---|
| 1 | Is a usable environment already present? | a venv/conda env with the project installed | `node_modules/` present |
| 2 | If not, how to make it ready? | `pip install -e .` / `poetry install` | `npm ci`/`yarn`/`pnpm` (by lockfile) |
| 3 | What test command runs *in that environment*? | `pytest …` (in the env) | the package's test script |

**Flow:**
- **`styre setup`** runs each detector, which now also produces a **bootstrap plan** per component: `{ reuseEnv?: <how to use an existing env>, bootstrap?: <install command>, verifyCommand: <matched command> }`. Recorded in the profile.
- **`styre run`**, before the first verify, executes the recorded bootstrap plan **deterministically in the worktree** (runner-owned), leaving the environment ready for the detected verify command.

**Why detect at setup but execute at run:** setup is already the "understand the repo" phase, so *detecting* how to ready the env fits there; but the environment is ephemeral per-run (a fresh worktree; the run container may differ from where setup ran), so the actual *provisioning* must happen at run time when the workspace exists. This mirrors setup's existing split of "detect commands" from "run commands." (Risk: setup's environment may not match run's, so a recorded plan could be stale — mitigated because the plan is a small, environment-agnostic instruction like "npm ci" / "reuse a venv if present," re-evaluated against the actual run workspace by the reuse-check in §5.)

## 5. C1 — the matched (bootstrap, verify-command) pair

styre's verify runs the **component's `commands.test`** (`src/dispatch/handlers.ts:454`, `commandFor(c, "test")`). So the environment and the command it runs in are **one decision**: you can't pick the right test command without knowing the environment you'll have, and you can't ready the environment without knowing the command that must run in it.

**Rule — prefer a usable pre-existing environment over rebuilding from a config file.** When a ready env exists (a venv/conda with the project installed; a warm `node_modules`), the bootstrap is "use it" and the verify command is *that environment's native runner* (`pytest`), **overriding** a config-file command like `tox` that would rebuild from scratch. When no env exists, the bootstrap installs from the lockfile and the detected command stands.

This is not a bench accommodation: a developer with a working venv wants styre to use it, not re-run `tox`. It is also the mechanism by which the commercial plane's **pre-warming** works for free (§7): a pre-provisioned sandbox reads as "ready env" → styre reuses it → skips bootstrap.

The astropy failure was exactly this mismatch: styre picked `tox` (from `tox.ini`), which the pre-built conda env doesn't have. Under C1, styre detects the ready env and verifies with `pytest` in it.

## 6. Capability isolation

Provisioning is a **runner step**, not an agent capability. The agent never installs deps via Bash (that is why it correctly hit "npm ci requires approval"; the fix is the runner provisions, not loosening the agent). This preserves move-4 capability isolation and makes provisioning **deterministic and reproducible** — same input, same environment, every run — which a general benchmark requires.

## 7. The seam — deliberately minimal (YAGNI)

There is **no formal "provider contract"** in this design. Provisioning is plain styre logic. Every commercial need is met without a slot:

- **Where it runs:** wherever the commercial plane launches `styre run` (its managed machine) — the plane already wraps the whole run; provisioning is part of it. No slot.
- **Faster (caching):** the plane mounts a warm dependency cache into the sandbox; styre's `npm ci` hits it. Transparent. No slot.
- **Pre-installed env:** the plane pre-provisions the sandbox; styre's §5 reuse-before-rebuild detects "ready" and skips bootstrap. Already handled. No slot.

The **only** future seam — required by the "never fork the core" invariant so customers *extend* rather than fork — is a **one-line config override**: a `provision` hook / "assume-ready" flag in the profile/config that, when set, replaces styre's default provisioning. Cheap, additive, and **deferred** until a real customer environment needs it. Not built now.

## 8. Scope this cycle

- Build the **uniform strategy shape** on the detector interface + implement it for **Python and Node** (the two bench corpora; both immediately useful to real developers).
- Python: reuse an existing venv/conda env; else `pip install -e .` (or poetry). Verify via the env's `pytest`.
- Node: reuse `node_modules`; else lockfile install (`npm ci`/`yarn`/`pnpm`). Verify via the package's test script.
- Add the run-time **provision step** before the first verify.
- The other five stacks follow the same template later.

## 9. Error handling & graceful degradation

The provisioner must **never crash setup or run**. When a detector cannot determine a bootstrap (exotic setups — docker-compose test envs, custom Makefiles, multi-service, system `apt` deps), it records **no bootstrap**, and run falls back to **today's behavior**: assume the env is ready and run the detected command as-is. That instance may then fail verify — which is **honestly measured**, not masked. This is the same graceful-degradation styre already applies to unavailable commands (warnings, not crashes). The provisioner covers the common ~80%; the tail is config-override (§7) or later work.

Bootstrap execution failures (e.g. `npm ci` fails on a broken lockfile) are surfaced as a provisioning failure on the run — a real, reportable outcome, distinct from a verify failure.

## 10. The bench's role

The bench **authors no provider**. It re-pins `styreCommit` to the styre commit containing this capability and runs — styre provisions the eval images itself (reuse the conda env; `npm ci`/`yarn` for MSB), verifies with a matched command, and (when the fix is right) opens a PR. This tests styre **end-to-end and honestly** — no diff-capture workaround, no harness propping styre up. It measures the loop (job #2) *and* styre's real provisioning + delivery (job #1).

## 11. Testing strategy

- **Unit (per detector):** given a repo fixture, the Python/Node detector produces the correct `{reuseEnv?, bootstrap?, verifyCommand}` — including: ready-env present → reuse + native command (the tox→pytest override); no env → lockfile install + detected command; unknown → no bootstrap (degradation).
- **Unit (run step):** given a recorded plan, the provision step issues the right deterministic commands in the worktree, before verify; a bootstrap failure is surfaced distinctly.
- **Live (gated):** an actual `styre run` against a bare Node repo and a venv/conda Python repo that provisions → verifies → (on a real fix) opens a PR.
- **Bench (integration):** the re-pinned bench takes at least one SWE-bench and one MSB instance from "blocked (env)" to a verified, PR-opened run.

## 12. Separate / deferred (named, not silently dropped)

- **styre's "can't-verify → silently block, deliver nothing"** is its own defect. Even with perfect provisioning, some repo's verify will be un-runnable; styre should then deliver-with-caveat (an "unverified — needs review" PR) or escalate work-ready, not vanish. Separate fix.
- **Commercial managed substrate** — deferred; §7 shows it needs no seam here.
- **Config override seam** — deferred to first real need (§7).
- **Go/Rust/JVM/Ruby/PHP strategies** — later, via the §4 template.

## 13. Open risks

- **Setup/run environment drift** — a plan recorded at setup may not fit the run workspace. Mitigated by keeping plans environment-agnostic + re-checking "ready env?" at run time (§4, §5). Worth watching in the live gate.
- **Command-override aggressiveness** — "prefer the ready-env runner over the config-file command" could, in a pathological repo, override a legitimately-necessary command. Mitigation: only override when a *usable* env is actually detected; otherwise the detected command stands.
- **Reuse-detection false positives** — mistaking a partial/stale env for "ready" → verify fails confusingly. Mitigation: the reuse check should be conservative (require the project importable / the test runner present), else fall through to install.
