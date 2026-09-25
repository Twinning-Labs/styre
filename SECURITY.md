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
- **Confinement is verified, not assumed.** Before any run, the preflight checks that the installed `claude` (2.1.280 or newer) lists every flag above as an option in `--help`, and refuses otherwise. During every dispatch, the adapter reads the CLI's init event as it arrives and compares the reported tool set and permission mode with the step's allowlist. On any difference, or if the agent acts before the report, it kills the agent at once, before the agent can use a tool. Styre then discards the attempt and pauses the run (`needs_you`, exit `75`) naming the cause. A completed run with no report is refused the same way. `scripts/smoke-isolation.ts` checks all of this live against a hostile setup, alongside a control run that must leak.
- **Codex is refused until it can be confined.** Its `read-only` sandbox still runs shell commands and read a planted file outside the project in testing. Styre refuses to run with `agent.provider: "codex"` (exit `78`) until permission profiles confine it (ENG-484).
- **The runner commits.** Every git commit is performed by the Styre runner process — not by a dispatched agent — after validating the agent's output through a typed, schema-validated interface.

The practical consequence: a compromised or misbehaving agent cannot reach your tracker or code host, push to remote, or use its file tools outside its worktree. Remaining gaps, stated plainly:

- **Declared commands run unconfined.** A step allowed to run the project's test or build command runs it as an ordinary process on your machine, with whatever arguments the agent chose (for example `npm test --prefix <another folder>`). That process, and the agent-authored code it executes — a writing step can edit exactly the code the command runs — can read and write anything your user can. Only container or operating-system isolation closes this.
- **The design step can reach the web.** `design:dispatch` has `WebSearch` and `WebFetch`, so it can send what it has read (including repository contents) to the network. Restricting this is part of ENG-481.
- **Managed settings still apply.** `--restricted` ignores user, project and local settings files, but not organization-managed settings (or a `--settings` file, which Styre never passes). Managed allow rules or hooks could widen a step in ways the init report does not show.
- **The environment is inherited.** The agent holds the provider key it authenticates with and inherits any non-Styre secret in the runner's environment (see above).
- **Some configuration files cannot be edited by agents.** Restricted mode refuses agent writes to tool-configuration files such as `.claude/settings.json`, `.vscode/settings.json` and `.pre-commit-config.yaml`. A ticket that needs such a change must be finished by hand.

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
