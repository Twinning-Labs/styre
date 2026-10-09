# Conventions

Every file and directory Styre reads or writes, and the naming rules behind them. Grounded in
`src/config/paths.ts`, `src/config/slug.ts`, `src/cli/park.ts`, and the dispatch/setup modules.

---

## XDG base directories

Styre honors exactly **two** XDG variables, identically on macOS and Linux — there is no
`~/Library/Application Support` special-case (`src/config/paths.ts`). An empty-string value is
treated as unset.

| Function | Variable | Fallback | Holds |
|---|---|---|---|
| `configDir()` | `XDG_CONFIG_HOME` | `~/.config` | `<config>/styre/` — profiles + `config.json` |
| `stateDir()` | `XDG_STATE_HOME` | `~/.local/state` | `<state>/styre/` — DB, checkpoints, telemetry id; and its sibling `<state>/styre-processes/` — launch records |

`XDG_DATA_HOME` and `XDG_CACHE_HOME` are **not** read anywhere. Nothing Styre persists is classified
as data or cache; ephemeral work goes to the OS temp dir instead (below).

### Config tree — `$XDG_CONFIG_HOME/styre/`

```
<config>/styre/
  config.json                  # global runtime config (all projects)
  <slug>/
    config.json                # per-project runtime config (overrides global)
    profile.json               # the project profile written by `styre setup`
```

### State tree — `$XDG_STATE_HOME/styre/`

```
<state>/styre/
  styre.db                     # the SoT DB — only `styre migrate` (no --db) writes here
  telemetry.json               # anonymous analytics id + first-run notice latch
  <slug>/<ticket-ident>/       # a checkpoint (see below)
    run.db
    transcript.json
```

The default DB lives here only for `styre migrate`. A `styre run` journals directly to its
checkpoint (`<slug>/<ticket-ident>/run.db` above) unless you pass `--db` — the checkpoint IS the
run's live location, not a temp file written only on pause.

### Launch records — `$XDG_STATE_HOME/styre-processes/`

One small JSON file per live long running launch (an agent, or a command: suites, probes,
acceptance checks, provisioning, the macOS `lsof` of the leftover check), for the whole machine
(`src/util/process/records.ts`, ENG-485). It is how a later Styre command finds and stops what a
Styre killed with `kill -9` left running (the sweep, see
[`runtime-parameters.md`](runtime-parameters.md#stopping-interruption-and-orphan-cleanup-eng-485)).

```
<state>/styre-processes/                                   # created (mode 0700) by the first record if missing
  <pid>-<startedAt>.json                                   # a record (0600)
  <pid>-<startedAt>.json.claimed-<claimerPid>-<claimerStartedAt>   # a record a sweep has claimed
```

- **A sibling of `styre/`, never inside it.** Any folder name inside `styre/` could collide with a
  project slug, and `ls` and `clean --all` treat every child folder of `styre/` as one.
- **`<startedAt>`** is the process's start time as the kernel reports it: clock ticks since boot on
  Linux (digits only), `<seconds>.<microseconds>` (six digits) on macOS. With the pid it identifies
  the process, so a pid reused by another program is never mistaken for it.
- **A record holds** the pid, the start time, the boot ID (Linux), whether it is an `agent` or a
  `group`, the ticket ident, step ID and worktree when known, the first 200 characters of the
  command line, and the owner: the launching Styre's pid, start time and process group.
- **Written** right after the spawn, to a temporary name that starts with a dot, then renamed, so a
  reader never sees half a file. The temporary file is created new and never through a symbolic
  link; a file already at that name makes the write fail. **Removed** only once the process, or for a group every member, is
  confirmed gone.
- **A claimed record** is one a sweep has renamed while it checks the owner (the name keeps
  `.json`). A claim whose claimer is gone is taken again, so a sweep stopped midway strands nothing.
- **Nothing else in the folder is touched.** Styre reads, renames and deletes only regular files
  whose names match one of the two patterns exactly. A file with a record's name that cannot be used
  (not a regular file, not yours, over 64 KB, or not a valid record) is reported once per command and
  left in place.
- **The folder must be yours alone.** Styre creates it with mode 0700 but does not change a folder
  that already exists. The sweep uses it only when it is a real folder (not a symbolic link) owned by
  you and writable by no one else; otherwise it says so and stops nothing (anyone who could write it
  could make the sweep stop any of your processes). Fix it with `chmod 700`.
- Tests point `XDG_STATE_HOME` at a temporary folder (`test/preload.ts`) and fail the run if a record
  appears in the real folder.

---

## Slug derivation

The slug names a project's config/profile subdirectory and its checkpoint directory
(`deriveSlug`, `src/config/slug.ts`):

1. `git config --get remote.origin.url` in the repo.
2. If it parses as a **GitHub** remote (SCP `git@github.com:owner/repo(.git)` or
   `https|ssh|git://github.com/owner/repo(.git)`), the slug is the **repo name only** (not
   `owner/repo`).
3. On any failure — no remote, a non-GitHub host (GitLab/Bitbucket/self-hosted), an unparseable URL
   — fall back to `basename(repoDir)`. The one exception: a `git` call that times out (30 s) is not
   an answer, so the command fails with an error naming it instead of silently using the folder
   name, which would be a different state folder (`--resume` would not find its checkpoint).

Consequences worth knowing: the GitHub match is case-sensitive on `github.com`; a nested path like
`org/group/repo` yields a slug containing a slash, which becomes a nested directory under the config
and state trees. `styre setup --slug <name>` and `styre run --slug <name>` override derivation.

---

## Ephemeral working directories (OS temp dir)

Not XDG — each is a fresh `mkdtemp` under `os.tmpdir()`, created per invocation and (mostly) removed
after use:

| Prefix | Purpose |
|---|---|
| `styre-wt-*` | The dispatch **worktree** — the only place the agent's file tools can write. |
| `styre-inplace-*` | Identity-probe script dir for `--in-place` safety checks. |
| `styre-reuse-*` | Env-reuse probe script dir. |
| `styre-baseline-wt-*` | Replay-harness baseline worktree. |
| `styre-provcheck-*` | Provision-check script dir. |
| `styre-codex-msg-*` | Codex adapter message dir. |

In `--in-place` mode the "worktree" **is** the repo root (a `checkout -B`, never removed) rather than
a temp dir.

---

## Files Styre reads and writes inside the target repo

| Path | Access | Purpose |
|---|---|---|
| `.styre-disposable` | read | Disposability marker — a **regular file** (symlinks/dirs rejected). Required for `--in-place` and for a no-argument `styre setup`. Its presence asserts "this checkout may be rewritten." |
| `AGENTS.md` | read | Command/context source ingested at setup. Must be a regular file (symlinks refused); capped at 16 KB. |
| `**/styre_scratch/` | write + delete | The **scratch drawer** — an agent-created throwaway dir. Recursively swept and removed before commit-scope judging and before the broad verify run (skips `.git`/`node_modules`; never throws). It is always deleted, never persisted — there is no XDG scratch location. |
| git worktree | write | `git worktree add -B <branch> <tmp>` from the repo root; the temp worktree is the only place the agent's file tools can write. |
| `docs/**`, root `README*`/`CHANGELOG*`/`CONTRIBUTING*`, `mkdocs.yml` | write | The `docs:revise` step's writable allowlist (`src/dispatch/docs-paths.ts`). Nested `src/docs/*` and co-located READMEs are excluded; `..` segments fail closed. |

There are **no log files.** Styre never writes a log to disk: `styre run` puts NDJSON on stdout and
human output on stderr (see [`runtime-parameters.md`](runtime-parameters.md)).

---

## Checkpoints

A run journals directly to `$XDG_STATE_HOME/styre/<slug>/<ticket-ident>/` (`src/cli/park.ts`): the
run DB (`run.db`, plus its WAL sidecar) is the live journal itself, not a dump written only when
something goes wrong — a pause or crash simply leaves it there, resumable. A budget pause
additionally (re)writes the agent transcript sidecar (`transcript.json`, via `dumpPark`) at that same
checkpoint. `styre run --resume <ident>` reads it back; `styre clean <ident>` /
`--all` / `--purge` reap exactly this checkpoint dir (worktree + checkpoint). The checkpoint dir uses
the **profile's** slug; note that `styre run --slug X` steers config/profile lookup to slug `X` but
the checkpoint still lands under the profile's own slug.

---

## Telemetry identity in CI

The anonymous analytics id lives in `$XDG_STATE_HOME/styre/telemetry.json` as a bare random UUID
(never derived from machine/user/repo). There is no env override. In ephemeral CI, cache
`$XDG_STATE_HOME/styre/` (default `~/.local/state/styre/`) so the id — and the first-run-notice latch
— survive across runs; otherwise each run counts as a new install.

Since `styre run` counts early failures too, the id + first-run-notice latch can be minted (and the notice printed once to stderr) on a run that fails early — not only on a fully successful run. Still at most once; the `STYRE_TELEMETRY`/`DO_NOT_TRACK` opt-outs suppress it, as does a `"telemetry": false` config once the config has been read.
