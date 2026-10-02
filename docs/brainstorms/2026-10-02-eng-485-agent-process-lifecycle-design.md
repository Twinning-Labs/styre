# ENG-485 — Agent process lifecycle: stop, interrupt and recover whole process trees

**Date:** 2026-10-02
**Status:** Design (revision 2). The operator approved it section by section. Independent review
round 1 returned "revise" (1 critical, 11 major); this revision answers every finding (§15). Next:
review round 2, then operator review of this written spec, then the implementation plan.

**Ticket:** ENG-485 (parent ENG-483). Follows ENG-476 (PR #151, merged), which removed an earlier
process group attempt from its scope. That attempt is kept on local branch
`eng-485-process-group-attempt` (commit 38c2bf9) for reference only. This design does not reuse its
approach (§3, Approach 2).

---

## 1. Goal

Whenever an agent run ends, for whatever reason, everything the agent started stops, and nothing it
started is left running unnoticed in the worktree. The reasons a run ends:

- Styre ends it: the ENG-476 startup refusal, or a timeout.
- The operator ends it: Ctrl-C, Ctrl-\, a plain `kill`, or closing the terminal.
- CI ends it: GitHub Actions, GitLab, `docker stop`, Kubernetes, systemd.
- Styre itself dies without warning (`kill -9`, out of memory, a crash). Any later Styre command
  then cleans up.

The operator's framing: a customer who force quits Styre does not want agents left running in the
background, accumulating cost.

Constraints the operator set:

- **No new processes.** No watchdog or helper process sits beside the agent (D2).
- **macOS and Linux are both first class.** Linux means physical and virtual machines, not only
  containers (D11).
- **A normal successful dispatch pays no added latency** (ticket acceptance criterion).

Two named exceptions, both decided by the operator after review round 1:

- **Ctrl-\.** Its orphaned command is reported, not stopped (D13).
- **GitHub Actions.** A graceful stop on cancel needs `exec styre run …` in the workflow step (D14).

## 2. Evidence

### 2.1 Live tests on today's code (2026-10-02; macOS, Claude Code 2.1.280, Bun 1.4.2)

A throwaway probe launched the real `claude` CLI exactly as `src/agent/providers/claude.ts` does, with
the agent running a slow test script through its Bash tool. Styre's stand-in ran in its own session,
as a terminal job does.

| How Styre was stopped | Styre | Agent | The agent's test command |
|---|---|---|---|
| SIGINT to the whole group (what the terminal does on Ctrl-C) | stopped | stopped | stopped, all within 3 s |
| Plain `kill` (SIGTERM to Styre alone) | stopped | **kept running** (adopted by launchd) | **kept running** |
| `kill -9` (SIGKILL to Styre alone) | stopped | **kept running** | **kept running** |

After the `kill -9`, the orphaned agent's own session log shows that it let the test finish, made
another model call (billed), and finished its task. Losing the pipe to Styre did not stop it.

A second probe asked the agent to start a command in the background (`run_in_background: true`) and
end its turn at once. The session log confirms that the background command started. When the CLI
exited normally, nothing was left running: Claude Code stopped its own background command.

`claude --help` (2.1.280) has no option to exit when its parent dies.

### 2.2 From ENG-476's reviews and live tests (recorded in ENG-485)

- **Claude Code's own commands:**
  - It runs each Bash tool command in a process group of its own.
  - It stops those groups, in about 1 s, when sent SIGTERM, SIGINT or SIGHUP.
  - It does not handle SIGQUIT: it dies at once and the command is orphaned.
  - A SIGKILL also orphans the command.
- **Wrapper scripts.** If `agent.command` is a wrapper script that runs the real CLI as a child,
  without `exec`, killing the direct child leaves the real agent running.
- **A group of its own** (Bun's `detached`, which calls `setsid`) cuts the agent off from the
  terminal's Ctrl-C, Ctrl-\ and Ctrl-Z, and from a CI system's group kill. It also forces Styre to
  forward signals.
- **A blocking wait inside a signal handler** stops Bun reaping an exited child. The zombie looks
  alive, so every graceful stop waited out the full grace period.

### 2.3 From the code (main at 9f51460)

**No handlers.** Styre installs no signal handlers: `process.on` appears nowhere in `src/`.

**Two command runners, with different process handling:**
- **`runBoundedCommand`** (`src/util/run-bounded-command.ts:15`) spawns `detached`, so its command
  leads a group of its own. It is used by suite observation (`src/dispatch/suite-observation.ts:96`)
  and review probes. The terminal's Ctrl-C never reaches these groups. The journal stores their pid
  as negative, meaning "this whole group" (`src/dispatch/handlers.ts:1751,2008,2032`,
  `src/dispatch/code-review.ts:153`).
- **`runCommand`** (`src/util/run-command.ts:30`) spawns in Styre's group. On a timeout it sends
  SIGKILL to `sh` alone (`:43`); its own comment admits that children can survive. It is used by
  acceptance checks (`src/dispatch/checks-run.ts:46,110`), full suites for components the change did
  not touch (`handlers.ts:1906`), and provisioning (`handlers.ts:1394`).

**Agent pids.** The agent's pid is journaled positive (`src/dispatch/run-dispatch.ts:174`). `runStep`
journals Styre's own pid for effectful steps (`src/engine/step-journal.ts:108`).

**Recovery:**
- Only `--resume` runs `recover()` against an existing checkpoint (`src/cli/park.ts:414`).
- `--fresh` (`src/cli/run.ts:308-331`) and `styre clean` discard the checkpoint without stopping an
  orphan.

**Timeout.** The Claude adapter sends SIGKILL to the CLI alone (`src/agent/providers/claude.ts:242`).

**About 50 places launch processes.**
- The long-running ones all go through four functions: the Claude adapter, the Codex adapter,
  `runCommand` and `runBoundedCommand`.
- The rest are about 25 blocking `Bun.spawnSync` calls, nearly all `git`, plus version probes.
- Some of the `git` calls touch the network without a timeout (`git push`, `git ls-remote`,
  `src/dispatch/worktree.ts:451,453`).

**How a budget pause is handled:**
- `runStep` leaves the step `running` on `ParkSignal` (`src/engine/step-journal.ts:132`).
- `advance()` undoes the attempt that `markRunning` counted (`src/daemon/advance.ts:197`).
- The dispatch path closes the dispatch row and undoes the agent's edits before throwing
  (`run-dispatch.ts:208-218`).

**Setup prompts.** `styre setup` asks questions through the blocking `globalThis.prompt`
(`src/cli/setup.ts:200,259`).

**The agent's environment.** `agentEnv` removes only the credential variables, so the agent and its
commands inherit GitHub's `RUNNER_TRACKING_ID`.

### 2.4 Research (high confidence unless noted)

**GitHub Actions:**
- Cancellation sends SIGINT, then SIGTERM 7.5 s later, then kills 2.5 s after that.
- All of it goes to the step's entry process, by pid only (`actions/runner`, `ProcessInvoker.cs`).
- A cleanup pass at the end of the job kills every process carrying the job's `RUNNER_TRACKING_ID`.
  Review round 1 reports that this pass runs on Linux runners only. That is not independently
  verified here, and §11.3 checks it on GitHub's Ubuntu runners.

**Other CI systems:**
- **GitLab** (shell executor) sends SIGTERM to the job's process group, then SIGKILL after a grace
  period.
- **`docker stop`** sends SIGTERM to the container's first process, then SIGKILL after 10 s.
- **Kubernetes** and **systemd** (`KillMode=control-group`) signal every process in the container or
  unit, so they reach every process however it is grouped.

**Terminal job control.** Ctrl-C, Ctrl-\ and Ctrl-Z go only to the terminal's foreground process
group.

**Detecting a dead parent:**
- Linux has `PR_SET_PDEATHSIG` and subreapers. `Bun.spawn` exposes neither.
- macOS has no kernel mechanism a child can use without another process watching.
- Following a process across forks on macOS (`NOTE_TRACK`) has been unsupported since 10.5
  (`sys/event.h`, checked 2026-10-02).

**Process environments are hidden on macOS,** even from the same user. Tested 2026-10-02 with `ps -E`
and `sysctl KERN_PROCARGS2`. So the GitHub runner's trick of marking descendants with an inherited
variable works on Linux only.

**Finding processes by working folder** works on macOS. `lsof -a -d cwd` found a detached `nohup`
process in 0.2 s across 700 processes (tested 2026-10-02).

**Bun bug #30189** (open): SIGINT and SIGTERM handlers never run while stdin has a flowing data
listener.

### 2.5 Found by review round 1 (experiments in the review's scratch folder, macOS, Bun 1.4.2)

- **A child is reparented the moment its parent exits,** even while the parent is an unreaped zombie.
  So when a wrapper dies, the real CLI drops out of the wrapper's tree at once.
- **After the terminal closes, a single write to stdout or stderr makes Bun exit with status 1** on
  the next tick. With `error` listeners on both streams, Bun survives, and a re-raised SIGHUP exits
  129.
- **Re-raising a signal works.** After removing the listeners, `process.kill(process.pid, sig)` exits
  130, 143, 129 and 131, both under `bun` and as a compiled binary signed for local use.
- **In a container, the first process ignores signals left at their default action,** including ones
  it sends itself. So the re-raise does nothing there. This comes from the kernel source
  (`sig_task_ignored`); it was not run, because no docker daemon was available.
- **`ps -o lstart=` prints in the user's locale and timezone.** For example,
  `LC_ALL=fr_FR.UTF-8 ps -o lstart=` prints `ven.  2 oct. 16:49:38 2026`.
- **On macOS, checking a zombie can mislead.** `killpg(pgid, 0)` on a group holding only a zombie
  returns EPERM, not ESRCH. `kill(pid, 0)` succeeds on a zombie.
- **GitHub's signal never reaches Styre in a normal step.** In a `run:` step, bash is the entry
  process. SIGINT or SIGTERM sent to `bash -eo pipefail step.sh` never reached its Bun child, which
  had handlers installed. This was tested with macOS bash 3.2; Ubuntu's bash 5 is unverified.
- **A SIGINT handler breaks Ctrl-C at setup's prompt.** With the handler installed, `prompt()` blocks
  until Enter, then returns `null`, and setup code runs before the handler gets a turn. Without a
  handler, setup dies at once.
- **Measured costs:** `ps -o lstart` 1.4 ms, a full `ps -ax` 31 ms, `lsof` cwd 154 ms across 900
  processes.

## 3. Approaches considered

**Approach 1 (chosen, D4): the agent stays in Styre's terminal group.**
- The terminal's Ctrl-C, Ctrl-\ and Ctrl-Z reach Styre and the agent together, as they do today, so
  nothing needs forwarding.
- Styre adds handlers for the signals that reach it alone.
- When Styre itself stops an agent, it finds the agent's processes by parent links and by their
  groups (§6.1).

**Approach 2 (rejected): the agent in a group of its own.**
- One signal would reach everything that stays in the agent's group.
- But it cuts the agent off from the terminal and from CI's group kills, and needs forwarding for every
  terminal signal, including Ctrl-Z.
- This is ENG-476's reverted attempt, where three review rounds kept finding new edge cases.

**Rejected outright (D2): a watchdog process** that notices Styre's death and stops the agent.

## 4. Decision log

| # | Decision |
|---|---|
| D1 | Stops Styre can see coming stop the agent and everything still linked to it immediately: timeout, startup refusal, Ctrl-C, Ctrl-\, `kill`, closed terminal, CI cancel (with D13 and D14 as exceptions). |
| D2 | No new processes: no watchdog, no helper beside the agent. |
| D3 | After `kill -9`, which no program can react to, the next Styre command on the machine stops the orphan, whichever ticket and whichever command it is. |
| D4 | Approach 1: the agent stays in Styre's terminal group. |
| D5 | A launch record: one door for every process Styre starts. Each long-running launch is recorded in memory and on disk, with a start time used to confirm identity (§5). |
| D6 | Detached leftovers are reported, never stopped (§9). Matching by folder alone could hit the developer's own processes, especially in in-place mode. |
| D7 | Two ways to stop. Agents by their parent links and groups (§6.1). Every command launch, meaning suites, probes, acceptance checks and provisioning, by its own group (§6.2). |
| D8 | Grace period: 5 s, then a forced stop. |
| D9 | Ctrl-Z is not handled. Its behaviour is documented instead (§7.6). |
| D10 | Styre speaks as soon as a stop signal arrives, then reports the outcome (§7.3). |
| D11 | Linux coverage includes physical and virtual machines, not only containers: GitHub's Ubuntu VMs, the operator's physical laptop, and a container. Real terminals are used for the keystroke tests (§11). |
| D12 | An interruption is free (after review round 1). The attempt is not counted, the dispatch is closed as interrupted with what is known of its cost, and the agent's partial edits are undone. Same principle as a budget pause (ENG-164). |
| D13 | Ctrl-\ is a named exception (after review round 1). Styre stops what is still linked, then reports the orphaned command with how to stop it. The ticket's acceptance criterion is amended to name it. A Linux subreaper that would close the gap on Linux goes to a follow-up ticket. |
| D14 | GitHub Actions (after review round 1). Docs show `exec styre run …`, so Styre is the process GitHub signals. The spec and docs state what happens without `exec`. A test runs through a real GitHub bash step, with and without `exec`. |

## 5. The launch record (D5)

### 5.1 One door

A new module under `src/util/` (exact layout in the plan) is the only code allowed to start a
process.

**`launch(...)`: a long-running launch.**
- Used by the agent adapters, `runCommand`, `runBoundedCommand`, and anything else that runs while
  Styre goes on doing other work.
- It returns a handle with the process, its record, and `stop(how)`.
- When the door is closed (§7.3), `launch` starts nothing and throws `RunInterrupted`.

**`runBlocking(...)`: a blocking call.**
- Used by today's `Bun.spawnSync` sites (`git`, `command -v`, version probes).
- It takes a required timeout, so a signal arriving during a blocking call waits at most that long
  for the handler to run. The plan sets each call site's value; network `git` calls get one for the
  first time.
- These calls are not recorded on disk. Bun reports their pid only once they have finished.
- They stay in the terminal group, so Ctrl-C reaches them. Only a `kill -9` in the middle of one can
  leave it running, and it then ends by itself or at its timeout.

**A source guard** fails the build if any file outside the door imports `node:child_process` or calls
`Bun.spawn` or `Bun.spawnSync`. It parses imports and calls with the TypeScript compiler API, not a
regular expression, so the `child_process` text inside a generated string in
`src/testing/karma.ts:108` is not a false hit. Same pattern as ENG-476's `launchAgent` guard.

### 5.2 What a record holds

For each long-running launch:

- **`pid` and `startedAt`.** The start time comes from a source that does not depend on locale or
  timezone:
  - **Linux:** the start time field of `/proc/<pid>/stat` (clock ticks since boot), together with the
    boot ID from `/proc/sys/kernel/random/boot_id`, so a record from before a reboot is recognised.
  - **macOS:** microsecond start time from `proc_pidinfo(PROC_PIDTBSDINFO)` through `bun:ffi`, if the
    plan's first task shows that works in a compiled binary. Otherwise `ps -o lstart=` run under
    `LC_ALL=C TZ=UTC`, at whole second resolution.
- **`kind`:**
  - `agent`, stopped as in §6.1;
  - `group`, for every command launch, stopped as in §6.2. This covers `runBoundedCommand`, and also
    `runCommand`, which now gives each command a group of its own (§6.2).
- **`ticket`, `step` and `worktree`** (for §9), and a short description of the command.
- **`owner`:** the launching Styre's pid and start time.

### 5.3 Where it is kept

**In memory:** a live set inside the Styre process, used by the signal handlers (§7).

**On disk:** one small JSON file per live launch, in `$XDG_STATE_HOME/styre-processes/` (default
`~/.local/state/styre-processes/`), for the whole machine.

- **Why a sibling of `styre/`, not inside it.** Checkpoints live at `styre/<slug>/<ident>`, and a slug
  is any repository name (`src/config/slug.ts:31`). Any folder name inside `styre/` could collide
  with a repository of the same name, and `listCheckpoints` and `clean --all` treat every child folder
  as a slug.
- **Which files the sweep touches.** It acts only on regular files whose names match the record
  pattern exactly (§8). Anything else in the folder is ignored and never deleted.
- **Why not in the ticket's database:**
  - `styre setup` has no run database, and the sweep must see every ticket.
  - The record is state about processes on this machine, not ticket state. So the rule that SQLite is
    the single source of truth for tickets does not apply to it.
- **When it is written:** right after the launch returns its pid. It is written to a temporary file
  that is then renamed, so a reader never sees half a file.
  - The window between spawn and record is a few milliseconds. A `kill -9` landing inside it leaves
    an unrecorded orphan. That is a residual risk, stated in `SECURITY.md`.
- **When it is removed:** only after the process, or for a group launch the whole group, has been
  confirmed gone.

### 5.4 The identity check

Before Styre stops anything named in a record left by another Styre process, it confirms that the
process with that pid has the recorded `startedAt`. On Linux it also confirms that the boot ID is the
same.

- **A pid reused by an unrelated program** will not match. Styre then leaves that program alone,
  prints one line saying so, and deletes the stale record. A mismatch is never silent.
- **A group whose leader has exited** stands for the launch while any member remains. POSIX `fork()`
  does not hand out a pid that is still in use as a process group ID (confirmed by review round 1).

### 5.5 What the record replaces

- **`recover()` no longer kills from `workflow_step.pid`.** The column stays, for bookkeeping, and the
  sweep (§8) does the stopping from the launch record.
- **The negative pid convention is retired.** The record's `kind` says how to stop a launch.
- **Older checkpoints.** One written before this change has a journaled pid but no record.
  `recover()`, `--fresh` and `clean` warn whenever a `running` step's journaled pid is alive and no
  launch record names it. Its identity cannot be confirmed, so Styre does not stop it.
  - For checkpoints written after this change, the sweep has already stopped any orphan and the pid
    is gone, so no warning appears.

## 6. Stopping a launch (D7, D8)

One function stops every launch: `stop(record, how)`, where `how` is `graceful` or `forced`.

**Whether a process is gone** is always read from the process table, including its state field.
A zombie counts as gone. The return value of `kill(pid, 0)` is never used: on macOS it succeeds on a
zombie (§2.5).

### 6.1 Agents: parent links and groups

The agent stays in Styre's terminal group (D4). Claude Code puts each tool command in a group of its
own, and those commands are the agent's children while the agent lives.

1. **List.** Read the process table once: `ps -axo pid,ppid,pgid,stat,...` on macOS, `/proc` on Linux.
   Collect:
   - every descendant of the recorded process;
   - every member of each collected process's group, except Styre's own terminal group.

   Keep each one by pid and start time. Group membership survives the death of a parent, so a tool
   command whose agent has died is still found through its group.
2. **Ask politely.** Send SIGTERM to every process collected, all at once, not only the top one.
   Otherwise a wrapper script could die alone and leave the real CLI running without its stop signal.
3. **Wait, without blocking,** for up to 5 s. The wait polls with `await`, never a blocking sleep, so
   Bun can reap exited children.
4. **Stop by force.** List again, adding anything new to the collection; the collection only grows.
   Send SIGKILL to every collected process that is still alive with the same start time, whether or
   not it is still linked. This answers review finding 1: a real CLI that drops out of the tree when
   its wrapper dies is still in the collection.
5. **Confirm.** Check every collected process again. If any survives, `stop` reports a failure with
   its pid, command and reason, and never claims success.

**A `forced` stop** skips steps 2 and 3. It is used for the ENG-476 startup refusal and a second
Ctrl-C.

### 6.2 Command launches: a group of their own

Every command launch leads a group of its own (`detached`), as `runBoundedCommand` already does.

**What changes for `runCommand`.** It gains a group too (D7), and its timeout stops the whole group
instead of `sh` alone. Acceptance checks, full suites and provisioning then get the same handling as
suites.

**Why a group:** it holds together after the process that started it exits, so a server a test
started in the background is still reachable.

**Stopping a group:**
1. If the process table shows the group already empty, the stop is done. A command that finished
   normally pays nothing.
2. Otherwise, SIGTERM to the group, then a wait of up to 5 s that does not block.
3. SIGKILL to the group.
4. Confirm from the process table that the group is empty.

**A consequence of the group:** the terminal's Ctrl-C no longer reaches these commands directly. The
handlers in §7 stop them. A group of its own also has no controlling terminal. A command that opens
`/dev/tty` would fail, so the plan checks every `runCommand` caller for that.

### 6.3 Which trigger uses which stop

| Trigger | Stop |
|---|---|
| Agent timeout | graceful. Today it sends SIGKILL to the CLI alone, which orphans its running command. |
| Command timeout (`runCommand`, `runBoundedCommand`) | graceful, on the group. Today `runCommand` sends SIGKILL to `sh` alone. |
| ENG-476 startup refusal | forced, on everything collected. No tool has run yet, and a wrapper is now covered. |
| Ctrl-C, Ctrl-\, `kill`, closed terminal, CI cancel | graceful (§7); forced on a second signal |
| Agent exits normally | nothing extra. The record is removed, and §9's check runs off the critical path. |
| Command finishes normally | the group is checked; if it is empty, nothing more |
| Sweep of an orphan after `kill -9` | graceful, after the identity check (§8) |

### 6.4 Why 5 seconds

- Claude Code stopped its commands in about 1 s in ENG-476's tests.
- GitHub Actions allows 7.5 s after its first signal before escalating. §7.4 shows the whole handler
  fits.

## 7. Signals (D1, D9, D10, D12, D13, D14)

### 7.1 Where handlers are installed

- **`styre run` and `styre setup`** install handlers. They are the only commands that launch
  long-running processes.
- **`styre setup` removes its handlers while it waits at a prompt.** It launches nothing at that
  moment (the plan confirms this), and Ctrl-C at a prompt then ends setup at once, as it does today.
  It reinstalls them after the answer.
- **The other commands** (`ls`, `clean`, `migrate`, `notify`) install none; they only sweep (§8).
- **Both commands also install `error` listeners on stdout and stderr at startup,** so a write after
  the terminal has closed cannot kill Styre in the middle of a stop (§2.5).

### 7.2 Which signals

| Signal | Usual source |
|---|---|
| SIGINT | Ctrl-C; GitHub's first cancel signal (with D14's `exec`) |
| SIGTERM | `kill`; GitHub's second signal; GitLab; `docker stop`; Kubernetes; systemd |
| SIGHUP | the terminal closing |
| SIGQUIT | Ctrl-\ |

### 7.3 What happens on a signal

The handler owns stopping and exiting. The run code that was running owns the bookkeeping (§7.5).

1. **Close the door.** Mark the door `stopping`. `launch` now starts nothing and throws
   `RunInterrupted`.
2. **Send the stop signals, before writing anything.** For every launch in the set held in memory,
   start its graceful stop (§6). The signals go out synchronously, before any output. That matters
   because a write after hangup used to end Styre (§2.5).
3. **Speak,** on stderr (`styre run`'s stdout carries NDJSON telemetry only):
   ```
   styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…
   ```
   For a signal other than SIGINT, it opens with the reason instead:
   `styre: received a stop request (SIGTERM) — cleaning up…`.
4. **Wait for the stops to finish.** Each stop finishes as soon as its processes are gone, so the
   usual wait is about the 1 s Claude Code takes, not the full 5 s.
5. **Run the leftover check (§9)** for each agent launch that was stopped. That is how Ctrl-\'s
   orphaned command gets reported (D13).
6. **Wait for the run code to settle,** for up to 1 s (§7.5). This is when the dispatch is closed,
   the edits are undone, the attempt is given back, the run event is written and telemetry is flushed.
7. **Report the outcome:**
   ```
   styre: stopped the agent (pid 1234) and 2 of its commands.
   styre: run interrupted; resume with: styre run --resume ENG-123
   ```
   For each survivor, or each leftover found in step 5:
   `styre: could not stop node server.js (pid 4321); stop it with: kill -9 4321`.
8. **Exit as Styre would have without a handler.**
   1. Release the run lock and shut analytics down.
   2. Remove the handlers and send Styre the first signal it received again. Shells and CI then see
      "terminated by signal": 130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP, 131 for SIGQUIT.
   3. If Styre is still alive after that, it is a container's first process (§2.5). It then calls
      `process.exit(128 + n)` for the same status.

   This is deliberately not exit 75. Exit 75 means Styre paused the run itself. An interruption is
   reported the way any program stopped by a signal is.

**A second signal while stopping** prints `styre: forcing stop…` and switches every stop still in
progress to `forced`. The exit still uses the first signal received.

**When the terminal has closed** (SIGHUP), the stderr lines go nowhere, harmlessly, thanks to the
`error` listeners. The run event and telemetry are the durable record.

### 7.4 Time limit

The worst case is about 7 s:
- 5 s of grace;
- under 1 s for the forced stop and its confirmation;
- up to 1 s for the run code to settle.

The usual case is 1 to 2 s. Both fit inside GitHub's 7.5 s. If the run code has not settled after its
1 s, the handler exits anyway. The step then stays `running`, as after a crash, and the next
`--resume` handles it as an interruption.

### 7.5 The run code during a stop (D12)

The handler's waits use `await`, so Styre's run code keeps running in between. It must not mistake a
stopped launch for an ordinary failure, and it must not record any result while a stop is in
progress.

**Launch handles.** A handle stopped by the handler resolves with an `interrupted` marker, not an
ordinary result.

**The dispatch path** (`run-dispatch.ts`) turns that marker into `RunInterrupted`. It first does what
the budget pause path already does:
- closes the dispatch row, with outcome `interrupted`, `partial = 1`, and whatever usage is known
  (`src/db/schema.sql:253` already allows a null cost with `partial = 1`);
- undoes the agent's edits (`undoAttempt`), so resume starts the step cleanly, including in in-place
  mode.

**`runStep` enforces the rule centrally.** After `execute` returns or throws, it checks whether the
door is `stopping`. If it is, it records neither success nor failure, leaves the step `running`, and
throws `RunInterrupted`. This covers call sites that turn any error into an ordinary result, such as
`runAtBaseline` (`src/dispatch/baseline-rerun.ts:93`), `deliveredTestEvidenceAtBaseline` (`:149`) and
the Claude adapter's own catch (`claude.ts:323-327`). Review finding 2 showed these would otherwise
journal false success.

**`advance()`** handles `RunInterrupted` beside `ParkSignal`:
- it gives back the attempt (`decrementAttempt`), as it does for a park;
- it keeps the ticket `active`, which is what `styre ls` already shows as "interrupted mid-run"
  (`src/cli/checkpoints.ts:81`);
- it appends an `interrupted` event naming the signal, and rethrows.

**`recover()` on resume** does not count the interruption either. An interrupted suite step is reset
to `pending` without being marked failed, unlike a crash (`src/daemon/recover.ts:34`), because the
interrupted run left an `interrupted` event for that step.

**The top of `styre run` and `styre setup`** catches `RunInterrupted`, flushes telemetry, resolves the
"settled" promise the handler waits for in §7.3 step 6, and does nothing else. The handler owns the
exit. Setup has no run database, so for setup the event goes to stderr only.

**If the run database is already closed** when the signal arrives, the handler skips everything that
needs it.

**A test interrupts at every launch site** and then asserts:
- the step is still `running`;
- the attempt count equals its value before the interrupted attempt started;
- the dispatch row is closed as `interrupted`;
- the worktree is back to its state before the dispatch;
- no second launch happened.

### 7.6 Cases with known limits, documented

**Ctrl-\ (D13).** Claude Code dies at once without stopping its running command. Styre's handler
runs after the terminal has already delivered the signal to both of them.
- If the command's group still has members, §6.1's group collection finds it, and it is stopped.
- If the command has left its group too, it is reported by §7.3 step 5 with how to stop it.
- The acceptance criterion is amended to name this exception.

**Ctrl-Z (D9):**
- The terminal pauses Styre and the agent together, as today.
- Command launches and Claude Code's tool commands sit in groups of their own, so they keep running
  and simply finish.
- Timeouts count clock time, so a long pause can make a step time out right after `fg`. That takes
  the normal timeout path: stop, then retry.
- Handling Ctrl-Z properly would mean pausing and resuming every group and adjusting timers, which is
  where the reverted attempt kept finding edge cases. It is out of scope.

**GitHub Actions (D14):**
- **With `exec styre run …`,** Styre is the step's entry process. It receives GitHub's SIGINT and
  stops gracefully within GitHub's 7.5 s.
- **Without `exec`,** bash receives the signals and Styre does not. Styre and the agent keep working
  until GitHub's cleanup at the end of the job kills every process carrying `RUNNER_TRACKING_ID`.
  That reaches Styre, the agent and its commands, because `agentEnv` keeps that variable. But it is a
  kill, not a graceful stop: the run is not saved as interrupted, and the agent may bill for those
  last seconds. The docs state this next to the `exec` form.

**During a blocking call,** the handler runs when the call returns, at most after the call's own
timeout (§5.1).

**Bun bug #30189.** Handlers never run while stdin has a flowing data listener. Setup's prompts use
the blocking `prompt()`, which §7.1 handles. A test installs the handlers in each command and fails
if a signal is not handled, so a future reader of stdin is caught.

**Styre as a container's first process.** With handlers installed, `docker stop`'s SIGTERM is now
handled; today it is ignored until the 10 s SIGKILL. §7.3 step 8's fallback gives the right exit
status.

### 7.7 Normal exit

On a normal exit, `styre run` and `styre setup` first wait, for up to 2 s, for any leftover check
still running in the background (§9.1). Then they check that the set held in memory is empty.

A launch still recorded at that point is a bug. Styre stops it, prints what it stopped, and exits
non-zero, so a leak is never silent.

## 8. The sweep: cleaning up after `kill -9` (D3)

Every Styre command (`run`, `setup`, `ls`, `clean`, `migrate`, `notify`) sweeps
`$XDG_STATE_HOME/styre-processes/` before doing anything else.

**File names:**
- A record is named `<pid>-<startedAt>.json`.
- A claimed record is named `<pid>-<startedAt>.claimed-<claimerPid>-<claimerStartedAt>`.
- Nothing else is touched.

For each record:

1. **Claim it.** Rename it to its claimed name. If the rename fails, another command has claimed it;
   skip it.
   - A claimed record whose claimer is no longer alive (same pid and start time) is treated as
     unclaimed and claimed again. That way a sweep that was itself stopped midway cannot strand a
     record. This matters because `ls`, `clean`, `migrate` and `notify` have no handlers, and a Ctrl-C
     can land during their sweep.
2. **Is the owner alive?** Check the owner's pid and start time.
   - If the owning Styre is alive, the launch belongs to a live run. Rename the record back,
     unless the owner has removed it in the meantime, and leave it alone.
   - A live owner removing its own record also removes a claimed copy if one exists.
3. **If the owner is gone, the launch is an orphan.**
   - Run the identity check (§5.4).
   - If the process or group is still the recorded one, stop it gracefully (§6) and print to stderr:
     `styre: stopped an orphaned agent from ENG-123 (pid 1234), left running when Styre was force quit`.
   - Then run §9's leftover check on its worktree, for the window from its start until now. This runs
     whether the orphan was stopped just now or had already exited.
4. **Delete the record** once the stop is confirmed, or at once if the identity check failed. A record
   whose stop failed is kept, and the failure is printed, so the next command tries again.

**Where sweep lines go.** They always go to stderr, so `styre run`'s NDJSON stdout and the human
output that `ls` and `setup` print on stdout stay clean.

**What this means for each command:**
- **`--resume`:** the sweep stops the orphan, then `recover()` resets the interrupted step.
- **`--fresh` and `clean`:** the sweep runs before the checkpoint is discarded. This fixes the
  ticket's finding that both discarded it and left the orphan running.
- **`ls`:** sweeps like the others (operator's choice, D3), and lists what it stopped.

**Cost.** Normally the folder is empty, so the sweep is one directory read. This is measured
(§11.4).

## 9. The detached leftover check: reports, never stops (D6)

### 9.1 When it runs

- After every agent step, in the background, off the step's critical path.
- From the signal handler, after it stops each agent launch (§7.3 step 5).
- From the sweep, for every orphan (§8 step 3).

On macOS the check itself launches `lsof`, through the door, as a `group` launch with a 5 s timeout.

### 9.2 What counts as a leftover

A process that meets all three conditions:

1. its working folder is inside the step's worktree, or inside the checkout itself in in-place mode;
2. it started during the step's time window;
3. it is not part of any launch Styre is currently running, according to the set held in memory.

"Its parent is the system process" is deliberately not a condition. On Linux desktops orphans are
adopted by the user's session manager (`systemd --user`), not by process 1.

### 9.3 How the working folder is read

- **macOS:** `lsof -a -d cwd`, which ships with macOS.
- **Linux:** `/proc/<pid>/cwd`, with no process launched. Minimal containers often lack `lsof`.
- Either way, only the user's own processes are visible. The agent runs as that user.

### 9.4 What happens on a match

- A run event, which reaches telemetry, and a stderr line:
  `styre: the agent left "node server.js" (pid 4321) running in the worktree; stop it with: kill 4321 (if it is not yours)`.
- The step's result is unaffected.

### 9.5 Limits, documented

- **Start times.** If macOS falls back to `ps`, they have whole second resolution, so a process
  started within about a second of a window boundary can be missed or misattributed. That only
  affects a report line.
- **What it cannot see.** A leftover that moved out of the worktree, or runs as another user, is not
  found.
- **In in-place mode,** something the developer started in the checkout during the step is reported
  too. That false report is harmless, and it is why the check reports rather than stops.
- **Hardened Linux hosts.** Hosts that mount `/proc` with `hidepid` may hide processes even from the
  same user. The plan checks what the check sees there.

## 10. Providers

- The lifecycle does not depend on the provider: every launch goes through the door.
- Codex stays refused (ENG-484). Before ENG-484 lifts the refusal, it must verify live how Codex
  behaves when asked to stop, as §2.2 did for Claude Code.

## 11. Testing (D11)

### 11.1 Process tests, on every PR (CI)

These use a stand-in agent script that behaves like Claude Code in the ways that matter:
- it runs a command in a group of its own;
- on SIGTERM, SIGINT or SIGHUP it stops that command and exits;
- on SIGQUIT it dies at once.

Variants:
- launched through a wrapper script that does not `exec`;
- a real CLI that ignores SIGTERM, behind a wrapper that dies on it (review finding 1);
- one that detaches a command with `nohup`;
- a leader that exits without being reaped (the zombie case).

They use real processes and real signals, but make no model calls. They run:
- on GitHub's `ubuntu-latest` and `ubuntu-24.04-arm` runners, which are full virtual machines with
  systemd, not containers;
- on `macos-15`;
- in one container job, covering Styre as the container's first process.

### 11.2 Live tests with the real `claude` CLI

A manual script, like `scripts/smoke-isolation.ts`, repeats §2.1 with the new code. It runs on:
- macOS (the operator's machine);
- the operator's physical Linux laptop;
- a GitHub Ubuntu virtual machine, through a manually triggered workflow that uses the existing
  `ANTHROPIC_API_KEY` secret (already used by `release.yml`);
- a container.

### 11.3 The matrix, for both layers

**Triggers:**
- timeout, for the agent and for each command runner;
- startup refusal;
- Ctrl-C and Ctrl-\, typed into a real pseudo terminal on both platforms, not only sent as signals,
  so the terminal's own delivery is what gets tested;
- `kill`;
- terminal close, with a suite group running;
- a second Ctrl-C;
- SIGINT followed by SIGTERM;
- `kill -9`, followed by each of `run`, `--resume`, `--fresh`, `ls` and `clean`;
- Ctrl-C at a `styre setup` prompt.

**GitHub cancel, through a real `run:` step on GitHub's Ubuntu runners,** both with `exec styre run …`
and without it. This also settles bash 5's behaviour (§2.5).

**Targets:**
- a plain agent;
- an agent launched through a wrapper script;
- an agent with a running command in its own group;
- a suite with a background child;
- an acceptance check under `runCommand`.

**Pass means:**
- every target and its commands are gone within the grace period, except Ctrl-\'s orphaned command,
  which must instead be reported (D13);
- Styre exits with the expected status, 129 after terminal close;
- the run is still resumable, with the attempt not counted (D12);
- the expected messages appear.

**Also covered:**
- a reused pid is left untouched and reported;
- `ps` start times stay stable under a non-English locale and a different timezone;
- a record from before a reboot (Linux) is recognised as stale;
- an older checkpoint's journaled pid produces a warning and no stop;
- two commands sweeping at once stop an orphan exactly once;
- a sweep stopped midway leaves no stranded record;
- a detached `nohup` leftover is reported, not stopped;
- an interruption at every launch site leaves no false result in the journal (§7.5);
- each command's handlers fire (the Bun #30189 guard);
- the container fallback exit status;
- the source guard catches a direct spawn, and ignores the string in `karma.ts`.

**Recovery tests** drive real steps through `runStep` and the dispatch path, not rows inserted by hand
(ticket acceptance criterion).

### 11.4 Proof the tests can fail, and the latency measurement

- **Control run.** Before the new code is tested, the same matrix runs against main as a control. It
  must reproduce §2.1's leaks: `kill` and `kill -9` leave the agent running. If the control does not
  leak, the run reports that its probes are blind and does not report a pass. Same pattern as
  `scripts/smoke-isolation.ts`.
- **Deliberate breaks.** Each safeguard is broken on purpose once, and a test must catch it.
- **Latency:**
  - 50 normal dispatches with the stand-in agent, median before and after;
  - the sweep's cost with an empty folder;
  - the cost of the group check after a command finishes normally;
  - confirmation that §9's check does not lengthen a step.

## 12. Documentation, in the same PR

- **`SECURITY.md`:**
  - the wrapper gap is closed;
  - the limits are stated: `kill -9` (cleanup on the next command), the unrecorded window (§5.3),
    detached leftovers reported but not stopped, Ctrl-\ (D13), Ctrl-Z (D9), and GitHub without `exec`
    (D14).
- **`docs/architecture/control-loop.md`:** crash recovery (§6.1 there) moves to the sweep plus the
  reset, and an interruption is free.
- **`docs/architecture/runtime-parameters.md`:**
  - exit statuses on a signal;
  - the stop and sweep messages;
  - the `exec styre run …` form for GitHub Actions, with what happens without it.
- **`docs/architecture/conventions.md`:** the `styre-processes/` state folder.
- **`CLAUDE.md`:** the one door invariant.
- **`docs/architecture/brainstorm.md`:** a §11 changelog entry.
- **Linear:** ENG-485's acceptance criteria amended for D13 and D14, and a follow-up ticket filed for
  the Linux subreaper.

## 13. Out of scope

- Ctrl-Z handling (D9).
- The Linux subreaper (follow-up ticket, D13).
- Linux control groups.
- Windows.
- A ready-made GitHub Action for Styre.
- Confinement of the tool set (ENG-476, done).
- Codex confinement (ENG-484).

## 14. Acceptance criteria (from ENG-485), mapped

| Criterion | Where |
|---|---|
| Design brainstorm independently reviewed, no open critical or major findings, operator approved | this document, plus its review records |
| Each stop trigger and forwarded signal: the agent and a tool command in its own group gone within grace, expected exit status, shown live | §11.2, §11.3. Amended: for Ctrl-\, the orphaned command is reported, not stopped (D13). For GitHub, the graceful stop needs `exec` (D14). |
| An agent launched through a wrapper script stopped completely, live | §6.1, §11.3 |
| Recovery kills exactly what the record names; `--fresh` and `clean` stop an orphan first; tests through real steps | §5.4, §8, §11.3. The ticket's "a group for negative pids, one process for positive pids" is superseded by the record's `kind` (§5.5). |
| A normal successful dispatch pays no added latency, measured | §6.2, §6.3, §9.1, §11.4 |
| Independent review recorded before the PR opens | the review step after the plan |

## 15. Review round 1: findings and answers

| # | Severity | Finding | Answer |
|---|---|---|---|
| 1 | critical | Tree stop could report success while a wrapper's real CLI survives | §6.1: a collection that only grows, plus group members; §11.1 variant |
| 2 | major | Call sites that swallow every error could journal false success | §7.5: `runStep` checks `stopping` centrally; test at every launch site |
| 3 | major | Setup's prompt blocks a SIGINT handler | §7.1: handlers removed while prompting; §11.3 |
| 4 | major | A write after hangup kills Styre | §7.1 `error` listeners; §7.3 signals before writing; §11.3 asserts 129 |
| 5 | major | A container's first process ignores its re-raised signal | §7.3 step 8 fallback; §11.1 container job asserts the status |
| 6 | major | GitHub signals bash, not Styre | D14, §7.6, §11.3 real bash step |
| 7 | major | `ps -o lstart` depends on locale and timezone | §5.2 sources that ignore locale and timezone, plus the boot ID; §5.4 mismatch reported; §11.3 |
| 8 | major | A sweep that dies while holding a claim strands the record | §8 claim names carry the claimer; stale claims are retaken |
| 9 | major | An interruption's cost undecided; bookkeeping skipped | D12, §7.5 |
| 10 | major | Ctrl-\ coverage claimed but not delivered | D13, §7.3 step 5, §8 step 3, §14 amended |
| 11 | major | `runCommand` callers left to the plan; §2.3 misdescribed them | §2.3 corrected, D7, §6.2, §6.3 |
| 12 | major | Record folder could collide with a repo slug | §5.3 sibling folder, exact name pattern |
| 13 | minor | Event and database handling in setup; zombie group check; `lsof` at exit; old checkpoints; two signals; grace on normal completion; blocking call bound; private details in a public doc; regular expression guard | §7.5, §6, §7.7, §5.5, §7.3, §6.2, §5.1, §11.2, §5.1 |
