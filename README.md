# Styre

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
  ┌─────────────────────────────────────┐
  │  daemon (single writer / SQLite SoT) │
  │  orchestrates the control loop       │
  └──────────────┬──────────────────────┘
                 │  dispatches
        ┌────────┴────────┐
        ▼                 ▼
  agent (worktree)  agent (worktree)
  isolated: no      isolated: no
  creds / gh /      creds / gh /
  Linear tools      Linear tools
        │                 │
        └────────┬────────┘
                 │  results returned to daemon
                 ▼
          ┌────────────┐
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

Styre is open-core. The OSS core — `styre run` — is the full execution engine: it reads a ticket, drives the `design → implement → verify → review → merge → released` loop, and exits when a PR is ready. The commercial Control Plane is the layer above: continuous ticket pickup, the persistent daemon, inbox management, and scheduling. The core software is identical in both.

License: GPLv3.

---

## How it works

Styre's trust story starts with capability isolation: dispatched agents receive no credentials, no `gh` binary, no Linear API key, and no shell access outside their dedicated worktree. The worktree is the only writable surface. The daemon — running in your terminal or as a local service — holds credentials, commits the results, and is the sole writer to the SQLite state-of-truth.

Each step in the control loop is journaled before it runs. If a step has already succeeded, replay returns the recorded result — the step never re-executes. This gives you crash-resume for free. Verdicts (design sound? tests green? diff in scope?) come from build output, CI, and an independent reviewer step — never from the agent self-reporting success.

See [`docs/architecture/execution-model.md`](docs/architecture/execution-model.md) for the full step catalog and state machine.

---

## Commands

The OSS surface has three commands:

```sh
# Probe the repo, create and migrate the SQLite database, install the host service
styre setup <repo>

# Run one ticket end-to-end, exit when a PR is ready
styre run <TICKET-ID>

# Create or migrate the SQLite state-of-truth (idempotent)
styre migrate
```

`styre run` exits `0` when a PR is open. On a session-limit or out-of-credits interrupt it exits `75` (EX_TEMPFAIL) and parks state to `~/.local/state/styre/`; resume with `styre run --resume <TICKET-ID>`.

---

## Documentation

- [Architecture index](docs/architecture/README.md) — start here for the full substrate overview
- [Execution model](docs/architecture/execution-model.md) — step catalog, state machine, loopback atlas
- [Security policy](SECURITY.md) — capability model, threat surface, reporting vulnerabilities
- [Contributing](CONTRIBUTING.md) — how to contribute, branch conventions, PR process
- [Plans](docs/plans/) — milestone implementation plans

---

## Develop

Requires [Bun](https://bun.sh).

```sh
bun install
bun test
bun run lint
bun run build         # → dist/styre (single self-contained binary)
./dist/styre --version
./dist/styre migrate  # bootstraps the SQLite SoT under $XDG_STATE_HOME/styre/
```

---

## License

Styre is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License v3.0](LICENSE).
