# ENG-485 — Agent process lifecycle: stop, interrupt and recover whole process trees

**Date:** 2026-10-02
**Status:** Design, approved section by section by the operator; awaiting independent review, then
operator review of this written spec, then the implementation plan.
**Ticket:** ENG-485 (parent ENG-483). Follows ENG-476 (PR #151, merged), which removed an earlier
process group attempt from its scope. That attempt is kept on local branch
`eng-485-process-group-attempt` (commit 38c2bf9) for reference only; this design does not reuse its
approach (§3, Approach 2).

---

## 1. Goal

Whenever an agent run ends, for whatever reason, everything the agent started stops, and nothing it
started is left running unnoticed in the worktree. The reasons a run ends:

- Styre ends it: the ENG-476 startup refusal, a timeout.
- The operator ends it: Ctrl-C, Ctrl-\, a plain `kill`, closing the terminal.
- CI ends it: GitHub Actions, GitLab, `docker stop`, Kubernetes, systemd.
- Styre itself dies without warning (`kill -9`, out of memory, a crash), followed later by any Styre
  command.

The operator's framing: a customer who kills by force Styre does not want agents left running in the
background, accumulating cost.

Constraints the operator set:

- **No new processes.** No watchdog or helper process sits beside the agent (decision D2).
- macOS and Linux are both first class, and Linux means physical machines and virtual machines, not
  only containers (D11).
- A normal successful dispatch pays no added latency (ticket acceptance criterion).

## 2. Evidence (gathered 2026-09-25 and 2026-10-02)

### 2.1 Live tests on today's code (macOS, Claude Code 2.1.280, Bun 1.4.2)

A throwaway probe launched the real `claude` CLI exactly as `src/agent/providers/claude.ts` does,
with the agent running a slow test script through its Bash tool. Styre's stand-in ran in its own
session, as a terminal job would.

| How Styre was stopped | Styre | Agent | The agent's test command |
|---|---|---|---|
| SIGINT to the whole group (what the terminal does on Ctrl-C) | stopped | stopped | stopped, all within 3 s |
| Plain `kill` (SIGTERM to Styre alone) | stopped | **kept running** (adopted by launchd) | **kept running** |
| `kill -9` (SIGKILL to Styre alone) | stopped | **kept running** | **kept running** |

After the `kill -9`, the orphaned agent's own session log shows that it let the test finish, made a
further model call (billed), and finished its task. Losing the pipe to Styre did not stop it.

A second probe asked the agent to start a command in the background (`run_in_background: true`) and
end its turn at once. The session log confirms the background command started. When the CLI exited
normally, nothing was left running: Claude Code stopped its own background command.

`claude --help` (2.1.280) has no option to exit when its parent dies.

### 2.2 From ENG-476's reviews and live tests (recorded in ENG-485)

- Claude Code runs each Bash tool command in a process group of its own, and stops those groups
  (in about 1 s) when sent SIGTERM, SIGINT or SIGHUP. It does not handle SIGQUIT: it dies at once and
  the command is orphaned. A SIGKILL also orphans the command.
- If `agent.command` is a wrapper script that runs the real CLI as a child, without `exec`, killing
  the direct child leaves the real agent running.
- Putting the agent in a process group of its own (Bun's `detached`, which calls `setsid`) cuts it
  off from the terminal's Ctrl-C, Ctrl-\ and Ctrl-Z and from a CI system's group kill. It also forces
  Styre to forward signals. Three review rounds found new edge cases in that forwarding each time.
- A blocking wait inside a signal handler stops Bun reaping an exited child. The zombie looks alive,
  so every graceful stop waited out the full grace period.

### 2.3 From the code (main at 9f51460)

- Styre installs no signal handlers (`process.on` appears nowhere in `src/`).
- Verify suites and review probes are spawned `detached`
  (`src/util/run-bounded-command.ts:15`), so the terminal's Ctrl-C never reaches them.
- The journal stores a negative pid for them, meaning "this whole group"
  (`src/dispatch/handlers.ts:1751,2008,2032`, `src/dispatch/code-review.ts:153`). The agent's pid is
  stored positive (`src/dispatch/run-dispatch.ts:174`). `runStep` stores Styre's own pid for effectful
  steps (`src/engine/step-journal.ts:108`).
- Only `--resume` runs `recover()` against an existing checkpoint (`src/cli/park.ts:414`). `--fresh`
  (`src/cli/run.ts:308-331`) and `styre clean` discard the checkpoint without stopping an orphan.
- On a timeout the Claude adapter sends SIGKILL to the CLI alone (`src/agent/providers/claude.ts:242`).
- About 50 places launch processes. The long-running ones all go through four functions: the Claude
  adapter, the Codex adapter, `src/util/run-command.ts` and `src/util/run-bounded-command.ts`. The rest
  are about 25 blocking `Bun.spawnSync` calls, nearly all `git`, plus version probes.

### 2.4 Research (sources in the ENG-485 research notes; high confidence unless noted)

- **GitHub Actions** cancellation sends SIGINT, then SIGTERM 7.5 s later, then kills 2.5 s after
  that, all to the step's entry process by pid only, not its group (`actions/runner`,
  `ProcessInvoker.cs`). A later cleanup pass kills every process carrying the job's
  `RUNNER_TRACKING_ID`.
- **GitLab** (shell executor) sends SIGTERM to the job's process group, then SIGKILL after a grace
  period. **`docker stop`** sends SIGTERM to the container's first process, then SIGKILL after 10 s.
  A first process with no handler ignores SIGTERM. **Kubernetes** and **systemd** (`KillMode=control-group`)
  signal every process in the container or unit, so they reach every process however it was grouped.
- **Terminal job control:** Ctrl-C, Ctrl-\ and Ctrl-Z go only to the terminal's foreground process
  group.
- **Detecting a dead parent:** Linux has `PR_SET_PDEATHSIG` and subreapers. Bun's `Bun.spawn` exposes
  neither. macOS has no kernel mechanism a child can use without another process watching.
- **Following a process across forks on macOS** (`NOTE_TRACK`) has been unsupported since 10.5. The
  SDK header says so (`sys/event.h`, checked 2026-10-02).
- **Process environments are hidden on macOS,** even for the same user. Tested 2026-10-02 with `ps -E`
  and `sysctl KERN_PROCARGS2`: only the arguments came back. So the GitHub runner's trick of marking
  every descendant with an inherited environment variable works on Linux only.
- **Finding processes by working folder on macOS** works. `lsof -a -d cwd` found a detached `nohup`
  process in a test folder, taking 0.2 s across 700 processes (tested 2026-10-02).
- Bun bug #30189 (open): SIGINT and SIGTERM handlers never run while stdin has a flowing data
  listener.

## 3. Approaches considered

**Approach 1 (chosen, D4): the agent stays in Styre's terminal group.**
- The terminal's Ctrl-C, Ctrl-\ and Ctrl-Z reach Styre and the agent together, as they do today, so
  no forwarding is needed.
- Styre adds handlers for the signals that reach it alone.
- Stops that Styre starts itself find the agent's tree by following parent links.

**Approach 2 (rejected): the agent in a group of its own.**
- One signal would reach everything the agent started that stays in its group.
- It cuts the agent off from the terminal and from CI's group kills.
- It needs forwarding for every terminal signal, including Ctrl-Z.
- This is ENG-476's reverted attempt, where three review rounds kept finding new edge cases.

**Rejected outright (D2): a watchdog process** that notices Styre's death and stops the agent.

## 4. Decision log

| # | Decision |
|---|---|
| D1 | Stops Styre can see coming (timeout, startup refusal, Ctrl-C, Ctrl-\, `kill`, closed terminal, CI cancel) stop the agent and everything still linked to it immediately. |
| D2 | No new processes: no watchdog, no helper beside the agent. |
| D3 | After `kill -9`, which no program can react to, the next Styre command on the machine stops the orphan, whichever ticket and whichever command it is. |
| D4 | Approach 1: the agent stays in Styre's terminal group. |
| D5 | A launch record: one door for every process Styre starts. Each long-running launch is recorded in memory and on disk, with a start time used to confirm identity (§5). |
| D6 | Detached leftovers are reported, never stopped (§9). Matching by folder alone could hit the developer's own processes, especially in in-place mode. |
| D7 | Two ways to stop: agents by their parent links, suites and probes by their own group (§6). |
| D8 | Grace period: 5 s, then a forced stop. |
| D9 | Ctrl-Z is not handled. Its behaviour is documented instead (§7.5). |
| D10 | Styre speaks the moment a stop signal arrives, then reports the outcome (§7.3). |
| D11 | Linux coverage includes physical and virtual machines, not only containers: GitHub's Ubuntu VMs, a physical laptop and a container. Real terminals are used for the keystroke tests (§11). |

## 5. The launch record (D5)

### 5.1 One door

A new module under `src/util/` (exact layout in the plan) is the only code allowed to start a
process. It offers two forms.

**`launch(...)`: a long-running launch.**
- Used by the agent adapters, `runCommand`, `runBoundedCommand`, and anything else that runs while
  Styre goes on doing other work.
- It returns a handle with the process, its record, and `stop(how)`.

**`runBlocking(...)`: a blocking call.**
- Used by today's `Bun.spawnSync` sites: `git`, `command -v`, version probes.
- These calls are not recorded on disk. Bun reports their pid only after they have finished, so there
  is nothing to record while they run.
- Styre waits for each one to finish, and they stay in the terminal group, so Ctrl-C already reaches
  them.
- The only way one outlives Styre is a `kill -9` in the middle of, say, a `git push`, which finishes on
  its own.

A source guard test fails the build if any file outside the door calls `Bun.spawn`, `Bun.spawnSync`,
or `node:child_process`'s `spawn`, `spawnSync`, `exec`, `execSync`, `execFile` or `execFileSync`. This
is the same pattern as ENG-476's `launchAgent` guard.

### 5.2 What a record holds

For each long-running launch:

- `pid` and `startedAt`: the process start time as the operating system reports it. On Linux it comes
  from `/proc/<pid>/stat`; on macOS from `ps -o lstart=`, or a finer source if the plan finds one
  usable from Bun.
- `kind`:
  - `agent` (stopped by its tree, §6.1);
  - `group` (suites and probes, stopped by their group, §6.2);
  - `command` (other long-running commands; the plan decides tree or group for each caller from how
    it is spawned today).
- `ticket`, `step`, `worktree` (for §9), and a short description of the command.
- `owner`: the launching Styre's pid and start time.

### 5.3 Where it is kept

**In memory:** a live set inside the Styre process, used by the signal handlers (§7).

**On disk:** one small JSON file per live launch, in `$XDG_STATE_HOME/styre/processes/` (default
`~/.local/state/styre/processes/`), for the whole machine.
- **Why not in the ticket's database:** `styre setup` has no run database, and the sweep (§8) must
  see every ticket. The record is operational state about processes on this machine, not ticket
  state, so the rule that SQLite is the single source of truth for tickets does not apply to it.
- **Written** with a write to a temporary file followed by a rename, so a reader never sees half a file, immediately after the
  launch returns its pid. The window between spawn and record is a few milliseconds. A `kill -9`
  landing exactly inside it leaves an unrecorded orphan, a residual risk stated in `SECURITY.md`.
- **Removed** only after the process, and for a group launch the whole group, has been confirmed gone.

### 5.4 The identity check

Before Styre stops anything named in a record left by another Styre process, it confirms that the
process with that pid has the recorded `startedAt`.
- A pid reused by an unrelated program will not match. Styre then leaves that program alone and
  deletes the stale record.
- For a group whose leader has exited, the group itself stands for the launch. The kernel does not
  hand out a pid while a process group with that number still exists. The plan must confirm this on
  both platforms.

### 5.5 What the record replaces

- `recover()` stops killing from `workflow_step.pid`. The column stays, for bookkeeping. The sweep
  (§8) does the stopping, from the launch record.
- The negative pid convention ("a negative journaled pid means the whole group") is retired. The
  record's `kind` says how to stop it.
- **An older checkpoint** written before this change has journaled pids but no record. Their
  identity cannot be confirmed, so Styre does not stop them. It prints a warning naming the ticket
  and the pid.

## 6. Stopping a launch (D7, D8)

One function stops every launch: `stop(record, how)`, where `how` is `graceful` or `forced`.

### 6.1 Agents: follow the parent links

The agent stays in Styre's terminal group (D4). Claude Code puts each tool command in a group of its
own, but those commands remain the agent's children while the agent is alive, so the parent links
lead to them.

1. **List the tree.** Read the process table once (`ps -axo pid,ppid,...` on macOS, `/proc` on
   Linux) and collect every descendant of the recorded process, with start times. That covers a
   wrapper script, the real CLI beneath it, and its running commands.
2. **Ask politely.** Send SIGTERM to every process in the list at once, not only the top one.
   Otherwise a wrapper script would die alone and leave the real CLI running without its stop signal.
3. **Wait, without blocking,** for up to 5 s. The wait polls with `await`, never a blocking sleep,
   so Bun can reap exited children and an exited child never looks alive (the ENG-476 zombie
   finding). A process in zombie state counts as gone.
4. **Stop by force.** List the tree again, to catch processes started during the wait, and SIGKILL
   every member still running.
5. **Confirm.** If anything survives, `stop` reports it as a failure: pid, command and reason. It
   never claims success.

For a `forced` stop (the ENG-476 startup refusal, a second Ctrl-C), steps 2 and 3 are skipped.

### 6.2 Suites and probes: their own group

They keep today's own group (`detached`). A group still holds together after the process that
started it exits, so a server a test started in the background is still reachable. That is exactly
what a suite's cleanup needs.

- Stopping one means SIGTERM to the group, a wait of up to 5 s that does not block, then SIGKILL to
  the group, then a check that the group is empty.
- Today the terminal's Ctrl-C does not reach these groups. The handlers in §7 stop them.

### 6.3 Which trigger uses which stop

| Trigger | Stop |
|---|---|
| Timeout | graceful (today: SIGKILL to the CLI alone, which orphans its running command) |
| ENG-476 startup refusal | forced, on the whole tree. No tool has run yet, and a wrapper is now covered too. |
| Ctrl-C, Ctrl-\, `kill`, closed terminal, CI cancel | graceful (§7), forced on a second signal |
| Agent exits normally | nothing extra; the record is removed. §9's check runs off the critical path. |
| Suite finishes normally | today's group cleanup, now graceful first |
| Sweep of an orphan after `kill -9` | graceful, after the identity check (§8) |

### 6.4 Why 5 seconds

- Claude Code stopped its commands in about 1 s in ENG-476's tests.
- GitHub Actions allows 7.5 s after its first signal before escalating, so the whole handler (§7.4)
  must finish inside that.

## 7. Signals (D1, D9, D10)

### 7.1 Where handlers are installed

- `styre run` and `styre setup` install handlers. They are the only commands that launch long-running
  processes.
- The other commands (`ls`, `clean`, `migrate`, `notify`) launch none. They only sweep (§8).

### 7.2 Which signals

| Signal | Usual source |
|---|---|
| SIGINT | Ctrl-C; GitHub's first cancel signal |
| SIGTERM | `kill`, GitHub's second signal, GitLab, `docker stop`, Kubernetes, systemd |
| SIGHUP | the terminal closing |
| SIGQUIT | Ctrl-\ |

### 7.3 What the handler does

1. **Speaks at once,** on stderr (`styre run`'s stdout is NDJSON telemetry only):
   ```
   styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…
   ```
   For a signal other than SIGINT it opens with the reason instead:
   `styre: received a stop request (SIGTERM) — cleaning up…`.
2. **Closes the door.** No new long-running launches are accepted. A launch that returns after this
   point is stopped immediately.
3. **Stops every live launch** in the set held in memory, all at once, gracefully (§6). For Ctrl-C the
   agent has already had SIGINT from the terminal. The stop still runs: it reaches a wrapper's child,
   stops suite groups, and confirms nothing is left.
4. **Records the interruption.** It appends a run event naming the signal and what was stopped,
   which also reaches telemetry. The interrupted step stays `running` in the journal, which is how
   `--resume` already recognises an interrupted run and how `styre ls` already shows it as
   "interrupted mid-run".
5. **Reports the outcome:**
   ```
   styre: stopped the agent (pid 1234) and 2 of its commands.
   styre: run interrupted; resume with: styre run --resume ENG-123
   ```
   or, for each survivor, `styre: could not stop node server.js (pid 4321); stop it with: kill -9 4321`.
6. **Exits as it would have without a handler.** It removes its handlers and re-sends itself the same
   signal. Shells and CI then see "terminated by signal" (status 130 for SIGINT, 143 for SIGTERM, 129
   for SIGHUP, 131 for SIGQUIT), as they do today. This is deliberately not exit 75. Exit 75 means
   Styre paused the run itself; an interruption is reported the way any program stopped by a signal
   is.

**A second signal while stopping** prints `styre: forcing stop…`, switches every stop still in progress
to `forced`, and continues from step 4.

When the terminal has closed (SIGHUP), the stderr lines go nowhere. The run event and telemetry are
the durable record.

### 7.4 Time limit

The handler finishes within about 6 s: 5 s of grace, then the forced stop and its confirmation. That
is inside GitHub's 7.5 s.

### 7.5 Cases with known limits, documented

**Ctrl-\.** Claude Code dies at once without stopping its running command. That command has already
lost its link by the time Styre's handler runs. Styre stops what is still linked; §9 reports the rest.

**Ctrl-Z (D9).**
- The terminal pauses Styre and the agent together, as today.
- A running suite, and any command Claude Code was running, are in groups of their own, so they keep
  going and simply finish.
- Timeouts count clock time, so a long pause can make a step time out right after `fg`. Styre then
  takes the normal timeout path: stop, then retry.
- Handling Ctrl-Z properly means pausing and resuming every group and adjusting timers, which is where
  the reverted attempt kept finding edge cases. It is out of scope.

**During a blocking call** (`runBlocking`), the handler runs when that call returns, usually within
seconds.

**Bun bug #30189.** Handlers never run while stdin has a flowing data listener. No command reads
stdin today. A test installs the handlers in each command and fails if a signal is not handled, so a
future reader of stdin is caught.

**Styre as a container's first process.** With handlers installed, `docker stop`'s SIGTERM is
handled. Today it is ignored until the 10 s SIGKILL.

### 7.6 The run flow while a stop is in progress

The handler's waits use `await`, so Styre's normal run code keeps running in between. Without a rule,
it would see a stopped agent's result as an ordinary failed dispatch:
- it would record the step as failed;
- it would use up a retry;
- it would try to launch the next attempt.

The interrupted step must instead stay `running` (§7.3 step 4). The rule:

- Once a stop begins, the door is in a **stopping** state. Every launch handle stopped by the handler
  resolves with an `interrupted` marker, not an ordinary result.
- `launchAgent`, `runCommand` and `runBoundedCommand` turn that marker into a dedicated
  `RunInterrupted` error. `runStep` treats it exactly as it already treats `ParkSignal` (a budget
  pause, `src/engine/step-journal.ts:132`): it leaves the step `running`, does not call `markFailed`,
  and rethrows. It never reaches the failure policy. It is rethrown to the top of the command.
- The top of `styre run` and `styre setup` catches `RunInterrupted` and does nothing else. The handler
  owns the exit (§7.3 step 6).
- A test sends a signal mid dispatch and asserts that the journal still shows the step `running`
  with the same attempt count, and that no second launch happened.

### 7.7 Normal exit

On a normal exit, `styre run` and `styre setup` check that the set held in memory is empty. A launch still
recorded at that point is a bug. Styre stops it, prints what it stopped, and exits non-zero, so a leak
is never silent.

## 8. The sweep: cleaning up after `kill -9` (D3)

Every Styre command (`run`, `setup`, `ls`, `clean`, `migrate`, `notify`) sweeps
`$XDG_STATE_HOME/styre/processes/` before doing anything else. For each record:

1. **Claim it.** Rename the file to a claimed name that carries this Styre's pid. If the rename
   fails, another Styre command has claimed it; skip it. This also covers two commands starting at
   once.
2. **Is the owner alive?** Check the owner's pid and start time. If the owning Styre is still
   running, the launch belongs to a live run: put the record back and leave it alone.
3. **If the owner is gone, it is an orphan.**
   - Run the identity check (§5.4).
   - If the process or group is still the recorded one, stop it gracefully (§6) and print to stderr:
     `styre: stopped an orphaned agent from ENG-123 (pid 1234), left running when Styre was force quit`.
   - If the recorded process has already exited, run §9's leftover check on its worktree, for the
     time from its start until now, and report what it finds.
4. **Delete the record** once the stop is confirmed, or straight away if the identity check failed.
   A record whose stop failed is kept, and the failure is printed, so the next command tries again.

A live owner removing its own record must also remove a claimed copy, if a sweep happens to hold the
record at that moment. A sweep that finds the owner alive puts the record back only if the owner has
not removed it in the meantime. The plan defines the exact file protocol and tests the interleaving.

**What this means for each command:**
- **`--resume`:** the sweep stops the orphan, then `recover()` resets the interrupted step, as today.
- **`--fresh` and `clean`:** the sweep runs before the checkpoint is discarded. This fixes the
  ticket's finding that both discarded the checkpoint and left the orphan running.
- **`ls`:** sweeps like the others (operator's choice in D3), and lists anything it stopped.

**Cost:** normally the folder is empty, so the sweep is one directory read. This is measured (§11.4).

## 9. The detached leftover check: reports, never stops (D6)

### 9.1 When it runs

- After every agent step, in the background, off the step's critical path.
- From the sweep, for an orphan that had already exited (§8).

### 9.2 What counts as a leftover

A process that meets all three conditions:

1. its working folder is inside the step's worktree, or the checkout itself in in-place mode;
2. it started during the step's time window;
3. it is not part of any launch Styre is currently running, according to the set held in memory.

"Its parent is the system process" is deliberately not a condition. On Linux desktops orphans are
adopted by the user's session manager (`systemd --user`), not by process 1.

### 9.3 How the working folder is read

- **macOS:** `lsof -a -d cwd`, which ships with macOS.
- **Linux:** `/proc/<pid>/cwd`, which needs no `lsof`. Minimal containers often lack `lsof`.
- Either way, only the user's own processes are visible. That is what the agent runs as.

### 9.4 What happens on a match

- A run event (which reaches telemetry), and a stderr line:
  `styre: the agent left "node server.js" (pid 4321) running in the worktree; stop it with: kill 4321 (if it is not yours)`.
- The step's result is unaffected.

### 9.5 Limits, documented

- macOS start times have whole second resolution, so a process started within about a second of a
  window boundary can be missed or misattributed. That only affects a report line.
- A leftover that moved out of the worktree, or runs as another user, is not found.
- In in-place mode, something the developer started in the checkout during the step is reported too.
  That false report is harmless, and it is why the check reports rather than stops.
- Linux hosts that mount `/proc` with `hidepid` may hide other processes even from the same user.
  The plan must check what the check sees there.

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
- one that detaches a command with `nohup`;
- a leader that exits without being reaped (the zombie case).

They use real processes and real signals but make no model calls. They run:
- on GitHub's `ubuntu-latest` and `ubuntu-24.04-arm` runners, which are full virtual machines with
  systemd, not containers;
- on `macos-15`;
- in one container job, covering Styre as the container's first process.

### 11.2 Live tests with the real `claude` CLI

A manual script, like `scripts/smoke-isolation.ts`, repeats §2.1 with the new code. It runs on:
- macOS (the operator's machine);
- the operator's physical Linux laptop (`rajatgoyal@192.168.4.66`; unreachable on 2026-10-02, so it
  must be awake with SSH enabled);
- a GitHub Ubuntu virtual machine, through a manually triggered workflow that uses the existing
  `ANTHROPIC_API_KEY` secret (already used by `release.yml`);
- a container.

### 11.3 The matrix, for both layers

**Triggers:**
- timeout;
- startup refusal;
- Ctrl-C and Ctrl-\, typed into a real pseudo terminal on both platforms (not only signals sent by
  command), so the terminal's own delivery of the signal is what gets tested;
- `kill`;
- terminal close;
- GitHub's sequence: SIGINT, then SIGTERM, to Styre's pid alone;
- a second Ctrl-C;
- `kill -9`, followed by each of `run`, `--resume`, `--fresh`, `ls` and `clean`.

**Targets:**
- a plain agent;
- an agent launched through a wrapper script;
- an agent with a running command in its own group;
- a suite with a background child.

**Pass means:**
- every target and its commands are gone within the grace period;
- Styre exits with the expected status;
- the run is still resumable;
- the expected messages appear.

**Also covered:**
- a reused pid is left untouched;
- an older checkpoint's journaled pid produces a warning and no stop;
- two commands sweeping at once stop an orphan exactly once;
- a detached `nohup` leftover is reported, not stopped;
- each command's handlers fire (the Bun #30189 guard).

Recovery tests drive real steps through `runStep` and the dispatch path, not rows inserted by hand (ticket
acceptance criterion).

### 11.4 Proof the tests can fail, and the latency measurement

- **Control run.** Before the new code is tested, the same matrix runs against main as a control. It
  must reproduce §2.1's leaks: `kill` and `kill -9` leave the agent running. If the control does not
  leak, the run reports that its probes are blind and does not report a pass. Same pattern as
  `scripts/smoke-isolation.ts`.
- **Deliberate breaks.** Each safeguard is broken on purpose once, and a test must catch it.
- **Latency:**
  - 50 normal dispatches with the stand-in agent, median before and after;
  - the sweep's cost with an empty folder;
  - confirmation that §9's check does not lengthen a step.

## 12. Documentation, in the same PR

- `SECURITY.md`:
  - the wrapper gap is closed;
  - the `kill -9` limit (cleanup on the next command) is stated;
  - so are the unrecorded window of §5.3, detached leftovers being reported but not stopped, Ctrl-\,
    and Ctrl-Z.
- `docs/architecture/control-loop.md`: crash recovery (§6.1 there) moves to the sweep plus the reset.
- `docs/architecture/runtime-parameters.md`: exit statuses on a signal, and the stop and sweep
  messages.
- `docs/architecture/conventions.md`: the `processes/` state folder.
- `CLAUDE.md`: the one door invariant.
- `docs/architecture/brainstorm.md`: a §11 changelog entry.

## 13. Out of scope

- Ctrl-Z handling (D9).
- Linux control groups, which could later stop detached leftovers on Linux hosts that allow them.
- Windows.
- Confinement of the tool set (ENG-476, done).
- Codex confinement (ENG-484).

## 14. Acceptance criteria (from ENG-485), mapped

| Criterion | Where |
|---|---|
| Design brainstorm independently reviewed, no open critical or major findings, operator approved | this document, plus its review record |
| Each stop trigger and forwarded signal: the agent and a tool command in its own group gone within grace, expected exit status, shown live | §11.2, §11.3 |
| An agent launched through a wrapper script stopped completely, live | §6.1, §11.3 |
| Recovery kills exactly what the record names; `--fresh` and `clean` stop an orphan first; tests through real steps | §5.4, §8, §11.3. The ticket's wording "a group for negative pids, one process for positive pids" is superseded by the record's `kind` (§5.5). |
| A normal successful dispatch pays no added latency, measured | §6.3, §9.1, §11.4 |
| Independent review recorded before the PR opens | the review step after the plan |
