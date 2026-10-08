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
| `--review-action` | `retry` or `accept-risk` | retry semantics | Resume an unresolved review; plain resume never accepts risk. Requires `--resume`. |
| `--review-findings` | comma-separated positive IDs | — | With `accept-risk`, list exactly all current nominated major finding IDs. |
| `--review-reason` | nonblank text | — | With `accept-risk`, record why shipping these findings is acceptable at the reviewed SHA. |
| `--inspect` | boolean | off | Print resume diagnostics to stderr and exit `0` without running. |
| `--in-place` | boolean | off | Work on a branch in the **repo root** instead of an isolated worktree. Fresh-run only (on resume it is derived from the DB). Requires a disposable, single-use checkout — see below. |
| `--fresh` | boolean | off | Discard an existing checkpoint for this ticket and reconcile the worktree, then start over. Fresh-run only. |

No flag declares a default in citty; booleans are `undefined` when absent and coerced at the use
site. There are no short aliases.

Review resume decisions are validated before signal consumption or worktree reconciliation.
Plain resume and `--review-action retry` preserve unresolved findings and repair limits. An
unchanged repeated finding can immediately escalate again; retry is not a waiver. Explicit
`accept-risk` requires a succeeded current code review, unchanged HEAD, exactly all eligible
major IDs and a reason; plan and critical findings cannot be deferred. Accepted risks appear in
the PR body. `--accept-head` cannot waive review: changed code re-enters implementation and
verification. Invalid review decisions exit `65`. See [review-repair.md](review-repair.md).

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

When the sweep that `ls` runs first (see
[Stopping, interruption and orphan cleanup](#stopping-interruption-and-orphan-cleanup-eng-485))
stopped any orphan, a fourth section follows, one row per orphan:

```
Stopped orphans (left running when Styre was force quit):
  <ident>  [<agent|group>, pid <pid>]  <command>
```

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

## Stopping, interruption and orphan cleanup (ENG-485)

How Styre stops the agent and its commands, what it prints while it does, and how it cleans up
after a Styre that was killed. The security view, with every known limit, is in
[`SECURITY.md`](../../SECURITY.md); the records folder is in [`conventions.md`](conventions.md).

### Who does what

- **`styre run` and `styre setup` handle stop signals:** SIGINT (Ctrl-C), SIGTERM (`kill`, CI,
  `docker stop`), SIGHUP (the terminal closing) and SIGQUIT (`Ctrl-\`). `styre setup` removes its
  handlers while it waits at a prompt, so Ctrl-C there ends setup at once (130) and `Ctrl-\` ends it
  at once (131, with core dumps turned off for the prompt).
- **Every command sweeps first.** `run`, `setup`, `ls`, `clean`, `migrate` and `notify` read the
  launch records before doing anything else and stop what an earlier Styre left running when it
  was killed with `kill -9` (an orphan). A live run's launches are never touched. `ls` also lists
  what it stopped.
- **On a signal, the handler owns the exit.** Within one deadline of 6.5 s from the first signal
  it:
  1. closes the door (no new process, no `git`, no write to the run database by run code);
  2. sends SIGTERM to the agent's whole tree and to every command group at once;
  3. says it is stopping;
  4. waits up to 5 s for them to go, then sends SIGKILL to what is left;
  5. looks for processes the agent left running in its worktree;
  6. (`styre run` only) records the interruption in the run database: the step's attempt is given
     back, its dispatch is closed as `interrupted`, and the data `--resume` needs to undo the
     agent's edits is saved;
  7. writes that record as a telemetry `event` line on stdout, then reports the outcome on stderr;
  8. removes any temporary baseline worktree the run still holds;
  9. shuts analytics down, releases the run lock, and ends itself by the same signal.
- **An agent that exits on its own** is not stopped further: what it left running is no longer
  linked to it. The leftover check that runs in the background after every agent step reports any
  such process whose working folder is inside the worktree (the leftover lines below), and stops
  nothing. A command launch is different: when the process it started exits, anything still in
  its group is stopped before its output is read.
- **A second signal** while stopping prints `styre: forcing stop…` and skips the rest of the 5 s
  wait. The exit still uses the first signal.
- **An interruption is free.** `styre run --resume <ident>` resets the interrupted step to pending
  without counting the attempt, undoes the agent's partial edits in place, and returns the branch to
  where the step started when the step had moved it and nobody else has since. A crash or `kill -9`
  takes the normal crash path instead (control-loop §6.1).
- **Normal exit.** Before `styre run` and `styre setup` exit, they wait for any leftover check still
  running in the background (each bounded by 5 s), then check that no launch is still running. One
  that is, is a bug: Styre stops it, names it, and turns a success exit into `70`. It never replaces
  an exit status that already says something (`75`, `65`, `64`, `1`, or an error's own code). The
  check also runs when the command failed.

### Cost

A normal dispatch costs about 0.5 ms more than before ENG-485 (the launch record, and the git calls
going through the door), and each effectful step about 5 to 6 ms for one `git rev-parse` plus about
0.7 to 0.9 ms before the next step starts while the leftover check is launched. Measured on macOS
arm64 with `scripts/measure-lifecycle-latency.ts`; the evidence and the breakdown are in
[`SECURITY.md`](../../SECURITY.md#cost).

### Exit statuses on a signal

The handler ends Styre by re-raising the first signal it received, so shells and CI see
"terminated by signal":

| Signal | Usual source | Exit status |
|---|---|---|
| SIGINT | Ctrl-C; GitHub's first cancel signal (with `exec`) | `130` |
| SIGTERM | `kill`; GitHub's second signal; GitLab; `docker stop`; Kubernetes; systemd | `143` |
| SIGHUP | the terminal closing | `129` |
| SIGQUIT | `Ctrl-\` | `131` (no core dump is written) |

As a container's first process, Styre ignores its own re-raised signal; it then exits with
`128 + n`, the same numbers. An interruption is never exit `75`: `75` means Styre paused the run
itself.

### Messages

Every line below goes to stderr, for every command: `styre run`'s stdout keeps only NDJSON, and the
human output `ls` and `setup` print on stdout stays clean. Text in angle brackets is filled in;
`<ident>` is `an unknown run` when a record names no ticket. A test
(`test/lifecycle/messages-doc.test.ts`) checks that each line here is a message in `src/`, that every
`styre: …` message in `src/` is here (apart from a short, tested list of messages unrelated to
stopping), that `<pid>` stands exactly where the code puts a pid, and that no message is built from
parts (a `+`, a prefix constant, or a helper) that would hide it from the check.

<!-- messages:begin -->
**The stop handler** (`src/util/process/signals.ts`):

```
styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…
styre: received a stop request (<SIGNAL>) — cleaning up…
styre: forcing stop…
styre: stopped the agent (pid <pid>) and <n> of its commands.
styre: could not stop <command> (pid <pid>); stop it with: kill -9 <pid>
styre: could not confirm that <command> (pid <pid>) stopped (<why>); if it is still running, stop it with: kill -9 <target>
styre: run interrupted; resume with: styre run --resume <ident>
styre: could not record the interruption: <why>
styre: could not write the interruption's telemetry event: <why>
styre: could not clean up after the run: <why>
styre: could not release the run lock: <why>
styre: could not turn off core dumps before exiting: <why>
styre: the stop handler failed: <why>
```

- The first line is for SIGINT; the second, for any other signal, names it (`SIGTERM`, `SIGHUP`,
  `SIGQUIT`).
- `<n>` counts the agent's commands this stop signalled and that are gone.
- `<command>` in `could not stop` is the survivor's own command line, read from the process table.
- `<target>` in `could not confirm` is the pid, or `-- -<pid>` for a command's whole group.
- `could not clean up after the run` covers a temporary worktree the handler could not remove. Its
  `<why>` names the worktree and the command that finishes the removal by hand, and starts with
  `no time was left before the stop deadline to` when the deadline was too close to try.
- The resume line appears for `styre run` only, once the interruption is recorded.

**Setup's prompts** (`src/util/process/signals.ts`, `suspendStopHandlers`):

```
styre: could not turn off core dumps for the prompt: <why>
styre: could not restore core dumps after the prompt: <why>
```

**The leftover check** (`src/util/process/leftovers.ts`, `src/daemon/advance.ts`). It runs after
every agent step in the background, on a stop, and in the sweep. It reports; it never stops anything:

```
styre: the agent left "<command>" (pid <pid>) running in the worktree; stop it with: kill <pid> (if it is not yours)
styre: skipped the check for processes the agent left running in the worktree (<why>)
styre: could not start the leftover check (<why>)
```

**The sweep** (`src/util/process/sweep.ts`):

```
styre: stopped an orphaned agent from <ident> (pid <pid>), left running when Styre was force quit
styre: stopped an orphaned command "<command>" from <ident> (pid <pid>), left running when Styre was force quit
styre: an orphaned command "<command>" from <ident> (pid <pid>) left "<command>" (pid <pid>) running in its process group; its leader has exited, so Styre cannot confirm the group is still that command's and stopped nothing; if the process is a leftover of that command, stop it with: kill <pid>
styre: could not stop <command> (pid <pid>); stop it with: kill -9 <pid>
styre: could not stop the orphaned <agent or command> from <ident> (pid <pid>): <why>; its launch record was kept, so the next Styre command tries again
styre: pid <pid> from <ident> now belongs to another program, so it was left alone and its launch record removed
styre: removed the launch record for pid <pid> from <ident>: it was written before this machine last started, so nothing was stopped
styre: could not check pid <pid> from <ident> (not allowed to read it); its launch record was kept, so the next Styre command tries again
styre: could not finish with the launch record for pid <pid> from <ident>: <why>
styre: ignored the launch record <file>: <why>; it was left in place
styre: could not read the launch records in <folder> (<why>), so no orphans were stopped
styre: could not read this process's own identity (<why>), so no orphans were stopped
```

The sweep stops orphans one at a time, each with its own grace period of up to 5 s. A record whose
stop failed is kept, so the next Styre command tries again.

An orphaned command group whose leader has exited is never stopped: once the leader is gone,
nothing confirms the group is still that command's (its pid may have been handed to another program
that left a group with the same id). The sweep names each process still in the group, one line each,
with `kill <pid>` to stop it, removes the record, and signals nothing. The first `<command>` is the
launch's command from its record; the second is the remaining process's own command line.

**Resume, `--fresh` and `clean`** (`src/util/process/interruption.ts`):

```
styre: skipped undoing the interrupted step's edits: <why>
styre: could not undo the interrupted step's edits in <folder> (<why>); they remain
styre: the interrupted step's commits remain under the current HEAD of <branch> (<why>); nothing was reset
styre: could not return <branch> to <sha> (<why>); the interrupted step's commits remain
styre: step '<step key>' was left running by an older Styre; pid <pid> is alive but its identity cannot be confirmed, so nothing was stopped
styre: could not read <path> to undo an interrupted step's edits: <why>
```

The last but one appears only for a checkpoint written by a Styre from before ENG-485, which
journaled pids; Styre stops nothing for it.

**During a run** (a command's or the agent's stop, a temporary worktree, the exit check):

```
styre: could not stop <command> (pid <pid>); stop it with: kill -9 <pid>
styre: stopping the agent failed: <why>
styre: could not remove a temporary worktree: <why>
styre: internal error: a launch was still running at exit; stopped "<command>" (pid <pid>).
```
<!-- messages:end -->

### Blocking calls

Short calls (`git`, `command -v`, version probes) run to completion and stay in Styre's terminal
group. Every one has a bound of at most 120 s, which the source guard checks. For example: 5 s for
`command -v` and `--version` probes, 10 s for `--help`, 30 s for local git reads, and 120 s for git
calls that rewrite the tree (checkout, reset, clean, add, commit, worktree add and remove) and for
network git calls (`push`, `ls-remote`). A call that reaches its bound is killed with SIGKILL (that
one process only) and reported as a timeout. A stop signal that lands during a blocking call is
handled when the call returns, at most after its bound.

### GitHub Actions: use `exec`

GitHub cancels a step (a manual cancel, or a step or job timeout) by signalling the step's own
process by pid: SIGINT, then SIGTERM 7.5 s later, then SIGKILL 2.5 s after that (actions/runner,
`src/Runner.Sdk/ProcessInvoker.cs`). A `run:` step's process is bash running the step as a script
file. Make Styre that process with `exec`:

```yaml
- name: Run the ticket
  run: exec styre run ENG-123 --profile profile.json
```

- **With `exec`,** Styre receives GitHub's SIGINT, stops the agent and its commands within the 7.5 s,
  records the interruption, and ends by SIGINT (130). The run resumes with `--resume`.
- **Without `exec`,** bash receives the signals and Styre does not: bash ignores the SIGINT while it
  waits, dies on the SIGTERM, and the runner ends the step. Styre, the agent and its commands keep
  working until the job's final cleanup kills every process carrying the job's
  `RUNNER_TRACKING_ID` ("Terminate orphan process" under "Complete job"). That is a kill, not a
  stop: the run is not recorded as interrupted, and the agent may bill for those last seconds. On a
  macOS runner, where process environments cannot be read, they may outlive the job.
- `exec` must be the step's last command, since nothing after it runs. Put any setup in an earlier
  step.

---

## Exit codes (error codes) and their meaning

The process exit code is the machine-readable error code. The space is enumerated in `src/cli/run.ts`
(the per-command comment) and defined in `src/cli/errors.ts` (`EXIT`) — treat those as the authority;
this table is reconciled to them (ENG-338). Codes `64` and above follow the BSD `sysexits.h`
convention, which is what lets a CI/fleet caller branch on them.

| Code | Name | Meaning | Retryable? |
|---|---|---|---|
| `0` | success | The command did its job. For `run`: a PR is open and ready (`done` / `pr-ready`; `pr-ready` requires the forge to have returned the PR's URL and the push of the current head to have been delivered — otherwise the run pauses instead, exit `75`). Also returned by `--version`, `--help`, `run --resume --inspect`, and a `styre clean --purge` soft-skip on the default branch. | — |
| `1` | operational stop | `abandoned` — a reserved terminal outcome. **Not currently emitted by any run.** | No — a human should look at it. |
| `64` | usage (`EX_USAGE`) | CLI misuse — e.g. `styre notify` without `--test`, `styre clean --all --purge`, or a fresh `styre run <ticket>` when a checkpoint already exists for that ident (`usageError` → `EXIT.USAGE`). A misuse error, not a run failure. | No — correct the invocation. |
| `65` | resume refused (`EX_DATAERR`) | `run --resume`, refused because either the branch HEAD moved since the run paused and `--accept-head` was not passed, *or* concurrent-resume lock contention — another `styre run --resume` already holds this checkpoint. | Yes, deliberately — re-run with `--accept-head` (HEAD moved) or retry once the other resume releases the lock (contention), or `--inspect` (diagnose, exits `0`). |
| `69` | toolchain missing (`EX_UNAVAILABLE`) | A required repo toolchain program (a build/test/check tool the profile depends on) is not installed on this machine. Detected by the fresh-run preflight *before any spend*; never raised on `--resume`/`--inspect`. Also raised when component-role classification (ENG-425) leaves the run no primary component to work on — same fresh-run-only rule: a resumed or inspected run is never refused for it. Also raised, on any run, resume or setup, when the agent CLI is missing, below its minimum version, or lacks a flag Styre needs to confine agents (ENG-476), and when an agent run in `setup` could not be confirmed as confined (including one stopped at startup). | Yes, after you install or upgrade the tool — the stderr report names it. |
| `70` | internal (`EX_SOFTWARE`) | An unexpected crash or a violated internal invariant — anything that is not a `StyreError` reaching the error boundary. Also set by `styre run` and `styre setup` when a launch is still running at a normal exit (ENG-485: Styre stops and names it), but only when the exit status was otherwise `0`. | No — this is a bug; please report it. |
| `75` | paused (`EX_TEMPFAIL`) | **Any** paused run (`exitCodeForOutcome`) — reason `budget`, `needs_you` (including a PR the forge did not deliver — a resume retries the request; one made for an older commit is replaced when the PR step runs again at the new head — and an agent dispatch whose confinement could not be confirmed, ENG-476, whose cause the run summary's timeline shows), or `interrupted` (reserved: a stop signal does not pause a run, it ends it with the signal's own status, `129` to `143`). The checkpoint (SoT + transcript) is already on disk and **no retry attempt is consumed**. Also returned by `styre clean <ident>` when that ident is currently a live run — `clean` refuses rather than reaping. | Paused: yes — `styre run --resume <ident> --profile <p>`. `clean` on a live run: not as-is — wait for the run to finish or pause, then clean. |
| `129`, `130`, `131`, `143` | ended by a stop signal | `styre run` or `styre setup` stopped the agent and its commands on SIGHUP, SIGINT, SIGQUIT or SIGTERM and ended itself by the same signal ([Exit statuses on a signal](#exit-statuses-on-a-signal)). For `run`, the interruption is recorded and costs no attempt. Never `75`. | Yes — `styre run --resume <ident>`. |
| `78` | config (`EX_CONFIG`) | A bad config/profile value, an unknown adapter, an unresolved profile (`configError` → `EXIT.CONFIG`), or — at `run` start — a forge with neither the profile's `defaultBranch` nor its own default branch to open a PR against. Also raised when `agent.provider` is `codex`, which Styre cannot yet confine (ENG-476; lifted by ENG-484). | No — fix the value, or re-run `styre setup`. |

**How to read them as a caller:**

- **`0`** — done; for `run`, go merge the PR.
- **`75`** — any paused run, whatever the reason (`budget` / `needs_you` / `interrupted`): back off and re-run the *same* ticket with `--resume`; a fleet scheduler should retry, not mark it failed. The same code is also returned by `styre clean <ident>` when that ident is a live run — `clean` refused rather than reaping, so wait for the run to finish (or pause), then clean.
- **`65`** — either the world moved under a paused run (branch HEAD advanced) or a concurrent `--resume` already holds this checkpoint; a human (or a policy) decides whether to accept the new HEAD (`--accept-head`), retry once the other resume finishes, or investigate (`--inspect`).
- **`69`** — an environment/provisioning gap on this machine, not a problem with the ticket; fix the host toolchain and re-run.
- **`1`** — reserved for `abandoned`. Not currently emitted by any run — cleaning a run's disk state (`styre clean`) is not the same as abandoning the ticket.
- **`64` / `78`** — a misuse or a bad config value: the invocation or the config needs fixing, not a retry.
- **`70`** — an internal error: a bug in Styre, not in the ticket or the host. Worth reporting.
- **`129` / `130` / `131` / `143`** — a stop signal ended the run (terminal, operator or CI); resume it with `--resume`.

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
| `OPENAI_API_KEY` | `codex` provider | Required when the provider is `codex` — which is currently refused (exit `78`) until Styre can confine it (ENG-484). |
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
