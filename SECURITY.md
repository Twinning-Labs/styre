# Security

## Supported versions

Styre is pre-1.0. Security fixes land on **`main`** and are included in the latest release. No backport branches are maintained at this stage.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting** — click "Report a vulnerability" on the [Security tab](https://github.com/Twinning-Labs/styre/security/advisories) of this repository. This keeps the report confidential until a fix is ready.

Please **do not open a public GitHub issue** for security vulnerabilities.

Expected timeline:

- **Acknowledgement:** within 5 business days of receipt.
- **Assessment and fix:** we aim to ship a fix within 30 days for critical issues; less severe issues may take longer.

Once a fix is released you are welcome to publish a write-up; we will coordinate disclosure timing with you.

---

## Capability isolation (the lead safety property)

When Styre drives a ticket, it dispatches agents to implement code. Those agents operate inside a strict sandbox:

- **No `gh`, Linear, or issue-tracker tools.** Dispatched agents have no access to the GitHub CLI and no ticket-tracker API surface (Linear/Jira).
- **Tracker and forge credentials are stripped from the agent's environment.** The runner spawns the agent CLI with a scrubbed environment that removes `LINEAR_API_KEY`, `GITHUB_TOKEN`, and `JIRA_API_TOKEN` (`src/agent/agent-env.ts`, `AGENT_ENV_DENYLIST`). The agent cannot reach your tracker or code host.
- **The provider (LLM) key is *retained* for the agent CLI — by necessity.** The agent CLI needs `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) to authenticate its own model calls, so that key is *not* stripped from the agent spawn. It **is** stripped, along with every tracker/forge key, from **verify-time project commands** (`VERIFY_ENV_DENYLIST`) — the step that runs agent-authored code — so build/test execution never sees any Styre-held credential.
- **The scrub is a denylist, not an allowlist.** Only the named keys above are removed. Any *other* secret in the runner's environment (`AWS_*`, `NPM_TOKEN`, CI tokens, etc.) is inherited by both the agent and verify subprocesses. If you run Styre in an environment holding secrets beyond the provider/tracker/forge keys, isolate it at the process/container boundary — the env scrub alone does not contain them.
- **Each step gets exactly its tools, and file access is confined to the project folder (ENG-476).** Styre launches the Claude CLI with `--restricted --tools <exact set> --allowedTools <scoped permissions> --permission-mode dontAsk --strict-mcp-config` (`src/agent/providers/claude.ts`). In practice:
  - a read-only step (review, plan review, classification) can only use `Read`, `Grep` and `Glob`, and only inside its working folder;
  - a writing step's file tools can write only inside its worktree;
  - the shell, where a step has it, accepts only the profile's declared commands (with any arguments); chained and substituted commands (`;`, `&&`, `|`, `>`, `$(...)`) are refused. This narrows what the agent can type, but it is **not** a security boundary for a writing step: see the gaps below;
  - user, project and local Claude settings files are ignored, so a hostile `.claude/settings.json` in the target repository cannot widen a step;
  - no MCP servers and no user or project plugins are loaded (the CLI's own built-in plugins still are);
  - an inherited permission mode (for example `auto`, when Styre runs inside a Claude Code session) is overridden.
- **Confinement is verified, not assumed.** Before any run, the preflight checks that the installed `claude` (2.1.280 or newer) lists every flag above as an option in `--help`, and refuses otherwise. During every dispatch, the adapter reads the CLI's init event as it arrives and compares the reported tool set and permission mode with the step's allowlist. On any difference, or if the agent acts before the report, it kills the CLI process at once, before the agent can use a tool. Styre then discards the attempt and pauses the run (`needs_you`, exit `75`) naming the cause. A completed run with no report is refused the same way. A tool the step needs but the CLI does not offer (for example `WebSearch` on a backend without it) also stops the run, reported as "missing tools": Styre does not run a step with a different tool set than it declared. `scripts/smoke-isolation.ts` checks all of this live against a hostile setup, alongside a control run that must leak.
- **Codex is refused until it can be confined.** Its `read-only` sandbox still runs shell commands and read a planted file outside the project in testing. Styre refuses to run with `agent.provider: "codex"` (exit `78`) until permission profiles confine it (ENG-484).
- **The runner commits.** Every git commit is performed by the Styre runner process — not by a dispatched agent — after validating the agent's output through a typed, schema-validated interface.

The practical consequence: a compromised or misbehaving agent cannot reach your tracker or code host, push to remote, or use its file tools outside its worktree. Remaining gaps, stated plainly:

- **Declared commands run unconfined.** A step allowed to run the project's test or build command runs it as an ordinary process on your machine, with whatever arguments the agent chose (for example `npm test --prefix <another folder>`). That process, and the agent-authored code it executes — a writing step can edit exactly the code the command runs — can read and write anything your user can. Only container or operating-system isolation closes this.
- **The design step can reach the web.** `design:dispatch` has `WebSearch` and `WebFetch`, so it can send what it has read (including repository contents) to the network. Restricting this is part of ENG-481.
- **Managed settings still apply.** `--restricted` ignores user, project and local settings files, but not organization-managed settings (or a `--settings` file, which Styre never passes). Managed allow rules or hooks could widen a step in ways the init report does not show.
- **The environment is inherited.** The agent holds the provider key it authenticates with and inherits any non-Styre secret in the runner's environment (see above).
- **Some configuration files cannot be edited by agents.** Restricted mode refuses agent writes to tool-configuration files such as `.claude/settings.json`, `.vscode/settings.json` and `.pre-commit-config.yaml`. A ticket that needs such a change must be finished by hand.

## Agent processes: stopping, interruption and cleanup (ENG-485)

Whenever an agent run ends, Styre stops everything the agent started, and reports what it cannot
stop. The design is `docs/brainstorms/2026-10-02-eng-485-agent-process-lifecycle-design.md`; the
messages and exit statuses are in [`runtime-parameters.md`](docs/architecture/runtime-parameters.md#stopping-interruption-and-orphan-cleanup-eng-485).

- **One door.** Every process Styre starts goes through `src/util/process/door.ts` (a source guard
  enforces it). Each long running launch (the agent, and every command: suites, probes, acceptance
  checks, provisioning) is recorded in memory and in a small file on disk
  (`$XDG_STATE_HOME/styre-processes/`, see [`conventions.md`](docs/architecture/conventions.md)), with
  its start time, so Styre can later confirm it is the same process before stopping it.
- **Whole trees, including wrappers.** A stop collects the agent's descendants and the members of
  every process group one of them leads (Claude Code runs each tool command in a group of its own),
  sends SIGTERM to all of them at once, waits up to 5 s, then sends SIGKILL to whatever is still
  alive, including a real CLI that dropped out of the tree when the wrapper script around it died.
  The gap ENG-476 stated, that a wrapper's child survived Styre's kills, is closed. Every command
  launch leads a group of its own and is stopped as a group, also on its timeout.
- **Stop signals.** `styre run` and `styre setup` handle Ctrl-C, `Ctrl-\`, `kill` (SIGTERM) and a
  closed terminal (SIGHUP): they stop the agent and its commands, record the interruption so it is
  free on `--resume` (the attempt is not counted and the agent's partial edits are undone), and exit
  with the signal's status (130, 143, 131, 129).
- **After `kill -9`.** No program can react to SIGKILL. The next Styre command on the machine (any of
  `run`, `setup`, `ls`, `clean`, `migrate`, `notify`) reads the records, confirms each process's
  identity, and stops the orphan.
- **Never someone else's process.** A stop never expands Styre's own process group, the group of the
  script that started Styre, or any group not led by one of the agent's own processes. A pid that now
  belongs to another program (a different start time) is left alone and reported. On Linux, a
  record from before the last restart stops nothing (the boot ID differs). Processes Styre may not inspect are reported, never treated
  as gone.
- **Launch records hold the command text.** Each record stores the first 200 characters of the
  launch's command line, in a file only your user can read. Styre passes the agent's prompt on stdin,
  never on the command line; keep secrets out of declared commands too.

### Limits, stated plainly

- **`kill -9` is cleaned up later, not at once.** The orphaned agent keeps running, and may keep
  billing, until the next Styre command on the machine runs its sweep.
- **The unrecorded window.** Between the spawn and the record write there are a few milliseconds. A
  `kill -9` landing there leaves an orphan with no record, which nothing will stop.
- **Detached leftovers are reported, not stopped.** A process the agent left running in its worktree
  outside its process tree and groups (for example one started with `nohup` or in a new session) is
  reported after the step, on a stop, and by the sweep, with the command to stop it. Styre never stops
  it: matching by folder alone could hit your own processes, especially in in-place mode, where
  something you started in the checkout during the step is reported too. A leftover that moved out of
  the worktree, or runs as another user, is not found.
- **`Ctrl-\` (SIGQUIT).** The terminal delivers it to Claude Code too, which can die at once without
  stopping its running command. That command is then no longer linked to the agent, so Styre reports
  it (with how to stop it) instead of stopping it. Seen on macOS; on Linux, Claude Code 2.1.294 did
  not die at once and Styre stopped everything. `Ctrl-\` writes no core dump: Styre turns core dumps off
  just before it ends itself by SIGQUIT, and while `styre setup` waits at a prompt.
- **Ctrl-Z is not handled.** The terminal pauses Styre and the agent together. Command launches and
  Claude Code's tool commands sit in groups of their own, so they keep running and simply finish.
  Timeouts count clock time, so a long pause can make a step time out right after `fg`; that takes the
  normal timeout path (stop, then retry).
- **GitHub Actions needs `exec`.** GitHub cancels a step by signalling the step's own process, by pid:
  SIGINT, then SIGTERM 7.5 s later, then SIGKILL 2.5 s after that (actions/runner,
  `src/Runner.Sdk/ProcessInvoker.cs`). In a `run:` step that process is bash. With
  `exec styre run …`, Styre is that process and stops the agent gracefully on the first SIGINT.
  Without `exec`, bash takes the signals and dies, Styre never hears one, and Styre, the agent and its
  commands keep running until the job's final cleanup kills every process carrying the job's
  `RUNNER_TRACKING_ID` (Styre keeps that variable in the agent's environment; the runner can read
  process environments on Linux, not on macOS, so on a macOS runner they may survive the job). That
  is a kill: the run is not recorded as interrupted, and the agent may bill for those last seconds. See
  [`runtime-parameters.md`](docs/architecture/runtime-parameters.md#github-actions-use-exec).
- **At most one duplicate Slack post per interruption.** The outbox drain checks for a stop before each
  row, but a request already in flight can still complete. Its delivery cannot be recorded, so it is
  sent again on resume, and Slack posts have no idempotency key.
- **Commands have no controlling terminal.** Every command launch leads a group of its own, so a
  command that prompts through `/dev/tty` (`sudo`, an ssh passphrase or host key prompt, a git
  username prompt) fails at once instead of waiting for an answer.
- **Hardened Linux hosts.** With `/proc` mounted with `hidepid`, other users' processes cannot be read
  and look gone. Styre's own processes, and the agent's, run as your user and are unaffected; a
  descendant that switched user (for example through `sudo`) may then be missed by a stop or by the
  leftover check.
- **Claude Code's nested command group (Linux).** On Linux with bash, Claude Code's own shell snapshot
  turns job control on, so each tool command sits one group deeper. While the agent lives, a stop
  still collects it. A background child that such a command leaves behind after the command itself
  has exited sits in a group whose leader is gone and that no collected process leads; only the
  leftover check reports it.
- **Blocking calls delay a stop.** Short calls such as `git` run to completion before the stop handler
  runs, at most for their own bound: 30 s for local reads, 120 s for git calls that rewrite the tree
  (checkout, reset, commit with hooks, worktree add or remove) and for network calls. A call that
  reaches its bound is killed with SIGKILL, which reaches only that one process: a child it started
  (for example ssh under `git push`) can outlive it, and a killed git can leave `.git/index.lock`
  behind.
- **Held cleanups have a time cap.** When a stop ends Styre during a step that holds a temporary
  baseline worktree, the stop handler removes that worktree itself, within its 6.5 s deadline. The cap
  stops only git itself, not processes git starts. When no time is left it names the command that
  finishes the removal by hand.
- **The leftover check and the sweep are bounded, not instant.** On a stop, the leftover check gives
  each stopped agent whatever is left of the handler's deadline (OSS runs one agent at a time). The
  sweep stops orphans one at a time, each with its own grace period of up to 5 s.
- **Interrupted checks step, worktree mode.** An interruption during the checks step's test run, after
  its commit, is undone on resume by returning the branch to where the step started. In worktree mode
  that return depends on a separate fix to `ensureWorktree`, whose `git worktree add -B` on resume
  moves the branch again; until it lands, that commit can remain. In-place mode is unaffected.
- **Test artefacts from an interrupted checks step.** An interruption during that step's test run
  happens while no agent is running, so the untracked files the tests wrote are not undone on resume
  (in in-place mode they stay in your checkout). The commit is still returned as above.
- **An in-place run stopped before its first dispatch resumes in worktree mode** (ENG-487). Resume
  derives the mode from the latest dispatch's folder, and there is none yet.

### Cost

Measured on macOS arm64 with a stand-in agent (`scripts/measure-lifecycle-latency.ts`): a normal
dispatch costs about 0.8 to 1.1 ms more than before ENG-485 (about 42.6 ms against 41.7 ms), for the
launch record, one read of the process table, and git calls going through the door. Per step, outside
the dispatch: recording the branch head where the step started is one `git rev-parse`, about 5.3 ms;
starting the background leftover check delays the next step's start by about 0.7 ms (the check itself,
about 77 ms with macOS `lsof`, runs beside it). The sweep over an empty records folder takes about
10 µs.

## Human gate

**There is no auto-merge.** Styre opens a pull request and stops. The operator reviews and merges every PR personally. No agent-authored code reaches `main` without a human sign-off.

## Data egress

Three distinct channels can leave the machine. Know all three.

**1. Local telemetry stream (no network).** `styre run` emits NDJSON telemetry events to **stdout** (one JSON object per line); a human-readable summary goes to **stderr**. This stream involves no network — it goes to your terminal or wherever you pipe it. Library callers that import Styre programmatically default to a `noopSink` and emit nothing. Where those stdout bytes go is entirely the operator's choice.

**2. Anonymous product analytics (network, on by default).** Styre sends a small set of coarse events to PostHog (`https://us.i.posthog.com`) — `setup_completed`, `run_started`, `run_completed`, `cli_error` — keyed to a random anonymous ID. Payloads pass through a strict **key allowlist** (`sanitize`/`ALLOWED_KEYS` in `src/telemetry/analytics/`): source code, repo names/paths, ticket IDs, commands, branch SHAs, costs, and tokens are **never** included. This is on by default; disable it with `STYRE_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `"telemetry": false` in your runtime `config.json`. See the README's Telemetry section for the full contract.

**3. Slack notifications (network, opt-in).** If you configure `notifier: "slack"`, the runner posts escalation/transition notices to Slack's API (`chat.postMessage`). Those messages contain the ticket identifier, the event, an optional reason, and the PR URL — a deliberate, operator-enabled egress to a third party. Off unless you turn it on.

**Credentials are never transmitted.** Operator-supplied keys (provider API key, tracker API key, forge token) are used only within the process for the duration of the run. They are not sent to PostHog (the allowlist excludes them), not sent to Slack, and not written to any Styre-operated service.

## License

Styre is released under the [GNU General Public License v3.0](LICENSE).
