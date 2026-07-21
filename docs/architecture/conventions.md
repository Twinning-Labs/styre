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
| `stateDir()` | `XDG_STATE_HOME` | `~/.local/state` | `<state>/styre/` — DB, park dumps, telemetry id |

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
  <slug>/<ticket-ident>/       # a park dump (see below)
    run.db
    transcript.json
```

The default DB lives here only for `styre migrate`; a `styre run` uses a fresh per-run temp DB
unless you pass `--db`.

---

## Slug derivation

The slug names a project's config/profile subdirectory and its park directory
(`deriveSlug`, `src/config/slug.ts`):

1. `git config --get remote.origin.url` in the repo.
2. If it parses as a **GitHub** remote (SCP `git@github.com:owner/repo(.git)` or
   `https|ssh|git://github.com/owner/repo(.git)`), the slug is the **repo name only** (not
   `owner/repo`).
3. On any failure — no remote, a non-GitHub host (GitLab/Bitbucket/self-hosted), an unparseable URL
   — fall back to `basename(repoDir)`.

Consequences worth knowing: the GitHub match is case-sensitive on `github.com`; a nested path like
`org/group/repo` yields a slug containing a slash, which becomes a nested directory under the config
and state trees. `styre setup --slug <name>` and `styre run --slug <name>` override derivation.

---

## Ephemeral working directories (OS temp dir)

Not XDG — each is a fresh `mkdtemp` under `os.tmpdir()`, created per invocation and (mostly) removed
after use:

| Prefix | Purpose |
|---|---|
| `styre-run-*` | The per-run ephemeral SoT DB (`run.db`) when `--db` is not given. |
| `styre-wt-*` | The dispatch **worktree** — the agent's only writable surface. |
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
| git worktree | write | `git worktree add -B <branch> <tmp>` from the repo root; the temp worktree is the agent's writable surface. |
| `docs/**`, root `README*`/`CHANGELOG*`/`CONTRIBUTING*`, `mkdocs.yml` | write | The `docs:revise` step's writable allowlist (`src/dispatch/docs-paths.ts`). Nested `src/docs/*` and co-located READMEs are excluded; `..` segments fail closed. |

There are **no log files.** Styre never writes a log to disk: `styre run` puts NDJSON on stdout and
human output on stderr (see [`runtime-parameters.md`](runtime-parameters.md)).

---

## Park dumps

When a run parks (exit `75`), it dumps under `$XDG_STATE_HOME/styre/<slug>/<ticket-ident>/`
(`src/cli/park.ts`): the run DB (`run.db`) and the agent transcript (`transcript.json`). `styre run
--resume <ident>` reads them back. The park dir uses the **profile's** slug; note that
`styre run --slug X` steers config/profile lookup to slug `X` but the park dump still lands under the
profile's own slug.

---

## Telemetry identity in CI

The anonymous analytics id lives in `$XDG_STATE_HOME/styre/telemetry.json` as a bare random UUID
(never derived from machine/user/repo). There is no env override. In ephemeral CI, cache
`$XDG_STATE_HOME/styre/` (default `~/.local/state/styre/`) so the id — and the first-run-notice latch
— survive across runs; otherwise each run counts as a new install.

Since `styre run` counts early failures too, the id + first-run-notice latch can be minted (and the notice printed once to stderr) on a run that fails before config resolves — not only on a fully successful run. Still at most once; the `STYRE_TELEMETRY`/`DO_NOT_TRACK` opt-outs suppress it.
