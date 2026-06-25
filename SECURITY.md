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

- **No `gh` or Linear tools.** Dispatched agents have no access to the GitHub CLI and no Linear API surface.
- **No ambient credentials.** `LINEAR_API_KEY`, GitHub tokens, and Anthropic keys are held exclusively by the daemon/runner process. They are never injected into an agent's environment.
- **Worktree-only write surface.** The only thing an agent can write to is the isolated git worktree assigned for the run. It cannot push branches, open PRs, or modify repository settings.
- **The runner commits.** Every git commit is performed by the Styre runner process — not by a dispatched agent — after validating the agent's output through a typed, schema-validated interface.

The practical consequence: a compromised or misbehaving agent cannot exfiltrate credentials, push to remote, or take any action outside its worktree.

## Human gate

**There is no auto-merge.** Styre opens a pull request and stops. The operator reviews and merges every PR personally. No agent-authored code reaches `main` without a human sign-off.

## Data egress and telemetry

**The OSS core does not phone home.** There is no background network collection and no remote telemetry endpoint in `styre run` or `styre setup`.

What does happen:

- `styre run` emits NDJSON telemetry events to **stdout** (one JSON object per line).
- A human-readable summary goes to **stderr**.
- Library callers that import Styre programmatically default to a `noopSink` — they emit nothing at all.

Operators who want to capture telemetry pipe stdout to a sink of their choosing (a file, a log aggregator, etc.). That choice belongs entirely to the operator; Styre does not control where those bytes go.

**Credentials stay local.** Operator-supplied keys (Anthropic API key, Linear API key, GitHub token) are used only within the process for the duration of the run and are never transmitted to any Styre-operated or third-party service.

## License

Styre is released under the [GNU General Public License v3.0](LICENSE).
