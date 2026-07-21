# Build & Operations (open-core)

> Captures the **repo, distribution, install/setup, run modes, auth, and the open-core seam** for
> **Styre**. Grounded in the commercial vision (`~/code/SDLC SaaS Product.md`) and GOAL-INSTALL
> (control-loop §10). **Styre** is the **free OSS execution core**; a separate commercial **SaaS
> Control Plane** plugs in around it. This doc defines the core's shape so the plane is a clean
> plug-in, never a fork. Status: draft 2026-06-20.

---

## 1. Repo + the leaves `[DECIDED — operator 2026-06-20]`

- **Styre is its own repo** (greenfield TS product) — *not* built inside the legacy bash prototype it
  supersedes; Styre gets its own repo, name, CI, and release process.
- **Do NOT vendor the leaves.** Instead **port them authoritatively** into the new codebase: the prompt
  assets (`AGENT_PROMPTS.md` content) are copied in as first-class assets; the leaf *logic*
  (`render-prompt` extraction, the `dispatch.sh` invocation, `scope-check`'s diff) is reimplemented in
  TS as needed. The new repo is **self-contained** — no `leaves/` sidecar, no shell-out to the old repo.
  - *Reconciliation:* this supersedes the cutover-convenience "shell out to `dispatch.sh`" in
    minimal-loop §3 — the dispatch invocation becomes native TS. (The §3a *disambiguation* and the
    structured-output story are unaffected; only the seam moves from bash-shell-out to in-process.)
- **The old repo stays live** through the 1–2 week rollback window (§9.4 #7), then is decommissioned.
- `docs/architecture/` moves to the new repo as the product's design docs (the current branch keeps history).

## 2. The open-core boundary (what's CORE vs the PLANE)

From the commercial blueprint (SaaS doc §6). The **core is self-sufficient and free**; the plane is the
paid layer that removes organisational/financial/social friction.

| SDLC stage | OSS core (`styre`) | Commercial plane ("Control Plane") |
|---|---|---|
| Ideas → Tickets | execute a *structured* ticket (own design stage for rough tickets) | the **Autonomous PM**: messy idea → atomised, machine-readable tickets |
| Tickets → SDLC | **our substrate** — design→implement→verify→review→merge loop, worktrees, bounded cycles | guardrail/budget panel, escalation routing, **parallel fleet** |
| SDLC → Measure | verify telemetry hooks exist; local test runs | ephemeral-env preview sync |
| Measure → Report | per-ticket execution summary to terminal/JSON | persona-filtered weekly drill-down dashboards |
| Report → Learn | raw `learned-rules/` dump (the retrospective) | retro portal + profile compaction/auto-update |

**Everything we've specced (schema / control-loop / projector / minimal-loop) IS the core's
"Tickets → SDLC" engine.** The plane never reaches inside it — it talks through the stable contracts in §5.

## 3. Distribution, install targets + run modes

**Install targets are macOS *and* Linux — both first-class — plus a container image and a GitHub
Action.** This is real, not aspirational: the runtime is OS-portable by construction (TypeScript +
embedded SQLite + native timers — **no launchd, no `gtimeout`, no bash**), so the OS only shows up at
the *service-install* edge. The same TS core compiles to per-platform binaries.

- **Distribution per target:**
  - **macOS** (Apple Silicon + Intel) — `brew install styre` (Homebrew tap) or the release binary.
  - **Linux** (x86_64 + arm64; box / VM) — a one-line install script (`curl … | sh`) or the release
    tarball (a **static/musl** build for portability across distros); `.deb`/`.rpm` later.
  - **Container** — a small OCI (Linux) image; the primary cloud / fleet / CI artifact.
  - **GitHub Action** — wraps the container/binary for CI.
  - **Upgrade** (any target): replace the binary/image; `migrate()` self-applies schema migrations on start.
- **OSS run modes (`styre` binary):**
  - **`styre setup <repo>`** — the probe: discover the project-profile, discover/ask the checks-system,
    write the project profile (`profile.json`). Idempotent. *The developer hook.*
  - **`styre migrate`** — bootstraps and migrates the SQLite SoT under `$XDG_STATE_HOME/styre/`.
  - **`styre run <ticket>`** — a **one-shot runner**: execute ONE ticket to PR-ready and exit,
    emitting NDJSON telemetry to stdout. Ephemeral per-run SQLite — the journal gives in-run
    crash-resume; durable output = the git branch + telemetry stream.
    - **Park on session interruption (exit 75):** if the run is interrupted (credits/limit), it parks:
      dumps the SoT + transcript to `$XDG_STATE_HOME/styre/<slug>/<ticket-ident>/` and exits
      `75` (EX_TEMPFAIL) without burning a retry. Resume with `styre run --resume <ticket> --profile <p>`
      (re-runs only the interrupted step; `--accept-head` accepts a moved HEAD; `--inspect` is
      diagnostics-only, exit `0`).
  - **`styre notify --test`** — a diagnostic that sends one test notification through the configured
    notifier (Slack). There is **no** OSS `status` / `config` / `logs` management CLI — the OSS binary
    is exactly these four subcommands (`migrate` · `notify` · `run` · `setup`).

- **Commercial Control Plane run modes** *(not part of the OSS binary — the persistent orchestration
  layer lives in the separate `control-plane` repo):*
  - **`styre daemon`** — persistent local service, supervised by the host service manager
    (**launchd / systemd**), watches the SQLite queue, K-concurrency, one DB / all projects (CL-1).
    Orchestrates many `styre run` invocations for multi-ticket pickup, dependency-aware scheduling,
    and persistent supervision. **This command does NOT exist in the OSS binary.**
  - **commercial management CLI:** `inbox` (resume/`--after-fix`/abandon) · `pause`/`resume` ·
    `uninstall`.

### 3.1 The install matrix (macOS · Linux · container)

| | **macOS** | **Linux** (box/VM) | **Container / cloud** |
|---|---|---|---|
| Get it | `brew install styre` / release binary | `curl … \| sh` / release tarball (static/musl) | OCI image (Linux) |
| Arch | arm64 + x64 | x86_64 + arm64 | per-arch images |
| Daemon supervisor | launchd LaunchAgent *(commercial plane)* | **systemd** *(commercial plane)* | orchestrator (k8s / Fargate) *(commercial plane)* |
| State / config paths | XDG | XDG | mounted volume (persistent) or ephemeral (runner) |
| Primary mode | `styre run` (ephemeral, one ticket) | `styre run` (ephemeral, one ticket) | `styre run <ticket>` (ephemeral worker) |
| Auth | subscription session *or* API key | either | `ANTHROPIC_API_KEY` (headless) |

- **One path model on both OSes** — the **XDG Base Directory spec** (Linux-native, works cleanly on
  macOS): DB at `$XDG_STATE_HOME/styre/`, config at `$XDG_CONFIG_HOME/styre/`. No per-OS path forks.
- **Host deps (all targets):** `git`, `gh`, the `claude` CLI; node is bundled in the binary.
- **`styre setup` is OS-aware:** it probes the repo and writes the project profile (`profile.json`).
  The commercial Control Plane's host-service installer (launchd plist on macOS / systemd unit on Linux)
  is rendered by the plane, not the OSS `setup` command — the control-loop engine is identical; only
  the supervisor wiring differs.
- **No-init environments** (bare containers, minimal images): run `styre run` directly under the
  orchestrator / as PID 1 — no service manager required.

### 3.2 Cloud-native operation (the fleet)

- **The cloud pattern is the headless runner, not a shared daemon.** The SaaS fleet runs **N ephemeral
  `styre run <ticket>` workers** (a k8s `Job` / Fargate task / CI job), each in its own container with its
  **own ephemeral SQLite** and worktree, executing one ticket and exiting:
  - **no shared database, no multi-writer problem** — the single-writer invariant (B2) holds *per runner*;
    the SaaS Control Plane (not the core) decides which ticket each worker gets.
  - **horizontally scalable + stateless** — autoscale freely; durable output = git branch + telemetry,
    not local disk; a killed worker is just re-spawned on the same ticket.
  - logs to **stdout** (container-native); secrets via env / a secret manager.
  - the **GitHub Action** is this same runner on GitHub's Linux runners.
- **Persistent-daemon mode** (one box, one SQLite, K-concurrency) is the **commercial Control Plane**
  model on Mac *or* Linux — it orchestrates many `styre run` invocations. `Postgres`-on-concurrency-demand
  (schema §9.2) is the upgrade path only if anyone ever wants a single shared multi-worker daemon — the
  fleet model avoids needing it.

## 4. Auth + config (re-thought for both audiences)

> **Provider-agnostic (2026-06-21):** the model tiers here (Opus/Sonnet/Haiku) are the *default
> Claude adapter*'s preset, not a core assumption. The agent is a config-selected provider behind a
> generic `AgentRunner`; steps map to abstract tiers (deep/standard/cheap) and config maps tier→model
> id per provider. See `docs/brainstorms/2026-06-21-provider-agnostic-agent-design.md`.

**Auth — TWO modes** (a change from the local-only "subscription session, never an API key"):
- **Subscription session** — local dev; cheapest for an individual; the OSS adoption hook.
- **`ANTHROPIC_API_KEY`** — **required for headless** (the GitHub Action, the cloud fleet): an interactive
  subscription session can't run unattended. The core must support both and pick by context.
- **Linear + GitHub creds** — the dev's own (OSS) or centrally managed/injected (SaaS).

**Config — now FOUR tiers** (the SaaS's primary control lever is the *per-ticket* tier):

| Tier | Holds | Set by |
|---|---|---|
| **per-ticket** `styre_config` block (in the Linear ticket) | `max_loop_cycles`, `strictness`, `test_command`, `target_branch` | **the SaaS** (or a solo dev by hand) |
| workspace `config.json` (per project) | budgets, models, gates, checks-system | operator |
| project-profile | stack truth (build/test/tools/layout/kinds) | discovered; SaaS may auto-update |
| binary defaults | the cutover defaults (minimal-loop §4) | shipped |

Precedence: **ticket > workspace > profile > default**. The harness **reads the ticket's config block**
so the plane can set per-ticket budgets/strictness without touching the binary. The vision's
*N-cycles* and *strictness* map directly onto our **K_DISTINCT** and **review block-threshold**.

> **Deferred to the commercial product `[DECIDED — operator 2026-06-23; brainstorm §11]`.** The
> **per-ticket `styre_config` tier is NOT built in the OSS core** and is not planned for it. Because
> OSS `styre run` is one-shot, the caller (a solo script *or* the plane) already sets each run's
> config through the normal `--config`/RuntimeConfig path at launch, so a ticket-embedded block the
> core must parse is redundant. The OSS core reads only **title + description + type** from a ticket
> (`IngestedTicket`). The three lower tiers (workspace `config.json`, profile, defaults) are the live
> OSS config surface; the per-ticket tier is a plane-owned enrichment. The *N-cycles/strictness →
> K_DISTINCT/block-threshold* mapping still holds for whatever sets RuntimeConfig — just not via a
> ticket block in OSS.

> **`[IMPLEMENTED 2026-07-07]`** The workspace-config loader is wired: `styre run`/`setup` discover
> `~/.config/styre/config.json` (global) + `~/.config/styre/<slug>/config.json` (per-project),
> shallow-merged under an explicit `--config`. Profile auto-discovery by slug is likewise live for
> `styre run`. See `docs/brainstorms/2026-07-07-config-profile-by-convention-design.md`.

## 5. The open-core seam — stable contracts the plane plugs into `[BUILD THESE STABLE]`

> **This is the OSS↔commercial integration boundary.** The commercial Control Plane integrates with the
> OSS core *exclusively* through these contracts. They are versioned, stable, and public — the plane must
> never fork or import the core; the core has zero knowledge of the plane. A solo dev can run the OSS
> core forever without the plane. Build these stable from day one so the plane never needs a fork.

The plane integrates *only* through these. Treat them as the public API surface (versioned, documented):

1. **Linear ticket contract (input).** `[OSS scope narrowed — operator 2026-06-23; brainstorm §11]`
   At OSS cutover the core reads only **title + description + type** (`IngestedTicket`). The richer
   contract — the `styre_config` metadata block, the AC checklist, the target-context-files list, and
   the `Ready for Agent` trigger state — is **owned by the commercial plane, not built in the OSS core**:
   the plane writes/enriches the ticket and steers each one-shot `styre run` via per-invocation config;
   AC criteria and context-file hints already ride as **prose in the `description`** (ingested → fed to
   the design stage), so no OSS capability is lost. Keep this contract's *shape* stable for the plane,
   but the parsing/ingestion lives plane-side. (A solo dev writes acceptance criteria + file hints as
   description prose, or relies on the harness's own design stage.)
2. **The profile artifact.** Canonical stack truth (`profile.md`). The plane reads/compacts/auto-updates
   it; the core reads it. Keep its schema stable.
3. **Telemetry / state (output).** The SQLite DB (readable) + a documented **telemetry export** — the
   metrics the dashboards need (cycle count, unit cost per ticket, autonomous-fix ratio, first-time CI
   pass rate, escalation reasons). Our `dispatch` / `event_log` / `ground_truth_signal` rows already
   hold this data; expose it cleanly + emit a per-ticket terminal/JSON summary.
   - **The export's wire form is a structured event stream to stdout** `[DECIDED — operator 2026-06-20]`:
     the core writes each **`dispatch`** (per-step cost/tokens incl. `cache_read`/`cache_create`) /
     `event_log` / `ground_truth_signal` row to stdout (NDJSON) as it is journaled, plus a final
     per-ticket **summary** (cost/tokens/cache summed) on exit. This is container-native (the
     orchestrator's log pipeline ingests it), idempotent (rows keyed by `dispatch_id` so a re-spawned
     worker dedups cleanly), and **lives in the OSS core** — the GitHub Action and any self-hoster get
     it too. The plane *consumes* this stream; it does not fork the core to produce it. `[implemented —
     M9, PR #23]` *(The `metric_event` table is an OPTIONAL denormalized rollup the plane may derive
     from this stream; the OSS core does not write it — see schema.sql. The earlier "writes each
     `metric_event` row" phrasing predates the implemented shape, which emits `dispatch` rows.)*
   - **The wire stream is now `SCHEMA_VERSION = 2`.** The field-by-field spec — every event type
     (`event`/`dispatch`/`signal`/`summary`/`ci_handoff`), each field's type/nullability/source, the
     cost/aggregate contract (`usage_coverage`, floor-sum, `null` = unreported), `run_id` vs.
     run-local `ticket_id` semantics, and the reserved (currently-`null`) `event.dispatch_id` — lives
     in [`telemetry-export.md`](telemetry-export.md), kept current with `src/telemetry/events.ts`.
4. **(Later) a programmatic API.** The vision mentions "feeds into the harness API." At OSS cutover the
   artifact contracts (1–3) suffice; a thin REST/IPC API is a later addition for tighter coupling.

## 6. Implications to thread into the spec (flag, don't redesign now)

- **SaaS enrichment = richer design INPUT, not a skipped stage** `[corrected — operator 2026-06-20]`.
  A SaaS-fed ticket carries more context (enriched description, AC, candidate context-files, config),
  but the harness's **design stage always runs, full-strength**: ticket → brainstorm+plan → plan-review
  (S1c) → work-unit decomposition. It is the *same* stage with better starting material — exactly like
  doing design from any rich Linear ticket. There is **no "pre-scoped" track**; the only track
  distinction stays fast/full by size (C2). *Rationale:* design's value (feasibility against the **actual
  codebase**, decomposition, the plan-quality gate) is independent of how the ticket was scoped upstream;
  skipping it forfeits the harness's own ground-truth validation. (The SaaS decomposes *idea → tickets*;
  the harness decomposes *each ticket → work-units* — different granularities, no overlap.) The SaaS's
  candidate context-files become *advisory input* to design (→ `work_unit.files_to_touch`, reviewer-judged
  per A3), not a hard scope lock at cutover.
- **Per-ticket budget/strictness** = the vision's N-cycles/strictness → our K_DISTINCT / block-threshold.
  In OSS these come from RuntimeConfig set per invocation (`--config`), **not** a ticket-embedded block —
  the per-ticket `styre_config` tier is plane-owned and deferred out of OSS (§4 deferral note; brainstorm
  §11 2026-06-23).
- **Headless runner mode** ⇒ the durable-execution model spans **ephemeral per-run SQLite** (`styre run`)
  and the **persistent daemon DB** *(commercial Control Plane)* — both must work; the journal semantics
  are identical, only the DB lifetime differs. `[RESOLVED — operator 2026-06-20]` **One core, no fork.**
  SQLite is the system of record in *both* modes — the OSS model is `styre run` (ephemeral per-run DB,
  one ticket, exits at PR-ready); the persistent daemon DB is the **commercial plane** (long-lived, multi-ticket
  orchestration). The ephemeral DB is the in-run journal; durable output that survives the runner is
  **git branch + the stdout telemetry stream** (§5.3, option B). The commercial value stays entirely in
  the *plane* (Autonomous PM, dashboards, fleet orchestrator, escalation routing, retro portal — §2)
  which wraps the unmodified core; there is **no closed-source fork of styre** (CLAUDE.md invariant; §1).
  The DB-lifetime switch is run-mode config, not a second codebase.
- **Telemetry is first-class**, not an afterthought — it's a paid-product input, so the per-ticket
  summary + the export schema get designed deliberately.

## 7. Status

**DECIDED (operator 2026-06-20):** new repo · port-the-leaves · the three **run modes** (setup / daemon /
headless `run`) · **dual auth** (subscription session + `ANTHROPIC_API_KEY`) · the **§5 seam as the
first build priority**. The open-core boundary + four-tier config follow from the vision and stand.
**Corrected:** the "pre-scoped skips design" idea is **rejected** — design always runs (§6); SaaS
enrichment is richer input only. **DECIDED (operator 2026-06-20):** **no closed-source fork** — one
core serves both SoR modes (persistent daemon DB + ephemeral per-run DB); the §5.3 telemetry export
is a **structured stdout event stream (option B)** that ships in the OSS core; commercial value lives
only in the plane (§6 resolved). Remaining §6 flag for a later spec pass: the per-ticket-config →
K_DISTINCT/threshold mapping. Get the §5 contracts stable early so the plane never has to fork the core.

> **NOTE — superseded by OSS/commercial boundary (2026-06-26):** The 2026-06-20 "three run modes
> (setup / daemon / run)" decision predates the OSS boundary split. The persistent `daemon` is **not**
> an OSS run mode — it is the commercial Control Plane's runtime. The OSS binary's run modes are
> **`setup` / `run` / `migrate`** only. The "daemon = the OSS solo/local model" and "persistent daemon DB
> (local)" framings in this doc are similarly superseded: the OSS model is `styre run` (one ticket,
> ephemeral DB, exits at PR-ready); the persistent daemon and its long-lived DB belong to the commercial
> plane. This historical decision record is preserved as-is; the §3 run-mode section above reflects the
> corrected boundary.
