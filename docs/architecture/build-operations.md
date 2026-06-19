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
- **Run modes:**
  - **`styre setup <repo>`** — the probe: discover the project-profile, discover/ask the checks-system,
    create+migrate the DB, refresh the Linear id-cache + projection labels, and **install the host
    service for the detected OS** (launchd on macOS, systemd on Linux). Idempotent. *The developer hook.*
  - **`styre daemon`** — persistent local, supervised by the host service manager (**launchd / systemd**),
    watches the SQLite queue, K-concurrency, one DB / all projects (CL-1). The **solo-dev / local-team** mode.
  - **`styre run <ticket>`** — a **one-shot headless runner**: execute ONE ticket to PR-ready and exit,
    emitting telemetry. The **CI / cloud / fleet primitive** (the SaaS spins up N in parallel; ephemeral
    per-run SQLite — the journal still gives in-run crash-resume; durable output = the git branch + telemetry).
  - **management CLI:** `status` · `inbox` (resume/`--after-fix`/abandon) · `config` · `pause`/`resume` ·
    `logs` · `uninstall`.

### 3.1 The install matrix (macOS · Linux · container)

| | **macOS** | **Linux** (box/VM) | **Container / cloud** |
|---|---|---|---|
| Get it | `brew install styre` / release binary | `curl … \| sh` / release tarball (static/musl) | OCI image (Linux) |
| Arch | arm64 + x64 | x86_64 + arm64 | per-arch images |
| Daemon supervisor | launchd LaunchAgent | **systemd** (`--user` or system unit) | orchestrator (k8s / Fargate) |
| State / config paths | XDG | XDG | mounted volume (persistent) or ephemeral (runner) |
| Primary mode | `daemon` (persistent) | `daemon` (persistent) | `run <ticket>` (ephemeral worker) |
| Auth | subscription session *or* API key | either | `ANTHROPIC_API_KEY` (headless) |

- **One path model on both OSes** — the **XDG Base Directory spec** (Linux-native, works cleanly on
  macOS): DB at `$XDG_STATE_HOME/styre/`, config at `$XDG_CONFIG_HOME/styre/`. No per-OS path forks.
- **Host deps (all targets):** `git`, `gh`, the `claude` CLI; node is bundled in the binary.
- **`styre setup` is OS-aware:** it renders the **launchd plist** (macOS) or the **systemd unit** (Linux)
  from the *same* daemon definition — the daemon logic is identical; only the supervisor unit differs.
- **No-init environments** (bare containers, minimal images): run `styre daemon` directly under the
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
- **Persistent-daemon mode** (one box, one SQLite, K-concurrency) stays the **local/solo** model on Mac
  *or* Linux. `Postgres`-on-concurrency-demand (schema §9.2) is the upgrade path only if anyone ever
  wants a single shared multi-worker daemon — the fleet model avoids needing it.

## 4. Auth + config (re-thought for both audiences)

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

## 5. The open-core seam — stable contracts the plane plugs into `[BUILD THESE STABLE]`

The plane integrates *only* through these. Treat them as the public API surface (versioned, documented):

1. **Linear ticket contract (input).** The harness reads: the `styre_config` metadata block, the AC
   checklist, the target-context-files list, and the `Ready for Agent` state as the trigger. (A solo dev
   writes these by hand *or* uses the harness's own design stage; the SaaS writes them automatically.)
2. **The profile artifact.** Canonical stack truth (`profile.md`). The plane reads/compacts/auto-updates
   it; the core reads it. Keep its schema stable.
3. **Telemetry / state (output).** The SQLite DB (readable) + a documented **telemetry export** — the
   metrics the dashboards need (cycle count, unit cost per ticket, autonomous-fix ratio, first-time CI
   pass rate, escalation reasons). Our `dispatch` / `metric_event` / `event_log` / `ground_truth_signal`
   already hold this data; expose it cleanly + emit a per-ticket terminal/JSON summary.
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
- **Per-ticket budget/strictness** = the vision's N-cycles/strictness → our K_DISTINCT / block-threshold,
  sourced from the ticket config block (§4).
- **Headless runner mode** ⇒ the durable-execution model spans **ephemeral per-run SQLite** (runner) and
  the **persistent daemon DB** (local) — both must work; the journal semantics are identical, only the
  DB lifetime differs.
- **Telemetry is first-class**, not an afterthought — it's a paid-product input, so the per-ticket
  summary + the export schema get designed deliberately.

## 7. Status

**DECIDED (operator 2026-06-20):** new repo · port-the-leaves · the three **run modes** (setup / daemon /
headless `run`) · **dual auth** (subscription session + `ANTHROPIC_API_KEY`) · the **§5 seam as the
first build priority**. The open-core boundary + four-tier config follow from the vision and stand.
**Corrected:** the "pre-scoped skips design" idea is **rejected** — design always runs (§6); SaaS
enrichment is richer input only. Remaining §6 flags for a later spec pass: the headless-runner DB
lifetime (ephemeral per-run vs persistent daemon) and the per-ticket-config → K_DISTINCT/threshold
mapping. Get the §5 contracts stable early so the plane never has to fork the core.
