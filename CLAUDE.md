# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is right now

Styre is the **free, open-source execution core of an open-core autonomous-SDLC product** (a commercial "Control Plane" SaaS wraps it; the core must stay a clean plug-in target, never get forked). Its job: take a structured Linear ticket and drive it through `design → implement → verify → review → merge → released` with minimal human involvement.

**The repo currently contains only design docs and a schema — there is no implementation yet.** No `package.json`, no TypeScript, no build/test/lint commands. The design is *frozen and coherent* (the substrate spec is closed); the next work is to build it. The intended stack is **TypeScript + embedded SQLite** (the `.gitignore` is the standard Node one), compiled to a single self-contained binary. Styre supersedes a legacy bash harness (in another repo) whose measured failure modes ground every decision here.

When you add code, the canonical layout decisions live in `build-operations.md` (own repo, port-the-leaves into TS — do not vendor or shell out to the old bash repo).

## Development workflow (hard rules)

- **Never commit directly to `main`.** All work happens on a branch.
- **Branch naming:** features and improvements use the `feat/` prefix; bug fixes use the `fix/` prefix.
- **Merging back is via PR only.** Open a PR from the branch into `main`.
- **No auto-merge, ever.** Do not merge PRs (no `gh pr merge`, no `--auto`). The operator merges every PR personally. Your job ends at "PR is open and ready."

## Read the docs in this order

Everything authoritative lives in `docs/architecture/`. Read top-to-bottom before changing anything:

1. **`minimal-loop.md`** — the concrete `next_step_key` state machine, loopback resets, budget numbers, the needs-you inbox. Start here; it's the most concrete.
2. **`control-loop.md`** — durable control-loop semantics: the daemon, event loop, step catalog (S1–S10) with per-step guards/inputs/outputs/tools, the structured-output interface (§3a), the Loopback Atlas (§8), invariants a step author must hold (§9).
3. **`projector.md`** — the one-way projector: the sole outward write path from SQLite to Linear/GitHub.
4. **`schema.sql`** — the SQLite SoT (16 tables). Loads clean; invariants smoke-tested. Memory/UGL tables are a deferred `-- DEFERRED` stub.
5. **`brainstorm.md`** — the running decision log / rationale. §4 gate taxonomy, §5 supervisor+memory (post-cutover), §9 migration plan, **§10 Open Decisions Register** (the DECIDED/OPEN status of every design item), §12 schema overview. It's append-only — **never rewrite its history**; add new entries to the §11 changelog.

The `▶ RESUME HERE` banner at the top of `brainstorm.md` is the live status pointer — check it first to see what's settled and what's open.

## Docs conventions (where new docs go)

- **Brainstorms** → `docs/brainstorms/` — exploratory decision-shaping docs from the brainstorming skill.
- **Plans** → `docs/plans/` — implementation/scaffolding plans from the planning skill.
- **Repo (design) docs** → `docs/design/` — durable design docs, linked from the root `README.md`.

Use the **superpowers brainstorming and planning skills** for that work, not ad-hoc freewriting. (Note: the existing authoritative design docs currently live in `docs/architecture/`; see migration note in that section above until they are moved under `docs/design/`.)

> **OVERRIDE — do not obey the skill's default save path.** The superpowers brainstorming/planning skills instruct you to save to `docs/superpowers/specs/`. **Ignore that** — it is wrong for this repo. Brainstorm output → `docs/brainstorms/`, plan output → `docs/plans/`, durable design docs → `docs/design/`. A `PreToolUse` hook in `.claude/settings.json` hard-blocks writes under `docs/superpowers/` and `docs/specs/`; if you hit that block, it is working as intended — redirect to the correct dir above.

## Architecture: the non-obvious invariants

These are the load-bearing decisions. Code that violates them is wrong even if it works:

- **Single transactional SoT (SQLite). Only the daemon writes it** (B2). Workers/agents return results; the daemon persists them. Two authoritative writers is the bug class (legacy ENG-217) this deletes by construction. Concurrency cap K=2.
- **Linear/GitHub are one-way projections, never read for control flow** (move 2). All outward writes go through the projector draining `projection_outbox`, enqueued in the *same transaction* as the state change. Inbound facts (CI green, merged, human action) arrive only as **signals** (control-loop §7) — never by reading Linear.
- **Durable step journal = exactly-once + crash-resume.** A succeeded `workflow_step` returns its recorded result on replay (the resolver never re-runs it). Every external effect carries an idempotency key + a probe of external state before applying (B3 / CL-3).
- **Ground truth over self-report** (move 5). Verdicts come from build/tests/CI/scope-diff/independent-reviewer — never agent self-scoring. Dimensional/self-scored grading is discarded.
- **Loop-not-halt.** The default response to any anomaly is absorb-and-continue (bounded retry against ground truth), not halt-to-human. Human gates wired at cutover are **MERGE only** + escalations.
- **Capability isolation** (move 4): agents get no `gh`/Linear/branch tools and no ambient `LINEAR_API_KEY`; the worktree is the only writable surface. The daemon holds creds and commits (CL-COMMIT).
- **Structured agent output goes through a validated (zod) interface; the daemon computes decisions from state, never parses a free-form blob** (§3a). An absent/malformed payload is a *transport failure* (re-dispatch), not a "no".
- **Clean-break stage vocab from day one** (DS-2): `ticket.stage ∈ {design, implement, verify, review, merge, released}` — NOT the legacy gerund stages. Implement decomposes into per-`work_unit` dispatches tagged by `kind` (backend/frontend/data/…). **There is no hardcoded `ui` stage** — UI is a frontend work-unit + a visual verify check-type.
- **Timestamps: store UTC, display in the host's local timezone** at the render edge only (DS-1).
- **The autonomy layer (supervisor, memory/RAG, the Unified Gate Layer, learning loop — brainstorm §5/§5.8) is explicitly post-cutover.** The minimal loop is deterministic routing only. Don't build it into the substrate.

## Intended commands (once code exists)

Per `build-operations.md` §3 — three run modes on the single binary:
- `styre setup <repo>` — idempotent probe: discover project profile + checks-system, create+migrate the DB, refresh Linear id-cache, install the host service (launchd on macOS, systemd on Linux).
- `styre daemon` — persistent local supervised mode (solo/local-team).
- `styre run <ticket>` — one-shot headless runner (the CI/cloud/fleet primitive; ephemeral per-run SQLite).
- Management CLI: `status` · `inbox` (resume / `--after-fix` / abandon) · `config` · `pause`/`resume` · `logs` · `uninstall`.

macOS and Linux are both first-class targets; paths follow the XDG Base Directory spec on both. Auth supports a subscription session (local) **or** `ANTHROPIC_API_KEY` (required for headless). Model tiers: design/review = Opus 4.8, implement = Sonnet 4.6, build = Haiku 4.5.

## The open-core seam (keep stable)

The commercial plane integrates only through these contracts (`build-operations.md` §5) — treat them as a versioned public API: the Linear ticket contract (the `styre_config` block, AC checklist, context-files, trigger state), the project-profile artifact, and the telemetry/state export. Config precedence: **per-ticket > workspace `config.json` > profile > binary defaults.**
