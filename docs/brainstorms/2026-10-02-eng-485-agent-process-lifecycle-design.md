# ENG-485 — Agent process lifecycle: stop, interrupt and recover whole process trees

**Date:** 2026-10-02
**Status:** Design (revision 7). The operator approved it section by section.

| Review round | Verdict | Findings | Answered in |
|---|---|---|---|
| 1 | revise | 1 critical, 11 major | revision 2 |
| 2 | revise | 1 critical, 5 major, 6 minor | revision 3, which simplifies the interruption handling at the operator's direction (D15) |
| 3 | revise | 3 major, 6 minor | revision 4 |
| 4 | revise | 1 major, 4 minor | revision 5 |
| 5 | revise | 1 major, 4 minor | revision 6 |
| 6 | **ship** | 3 minor notes | revision 7 (two notes applied; the third is an existing defect outside ENG-485, filed separately) |

Every finding is answered in §15–§19. Next: confirmation of revision 7's two small edits, then
operator review of this written spec, then the implementation plan.

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

### 2.6 Found by review round 2 (macOS, Bun 1.4.2)

- **A process group is shared with whatever started Styre** when that caller has no job control.
  `bash outer.sh` starting a Bun parent that starts a child put all three in one group. So a group
  can contain processes that are not the agent's.
- **`runCommand` can hang with no limit today.** `runCommand("sleep 6 & echo hi", {timeoutMs: 2000})`
  returned after 6.0 s with `timedOut=false`. Reading the output after `sh` exits
  (`src/util/run-command.ts:47-50`) is outside the timeout race, and a background child holds the
  pipe.
- **`proc_pidinfo(PROC_PIDTBSDINFO)` through `bun:ffi` works:**
  - it returns pid, ppid, pgid and a microsecond start time, under `bun` and in a compiled binary;
  - but it returns 0 for processes owned by root or another user, which is the same result as for a
    missing pid.
- **The event table only accepts six kinds:** `CHECK (kind IN ('transition','loopback','escalated','resumed','note','parked'))`
  (`src/db/schema.sql:284-285`). `migrate()` returns early for an existing database
  (`src/db/migrate.ts:30-33`), so a new kind could never reach a checkpoint created earlier.
- **`styre setup` calls `launchAgent` directly** (`src/setup/discover.ts:55`). When discovery fails it
  falls back (`:64-68`) and carries on to write `profile.json` (`src/cli/setup.ts:268`).
- **The analytics shutdown can take up to 2 s** (`FLUSH_TIMEOUT_MS`,
  `src/telemetry/analytics/client.ts:8`).
- **`undoAttempt` needs only the list of files that were untracked before the dispatch**
  (`src/dispatch/worktree.ts:376-382`).

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
| D7 | Two ways to stop. Agents by their parent links, plus the groups their own descendants lead (§6.1). Every command launch (suites, probes, acceptance checks, provisioning) by its own group (§6.2). |
| D8 | Grace period: 5 s, then a forced stop. |
| D9 | Ctrl-Z is not handled. Its behaviour is documented instead (§7.6). |
| D10 | Styre speaks as soon as a stop signal arrives, then reports the outcome (§7.3). |
| D11 | Linux coverage includes physical and virtual machines, not only containers: GitHub's Ubuntu VMs, the operator's physical laptop, and a container. Real terminals are used for the keystroke tests (§11). |
| D12 | An interruption is free (after review round 1). The attempt is not counted, the dispatch is closed as interrupted with what is known of its cost, and the agent's partial edits are undone. Same principle as a budget pause (ENG-164). |
| D13 | Ctrl-\ is a named exception (after review round 1). Styre stops what is still linked, then reports the orphaned command with how to stop it. The ticket's acceptance criterion is amended to name it. A Linux subreaper that would close the gap on Linux goes to a follow-up ticket. |
| D14 | GitHub Actions (after review round 1). Docs show `exec styre run …`, so Styre is the process GitHub signals. The spec and docs state what happens without `exec`. A test runs through a real GitHub bash step, with and without `exec`. |
| D15 | The signal handler owns the interruption entirely, with no handoff to the run code (after review round 2; operator chose the simplification). While a stop is in progress the journal records nothing. The handler writes the interruption into the run database in one synchronous transaction, then exits. `--resume` undoes the partial edits from what the handler saved. A step that happened to finish during those few seconds is redone on resume, a documented cost (§7.5). |

## 5. The launch record (D5)

### 5.1 One door

A new module under `src/util/` (exact layout in the plan) is the only code allowed to start a
process.

**`launch(...)`: a long-running launch.**
- Used by the agent adapters, `runCommand`, `runBoundedCommand`, and anything else that runs while
  Styre goes on doing other work.
- It returns a handle with the process, its record, and `stop(how)`.
- When the door is closed (§7.3), `launch` starts nothing and throws `RunInterrupted`.
- **The one exception is diagnostics.** The signal handler and the sweep may make diagnostic launches
  (the `lsof` of §9.3) through a separate `launchDiagnostic(...)` that works while the door is
  closed. It always has a timeout and is never recorded on disk. Run code cannot call it; the source
  guard limits its callers to the handler and the sweep.

**`runBlocking(...)`: a blocking call.**
- Used by today's `Bun.spawnSync` sites (`git`, `command -v`, version probes).
- When the door is closed, it starts nothing and throws `RunInterrupted`, like `launch` (§7.3 step 1).
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
  - **macOS:** the microsecond start time from the kernel's process table, read with
    `sysctl(KERN_PROC)` through `bun:ffi`. Unlike `proc_pidinfo`, this sees processes owned by other
    users, so a descendant running under `sudo` is never mistaken for "gone" (§2.6).
    - The plan's first task proves it works in a compiled binary on both arm64 and x86_64. Review
      round 3 confirmed the struct offsets on arm64 only.
    - A missing pid returns success with a length of 0, not an error, so "gone" is judged on the
      returned length (review round 3, R9).
    - The fallback is `ps -o lstart=` run under `LC_ALL=C TZ=UTC`, at whole second resolution.
  - **On both platforms,** "no such process" is told apart from "not allowed to look". A process
    Styre may not inspect is reported as such, never counted as gone.
- **`kind`:**
  - `agent`, stopped as in §6.1;
  - `group`, for every command launch, stopped as in §6.2. This covers `runBoundedCommand`, and also
    `runCommand`, which now gives each command a group of its own (§6.2).
- **`ticket`, `step` and `worktree`** (for §9), and a short description of the command.
- **`owner`:** the launching Styre's pid, start time, and process group. The group is never expanded
  when stopping (§6.1).
- **For agent dispatches, `untrackedBefore`:** the files that were untracked before the dispatch. It
  is held in memory only, and the handler saves it with the interruption (§7.3), so `--resume` can
  undo the agent's edits.

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

- **Styre stops writing pids into the journal.** `runStep` no longer journals Styre's own pid, and
  the dispatch paths no longer journal agent or group pids. The `workflow_step.pid` column stays, and
  new code always leaves it null.
- **`recover()` no longer kills anything.** The sweep (§8) does the stopping, from the launch record.
- **The negative pid convention is retired.** The record's `kind` says how to stop a launch.
- **Older checkpoints.** A `running` step with a non-null pid can only come from a Styre version
  before this change.
  - If that pid is alive, `recover()`, `--fresh` and `clean` print a warning that names it and says
    its identity cannot be confirmed. They stop nothing.
  - Checkpoints written by the new code never produce this warning (review round 2, N12).

## 6. Stopping a launch (D7, D8)

One function stops every launch: `stop(record, how)`, where `how` is `graceful` or `forced`.

**Whether a process is gone** is always read from the process table, including its state field.
A zombie counts as gone. The return value of `kill(pid, 0)` is never used: on macOS it succeeds on a
zombie (§2.5).

### 6.1 Agents: parent links and groups

The agent stays in Styre's terminal group (D4). Claude Code puts each tool command in a group of its
own, and those commands are the agent's children while the agent lives.

1. **List.** Read the process table once (§5.2's source). Collect:
   - every descendant of the recorded process;
   - every member of a group **led by** a collected descendant, meaning the group's ID equals that
     descendant's pid. The leader may have exited since; the group still counts.

   Keep each one by pid and start time.

   **Which groups are taken in.** Claude Code's command groups are led by the agent's own children,
   so they are taken in. Group membership survives the death of a parent, so a command whose agent
   has died is still found through its group, provided the agent was alive at an earlier listing.

   **A known limit** (review round 3, R8). A command group whose leader has already exited before
   the handler's first listing is not taken in, because nothing then links it to the agent. Its
   members are usually stopped by Claude Code itself on SIGTERM (§2.2). Otherwise §9's check reports
   them. The live tests confirm that Claude Code's command groups are led by its direct children, and
   record the CLI version they ran against.

   **Which groups are never taken in** (review round 2, N1):
   - The group the agent itself belongs to: Styre's, or whatever Styre inherited from a script that
     started it.
   - The owner's recorded group.
   - Any group not led by a collected descendant. An agent command that joins another group (for
     example your shell's) cannot make Styre stop that group: its leader is not the agent's
     descendant.
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

**When a command's leader exits normally,** the order is fixed (review round 2, N6):
1. Check the group.
2. If anything is left, stop it, unless the launch is provisioning (below).
3. Only then read the rest of the output, for at most 5 s, the same limit ENG-476 gave the agent
   adapter. Output still unread at the limit is dropped with a note.

This fixes today's hang, where a background child holding the output pipe kept `runCommand` waiting
with no limit (§2.6). It also stops a server that a test left behind; in `runBoundedCommand` today, a
leftover like that turns a suite that passed into a timeout.

**No exceptions, including provisioning** (review round 3, R2, which removed an exception revision 3
had added):
- Provisioning runs the profile's `prepare` commands (`src/dispatch/handlers.ts:1394,1472,1480`), such
  as `npm ci` and `pip install -e .`. None of these is meant to leave a process behind.
- A service that daemonizes itself leaves the group and survives. One that stays in the group is a
  leftover like any other, and is stopped.

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
| Command finishes normally | the group is checked: if empty, nothing more; if not, stopped, then output read for at most 5 s |
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

### 7.3 What happens on a signal (D15)

The handler owns the whole interruption: stopping, recording and exiting. The run code is never
asked to settle, and nothing is handed back and forth. Everything below runs against one deadline:
6.5 s after the first signal (§7.4).

1. **Close the door.** Mark it `stopping`. From this moment the run code can neither write to the
   run database, nor start a process, nor run `git` (review round 3, R3). It does not cover every
   effect: see the outbox and file writes below. Two choke points enforce this:
   - **The door refuses every launch and every blocking call** with `RunInterrupted`. That covers
     the run code's `git` commands, such as a worktree reset. Two kinds of call still work:
     - the handler's and the sweep's diagnostic launches, including the macOS `ps` fallback of §5.2
       (review round 4, m4);
     - blocking calls marked as cleanup, which only release something the run had taken, such as
       `git worktree remove` for a baseline worktree (`src/dispatch/baseline-rerun.ts:96-99,170-176`).
       Without this, refusing that call would leave a `styre-baseline-*` worktree registered in the
       target repo (review round 4, m3). The source guard lists the permitted cleanup calls.
   - **The run's database connection becomes read only** (`PRAGMA query_only = ON`). Every write the
     run code attempts, transactions included, fails with "attempt to write a readonly database".
     The handler writes through a second connection of its own (step 6). Both behaviours were checked
     in Bun on 2026-10-02.

     A signal handler cannot run while a synchronous `db.transaction` is in progress (review round 3,
     `txsig.ts`), and every transaction in `src/` is synchronous. So the switch never lands halfway
     through a write.
   - **The outbox drain checks the door before each row** (review round 4, m2). It sends Slack
     posts, tracker comments and PR updates (`src/daemon/projector.ts:160-205`). Without the check
     it would keep sending during the stop and could not record the delivery, so the row would be sent
     again on resume, and Slack posts have no idempotency key.

     **The remaining limit:** a request already in flight when the stop begins can still complete.
     Its delivery cannot be recorded, so it is sent again on resume. For Slack, that is at most one
     duplicate post per interruption (review round 5).
   - **Not covered: plain file writes by run code,** such as clearing the agent's scratch folder.
     These touch only Styre's own working files, and resume rebuilds or resets them.
2. **Send the stop signals, before writing anything.** For every launch in the set held in memory,
   start its graceful stop (§6). The signals go out synchronously, before any output, because a
   write after hangup used to end Styre (§2.5).
3. **Speak,** on stderr (`styre run`'s stdout carries NDJSON telemetry only):
   ```
   styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…
   ```
   For a signal other than SIGINT, it opens with the reason instead:
   `styre: received a stop request (SIGTERM) — cleaning up…`.
4. **Wait for the stops to finish.** Each stop finishes as soon as its processes are gone, so the
   usual wait is about the 1 s Claude Code takes. The grace period is cut short if needed to leave
   1.5 s of the deadline for the steps below.
5. **Look for leftovers (§9)** for each agent launch that was stopped. On macOS this uses a diagnostic
   `lsof` with a timeout of whatever remains before the deadline minus 1 s. If there is not enough
   time, the check is skipped and the skip is reported. This is how Ctrl-\'s orphaned command gets
   reported (D13).
6. **Record the interruption: `styre run` only, in one synchronous transaction, through the
   handler's own connection.** Run code cannot interleave with it, because bun:sqlite transactions
   are synchronous.

   It acts on **the step in flight**, which `runStep` registers with the door in memory when it
   starts executing and clears when it finishes. It does not act on every step left `running`: a budget
   pause also leaves its step `running` and has already given its attempt back (review round 3, R5).
   If no step is in flight, nothing is written beyond the event. For the step in flight:
   - give back the attempt that `markRunning` counted (`decrementAttempt`), as a budget pause does;
   - append an event of the existing kind `note`, with reason `interrupted`. No schema change is
     needed (§2.6). The payload holds:
     - the step's ID and its `started_at`;
     - its attempt number **after** the decrement, written in the same transaction, which is the value
       `recover()` will find on the step (review round 3, R6);
     - the signal and the worktree path;
     - for an agent dispatch, its `untrackedBefore` list and dispatch ID.
   - close the step's open dispatch row as `interrupted`, with `partial = 1` and whatever usage is
     known.

   The ticket stays `active`, which `styre ls` already shows as "interrupted mid-run". If the run
   database is not open yet, or is already closed, this step is skipped.
7. **Write the telemetry event** for the interruption to stdout. It is the `note` row from step 6,
   emitted as an ordinary `event` line in the existing telemetry schema (`src/telemetry/events.ts`),
   with no new event type (review round 3, R4). When the run resumes, the emitter emits that row
   again; the telemetry contract already allows repeats (`emitter.ts:247`). Then report the outcome on
   stderr:
   ```
   styre: stopped the agent (pid 1234) and 2 of its commands.
   styre: run interrupted; resume with: styre run --resume ENG-123
   ```
   For each survivor or leftover found:
   `styre: could not stop node server.js (pid 4321); stop it with: kill -9 4321`.
8. **Exit as Styre would have without a handler.**
   1. Shut analytics down, bounded by the time left before the deadline, or skip it if none is left.
   2. Release the run lock, as the last thing before the exit, so a `--resume` started meanwhile
      cannot overlap the dying run (review round 3, R7).
   3. Remove the handlers and send Styre the first signal it received again. Shells and CI then see
      "terminated by signal": 130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP, 131 for SIGQUIT.
   4. If Styre is still alive after that, it is a container's first process (§2.5). It then calls
      `process.exit(128 + n)`.

   This is deliberately not exit 75. Exit 75 means Styre paused the run itself.

**A second signal while stopping** prints `styre: forcing stop…` and switches every stop still in
progress to `forced`. The exit still uses the first signal received.

**When the terminal has closed** (SIGHUP), the stderr lines go nowhere, harmlessly, thanks to the
`error` listeners. The run database and telemetry are the durable record.

**`styre setup`** runs steps 1 to 5, 7 and 8; it has no run database. The interruption appears on
stderr only.

### 7.4 Time limit

One deadline, 6.5 s after the first signal, bounds the handler (review round 2, N10). Each step
shortens or skips itself to fit:

| Step | Budget |
|---|---|
| Graceful stops | up to 5 s, cut short to leave 1.5 s |
| Forced stop and confirmation | under 0.5 s |
| Leftover check | what is left, minus 1 s; otherwise skipped and reported |
| Recording and telemetry | synchronous, milliseconds |
| Analytics shutdown | what is left; otherwise skipped |

- **The usual case is 1 to 2 s.** The worst case is 6.5 s, inside GitHub's 7.5 s.
- **A signal during a blocking call** delays the handler by up to that call's timeout (§5.1), which
  the deadline cannot cover. The deadline starts when the handler starts.

### 7.5 The run code during a stop (D12, D15)

The handler's waits use `await`, so the run code keeps running in between until Styre exits. Rule:
**while the door is `stopping`, the run code can neither record nor change anything.** It is enforced
at the two choke points of §7.3 step 1: the door, and the read-only database connection. The points
below make the run code fail fast and cleanly rather than relying on those refusals alone.

- **Launch handles** stopped by the handler resolve with an `interrupted` marker. **`launchAgent`
  itself** turns that marker into `RunInterrupted`, so `styre run` and `styre setup` share the
  conversion (review round 2, N5). `runCommand` and `runBoundedCommand` do the same.
- **`runStep` checks the door** after `execute` returns or throws. If the door is `stopping`, it calls
  neither `markSucceeded` nor `markFailed`, and throws `RunInterrupted`. This covers call sites that
  turn any error into an ordinary result, such as:
  - `runAtBaseline` (`src/dispatch/baseline-rerun.ts:93`);
  - `deliveredTestEvidenceAtBaseline` (`:149`);
  - the Claude adapter's own catch (`claude.ts:323-327`).
- **`styre setup` checks the door before each write** it makes (`profile.json`, configuration), and
  throws `RunInterrupted` instead of writing. Setup has no database, so this check is its choke point
  for file writes.
- **The top of `styre run` and `styre setup`** treats any error raised while the door is `stopping`
  as an interruption, whatever its type, and does nothing. The handler owns the exit. A refused write
  raises SQLite's own "readonly database" error, not `RunInterrupted`. Without this rule, such an
  error from outside `runStep` (the notifier's `enqueue`, the outbox drain) would print "internal
  error — please report" and send a false `cli_error` analytics event (review round 4, m1).
- **The cost, accepted and documented** (review round 2, N11). A step whose work finished during the
  few seconds of a stop is not recorded, so it is redone on resume. That window is the same as a
  crash between the step's work and its journal write.

  For an agent dispatch, review round 3 checked that `run-dispatch.ts:226-372` contains no `await`.
  So the runner's commit (`:325`) and the dispatch row's completion (`:369`) happen together,
  synchronously, and a signal cannot fall between them.

**On `--resume`, `recover()` tells an interruption from a crash.** For each step left `running`, it
looks for a `note` event with reason `interrupted` whose payload matches the step's ID, attempt number
and `started_at` (review round 2, N3).
- **If it matches, it was an interruption.** The attempt was already given back. `recover()` resets
  the step to `pending` without marking it failed, including suite steps.
- **Returning the branch to where the step started** (review round 4, M1; narrowed by round 5, N1).
  A step can commit before it finishes. The checks step's author commits the authored tests inside
  `runAgentDispatch` (`handlers.ts:778`, through `run-dispatch.ts:325`), then runs them, and rolls the
  branch back if they are rejected (`handlers.ts:1049-1066`). A stop during that run blocks the
  rollback, because `git` is refused.
  - **What is recorded:**
    - When `runStep` starts the step in flight, it records the branch HEAD as **`headAtStart`**. If the
      branch does not exist yet (the first step in worktree mode creates it), there is no
      `headAtStart`, and the branch is never reset for that step (N3).
    - Every function that moves HEAD reports the new HEAD to the in-flight record: the runner's
      commit (`worktree.ts:74-84`, which already returns the sha), `resetWorktreeHard`
      (`worktree.ts:438`), and the reset in `run-dispatch.ts:354`.
    - **Deliberately not reporting:** `ensureWorktree`'s `checkout -B` (`worktree.ts:44`) and
      `worktree add -B` (`:51`, `:59`) also move the branch (review round 6). They are left
      unreported on purpose, because the failure is safe in both orders:
      - if one runs after the last report, the current HEAD no longer equals `headAtStop`, so
        `recover()` skips the reset;
      - if one runs before a commit, the commit's report replaces it.
    - There is no rebase, merge or cherry-pick in `src/`. Baseline and replay worktrees use
      `worktree add --detach`, which leaves the ticket branch alone.
    - The handler stores both `headAtStart` and the latest reported HEAD, **`headAtStop`**, in the
      note. Neither needs `git` at stop time.
  - **When `recover()` resets.** All four conditions must hold:
    - the interruption is matched;
    - `headAtStart` exists, and `headAtStop` differs from it;
    - the branch's current HEAD still equals `headAtStop`, so nobody but the step has moved it since;
    - `--accept-head` was not given (N1).

    Then it resets the branch to `headAtStart`. Otherwise it does not reset, and prints that the
    step's commits remain under the current HEAD.
  - **Marking the abandoned dispatches.** After a reset, `recover()` marks as `reverted` the dispatch
    rows with `step_id` equal to the step's ID and `started_at` at or after the note's `started_at`
    (N2), with `branchHeadSha` set to `headAtStart`. Those are the same values the checks step's own
    rollback writes. Filtering on `step_id` alone would also catch earlier attempts of the same step.
    This keeps resume's "HEAD moved" check correct.
  - **How it resets:**
    - In worktree mode, `git branch -f` on the branch, after the old worktree is removed and before
      the new one is created (`park.ts:363`, then `:414`).
    - If the branch is checked out in another worktree, for example the operator's main clone, `git`
      refuses. `recover()` reports that and does not reset, rather than failing the resume (N4).
    - In place, `git reset --hard` in the checkout, after the in-place undo below.
  - **Pushes are not affected.** No step in flight ever has its own commits pushed or queued:
    - pushes happen only in the outbox drain, after a step has succeeded;
    - `merge:push` and `merge:pr-ensure` contain no `await`, so they are never the step in flight
      across a signal (review round 5).

    The drain pushes with `--force-with-lease`, where the lease is the remote branch head read just
    before the push (`src/integrations/adapters/github.ts:105-115`, `worktree.ts:479`). So a redone
    branch replaces Styre's own remote branch, and a concurrent foreign push is still rejected.
- **Undoing the agent's edits depends on the mode** (review round 3, R1):
  - **Worktree mode:** nothing to undo. `resumeRun` removes the old worktree before `recover()` runs
    (`src/cli/park.ts:362-363`) and creates a fresh one from the branch, so the edits are already
    gone. Running `undoAttempt` there would throw, because `Bun.spawnSync` throws on a missing
    folder.
  - **In-place mode:** the checkout is the same folder, so `recover()` runs `undoAttempt` with the
    saved `untrackedBefore` list.
  - **If the recorded folder no longer exists,** the undo is skipped, and Styre says so.
  - **`--fresh` and `clean` in in-place mode** run the same undo before they discard the
    checkpoint. Otherwise the agent's new files would stay in the checkout, and the next run would
    count them as files that were already there.
- **Otherwise it was a crash or a `kill -9`,** and today's crash handling applies unchanged.

**A test interrupts at every launch site, and between launches,** then resumes. It asserts:
- the step is redone and the attempt count equals its value before the interrupted attempt;
- the dispatch row is closed as `interrupted`;
- in in-place mode, the checkout is back to its state before the dispatch, both after `--resume` and
  after `--fresh`;
- an interruption during the checks step's test run, after its commit, leaves the branch at the
  step's starting HEAD after resume, with that dispatch marked `reverted` (M1);
- the same interruption, followed by an operator commit and `--resume --accept-head`, keeps the
  operator's commit and resets nothing (N1);
- a branch checked out in another worktree makes `recover()` report and skip the reset (N4);
- an interruption during the outbox drain sends nothing further, and prints no "internal error"
  (m1, m2);
- a baseline worktree is removed even when the stop lands during its run (m3);
- worktree mode resumes without trying to undo anything;
- nothing at all was written to the run database by run code during the stop: no step status, no
  evidence row, no dispatch change, and no worktree reset (R3);
- setup wrote nothing.

### 7.6 Cases with known limits, documented

**Ctrl-\ (D13).** Claude Code dies at once without stopping its running command. Styre's handler
runs after the terminal has already delivered the signal to both of them.
- By then the command has been re-attached to the system, and Styre never listed it while the agent
  lived. So nothing links it to the agent, and it is **not** stopped (corrected after review round 2,
  N4).
- §7.3 step 5's leftover check reports it with how to stop it, using a diagnostic `lsof` launch that
  works while the door is closed.
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

On a normal exit, `styre run` and `styre setup` first wait for any leftover check still running in
the background (§9.1), up to that check's own 5 s timeout (review round 2, N7). A check that hits its
timeout is reported as skipped. It is not counted as a leak.

They then check that the set held in memory is empty.

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
   - A live owner removing its own record repeats until neither the record nor a claimed copy
     exists. That closes the race in which a sweep renames a claimed copy back after the owner has
     looked (review round 2, N9).
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

On macOS the check itself launches `lsof`:
- after a step, as an ordinary `group` launch through the door, with a 5 s timeout;
- from the handler or the sweep, as a diagnostic launch (§5.1).

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
- the source guard catches a direct spawn, ignores the string in `karma.ts`, and allows diagnostic
  launches only from the handler and the sweep.

**Added after review round 2:**
- **A script parent survives the sweep (N1).** Styre is started by a bash script without job control,
  then killed with `kill -9`. The sweep runs from another shell, and the script must survive.
- **Joining another group earns nothing (N1).** A stand-in agent command that joins another job's
  group does not get that group stopped.
- **No hang from a background child (N6).** `runCommand` with a background child that holds the pipe
  returns within its timeout plus the 5 s output limit.
- **Provisioning leftovers are stopped (R2).** A process a provisioning command leaves in its group
  is stopped after the command exits; one that daemonizes itself survives.
- **Another user's process is not "gone" (N8).** A descendant running as another user is reported as
  not inspectable, never as gone.
- **Ctrl-\ is reported on macOS (N4).** The orphaned command is reported through the diagnostic
  launch.
- **The deadline holds (N10).** With a slow stand-in `lsof` and a slow analytics flush, the handler
  still exits within 6.5 s.
- **Resume undoes the edits (D15).** An interrupted dispatch's edits are undone on `--resume`, and a
  crash (`kill -9`) instead takes today's crash path.
- **The warning for older checkpoints (N12)** appears only for a `running` step with a non-null pid.

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
  - the cost of recording `headAtStart`: one blocking `git rev-parse` per step. `runStep` lives in
    `src/engine` and does not know the repo or branch, so they are injected (review round 6);
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
| Design brainstorm independently reviewed, no open critical or major findings, operator approved | this document, plus its review records (§15–§19) |
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

## 16. Review round 2: findings and answers

| # | Severity | Finding | Answer |
|---|---|---|---|
| N1 | critical | Expanding groups could stop a script that started Styre, or any group an agent command joins | §6.1 takes in only groups led by a collected descendant; never the agent's own or the owner's group; §11.3 tests |
| N2 | major | When the 1 s settle bound expired, the interruption was treated as a crash | D15: the handler records the interruption itself, synchronously; no handoff (§7.3 step 6) |
| N3 | major | The `interrupted` event kind is not allowed by the schema; matching it to a step was unsound | §7.3 step 6 uses kind `note` with a payload; §7.5 matches step ID, attempt and `started_at` |
| N4 | major | On macOS, Ctrl-\'s orphan was neither stopped nor reported (the door was closed to `lsof`) | §5.1 diagnostic launches; §7.6 corrected; §11.3 |
| N5 | major | `styre setup` had no central check and could still write `profile.json` | §7.5: `launchAgent` converts the marker; setup checks the door before each write |
| N6 | major | `runCommand` hangs while a background child holds the pipe; the group check could not run | §6.2 fixed order (check, stop, then read output for at most 5 s); provisioning exception |
| N7 | minor | The 2 s exit wait was shorter than the 5 s `lsof` timeout | §7.7 waits for the check's own timeout; a timeout is reported as skipped |
| N8 | minor | `proc_pidinfo` cannot see other users' processes, so they looked "gone" | §5.2 uses `sysctl(KERN_PROC)` and tells "not allowed" apart from "gone" |
| N9 | minor | A record removed by its live owner could come back | §8: the owner repeats until neither name exists |
| N10 | minor | The handler's real worst case exceeded 7.5 s | §7.4 one 6.5 s deadline; each step shortens or skips |
| N11 | minor | The central check discards work that finished cleanly | D15: accepted and documented cost, equal to a crash at that point (§7.5) |
| N12 | minor | The warning for older checkpoints could fire for new checkpoints | §5.5: new code journals no pids; warn only on a non-null pid |

## 17. Review round 3: findings and answers

| # | Severity | Finding | Answer |
|---|---|---|---|
| R1 | major | `recover()` undid edits in a worktree resume had already deleted, so `--resume` would crash; in place, `--fresh` and `clean` left the edits | §7.5: undo only in place; skip with a message if the folder is gone; `--fresh` and `clean` undo first in place |
| R2 | major | The provisioning exception contradicted §5.3, §7.3 and §7.7, with no contract | §6.2: exception removed; provisioning is treated like every command |
| R3 | major | "Nothing is recorded while stopping" was enforced only for step status | §7.3 step 1: the door refuses blocking calls too, and the run's database connection becomes read only; the handler writes through its own connection |
| R4 | minor | The handler's NDJSON line had no defined shape | §7.3 step 7: the `note` row as an ordinary `event` line |
| R5 | minor | Decrementing every `running` step could give back a paused step's attempt twice | §7.3 step 6: only the step in flight, registered in memory by `runStep` |
| R6 | minor | Which attempt value the note stores was unstated | §7.3 step 6: the value after the decrement |
| R7 | minor | The run lock was released before the analytics shutdown | §7.3 step 8: the lock is released last |
| R8 | minor | A command group whose leader exited before the first listing is not taken in | §6.1: documented limit; the live tests confirm group leadership and record the CLI version |
| R9 | minor | `sysctl` details: a missing pid returns length 0; offsets verified on arm64 only | §5.2 |

## 18. Review round 4: findings and answers

| # | Severity | Finding | Answer |
|---|---|---|---|
| M1 | major | An interruption after the checks step's commit leaves unvalidated tests on the branch, because the rollback's `git` call is refused | §7.5: `runStep` records the step's starting HEAD; on a matched interruption `recover()` returns the branch there and marks later dispatches `reverted` |
| m1 | minor | A refused write outside `runStep` prints "internal error — please report" | §7.5: any error while `stopping` is an interruption |
| m2 | minor | The outbox drain keeps sending during the stop; the rule overstated its coverage | §7.3 step 1: the drain checks the door per row; the rule is reworded to the database, processes and `git` |
| m3 | minor | Refusing `git` breaks the baseline worktree cleanup | §7.3 step 1: cleanup calls are permitted, listed by the source guard |
| m4 | minor | The macOS `ps` fallback would be refused during a stop | §7.3 step 1: it goes through the diagnostic path |

## 19. Review round 5: findings and answers

| # | Severity | Finding | Answer |
|---|---|---|---|
| N1 | major | After `--accept-head`, the reset would discard the operator's accepted commits | §7.5: reset only if the current HEAD still equals `headAtStop` and `--accept-head` was not given |
| N2 | minor | No defined query for "the step's dispatches made since" | §7.5: `step_id` and `started_at` at or after the note's `started_at` |
| N3 | minor | No starting HEAD when the step creates the branch | §7.5: no `headAtStart`, so no reset |
| N4 | minor | `git branch -f` refuses a branch checked out elsewhere | §7.5: report and skip |
| N5 | minor | `handlers.ts:702` records the HEAD; it does not commit | §7.5 citation corrected (`:778` through `run-dispatch.ts:325`) |
| m2 note | minor | One in-flight outbox request can still complete | §7.3 step 1: at most one duplicate Slack post, stated |

## Amendment 2026-10-08: no core dump on Ctrl-\

**Operator decision.** Before Styre's stop handler re-raises SIGQUIT (Ctrl-\, §7.3 step 8), it
makes sure no core dump is written. Found in Task 15b: the re-raised SIGQUIT's default action
dumps core, and a Bun core was about 6 GB. Ubuntu's apport stored it root-owned in
/var/lib/apport/coredump.

**Mechanism.** Both calls run just before the SIGQUIT re-raise, and for no other signal; the other
stop signals dump nothing.
- **The core limit is set to 0** (`setrlimit(RLIMIT_CORE, {0, 0})`). macOS writes a core to /cores
  only within this limit (core(5) on macOS). Linux applies it when core_pattern names a file.
- **On Linux, the process is also marked not dumpable** (`prctl(PR_SET_DUMPABLE, 0)`).
  - When core_pattern pipes to a program (Ubuntu's apport, systemd-coredump), the kernel ignores the
    core limit (core(5): "The RLIMIT_CORE limit is not enforced for core dumps that are piped to a
    program"). It starts no dump for a process that is not dumpable: fs/coredump.c skips such a
    process before any pipe handling.
  - On the test laptop a tiny process proved both points. With the limit at 0 the kernel still piped
    the core to apport (the wait status's WCOREDUMP bit was set). Not dumpable, nothing was dumped
    at all.
  - Its side effects (/proc entries owned by root, no ptrace attach) cannot matter at that moment:
    nothing reads them before the exit.
- **Calls:** through bun:ffi (libc.so.6, /usr/lib/libSystem.B.dylib).
- **A failure is said** (`styre: could not turn off core dumps before exiting: <why>`) and the
  re-raise still happens.

**D13 is unchanged.** Ctrl-\ still ends Styre by SIGQUIT, exit status 131, and the orphaned
command is still reported, not stopped. On macOS the system's crash report (a .ips file from
ReportCrash) is not a core and is not affected.

**Addition, same day: setup's prompts.** Operator decision. While `styre setup` waits at a prompt
with its stop handlers suspended (§7.1, finding 3), Ctrl-\ takes SIGQUIT's default action. Core
dumps are therefore also off for each such prompt: its missing command prompts and its approval
prompt, all through `suspendStopHandlers`.
- **Off for the prompt.** The state is read first, then turned off.
  - Only the soft core limit is lowered, to 0: a process that is not privileged can never raise its
    hard limit again (getrlimit(2); macOS setrlimit(2)).
  - On Linux the process is also marked not dumpable.
- **Restored afterwards,** in a `finally`, whether the prompt answers, throws or meets the end of
  input:
  - the exact soft limit;
  - on Linux, the dumpable flag. Setting it back to 1 returns the /proc/<pid> files to the user
    (proc_pid(5)).
- **Failures are said in one line,** for turning off or for restoring, and setup goes on.
- **Exit statuses unchanged.** Ctrl-\ at the prompt still ends setup by SIGQUIT (131); Ctrl-C still
  ends it by SIGINT (130).

## Amendment 2026-10-08: Claude Code's nested command group on Linux (R8)

**Found by the live smoke (Task 16) and its review.** On Linux with bash, claude 2.1.294 runs each
Bash tool command through a shell snapshot that it writes itself, and that snapshot turns job
control on (`set -o monitor`; it also carries `set -o onecmd`, which no rc file on the test laptop
sets). So the command is nested one group deeper than §6.1 and §2.2 describe:
- the tool shell (`bash -c 'source <snapshot> … eval <command>'`) is the agent's direct child and
  leads a group of its own, as §6.1 says, so R8 still holds;
- with job control on, that shell starts the command itself (here `sh test.sh`) in a further group,
  led by the command.

The Mac's zsh snapshot has no such line; there the command stays in the tool shell's group.

**It widens §6.1's known limit (R8).** While the agent lives, a stop still collects the command:
it is a descendant, and its group is led by a collected descendant. But a background child that the
command leaves behind after the command itself has exited now sits in the command's own group, whose
leader is gone, and no collected process leads that group. Without the nesting it would have sat in
the tool shell's group. Only §9's check reports such a process. The window is small, but the limit
now covers this group as well.

**What the smoke's R8 check verifies now** (`r8Check` in `scripts/lifecycle-live.ts`). It walks the
parent chain from the test's process up to the agent and requires that:
- the agent's direct child on the chain leads a group of its own (R8 itself);
- every process on the chain sits in a group led by a process on that chain, which is what a stop
  collects.

It reports whether the test ran in the tool shell's group or in a nested group below it.

**Also seen (Linux, claude 2.1.294):** on Ctrl-\ the agent did not die at once as §2.2 says. Styre's
handler still found and stopped the agent and two commands, so nothing was orphaned and D13's report
was not needed there. On macOS (the same version, zsh) the agent died at once, and the leftover line
of D13 appeared as specified.

## Correction 2026-10-08: the claimed record name, and the latency criterion

**The claimed record name keeps `.json`.** §8 and the plan's constraints write a claimed record as
`<pid>-<startedAt>.claimed-<claimerPid>-<claimerStartedAt>`. The code
(`src/util/process/records.ts`, `CLAIMED` and `claim()`) renames `<pid>-<startedAt>.json` to
`<pid>-<startedAt>.json.claimed-<claimerPid>-<claimerStartedAt>`, and the code is what holds. The
maintained reference (`docs/architecture/conventions.md`) gives the names as the code writes them.
Nothing else changes: the sweep still acts only on regular files whose names match one of the two
patterns exactly.

**Latency (§11.4, §14).** Measured with `scripts/measure-lifecycle-latency.ts` on macOS arm64: a
normal dispatch with a stand-in agent costs about 0.8 to 1.1 ms more than before ENG-485 (about
42.6 ms against 41.7 ms), after `stopTree` was changed to read the process table once when nothing
is left. What remains is the launch record (written and removed), the one table read that confirms
nothing the agent started is still running, and git calls going through the door. The operator
accepted this cost on 2026-10-08, and ENG-485's latency acceptance criterion was amended to match.

**Correction to the correction above, 2026-10-08 (Task 17 review, I1).** The latency paragraph
above says the remaining cost includes "the one table read that confirms nothing the agent started
is still running". That is false. `finish()` runs after the agent has exited and Bun has reaped it,
so the agent is no longer in the table, and every link of a stop's collection starts from the agent:
the read can find nothing the agent left running. The same was true before ENG-485; a probe through
the real `door.launch` and `finish()` gave identical results at cc3614e and at the fixed code, for a
reaped agent that left a tool group with a grandchild running and for one that left a child leading
its own group: nothing collected, nothing signalled, the processes still running. As §6.3 says, a
normal exit adds nothing; only the leftover check (§9) reports such processes, and only inside the
worktree.

Operator decision, same day: `stopTree` first probes the agent's own entry (pid and start time).
When the agent is gone, or its pid belongs to another program, it returns at once without reading
the table; the full read happens only while the agent is still there, alive or a zombie. Measured
again on macOS arm64 (5 runs of 5 rounds × 50 dispatches per side), the median dispatch difference
is within noise in every run (+1.00, +0.03, +0.23, +0.68 and +0.37 ms, on about 48 to 49 ms), so the
original criterion is met as written.

**The per step costs, which the paragraph above left out.** Outside the dispatch, each effectful step
pays one `git rev-parse` to record the branch head where it started (about 5 to 6 ms), and starting
the background leftover check delays the next step's start by about 0.7 to 0.9 ms (the check, about
80 to 90 ms with macOS `lsof`, runs beside the next step).
