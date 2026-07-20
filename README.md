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

`styre run` exits `0` when a PR is open. On a session-limit or out-of-credits interrupt it exits `75` (`EX_TEMPFAIL`) and parks state under `$XDG_STATE_HOME/styre/` (default `~/.local/state/styre/`); resume with `styre run --resume <TICKET-ID>`. Other exit codes: `65` (resume refused — branch HEAD moved), `69` (`EX_TOOLCHAIN_MISSING` — a required repo toolchain program is absent), `2` (`notify` misuse), `1` (any other error). The full flag, exit-code, and environment-variable surface is documented in [`docs/architecture/runtime-parameters.md`](docs/architecture/runtime-parameters.md).

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
