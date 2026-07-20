# Runtime parameters

The complete CLI surface of the `styre` binary: every command, flag, exit code, and environment
variable. Grounded in `src/index.ts`, `src/cli/`, and `src/config/`. When you change any of these,
update this file in the same PR.

The binary registers **four** subcommands (`src/index.ts` `subCommands`): `migrate`, `notify`,
`run`, `setup`. There are no hidden or aliased subcommands.

Two global behaviors sit in front of the subcommands (`src/index.ts`):

- `styre --version` (as the **first** argument) prints the version and exits `0` before the command
  parser runs. `styre migrate --version` is *not* intercepted — it runs `migrate`.
- `--help` / `-h` anywhere prints usage and exits `0`.

---

## Stream contract

- **`styre run` writes NDJSON telemetry — and only that — to stdout** (one JSON object per line).
  Every human-readable byte (progress, summaries, warnings, park hints, resume diagnostics,
  missing-tool reports) goes to **stderr** (`src/cli/run.ts`, `src/cli/park.ts`). This is what makes
  `styre run … | jq` and machine consumption clean.
- **`styre setup` and `styre migrate` print human output to stdout** via `console.log`
  (`src/cli/setup.ts`, `src/cli/migrate.ts`). `styre notify` prints to stderr.

Do not assume a uniform stream policy across commands — only `run` reserves stdout for NDJSON.

---

## `styre run [ticket]`

Ingest one ticket and drive it to PR-ready, then exit (`src/cli/run.ts`). `ticket` is an optional
positional (e.g. `ENG-123`); it is required on a fresh run and omitted when using `--resume`.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--profile <path>` | string | `~/.config/styre/<slug>/profile.json` for the cwd repo | Pin the project-profile JSON. |
| `--slug <name>` | string | derived from the cwd repo | Locate the profile + per-project config. |
| `--config <path>` | string | discovered from `~/.config` | Pin the runtime config. **Hermetic**: when set, it is the *sole* source — global/per-project `config.json` are not merged. |
| `--db <path>` | string | a fresh per-run temp DB (`os.tmpdir()/styre-run-*/run.db`) | SQLite state-of-truth for this run. |
| `--resume <ident>` | string | — | Resume a parked run by ticket ident. |
| `--accept-head` | boolean | off | On resume, proceed even though the branch HEAD moved (drops carried-forward context). |
| `--inspect` | boolean | off | Print resume diagnostics to stderr and exit `0` without running. |
| `--in-place` | boolean | off | Work on a branch in the **repo root** instead of an isolated worktree. Fresh-run only (on resume it is derived from the DB). Requires a disposable, single-use checkout — see below. |

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

On a session-limit / out-of-credits dispatch death, a run **parks** (see exit `75`): it dumps the
SoT + transcript under `$XDG_STATE_HOME/styre/<slug>/<ticket-ident>/` without consuming a retry
attempt. Resume with:

```sh
styre run --resume <ticket-ident> --profile <p>
```

Resume re-runs only the interrupted step, carrying its partial context forward. If the branch HEAD
moved since the park, resume refuses with exit `65`; override with `--accept-head` (resume against
the new HEAD, dropping carryover) or diagnose with `--inspect` (exit `0`).

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
| `--test` | boolean | off | **Required.** Send one test message to the configured channel. Without it: prints `usage: styre notify --test` to stderr and sets exit `2`. |
| `--config <path>` | string | discovered | Explicit `config.json` path. |
| `--slug <name>` | string | derived from the cwd repo | Project slug for per-project config. |

---

## Exit codes

The intended space is enumerated in `src/cli/run.ts`. A code comment there notes a final
cross-command reconciliation is still outstanding, so treat `run` as the authority.

| Code | Name | Condition |
|---|---|---|
| `0` | success | A PR is open (`run`); also `--version`, `--help`, and `run --resume --inspect`. |
| `1` | error | Any thrown error (missing ticket, unresolved profile commands, no profile/slug, setup not approved, bad `--checks`, missing provider key, Slack misconfig, …). citty's `runMain` maps a throw to exit `1`. |
| `2` | notify misuse | `styre notify` invoked without `--test`. |
| `65` | resume refused | `run --resume` and the branch HEAD moved without `--accept-head`. |
| `69` | `EX_TOOLCHAIN_MISSING` | A required repo toolchain program is not installed (fresh-run preflight; never on `--resume`/`--inspect`). |
| `75` | `EX_TEMPFAIL` (parked) | Session limit / out of credits: SoT + transcript dumped, resumable, no retry attempt consumed. |

---

## Environment variables

The complete set read anywhere in `src/` (verified by grep). None of the credential variables have
defaults — a missing one fails at the point of use.

### Paths (XDG)

| Variable | Read at | Effect | Fallback |
|---|---|---|---|
| `XDG_CONFIG_HOME` | `src/config/paths.ts` | Base for `<config>/styre/` — profiles + `config.json`. | `~/.config` |
| `XDG_STATE_HOME` | `src/config/paths.ts` | Base for `<state>/styre/` — default DB, park dumps, telemetry id. | `~/.local/state` |

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
