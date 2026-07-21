# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is right now

Styre is the **free, open-source execution core of an open-core autonomous-SDLC product** (a commercial "Control Plane" SaaS wraps it; the core must stay a clean plug-in target, never get forked). Its job: take a structured ticket (from Linear or Jira) and drive it through `design → implement → verify → review → merge → released` with minimal human involvement.

**The core is implemented and shipping** — TypeScript on Bun, embedded SQLite, compiled to a single self-contained binary and released via Homebrew (see `package.json`, `src/`, `test/`, and the `CHANGELOG`). The build is `bun run build`; tests are `bun test`; lint is `bun run lint`. Styre supersedes a legacy bash harness (in another repo) whose measured failure modes ground every decision here.

The canonical code-layout decisions live in `docs/architecture/build-operations.md`. `src/` top-level: `cli`, `config`, `daemon` (the control-loop engine), `dispatch`, `db`, `engine`, `integrations`, `agent`, `setup`, `telemetry`, `util`.

## Development workflow (hard rules)

- **Never commit directly to `main`.** All work happens on a branch.
- **Branch naming:** features and improvements use the `feat/` prefix; bug fixes use the `fix/` prefix.
- **Merging back is via PR only.** Open a PR from the branch into `main`.
- **No auto-merge, ever.** Do not merge PRs (no `gh pr merge`, no `--auto`). The operator merges every PR personally. Your job ends at "PR is open and ready."

## Read the docs in this order

Everything authoritative lives in `docs/architecture/`. Read top-to-bottom before changing anything:

1. **`minimal-loop.md`** — the concrete `next_step_key` state machine, loopback resets, budget numbers, the needs-you inbox. Start here; it's the most concrete.
2. **`control-loop.md`** — durable control-loop semantics: the control loop, the per-ticket event loop, step catalog (S1–S10) with per-step guards/inputs/outputs/tools, the structured-output interface (§3a), the Loopback Atlas (§8), invariants a step author must hold (§9).
3. **`projector.md`** — the one-way projector: the sole outward write path from SQLite to the issue tracker (Linear/Jira), the forge (GitHub), and the notifier (Slack), draining `projection_outbox`.
4. **`schema.sql`** — the SQLite SoT: **17 `CREATE TABLE` statements** (`grep -c '^CREATE TABLE'`). `memory_record` (Memory/UGL) is a commented-out `-- DEFERRED` stub, not one of the 17; `metric_event`, `external_id_cache`, and `projection_state` are defined but currently unwired; `run` (ENG-349) is the per-invocation identity table and is live. This file is a byte-identical copy of `src/db/schema.sql` — keep them in sync.
5. **`brainstorm.md`** — the running decision log / rationale. §4 gate taxonomy, §5 supervisor+memory (post-cutover), §9 migration plan, **§10 Open Decisions Register** (the DECIDED/OPEN status of every design item), §12 schema overview. It's append-only — **never rewrite its history**; add new entries to the §11 changelog.

The `▶ RESUME HERE` banner at the top of `brainstorm.md` is the live status pointer — check it first to see what's settled and what's open.

## Docs conventions (where new docs go)

There are exactly **three** doc folders. Do not create new ones without maintainer sign-off.

- **`docs/architecture/`** — the maintained reference: the substrate spec, glossary, ticket template, and the runtime/config/conventions references. Kept **current with the code** — when a change alters a documented behavior, update the reference in the same PR. (This is *not* a frozen, read-only spec; treating it as frozen is what let it rot in the past.)
- **`docs/brainstorms/`** → exploratory decision-shaping docs from the brainstorming skill. **Append-only history** — add new dated files, never rewrite old ones.
- **`docs/plans/`** → implementation/scaffolding plans from the planning skill. **Append-only history.**

Use the **superpowers brainstorming and planning skills** for that work, not ad-hoc freewriting.

> **OVERRIDE — do not obey the skill's default save path.** The superpowers brainstorming/planning skills instruct you to save to `docs/superpowers/specs/`. **Ignore that** — it is wrong for this repo. Brainstorm output → `docs/brainstorms/`, plan output → `docs/plans/`. Durable reference docs live in `docs/architecture/`. A `PreToolUse` hook in `.claude/settings.json` hard-blocks writes under `docs/superpowers/` and `docs/specs/`; if you hit that block, it is working as intended — redirect to the correct dir above.

## Architecture: the non-obvious invariants

These are the load-bearing decisions. Code that violates them is wrong even if it works:

- **Single transactional SoT (SQLite). Only the runner writes it** (B2). Workers/agents return results; the runner persists them. Two authoritative writers is the bug class (legacy ENG-217) this deletes by construction. (Multi-ticket concurrency cap K=2 is the commercial Control Plane; OSS `styre run` is single-ticket.)
- **The tracker and forge are one-way projections, never read for control flow** (move 2). All outward writes go through the projector draining `projection_outbox`, enqueued in the *same transaction* as the state change. Inbound facts (merged, human action) arrive only as **signals** (control-loop §7) — never by reading the tracker. (CI is *reported*, not gated: `styre run` takes one best-effort snapshot at PR-open and moves on.)
- **Durable step journal = exactly-once + crash-resume.** A succeeded `workflow_step` returns its recorded result on replay (the resolver never re-runs it). Every external effect carries an idempotency key + a probe of external state before applying (B3 / CL-3).
- **Ground truth over self-report** (move 5). Verdicts come from build/tests/CI/scope-diff/independent-reviewer — never agent self-scoring. Dimensional/self-scored grading is discarded.
- **Loop-not-halt.** The default response to any anomaly is absorb-and-continue (bounded retry against ground truth), not halt-to-human. Human gates wired at cutover are **MERGE only** + escalations.
- **Capability isolation** (move 4): agents get no `gh`/tracker/branch tools; the runner strips `LINEAR_API_KEY`/`JIRA_API_TOKEN`/`GITHUB_TOKEN` from the agent's environment (the provider key is retained so the agent CLI can authenticate; verify-time commands strip that too — see `SECURITY.md`). The worktree is the only writable surface. The runner holds creds and commits (CL-COMMIT).
- **Structured agent output goes through a validated (zod) interface; the runner computes decisions from state, never parses a free-form blob** (§3a). An absent/malformed payload is a *transport failure* (re-dispatch), not a "no".
- **Clean-break stage vocab from day one** (DS-2): `ticket.stage ∈ {design, implement, verify, review, merge, released}` — NOT the legacy gerund stages. Implement decomposes into per-`work_unit` dispatches tagged by `kind` (backend/frontend/data/…). **There is no hardcoded `ui` stage** — UI is a frontend work-unit + a visual verify check-type.
- **Timestamps: store UTC, display in the host's local timezone** at the render edge only (DS-1).
- **The autonomy layer (supervisor, memory/RAG, the Unified Gate Layer, learning loop — brainstorm §5/§5.8) is explicitly post-cutover.** The minimal loop is deterministic routing only. Don't build it into the substrate.

## Commands

OSS binary — **four** subcommands (`src/index.ts`). Full flag/exit-code/env detail in `docs/architecture/runtime-parameters.md`.
- `styre setup <repo>` — probe the repo and write the project profile (`profile.json`).
- `styre migrate` — bootstrap (create + migrate) the SQLite SoT.
- `styre run <ticket>` — one-shot headless runner (the CI/cloud/fleet primitive; ephemeral per-run SQLite).
  - On a session-limit / out-of-credits dispatch death, `run` parks: it dumps the SoT + transcript
    to `$XDG_STATE_HOME/styre/<slug>/<ticket-ident>/` and exits `75` (`EX_TEMPFAIL`) without
    burning a retry attempt. Resume with `styre run --resume <ticket> --profile <p>` (re-runs only
    the interrupted step, carrying its partial context forward). If the branch HEAD moved since the
    park, resume refuses (exit `65`); use `--accept-head` (resume against new HEAD, drops carryover)
    or `--inspect` (diagnostics only, exit `0`). A missing repo toolchain aborts a fresh run with
    exit `69` (`EX_TOOLCHAIN_MISSING`).
- `styre notify --test` — send a test notification through the configured notifier (Slack). Diagnostic; exits `2` if invoked without `--test`.

Stream contract: `styre run` writes **only NDJSON telemetry to stdout** and all human-readable output to **stderr**; `setup` and `migrate` print human output to stdout.

**(Commercial Control Plane only — not OSS, no subcommand ships in this binary):** persistent supervised mode, multi-ticket scheduling, K-concurrency; a management CLI (`status`/`inbox`/`config`/`pause`/`resume`/`logs`/`uninstall`); the needs-you inbox.

macOS and Linux are both first-class targets; paths follow the XDG Base Directory spec on both (only `XDG_CONFIG_HOME` and `XDG_STATE_HOME` are honored — see `docs/architecture/conventions.md`). The agent provider is operator config: `ANTHROPIC_API_KEY` for the default `claude` provider, or `OPENAI_API_KEY` for the `codex` provider. Models are set per **tier**, not hardcoded — `deep`/`standard`/`cheap` in the `agent.models` config block. The binary defaults are `deep: claude-opus-4-8`, `standard: claude-sonnet-4-6`, `cheap: claude-haiku-4-5-20251001` (`src/config/agent-config.ts`); which step runs on which tier lives in `src/agent/tiers.ts` (there is no "build" tier).

## The open-core seam (keep stable)

The commercial plane integrates only through these contracts (`build-operations.md` §5) — treat them as a versioned public API: the ticket contract (AC checklist, context-files, trigger state), the project-profile artifact, and the telemetry/state export.

**Config precedence (as implemented — see `docs/architecture/configuration.md`):** there is **no per-ticket config layer and no profile-derived config layer** in the OSS core. `config.json` and `profile.json` are disjoint artifacts. Runtime config resolves as: `--config <path>` (**hermetic** — sole source, nothing merged) **XOR** (per-project `<config>/<slug>/config.json` shallow-spread over global `<config>/config.json`, then zod defaults). `DO_NOT_TRACK`/`STYRE_TELEMETRY` env vars are a one-way veto on `telemetry`. A per-ticket `styre_config` block was scoped to the commercial plane and is **not** read by `styre run` — do not describe it as an OSS feature.
