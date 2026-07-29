# Runtime parameters

The complete CLI surface of the `styre` binary: every command, flag, exit code, and environment
variable. Grounded in `src/index.ts`, `src/cli/`, and `src/config/`. When you change any of these,
update this file in the same PR.

The binary registers **six** subcommands (`src/index.ts` `subCommands`): `clean`, `ls`, `migrate`,
`notify`, `run`, `setup`. There are no hidden or aliased subcommands.

Two global behaviors sit in front of the subcommands (`src/index.ts`):

- `styre --version` (as the **first** argument) prints the version and exits `0` before the command
  parser runs. `styre migrate --version` is *not* intercepted — it runs `migrate`.
- `--help` / `-h` anywhere prints usage and exits `0`.

---

## Stream contract

- **`styre run` writes NDJSON telemetry — and only that — to stdout** (one JSON object per line).
  Every human-readable byte (progress, summaries, warnings, pause hints, resume diagnostics,
  missing-tool reports) goes to **stderr** (`src/cli/run.ts`, `src/cli/park.ts`). This is what makes
  `styre run … | jq` and machine consumption clean.
- **`styre setup` and `styre migrate` print human output to stdout** via `console.log`
  (`src/cli/setup.ts`, `src/cli/migrate.ts`). `styre notify` prints to stderr.

Do not assume a uniform stream policy across commands — only `run` reserves stdout for NDJSON.

---

## `styre run [ticket]`

Ingest one ticket and drive it to PR-ready, then exit (`src/cli/run.ts`). `ticket` is an optional
positional (e.g. `ENG-123`); it is required on a fresh run and omitted when using `--resume`. A
fresh `styre run <ticket>` **refuses** (exit `64`) when a checkpoint already exists for that ident —
resume it with `--resume <ident>`, or discard it and start over with `styre run <ticket> --fresh`.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--profile <path>` | string | `~/.config/styre/<slug>/profile.json` for the cwd repo | Pin the project-profile JSON. |
| `--slug <name>` | string | derived from the cwd repo | Locate the profile + per-project config. |
| `--config <path>` | string | discovered from `~/.config` | Pin the runtime config. **Hermetic**: when set, it is the *sole* source — global/per-project `config.json` are not merged. |
| `--db <path>` | string | a fresh per-run temp DB (`os.tmpdir()/styre-run-*/run.db`) | SQLite state-of-truth for this run. |
| `--resume <ident>` | string | — | Resume a paused run by ticket ident. |
| `--accept-head` | boolean | off | On resume, proceed even though the branch HEAD moved (drops carried-forward context). |
| `--inspect` | boolean | off | Print resume diagnostics to stderr and exit `0` without running. |
| `--in-place` | boolean | off | Work on a branch in the **repo root** instead of an isolated worktree. Fresh-run only (on resume it is derived from the DB). Requires a disposable, single-use checkout — see below. |
| `--fresh` | boolean | off | Discard an existing checkpoint for this ticket and reconcile the worktree, then start over. Fresh-run only. |

No flag declares a default in citty; booleans are `undefined` when absent and coerced at the use
site. There are no short aliases.

### `--in-place` and the `.styre-disposable` marker

`--in-place` makes Styre check out its branch in the repo root and mutate it directly, rather than
creating a git worktree under `os.tmpdir()`. Because this writes agent-authored code into the
working checkout, it is gated: the repo root must contain a **regular file** named
`.styre-disposable` (`src/dispatch/in-place.ts`). Symlinks and directories are rejected. The same
marker is required when you run `styre setup` with **no** repo argument (it discovers the cwd repo).
Use `--in-place` only in throwaway/CI checkouts you are willing to have rewritten.

### Resume flow

**The checkpoint is the live location.** A run journals directly to
`$XDG_STATE_HOME/styre/<slug>/<ticket-ident>/run.db` (`~/.local/state` when unset) as it goes —
there is no separate "dump" step. On a session-limit / out-of-credits interrupt, the run **pauses**
(see exit `75`) with the checkpoint already holding the SoT + transcript, and no retry attempt is
consumed. A crash leaves the same checkpoint in place, equally resumable. Resume with:

```sh
styre run --resume <ticket-ident> --profile <p>
```

Resume re-runs only the interrupted step, carrying its partial context forward, and always consumes
the pending signal (there is no `--after-fix` flag). If the branch HEAD moved since the pause,
resume refuses with exit `65`; override with `--accept-head` (resume against the new HEAD, dropping
carryover) or diagnose with `--inspect` (exit `0`). Resume also refuses with exit `65` under
concurrent-resume lock contention — another `styre run --resume` already holds this checkpoint.

---

## `styre ls`

List every styre effort's checkpoint across all projects under `$XDG_STATE_HOME/styre/`
(`src/cli/ls.ts`). Takes no flags. Prints three sections, in order, to stdout:

```
Paused/resumable efforts:
  <ident>  [<kind>, <age>]  <note>
    resume: styre run --resume <ident> --slug <slug>

Finished leftovers (reap per project with `styre clean --all`):
  <slug>/<ident>  [<kind>, <age>]  <note>

Running:
  <ident>  [<kind>, <age>]
```

- **Paused/resumable efforts** — every checkpoint that is resumable and not currently live. Each row
  is followed by its exact resume command (`--slug` included, since `ls` spans every project). An
  empty list prints `No paused efforts.` instead of an empty section.
- **Finished leftovers** — checkpoints classified `pr-ready` or `done` and not live: provably
  finished, safe to reap with `styre clean --all`. Rows are slug-qualified (`<slug>/<ident>`) since
  leftovers span every project. The section is omitted entirely when empty. Classification is by
  checkpoint kind alone — there is **no merge-state check** (nothing confirms the PR actually
  merged) and **no age-based staleness heuristic**.
- **Running** — checkpoints currently live (an active `styre run` holds the lock). Live efforts
  never appear as reapable, even if their classified kind would otherwise qualify. The section is
  omitted entirely when empty.

Age is rendered by `humanAge`: under 60 minutes as `"<m>m"`, under 24 hours as `"<h>h"`, otherwise
`"<d>d"` (integer floors).

---

## `styre clean <ident>`

Reap one styre effort's disk artifacts — free its worktree and delete its checkpoint dir
(`src/cli/clean.ts`). **Clean never changes ticket status.** That's the issue tracker's job, driven
by the merge itself: cleaning a run's disk state is not the same as abandoning the ticket.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `<ident>` | positional | — | Ticket ident to clean (e.g. `ENG-123`). Required unless `--all`. |
| `--all` | boolean | off | Reap only the provably-finished (`pr-ready`/`done`) efforts for the current project; skips resumable pauses and live runs. Mutually exclusive with `<ident>`. |
| `--purge` | boolean | off | Single-ident only — rejects alongside `--all` (exit `64`). After reaping, also deletes the local + remote branch (closes the PR). Opt-in; silent when there is no branch/PR. |
| `--slug <name>` | string | derived from the cwd repo | Project slug to locate the profile. |
| `--profile <path>` | string | discovered | Path to the project-profile JSON. |

- **`styre clean <ident>`** — reaps that one effort's worktree + checkpoint. No ticket-status
  change. Refuses a live run: **exit `75`** (a different, currently-running `styre run` owns this
  checkpoint).
- **`styre clean --all`** — scoped to the current project's slug; reaps only checkpoints classified
  `pr-ready`/`done` and not live. Resumable pauses and live runs are skipped, not reaped. Same
  classification rule as `ls`: kind-only, no merge-state check, no age-based staleness heuristic.
- **`styre clean <ident> --purge`** — after reaping, additionally deletes the local + remote branch,
  closing the PR. On the repo's **default branch**, `--purge` skips the branch/PR deletion — the
  default branch is never deleted — but still reaps the disk state; it prints a stderr warning and
  exits `0` (a soft skip, not a failure).

Stream reminder: `clean` prints its summary to stdout (`reaped N finished leftover(s); kept M
resumable/unknown; F failed` for `--all`; `reaped <ident> (freed worktree, removed checkpoint)` for
a single ident) and failure detail to stderr.

---

## `styre setup [repo]`

Probe a repo and write its project profile (`src/cli/setup.ts`). `repo` is an optional positional;
omit it to discover the cwd repo (which then requires a `.styre-disposable` marker). An explicit
path needs no marker.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--out <path>` | string | `$XDG_CONFIG_HOME/styre/<slug>/profile.json` | Output profile path. |
| `--checks <v>` | string | probe decides | Override the checks system. Validated against `github \| external \| none`; any other value throws. |
| `--slug <name>` | string | derived from the repo | Override the derived project slug (stores the profile under that slug). |
| `--force` | boolean | off | Overwrite an existing profile, discarding the operator-resolved runtime-context merge. |
| `--reprobe` | boolean | off | Re-probe from scratch. **Behaviorally identical to `--force`** in the current code (both set the same `clean` path). |
| `--config <path>` | string | discovered | Selects the agent **provider** for the setup run (used to gate the required provider API key). Not otherwise forwarded into the profile. |
| `--trust-agent-commands` | boolean | off | **Headless only.** Accept agent-refined command strings. These run as code at verify time — the metacharacter filter is hygiene, **not** a sandbox. Use only on trusted repos / isolated environments. |

`setup` is interactive when stdin is a TTY: it prints the full resolved command list and requires a
literal `y` to proceed; anything else aborts (a thrown error → exit `1`). In headless mode there is
no prompt, and agent-authored commands are accepted only under `--trust-agent-commands`.

---

## `styre migrate`

Create or upgrade the SQLite database; idempotent (`src/cli/migrate.ts`). Prints
`bootstrapped: <path> (schema vN)` or `already current: …` to stdout.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--db <path>` | string | `$XDG_STATE_HOME/styre/styre.db` (`defaultDbPath()`) | Database file to create/upgrade. |

---

## `styre notify`

Notifier utilities (`src/cli/notify.ts`). Sends one test message through the configured notifier to
verify your Slack setup, resolving config exactly as `styre run` does (so per-project Slack config is
honored).

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--test` | boolean | off | **Required.** Send one test message to the configured channel. Without it: prints `usage: styre notify --test` to stderr and sets exit `64` (`EX_USAGE`). |
| `--config <path>` | string | discovered | Explicit `config.json` path. |
| `--slug <name>` | string | derived from the cwd repo | Project slug for per-project config. |

---

## Exit codes (error codes) and their meaning

The process exit code is the machine-readable error code. The space is enumerated in `src/cli/run.ts`
(the per-command comment) and defined in `src/cli/errors.ts` (`EXIT`) — treat those as the authority;
this table is reconciled to them (ENG-338). Codes `64` and above follow the BSD `sysexits.h`
convention, which is what lets a CI/fleet caller branch on them.

| Code | Name | Meaning | Retryable? |
|---|---|---|---|
| `0` | success | The command did its job. For `run`: a PR is open and ready (`done` / `pr-ready`). Also returned by `--version`, `--help`, `run --resume --inspect`, and a `styre clean --purge` soft-skip on the default branch. | — |
| `1` | operational stop | `abandoned` — a reserved terminal outcome. **Not currently emitted by any run.** | No — a human should look at it. |
| `64` | usage (`EX_USAGE`) | CLI misuse — e.g. `styre notify` without `--test`, `styre clean --all --purge`, or a fresh `styre run <ticket>` when a checkpoint already exists for that ident (`usageError` → `EXIT.USAGE`). A misuse error, not a run failure. | No — correct the invocation. |
| `65` | resume refused (`EX_DATAERR`) | `run --resume`, refused because either the branch HEAD moved since the run paused and `--accept-head` was not passed, *or* concurrent-resume lock contention — another `styre run --resume` already holds this checkpoint. | Yes, deliberately — re-run with `--accept-head` (HEAD moved) or retry once the other resume releases the lock (contention), or `--inspect` (diagnose, exits `0`). |
| `69` | toolchain missing (`EX_UNAVAILABLE`) | A required repo toolchain program (a build/test/check tool the profile depends on) is not installed on this machine. Detected by the fresh-run preflight *before any spend*; never raised on `--resume`/`--inspect`. | Yes, after you install the missing tool — the stderr report names it. |
| `70` | internal (`EX_SOFTWARE`) | An unexpected crash or a violated internal invariant — anything that is not a `StyreError` reaching the error boundary. | No — this is a bug; please report it. |
| `75` | paused (`EX_TEMPFAIL`) | **Any** paused run (`exitCodeForOutcome`) — reason `budget`, `needs_you`, or `interrupted`. The checkpoint (SoT + transcript) is already on disk and **no retry attempt is consumed**. Also returned by `styre clean <ident>` when that ident is currently a live run — `clean` refuses rather than reaping. | Paused: yes — `styre run --resume <ident> --profile <p>`. `clean` on a live run: not as-is — wait for the run to finish or pause, then clean. |
| `78` | config (`EX_CONFIG`) | A bad config/profile value, an unknown adapter, or an unresolved profile (`configError` → `EXIT.CONFIG`). | No — fix the value, or re-run `styre setup`. |

**How to read them as a caller:**

- **`0`** — done; for `run`, go merge the PR.
- **`75`** — any paused run, whatever the reason (`budget` / `needs_you` / `interrupted`): back off and re-run the *same* ticket with `--resume`; a fleet scheduler should retry, not mark it failed. The same code is also returned by `styre clean <ident>` when that ident is a live run — `clean` refused rather than reaping, so wait for the run to finish (or pause), then clean.
- **`65`** — either the world moved under a paused run (branch HEAD advanced) or a concurrent `--resume` already holds this checkpoint; a human (or a policy) decides whether to accept the new HEAD (`--accept-head`), retry once the other resume finishes, or investigate (`--inspect`).
- **`69`** — an environment/provisioning gap on this machine, not a problem with the ticket; fix the host toolchain and re-run.
- **`1`** — reserved for `abandoned`. Not currently emitted by any run — cleaning a run's disk state (`styre clean`) is not the same as abandoning the ticket.
- **`64` / `78`** — a misuse or a bad config value: the invocation or the config needs fixing, not a retry.
- **`70`** — an internal error: a bug in Styre, not in the ticket or the host. Worth reporting.

Stream reminder: for `run`, the human-readable explanation for any nonzero code is on **stderr**;
stdout carries only the NDJSON telemetry stream.

---

## Environment variables

The complete set read anywhere in `src/` (verified by grep). None of the credential variables have
defaults — a missing one fails at the point of use.

### Paths (XDG)

| Variable | Read at | Effect | Fallback |
|---|---|---|---|
| `XDG_CONFIG_HOME` | `src/config/paths.ts` | Base for `<config>/styre/` — profiles + `config.json`. | `~/.config` |
| `XDG_STATE_HOME` | `src/config/paths.ts` | Base for `<state>/styre/` — default DB, run checkpoints, telemetry id. | `~/.local/state` |

Only these two XDG variables are honored. `XDG_DATA_HOME` and `XDG_CACHE_HOME` are not read
anywhere. See [`conventions.md`](conventions.md) for the full path layout.

### Credentials

| Variable | Used by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | `claude` provider | Required for the default provider; `styre setup` throws if missing when the provider is `claude`. |
| `OPENAI_API_KEY` | `codex` provider | Required when the provider is `codex`. |
| `GITHUB_TOKEN` | GitHub forge/checks adapter | Push, PR, and checks reads. |
| `LINEAR_API_KEY` | Linear tracker adapter | Ticket ingest + projection. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira tracker adapter | Jira site, account, and token. |
| `SLACK_BOT_TOKEN` | Slack notifier | Auth for `chat.postMessage`; `assertSlackConfigured` fails loud at startup when `notifier: "slack"` and it is empty. |

The runner strips `LINEAR_API_KEY`, `GITHUB_TOKEN`, and `JIRA_API_TOKEN` from the **agent** CLI's
environment, and additionally strips the provider keys from **verify-time** commands
(`src/agent/agent-env.ts`). `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN` appear only in that denylist —
nothing reads them. See [`SECURITY.md`](../../SECURITY.md).

### Telemetry / CI

| Variable | Read at | Effect |
|---|---|---|
| `STYRE_TELEMETRY` | `src/telemetry/analytics/consent.ts` | `"0"` or `"false"` disables analytics. |
| `DO_NOT_TRACK` | `src/telemetry/analytics/consent.ts` | Any value other than `""`/`"0"`/`"false"` disables analytics. |
| `CI`, `GITHUB_ACTIONS` | `src/telemetry/analytics/properties.ts` | Truthy sets the `ci` super-property on analytics events. |

There is deliberately **no** `STYRE_ANON_ID` and **no** `STYRE_IN_PLACE` environment variable. The
anonymous analytics id is not env-provisionable (in CI, persist a stable id by caching the state
dir — see [`conventions.md`](conventions.md)); in-place execution is a CLI flag only, because an env
var would inherit into every child process and silently turn all runs into repo mutations. The
PostHog host and project token are compile-time constants in `src/telemetry/analytics/client.ts` —
not configurable via environment.
