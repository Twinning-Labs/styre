# Language-agnostic `styre setup` — deterministic-breadth design (v2.1)

**Status:** Design v2.1 — revised after an independent 4-reviewer pass (scope / adversarial / feasibility / security); operator decisions folded in (A1 trust-flag, C/C++ dropped, sequencing). Pending final review.
**Date:** 2026-06-28
**Branch:** `feat/polyglot-setup`.
**Companion:** `2026-06-28-setup-verify-security-findings.md` (F1–F4 = Track A / milestone **M-A**).
**Decision held:** the `2026-06-24-polyglot-monorepo-support-design.md` rule *"the scan anchors existence; the agent does not invent stacks"* **stays closed.** Tier-2 agent invention deferred — §6.

---

## 0. What changed (v1 → v2 → v2.1)

v1 proposed deterministic breadth **+ gated agent invention** of components (a `--trust-agent-components` flag, an `unconfirmed-component` signal, `source`/`confirmed` schema fields). The 4-reviewer pass killed the invention tier:

- **YAGNI / wrong reopen.** All intended benchmark languages have standard manifests → deterministic detection covers the whole acceptance corpus. No named stack needs invention.
- **Wrong security axis.** v1 keyed safety on *component existence*; the dangerous artifact is the *command string*, which the agent can overwrite even on a deterministic component (`discover-schema.ts:38`). Provenance must be **per-command**.
- **Live security holes underneath** (F1–F4): headless command injection, ungated `repoCommands`, `..` traversal, `ANTHROPIC_API_KEY` in verify env — must be fixed before widening the surface.

**v2.1 operator decisions:**
- **A1:** a **narrow `--trust-agent-commands`** opt-in for *headless* acceptance of agent-refined command strings (command-scoped — NOT the rejected component-invention flag).
- **C/C++:** **dropped** from the first cut (weak `make`/`ctest` guess; revisit with config-driven detection). First cut = **Python, Go, JVM-Maven, JVM-Gradle**.
- **Sequencing:** **M-A (harden) first**, then M-B (breadth); the bench's Axis-1 (supplied commands) may proceed in parallel.

**v2.1 = Track A (M-A, harden) → Track B (M-B, deterministic breadth). Tier-2 deferred.**

## 1. Problem (confirmed accurate by review)

`styre setup` detects components for **Rust and Node only**. `detectComponents` has two branches: Rust (`Cargo.toml`, `detect-components.ts:77`) and Node (`package.json`, `:101`); any other primary stack → `{ components: [], repoCommands: {} }`. The discovery agent is code-blocked from filling the gap — `mergeComponents` does `scan.map(...)` and drops agent-only components (`discover-schema.ts:24-26`). The TTY ladder (`resolve-commands.ts:20`) only fills missing commands on existing components. Net: a non-Rust/Node repo → empty, command-less profile → verify resolves zero commands → `error`, never `pass`. The `run` loop is language-agnostic; **the gap is entirely in detection.** (`STACK_KEYWORDS`, `setup.ts:49`, is analytics-only.)

## 2. Goal & non-goals

**Goal:** deterministically detect components (existence + a runnable test command) for the major manifest-bearing ecosystems, so the language-agnostic `run` loop runs across the benchmark corpus — *without* widening the command-execution attack surface.

**Non-goals (this arc):** agent-invented components (§6); multi-module workspace collapse for non-Rust/Node (§5.4); C/C++, Ruby, PHP, .NET, Swift in the first cut (follow-on, §5.2); a general verify sandbox (F4 is the first concrete cut).

## 3. Track A — harden the command pipeline (milestone M-A)

Fix F1–F4 **first** (Track B widens the repos the agent refines and the toolchains verify runs):

- **A1 (F1) — command validation + headless command policy + the trust flag.** Reject shell metacharacters (`; && || | \` $( > < newline`) in any agent-supplied/overridden command string at merge/persist time (all modes). In **headless** setup, agent command *overrides* are **rejected by default** — persist the machine-authored candidate command (or `{unavailable}`). A new **`--trust-agent-commands`** flag opts in to accepting agent-refined command strings headless (still subject to the metacharacter ban). Interactive keeps the existing all-or-nothing operator confirm (`setup.ts:150`). Provenance is tracked **per-command** (which command slots the agent authored/overrode vs. machine candidates) — transient at merge/persist time; no persisted `ComponentSchema` field needed.
- **A2 (F2) — gate `repoCommands`.** Run agent `repoCommands` through `probeCommandExists` + the metacharacter ban; in headless mode drop them unless `--trust-agent-commands` (parity with A1). Interactive keeps the existing confirm.
- **A3 (F3) — `..` path guard.** `!/^\*/.test(g.trim()) && !g.includes("..")`, normalize globs, **drop** (don't crash on) a component left with zero paths.
- **A4 (F4) — scrub `ANTHROPIC_API_KEY` from the verify env.** Split env policy: `runCommand` (verify) gets a stricter env that also strips `ANTHROPIC_API_KEY`; the agent-CLI spawn keeps it.

M-A is a self-contained, independently-reviewable security increment with standalone value.

## 4. (moved to §5) — see Track B

## 5. Track B — deterministic breadth (milestone M-B)

### 5.1 Prerequisite: extend the manifest-walk skip set
`findManifests`' `SKIP` set (`detect-components.ts:5`, `{node_modules, target, .git, dist, build, .svelte-kit}`) is Rust/Node-tuned. Adding Python/Go manifests would make the depth-3 walk descend into dependency trees → **phantom components**. Extend `SKIP` first: `.venv`, `venv`, `.tox`, `__pycache__`, `vendor`, `.gradle`, `.mvn`, `Pods`, etc. Correctness prerequisite, not a follow-on.

### 5.2 Detectors (first cut — 4 ecosystems; C/C++ dropped)
Single-component (N=1), machine-authored candidate command; existence-probe drops it if the tool is absent.

| Manifest(s) | kind | build candidate | test candidate |
|---|---|---|---|
| `pyproject.toml` / `setup.py` / `requirements.txt` | `python` | — | see §5.3 |
| `go.mod` | `go` | `go build ./...` | `go test ./...` |
| `pom.xml` | `jvm-maven` | `mvn -q -DskipTests compile` | `mvn -q test` |
| `build.gradle[.kts]` | `jvm-gradle` | `gradle build -x test` | `gradle test` |

**C/C++** (`CMakeLists.txt`/`Makefile`) — **dropped** from the first cut (operator decision: too much variance — cmake+ctest vs autotools vs bespoke; the `make`/`ctest` guess is weak). Revisit with config-driven detection. **Ruby/PHP/.NET/Swift/Elixir** → single-commit follow-on per consumer demand.

### 5.3 Python test-runner detection
Bare `pytest` is wrong for many real repos. Detect the runner deterministically from config first: `tox.ini` → `tox`; `noxfile.py` → `nox`; `pytest.ini` / `[tool.pytest]` in `pyproject.toml` → `pytest`; else candidate `python -m pytest`.

### 5.4 Single-module first; defer workspace collapse
Multi-module Maven/Gradle/`go.work` would emit N components with reactor-fragile per-subdir commands the binary-only probe won't catch. First cut: **single-module N=1 only.** Workspace-collapse parsers (mirroring Rust `cargoWorkspaceMembers`/`collapseWorkspaceGlobs`) are a follow-on triggered by the first real multi-module repo; until then a multi-module repo is detected as N=1 root with a loud note.

## 6. Deferred — Tier 2 (agent invention)

Agent invention of components for genuinely-bespoke stacks (no standard manifest) is **deferred** until a named stack requires it that manifest-anchoring cannot detect. Its own future spec would need: per-**command** provenance, a real command-shape allowlist (not the first-token `command -v` probe), a trust model that isn't a permanently-on CI flag, and `repoCommands` coverage. None built now. The 2026-06-24 decision stays closed.

## 7. Invariants (honest)

- **Capability isolation / ground-truth:** M-A *restores* these on the existing pipeline (closes F1–F4) before M-B widens the surface. Verify stays deterministic (exit codes); no agent at the gate.
- **Determinism:** M-B detection is machine-anchored; headless persists machine-authored commands by default (agent overrides only behind `--trust-agent-commands`). Agent non-determinism never reaches the runtime gate.
- **No new unscoped-Bash path:** A3 closes `..` widening; no invention path added.

## 8. Blast radius

M-A: `discover-schema.ts` (metachar validation, per-command provenance, `..` guard, drop-empty), `discover.ts` (probe + gate `repoCommands`, headless command policy), `cli/setup.ts` (`--trust-agent-commands` flag, headless command policy; confirm is **all-or-nothing** `y/N` today — `setup.ts:150` — per-component reject is out of scope), `run-command.ts` + `agent-env.ts` (verify-env split). M-B: `detect-components.ts` (SKIP set + 4 detector branches + Python runner detection), fixtures per ecosystem. Telemetry: the per-language auto-detection metric reads **`stackBucket`** (`setup.ts:49`), not `component_kinds` (which buckets new kinds to `"other"`). **No `ComponentSchema` change.** `schemaVersion` stays 2.

## 9. Test strategy (TDD)

- **M-A:** metachar-rejection per forbidden token; `--trust-agent-commands` headless gate (default-reject vs flag-accept) for both component commands and `repoCommands`; `repoCommands` probe; `..`-traversal + drop-empty; verify-env excludes `ANTHROPIC_API_KEY` while agent-CLI env retains it.
- **M-B:** one fixture repo per ecosystem (minimal manifest + a `.venv`/`vendor` decoy asserting the SKIP set) asserting component + candidate command; Python runner-detection matrix (`tox.ini`/`noxfile.py`/`pytest.ini`/bare).
- **End-to-end:** the bench Axis-2 (per-language auto-detection) is the integration regression test once M-B lands.

## 10. Milestone sizing & sequencing

- **M-A (Track A):** security hardening — small, high-value, ships independently. **First** (operator-confirmed).
- **M-B (Track B):** SKIP-set + 4 detectors + Python runner detection + fixtures. Depends on M-A.
- Ruby/PHP/C-C++, workspace-collapse, Tier-2 → later, consumer-triggered increments.
- Bench Axis-1 (supplied commands) may proceed in parallel with M-B.

## 11. Resolved decisions (was: open questions)

- **A1 strictness → RESOLVED:** narrow `--trust-agent-commands` opt-in for headless agent-command refinement (default reject; metachar ban always on).
- **C/C++ → RESOLVED:** dropped from the first cut.
- **Sequencing → RESOLVED:** M-A first, then M-B; bench Axis-1 in parallel.
- **Still open (M-B detail, for the M-B plan):** Maven/Gradle reactor — confirm single-module-only first cut emits a usable profile (or a loud skip) on a multi-module repo.
