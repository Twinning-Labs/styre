# Styre (ᛋᛏᚢᚱᛁ or ᛋᛏᚢᚱᛅ)

The free, open-source execution core that drives a structured ticket `design → implement → verify → review → merge → released` with minimal human involvement.

[![CI](https://github.com/Twinning-Labs/styre/actions/workflows/ci.yml/badge.svg)](https://github.com/Twinning-Labs/styre/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Twinning-Labs/styre)](https://github.com/Twinning-Labs/styre/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

---

```
  ticket (Linear / Jira)
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  styre run (single writer / SQLite SoT)      │
  │  orchestrates the control loop               │
  └──────────────┬───────────────────────────────┘
                 │  dispatches
        ┌────────┴────────┐
        ▼                 ▼
  agent (worktree)  agent (worktree)
  no gh / tracker   no gh / tracker
  tools; tracker    tools; tracker
  + forge creds     + forge creds
  stripped          stripped
        │                 │
        └────────┬────────┘
                 │  results returned to the runner
                 ▼
          ┌────────────-┐
          │  projector  │  (one-way write path)
          └──────┬──────┘
                 │
     ┌───────────┼───────────┐
     ▼           ▼           ▼
  tracker      GitHub      Slack
 (Linear/Jira) (forge)   (notifier)
```

---

## Killer command

```sh
styre run ENG-123
# stdout: NDJSON telemetry stream (machine-readable, pipe to jq or your log sink)
# stderr: human summary (progress, warnings, what needs your attention)
```

When the run completes, a PR is open and ready. You merge it.

---

## Is this for you?

**For you if:**
- You track work in Linear or Jira and host code on GitHub.
- You want a ticket executor that runs locally, under your own API key, with no cloud dependency.
- You are comfortable owning the merge decision — Styre opens the PR, you land it.
- You want the execution logic as auditable, forkable open-source code.

**Not for you if:**
- You want a hosted, zero-setup product. That is the commercial Control Plane — continuous pickup, scheduling, an inbox, and a dashboard — built on top of this core.
- Your code lives on GitLab, Bitbucket, or another code host. The forge is GitHub only (the issue tracker is pluggable — Linear and Jira ship today; the forge is not yet).
- You expect auto-merge. The operator merges every PR personally; Styre will never push directly to your main branch.

---

## What it is

Styre is open-core. The OSS core — `styre run` — is the full execution engine: it reads a ticket, drives the `design → implement → verify → review → merge → released` loop, and exits when a PR is ready. The core software is identical in the OSS release and the commercial plane.

License: GPLv3.

---

## How it works

Styre's trust story starts with capability isolation: dispatched agents get no `gh` or issue-tracker tools, and the runner strips the tracker/forge credentials (`LINEAR_API_KEY`, `JIRA_API_TOKEN`, `GITHUB_TOKEN`) from their environment — so an agent can't reach your tracker or code host. The agent CLI does keep the LLM provider key it needs to authenticate its own model calls; that key is additionally stripped from verify-time commands, which run agent-authored code. The worktree is the only writable surface. The runner (`styre run`) holds the outward credentials, commits the results, and is the sole writer to the SQLite state-of-truth. (Full model in [`SECURITY.md`](SECURITY.md).)

Each step in the control loop is journaled before it runs. If a step has already succeeded, replay returns the recorded result — the step never re-executes. This gives you crash-resume for free. Verdicts (design sound? tests green? acceptance criteria met? diff in scope?) come from build output, the test and acceptance-criteria gates, and an independent reviewer step — never from the agent self-reporting success. (CI is *reported* at PR-open, not used as a gate.)

See [`docs/architecture/execution-model.md`](docs/architecture/execution-model.md) for the full step catalog and state machine.

---

## Commands

The three commands you use day to day:

```sh
# Probe the repo and write its Styre profile (profile.json) — the project-shape artifact a run reads
styre setup <repo>

# Run one ticket end-to-end, exit when a PR is ready
styre run <TICKET-ID>

# Create or migrate the SQLite state-of-truth (idempotent)
styre migrate
```

A fourth command, `styre notify --test`, sends a one-off test notification through the configured notifier (Slack) to verify your setup — a diagnostic, not part of the run loop.

The full flag and environment-variable surface is documented in [`docs/architecture/runtime-parameters.md`](docs/architecture/runtime-parameters.md).

### Exit codes

The process exit code is the machine-readable error code (codes above `2` follow `sysexits.h`):

| Code | Meaning | Retryable? |
|---|---|---|
| `0` | success — for `run`, a PR is open and ready | — |
| `1` | generic error (any uncaught throw; also an escalation the loop can't resolve) | no — fix the cause |
| `2` | usage / notifier-config (`styre notify` without `--test`) | no |
| `65` | resume refused — the branch HEAD moved since the run parked | yes — `--accept-head` or `--inspect` |
| `69` | a required repo toolchain program isn't installed on this machine | yes — install it, re-run |
| `75` | parked — session limit / out of credits; state dumped, no attempt consumed | yes — `styre run --resume <ticket>` |

Full meanings, `sysexits` names, and caller guidance: [runtime-parameters.md → Exit codes](docs/architecture/runtime-parameters.md#exit-codes-error-codes-and-their-meaning).

---

### Running by convention

`styre setup` writes the project profile to `~/.config/styre/<slug>/profile.json`. After that,
`styre run` needs no path flags — from inside the repo:

    cd my-repo && styre run ENG-123

It derives the `<slug>` from the repo's `origin` remote (or dir name), loads that profile, and
resolves the runtime config by merging:

- `~/.config/styre/config.json` — global (applies to every project)
- `~/.config/styre/<slug>/config.json` — per-project override

Per-project wins per setting; the `agent` block (provider + models) must be written complete.
Example — use Codex everywhere by writing the full block once in the global file:

    { "agent": { "provider": "codex", "command": "codex",
                 "models": { "deep": "…", "standard": "…", "cheap": "…" } } }

Each explicit flag overrides discovery **for its own artifact only**: `--profile <path>` pins the
profile, `--config <path>` pins the runtime config (ignoring host `~/.config`). They are
independent — passing only `--profile` still discovers the runtime config from host `~/.config`, so
a CI/fleet caller that wants full hermeticity must pass **both** `--profile` and `--config`. A custom
`styre setup --slug <name>` stores under that slug — pass `--slug <name>` (or `--profile`) to
`styre run` for such a project.

---

## Configuration

Runtime policy lives in `config.json` (operator settings) — separate from `profile.json` (the probed project shape). Precedence: `--config <path>` is **hermetic** (sole source), otherwise per-project `config.json` shallow-overrides the global one, then binary defaults fill the rest. There is **no** per-ticket config layer in the OSS core.

The main knobs:

| Key | Default | What it does |
|---|---|---|
| `issueTracker` | `linear` | tracker adapter — `linear` or `jira` |
| `forge` | `github` | code-host adapter (GitHub only today) |
| `agent` | Claude preset | provider + per-tier models (`deep`/`standard`/`cheap`) |
| `notifier` / `notify` | `none` / `escalations` | Slack notifications and their verbosity |
| `onPlanDefect` | `escalate` | on a plan-level review defect: `escalate` or `redesign` |
| `telemetry` | `true` | anonymous PostHog analytics (also opt out via env) |

Every `config.json` and `profile.json` key, with the exact precedence rules, is in [`docs/architecture/configuration.md`](docs/architecture/configuration.md).

---

## Files & paths

Styre follows the XDG Base Directory spec (macOS and Linux alike) and honors `XDG_CONFIG_HOME` and `XDG_STATE_HOME`:

- `$XDG_CONFIG_HOME/styre/` (default `~/.config/styre/`) — `config.json` and per-project `profile.json`.
- `$XDG_STATE_HOME/styre/` (default `~/.local/state/styre/`) — the SQLite DB, the telemetry id, and park dumps (`<slug>/<ticket-ident>/`).
- Per-run worktrees and scratch live under the OS temp dir and are cleaned up; the agent's worktree is its only writable surface.

The full path layout, the `.styre-disposable` marker, `AGENTS.md` ingestion, and the `styre_scratch/` drawer are in [`docs/architecture/conventions.md`](docs/architecture/conventions.md).

---

## Prompts

The agent instructions for every step are editable Markdown templates in [`prompts/`](prompts/), compiled into the binary. They are the highest-leverage behavioral surface in the repo — see [`docs/architecture/prompts.md`](docs/architecture/prompts.md) for the catalog (which template drives which step, and on which model tier).

---

## Install

Styre ships as a single self-contained binary via Homebrew (macOS & Linux):

```sh
brew install twinning-labs/styre
```

Upgrade with `brew upgrade styre`; remove with `brew uninstall styre` (and `brew untap twinning-labs/styre` to drop the tap). Prebuilt binaries for macOS (arm64/x64) and Linux (arm64/x64) are also attached to each [GitHub Release](https://github.com/Twinning-Labs/styre/releases).

---

## Documentation

- [Architecture index](docs/architecture/README.md) — start here for the full substrate overview
- [Execution model](docs/architecture/execution-model.md) — step catalog, state machine, loopback atlas
- [Runtime parameters](docs/architecture/runtime-parameters.md) — every command, flag, exit code, and environment variable
- [Configuration](docs/architecture/configuration.md) — every `config.json` and `profile.json` key, and how they resolve
- [Conventions](docs/architecture/conventions.md) — XDG paths, temp/worktree layout, and the on-disk files Styre reads and writes
- [Prompts](docs/architecture/prompts.md) — the agent prompt templates compiled into the binary
- [Ticket template](docs/architecture/ticket-template.md) — how to write a ticket styre can actually deliver
- [Security policy](SECURITY.md) — capability model, threat surface, reporting vulnerabilities
- [Contributing](CONTRIBUTING.md) — how to contribute, branch conventions, PR process
- [Plans](docs/plans/) — milestone implementation plans (append-only history)

---

## Telemetry

`styre` collects anonymous usage analytics (via PostHog) to understand adoption and improve the
tool. It sends a small set of coarse events — `setup_completed`, `run_started`, `run_completed`,
`cli_error` — with an anonymous random ID. It **never** sends source code, repo names/paths,
ticket IDs, commands, branch SHAs, costs, or tokens.

**Opt out** at any time:

- `export STYRE_TELEMETRY=0`, or
- `export DO_NOT_TRACK=1`, or
- set `"telemetry": false` in your runtime `config.json`.

The anonymous ID lives at `~/.local/state/styre/telemetry.json`. In ephemeral CI, cache
`~/.local/state/styre/` to keep a stable ID across runs (otherwise each CI run is counted as new).

> **First-run notice on an early failure.** The one-time notice above prints on the first run that
> reaches telemetry. Because `styre run` now counts errors that happen early (e.g. run outside a git
> repo, or with an unreadable `config.json`), that first run can be one that fails before it gets
> going — the notice then prints once to **stderr** (never stdout, so machine output is unaffected),
> and the anonymous ID + notice latch are minted. It appears at most once. The `STYRE_TELEMETRY`/
> `DO_NOT_TRACK` env opt-outs suppress it on every path, including these early failures. A
> `"telemetry": false` in `config.json` is also honored on the early-failure path once the config has
> been read; it can only be missed when the failure prevents the config from being read at all (an
> unparseable `config.json`, or a failure before the config is loaded — e.g. running outside a git
> repo), where the env opt-outs are the reliable suppressor.

---

## Develop

Prerequisites: [Bun](https://bun.sh). (Nothing else to install: on macOS, `bun run build` ad-hoc re-signs the compiled binary with `codesign` so Apple Silicon won't kill it on launch — `codesign` ships with the Command Line Tools that `git` already relies on, and the build does it for you.)

```sh
git clone https://github.com/Twinning-Labs/styre.git
cd styre
bun install
bun test
bun run lint
bun run build         # → dist/styre (single self-contained binary)
./dist/styre --version
./dist/styre migrate  # bootstraps the SQLite SoT under $XDG_STATE_HOME/styre/
```

---

## How the commercial plane fits

Styre's core is free, open source, and ends at PR-ready. A commercial **Control Plane** (a separate product in its own repository — not yet public) runs *on top of* this core: a persistent service that orchestrates many `styre run` invocations with multi-ticket scheduling, dependency-aware ticket selection, a needs-you inbox, and dashboards. It plugs in only through Styre's versioned seam — the ticket contract, the project-profile artifact, and the NDJSON telemetry/state export — and never forks or imports the core. The core has no knowledge of the plane; you can run the OSS core on its own, forever.

---

## License

Styre is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License v3.0](LICENSE).
