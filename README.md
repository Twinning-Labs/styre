# Styre (ᛋᛏᚢᚱᛁ or ᛋᛏᚢᚱᛅ)

The free, open-source execution core that drives a structured ticket `design → implement → verify → review → merge → released` with minimal human involvement.

[![CI](https://github.com/Twinning-Labs/styre/actions/workflows/ci.yml/badge.svg)](https://github.com/Twinning-Labs/styre/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Twinning-Labs/styre)](https://github.com/Twinning-Labs/styre/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

---

<!-- demo cast injected by Task 9: docs/assets/demo.svg -->

```
  Linear ticket
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
  isolated: no      isolated: no
  creds / gh /      creds / gh /
  Linear tools      Linear tools
        │                 │
        └────────┬────────┘
                 │  results returned to the runner
                 ▼
          ┌────────────-┐
          │  projector  │  (one-way write path)
          └──────┬──────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
     Linear            GitHub
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
- You work out of Linear and GitHub.
- You want a ticket executor that runs locally, under your own API key, with no cloud dependency.
- You are comfortable owning the merge decision — Styre opens the PR, you land it.
- You want the execution logic as auditable, forkable open-source code.

**Not for you if:**
- You want a hosted, zero-setup product. That is the commercial Control Plane — continuous pickup, scheduling, an inbox, and a dashboard — built on top of this core.
- Your team uses Jira, GitLab, or another ticket/VCS system. Styre is Linear + GitHub only.
- You expect auto-merge. The operator merges every PR personally; Styre will never push directly to your main branch.

---

## What it is

Styre is open-core. The OSS core — `styre run` — is the full execution engine: it reads a ticket, drives the `design → implement → verify → review → merge → released` loop, and exits when a PR is ready. The core software is identical in the OSS release and the commercial plane.

License: GPLv3.

---

## How it works

Styre's trust story starts with capability isolation: dispatched agents receive no credentials, no `gh` binary, no Linear API key, and no shell access outside their dedicated worktree. The worktree is the only writable surface. The runner (`styre run`) holds credentials, commits the results, and is the sole writer to the SQLite state-of-truth.

Each step in the control loop is journaled before it runs. If a step has already succeeded, replay returns the recorded result — the step never re-executes. This gives you crash-resume for free. Verdicts (design sound? tests green? diff in scope?) come from build output, CI, and an independent reviewer step — never from the agent self-reporting success.

See [`docs/architecture/execution-model.md`](docs/architecture/execution-model.md) for the full step catalog and state machine.

---

## Commands

The OSS surface has three commands:

```sh
styre setup <repo>    # Probe the repo and write its Styre profile (profile.json) — the project-shape artifact runs use

# Run one ticket end-to-end, exit when a PR is ready
styre run <TICKET-ID>

# Create or migrate the SQLite state-of-truth (idempotent)
styre migrate
```

`styre run` exits `0` when a PR is open. On a session-limit or out-of-credits interrupt it exits `75` (EX_TEMPFAIL) and parks state to `~/.local/state/styre/`; resume with `styre run --resume <TICKET-ID>`.

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
- [Ticket template](docs/architecture/ticket-template.md) — how to write a ticket styre can actually deliver
- [Security policy](SECURITY.md) — capability model, threat surface, reporting vulnerabilities
- [Contributing](CONTRIBUTING.md) — how to contribute, branch conventions, PR process
- [Plans](docs/plans/) — milestone implementation plans

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

Styre's core is free, open source, and ends at PR-ready. A commercial **Control Plane** (a separate product in its own repository — not yet public) runs *on top of* this core: a persistent service that orchestrates many `styre run` invocations with multi-ticket scheduling, dependency-aware ticket selection, a needs-you inbox, and dashboards. It plugs in only through Styre's versioned seam — the Linear ticket contract, the project-profile artifact, and the NDJSON telemetry/state export — and never forks or imports the core. The core has no knowledge of the plane; you can run the OSS core on its own, forever.

---

## License

Styre is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License v3.0](LICENSE).
