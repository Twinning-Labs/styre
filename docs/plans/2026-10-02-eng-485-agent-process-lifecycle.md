# ENG-485 Agent Process Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every process Styre starts stoppable as a whole, on every way a run can end. That
covers timeouts, the startup refusal, Ctrl-C, Ctrl-\, `kill`, a closed terminal, CI cancel, and
`kill -9` followed by any later command. Interruptions are free and resumable.

**Architecture:**
- **One door** (`src/util/process/door.ts`) is the only code that starts processes. It records each
  long-running launch in memory and on disk, with an identity (pid plus kernel start time).
- **Two stop functions** (`stop.ts`):
  - agents by their parent links plus the groups their descendants lead;
  - commands by their own group.
- **A signal handler** (`signals.ts`) owns the whole interruption. It closes the door, switches the
  run database connection to read only, stops every launch, records the interruption in one
  transaction, and exits with the signal's status.
- **A sweep** (`sweep.ts`) at the start of every command stops orphans left by a `kill -9`.
- **A leftover check** (`leftovers.ts`) reports detached processes, and never stops them.

**Tech Stack:** TypeScript on Bun 1.4.x, `bun:sqlite`, `bun:ffi` (macOS `sysctl`), `bun test`, Biome,
GitHub Actions.

**Spec:** `docs/brainstorms/2026-10-02-eng-485-agent-process-lifecycle-design.md` (revision 7, commit
07f4e53). Read it before any task. Section numbers below (§N) refer to it, and decisions D1–D15 are
in its §4.

## Global Constraints

**Process handling:**
- **No new processes:** no watchdog or helper process beside the agent (D2).
- **The agent stays in Styre's terminal group.** Agents are never spawned `detached` (D4).
- **Command launches are spawned `detached`.** This covers suites, probes, acceptance checks and
  provisioning: `runCommand` and `runBoundedCommand` (D7).

**Timing:**

| Value | Name |
|---|---|
| 5000 ms graceful stop | `GRACE_MS = 5_000` (D8) |
| 6500 ms handler deadline | `HANDLER_DEADLINE_MS = 6_500` (§7.4) |
| 5000 ms output read limit after a command's leader exits | `DRAIN_LIMIT_MS = 5_000` (§6.2) |
| 5000 ms leftover check `lsof` timeout | `LEFTOVER_TIMEOUT_MS = 5_000` (§9.1) |

**Files and data:**
- **Record folder:** `$XDG_STATE_HOME/styre-processes/`, default `~/.local/state/styre-processes/`.
  It is a sibling of `styre/`, never inside it (§5.3).
- **Record names:**
  - `<pid>-<startedAt>.json`;
  - claimed: `<pid>-<startedAt>.claimed-<claimerPid>-<claimerStartedAt>`;
  - nothing else in the folder is touched.
- **No schema change.** The interruption note uses event kind `note`, and the dispatch outcome
  `interrupted` is free text. `src/db/schema.sql` and `docs/architecture/schema.sql` stay
  byte-identical and unchanged.

**Output:**
- **Stream contract:** `styre run` writes only NDJSON telemetry to stdout. Every human line goes to
  stderr: stop messages, sweep messages, leftover reports.
- **Exit statuses on a signal:** 130 SIGINT, 143 SIGTERM, 129 SIGHUP, 131 SIGQUIT, by re-raising
  the first signal received. Fallback `process.exit(128 + n)`. Never 75 for an interruption.

**Exact message texts, from §7.3, §8 and §9.4.** Fill only the parts in angle brackets:
- `styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…`
- `styre: received a stop request (<SIGNAME>) — cleaning up…`
- `styre: forcing stop…`
- `styre: stopped the agent (pid <pid>) and <n> of its commands.`
- `styre: run interrupted; resume with: styre run --resume <IDENT>`
- `styre: could not stop <command> (pid <pid>); stop it with: kill -9 <pid>`
- `styre: stopped an orphaned agent from <IDENT> (pid <pid>), left running when Styre was force quit`
- `styre: the agent left "<command>" (pid <pid>) running in the worktree; stop it with: kill <pid> (if it is not yours)`

**Workflow:**
- Branch `feat/eng-485-process-lifecycle`.
- Conventional Commit titles.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit to `main`. Never merge.
- Before `gh pr create`, record an independent review of the exact HEAD at
  `.claude/reviews/<full-sha>.md`, with `reviewed-sha:` and `reviewed-remote:` lines.

**Writing:** never coin hyphenated compound words in code comments, docs or messages.

**Commands:**
- Tests: `bun test <path>`.
- Typecheck: `bunx tsc --noEmit`.
- Lint: `bun run lint`.
- Full suite before each commit that touches shared code: `bun test`.

## Review Focus

1. **Styre started from a script without job control** (a Makefile, `bash script.sh`), so Styre, the
   agent and the script share one process group. Stopping an agent, or sweeping its orphan, must
   never signal the script. Pinned in Task 3 (stop) and Task 13 (sweep).
2. **A worktree path with spaces, or reached through a symlink** (macOS `/var` vs `/private/var`).
   The leftover check must compare real paths, or it silently reports nothing. Pinned in Task 14.
3. **A process that exits between listing and signalling.** `ESRCH` is not an error, and stop must
   not report it as a survivor. Pinned in Task 3.
4. **An unwritable or missing state folder** (`XDG_STATE_HOME` pointing somewhere read only). The
   launch must fail loudly, and stop what it just started, rather than run an unrecorded agent.
   Pinned in Task 4.
5. **Two Styre runs on different tickets at once.** One run's handler or sweep must never stop the
   other's launches. Pinned in Task 13.

---

## File structure

**New: `src/util/process/`**

| File | Responsibility |
|---|---|
| `proc-table.ts` | Read the process table. Linux: `/proc`. macOS: `sysctl(KERN_PROC)` via `bun:ffi`, falling back to `ps` under `LC_ALL=C TZ=UTC`. It is one of two files allowed to spawn (the fallback). |
| `stop.ts` | `stopTree` (agents) and `stopGroup` (commands). Pure policy over an injectable process table and `kill`. |
| `records.ts` | Launch records on disk: write, remove, claim and list, with the exact name pattern. |
| `door.ts` | The door: `launch`, `runBlocking`, `launchDiagnostic`, the set of live launches held in memory, the in-flight step, `RunInterrupted`, and the stopping state. The other file allowed to spawn. |
| `interruption.ts` | Writes the interruption in one transaction on the handler's own connection. On resume, matches it, undoes the edits in place, and resets the branch. |
| `signals.ts` | Installs and suspends the handlers; runs the §7.3 sequence under one deadline. |
| `sweep.ts` | The §8 sweep. |
| `leftovers.ts` | The §9 leftover check. |

**Modified:**
- `src/util/run-command.ts`, `src/util/run-bounded-command.ts`: rebuilt on the door.
- `src/agent/providers/claude.ts`, `src/agent/providers/codex.ts`: spawn through the door.
- `src/agent/runner.ts` (the `interrupted` flag), `src/agent/launch.ts` (the `RunInterrupted`
  conversion).
- `src/engine/step-journal.ts`: in-flight registration, the stopping check, no pid writes.
- `src/daemon/advance.ts`: passes `readHead`.
- `src/daemon/recover.ts`: no kills; interruption matching; warning for older checkpoints.
- `src/dispatch/worktree.ts`, `src/dispatch/run-dispatch.ts`: HEAD reports; `runBlocking` for `git`.
- `src/dispatch/handlers.ts`, `src/dispatch/code-review.ts`: no negative pid journaling.
- `src/daemon/projector.ts`: a door check per row.
- `src/telemetry/emitter.ts`: export `toEvent` and `runCtx`.
- `src/cli/output.ts` (`guard`), `src/cli/run.ts`, `src/cli/park.ts`, `src/cli/setup.ts`,
  `src/cli/clean.ts`, `src/cli/ls.ts`, `src/cli/migrate.ts`, `src/cli/notify.ts`.
- The remaining `Bun.spawnSync` sites: `src/config/slug.ts`,
  `src/dispatch/{review-evidence,baseline-rerun,replay-harness,check-selector,check-execution,test-target,completeness}.ts`,
  `src/testing/{environment,karma}.ts`, `src/setup/{test-action,node-manager,discover-schema}.ts`,
  `src/setup/lang/python.ts`, `src/integrations/adapters/github.ts`, `src/db/{client,migrate}.ts`,
  `src/db/repos/run.ts`, `src/agent/preflight.ts`.
- Docs: `SECURITY.md`, `CLAUDE.md`, `docs/architecture/{control-loop,runtime-parameters,conventions,brainstorm}.md`.
- CI: `.github/workflows/ci.yml`, plus a new `.github/workflows/lifecycle-live.yml`.

**New tests:** `test/util/process/*.test.ts`, `test/lifecycle/*.test.ts`, and the stand-in agent
scripts in `test/lifecycle/fixtures/`.

**New scripts:** `scripts/smoke-lifecycle.ts` (live, with a control run) and
`scripts/measure-lifecycle-latency.ts`.

---

## Phase A — Process primitives

### Task 0: Spike — the macOS `sysctl(KERN_PROC)` reader in a compiled binary

This is throwaway code. Its output is a decision, recorded in Task 1's code as constants.

**Files:**
- Create: `scripts/spike-kinfo.ts`. It is deleted at the end of the task and never committed.

- [ ] **Step 1: Write the spike**

```ts
// scripts/spike-kinfo.ts — prints this process's kinfo_proc fields next to `ps` for comparison.
import { dlopen, FFIType, ptr } from "bun:ffi";
const lib = dlopen("/usr/lib/libSystem.B.dylib", {
  sysctl: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
});
const pid = Number(process.argv[2] ?? process.pid);
const mib = new Int32Array([1 /*CTL_KERN*/, 14 /*KERN_PROC*/, 1 /*KERN_PROC_PID*/, pid]);
const len = new BigUint64Array([0n]);
lib.symbols.sysctl(ptr(mib), 4, null, ptr(len), null, 0n);
const buf = new Uint8Array(Number(len[0]));
const rc = lib.symbols.sysctl(ptr(mib), 4, ptr(buf), ptr(len), null, 0n);
const v = new DataView(buf.buffer);
console.log({
  rc,
  len: Number(len[0]),
  sec: v.getBigInt64(0, true),
  usec: v.getInt32(8, true),
  stat: v.getUint8(36),
  pid: v.getInt32(40, true),
  ppid: v.getInt32(560, true),
  pgid: v.getInt32(564, true),
});
```

- [ ] **Step 2: Run it under `bun` and as a compiled binary on arm64, and compare with `ps`**

Run:
```bash
bun run scripts/spike-kinfo.ts $$
bun build --compile scripts/spike-kinfo.ts --outfile /tmp/spike-kinfo && codesign -s - -f /tmp/spike-kinfo && /tmp/spike-kinfo $$
ps -o pid=,ppid=,pgid=,lstart= -p $$
bun run scripts/spike-kinfo.ts 1
bun run scripts/spike-kinfo.ts 999999
```

Expected:
- `len` is 648;
- pid, ppid and pgid match `ps`;
- `sec` matches `lstart`;
- pid 1 (root) still returns `rc 0` with `len 648`;
- pid 999999 returns `len 0`.

- [ ] **Step 3: Run it on x86_64**

Push a throwaway branch with a workflow with one job on `macos-15-intel` that runs the same commands, or
run them under Rosetta with an x86_64 Bun. Expected: the same offsets and a length of 648.

- [ ] **Step 4: Record the outcome and delete the spike**

If both architectures pass, Task 1 uses the `sysctl` reader with the offsets above. If either
fails, Task 1's macOS reader is the `ps` fallback alone (whole second resolution, §9.5), and the PR
description says so.

Run: `rm scripts/spike-kinfo.ts`. Nothing is committed.

---

### Task 1: The process table reader

**Files:**
- Create: `src/util/process/proc-table.ts`
- Test: `test/util/process/proc-table.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProcState = "running" | "zombie" | "stopped";
  export interface ProcInfo { pid: number; ppid: number; pgid: number; startedAt: string; state: ProcState }
  export type Probe = { kind: "alive"; info: ProcInfo } | { kind: "gone" } | { kind: "not-allowed" };
  export function listProcesses(): ProcInfo[];
  export function probe(pid: number): Probe;
  export function bootId(): string | null;          // Linux boot_id; null on macOS
  export function sameProcess(a: { pid: number; startedAt: string }, b: ProcInfo): boolean;
  export function nowToken(): string;               // "now" on the same clock as startedAt
  export function tokenValue(t: string): number;    // for ordering tokens on one machine
  ```
- **`startedAt` is an opaque, stable token.** On Linux it is the decimal clock ticks since boot
  (`/proc/<pid>/stat` field 22). On macOS it is `<sec>.<usec padded to 6>` from `sysctl`, or
  `<epoch sec>.000000` from the `ps` fallback. Compare it only for equality.

- [ ] **Step 1: Write the failing tests**

```ts
// test/util/process/proc-table.test.ts
import { afterEach, expect, test } from "bun:test";
import { listProcesses, nowToken, probe, sameProcess, tokenValue } from "../../../src/util/process/proc-table.ts";

const spawned: Bun.Subprocess[] = [];
afterEach(() => { for (const p of spawned.splice(0)) try { p.kill("SIGKILL"); } catch {} });

test("lists this process with its parent, group and a start time", () => {
  const me = listProcesses().find((p) => p.pid === process.pid);
  expect(me).toBeDefined();
  expect(me!.ppid).toBe(process.ppid);
  expect(me!.startedAt).toMatch(/^\d+(\.\d{6})?$/);
  expect(me!.state).toBe("running");
});

test("a child's start time is stable across reads and differs from ours", async () => {
  const child = Bun.spawn(["sleep", "5"]); spawned.push(child);
  await Bun.sleep(50);
  const a = probe(child.pid); const b = probe(child.pid);
  expect(a.kind).toBe("alive"); expect(b.kind).toBe("alive");
  if (a.kind === "alive" && b.kind === "alive") {
    expect(a.info.startedAt).toBe(b.info.startedAt);
    expect(a.info.ppid).toBe(process.pid);
    expect(sameProcess({ pid: child.pid, startedAt: a.info.startedAt }, b.info)).toBe(true);
  }
});

test("a pid that does not exist is gone, not alive and not 'not allowed'", () => {
  expect(probe(2_000_000_000).kind).toBe("gone");
});

test("a process owned by another user is reported as alive or not allowed, never gone", () => {
  // pid 1 is root's on both platforms.
  expect(probe(1).kind).not.toBe("gone");
});

test("an exited, unreaped child reads as a zombie", async () => {
  const child = Bun.spawn(["sh", "-c", "exit 0"]); spawned.push(child);
  // Block the event loop so Bun cannot reap it, then read the table synchronously.
  const end = Date.now() + 300; while (Date.now() < end) {}
  const p = probe(child.pid);
  expect(p.kind === "gone" || (p.kind === "alive" && p.info.state === "zombie")).toBe(true);
});

test("nowToken orders after this process's start and before a child started later", async () => {
  const before = nowToken();
  const child = Bun.spawn(["sleep", "2"]); spawned.push(child);
  await Bun.sleep(50);
  const c = probe(child.pid);
  expect(c.kind).toBe("alive");
  if (c.kind === "alive") expect(tokenValue(c.info.startedAt)).toBeGreaterThanOrEqual(tokenValue(before) - 0.02 * (process.platform === "linux" ? 100 : 1));
});

test("start times ignore locale and timezone", () => {
  const saved = { lc: process.env.LC_ALL, tz: process.env.TZ };
  const base = probe(process.pid);
  process.env.LC_ALL = "fr_FR.UTF-8"; process.env.TZ = "Asia/Kolkata";
  try {
    const again = probe(process.pid);
    expect(again.kind === "alive" && base.kind === "alive" && again.info.startedAt === base.info.startedAt).toBe(true);
  } finally { process.env.LC_ALL = saved.lc; process.env.TZ = saved.tz; }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/util/process/proc-table.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

```ts
// src/util/process/proc-table.ts
import { readFileSync, readdirSync } from "node:fs";

/** One snapshot of a process (ENG-485 §5.2). `startedAt` is an opaque token that is stable for the
 *  life of the process and never depends on locale or timezone; compare it only for equality. */
export type ProcState = "running" | "zombie" | "stopped";
export interface ProcInfo { pid: number; ppid: number; pgid: number; startedAt: string; state: ProcState }
export type Probe = { kind: "alive"; info: ProcInfo } | { kind: "gone" } | { kind: "not-allowed" };

export function sameProcess(a: { pid: number; startedAt: string }, b: ProcInfo): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

export function listProcesses(): ProcInfo[] {
  return process.platform === "linux" ? linuxList() : darwinList();
}

export function probe(pid: number): Probe {
  return process.platform === "linux" ? linuxProbe(pid) : darwinProbe(pid);
}

export function bootId(): string | null {
  if (process.platform !== "linux") return null;
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

/** Tokens are clock ticks since boot on Linux and wall seconds on macOS: comparable on one machine. */
export function tokenValue(t: string): number { return Number.parseFloat(t); }
let clkTck: number | null = null;
export function nowToken(): string {
  if (process.platform === "linux") {
    if (clkTck === null) {
      const r = Bun.spawnSync(["getconf", "CLK_TCK"], { timeout: 5_000 }); // allowed: proc-table spawns
      clkTck = r.success ? Number(r.stdout.toString().trim()) : 100;
    }
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return String(Math.floor(uptime * clkTck));
  }
  const ms = Date.now();
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}`;
}

// ---- Linux: /proc, no process launched ----
function parseStat(pid: number, raw: string): ProcInfo {
  // comm may contain spaces and parentheses; fields resume after the LAST ')'.
  const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const s = rest[0]; // field 3
  return {
    pid,
    ppid: Number(rest[1]), // field 4
    pgid: Number(rest[2]), // field 5
    startedAt: rest[19], // field 22: start time in clock ticks since boot
    state: s === "Z" || s === "X" ? "zombie" : s === "T" || s === "t" ? "stopped" : "running",
  };
}
function linuxProbe(pid: number): Probe {
  try {
    return { kind: "alive", info: parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8")) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return { kind: "gone" };
    if (code === "EACCES" || code === "EPERM") return { kind: "not-allowed" };
    throw err;
  }
}
function linuxList(): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const p = linuxProbe(Number(name));
    if (p.kind === "alive") out.push(p.info);
  }
  return out;
}

// ---- macOS: sysctl(KERN_PROC) through bun:ffi (Task 0), ps fallback ----
// Offsets verified in Task 0 on arm64 and x86_64 (struct kinfo_proc, LP64).
const KINFO_SIZE = 648;
const OFF_START_SEC = 0, OFF_START_USEC = 8, OFF_STAT = 36, OFF_PID = 40, OFF_PPID = 560, OFF_PGID = 564;
const SZOMB = 5, SSTOP = 4;

let sysctlFn: ((mib: Int32Array, n: number, buf: Uint8Array | null, len: BigUint64Array) => number) | null | undefined;
function loadSysctl() {
  if (sysctlFn !== undefined) return sysctlFn;
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    sysctlFn = (mib, n, buf, len) =>
      lib.symbols.sysctl(ptr(mib), n, buf ? ptr(buf) : null, ptr(len), null, 0n) as number;
  } catch {
    sysctlFn = null;
  }
  return sysctlFn;
}
function decode(v: DataView, at: number): ProcInfo {
  const sec = v.getBigInt64(at + OFF_START_SEC, true);
  const usec = v.getInt32(at + OFF_START_USEC, true);
  const stat = v.getUint8(at + OFF_STAT);
  return {
    pid: v.getInt32(at + OFF_PID, true),
    ppid: v.getInt32(at + OFF_PPID, true),
    pgid: v.getInt32(at + OFF_PGID, true),
    startedAt: `${sec}.${String(usec).padStart(6, "0")}`,
    state: stat === SZOMB ? "zombie" : stat === SSTOP ? "stopped" : "running",
  };
}
function sysctlRead(mib: Int32Array): DataView | null {
  const fn = loadSysctl();
  if (!fn) return null;
  for (let tries = 0; tries < 5; tries++) {
    const len = new BigUint64Array([0n]);
    if (fn(mib, mib.length, null, len) !== 0) return null;
    const buf = new Uint8Array(Number(len[0]) + KINFO_SIZE * 16); // headroom for new processes
    len[0] = BigInt(buf.length);
    if (fn(mib, mib.length, buf, len) === 0) return new DataView(buf.buffer, 0, Number(len[0]));
  }
  return null;
}
function darwinList(): ProcInfo[] {
  const v = sysctlRead(new Int32Array([1, 14, 0, 0])); // KERN_PROC_ALL
  if (!v) return psList();
  const out: ProcInfo[] = [];
  for (let at = 0; at + KINFO_SIZE <= v.byteLength; at += KINFO_SIZE) out.push(decode(v, at));
  return out;
}
function darwinProbe(pid: number): Probe {
  const v = sysctlRead(new Int32Array([1, 14, 1, pid])); // KERN_PROC_PID
  if (!v) {
    const hit = psList().find((p) => p.pid === pid);
    return hit ? { kind: "alive", info: hit } : { kind: "gone" };
  }
  // A missing pid returns success with length 0, not ESRCH (review round 3, R9).
  return v.byteLength < KINFO_SIZE ? { kind: "gone" } : { kind: "alive", info: decode(v, 0) };
}
function psList(): ProcInfo[] {
  // The only spawn outside door.ts; allowed by the source guard (Task 7). Locale and timezone fixed.
  const r = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    timeout: 5_000,
  });
  if (!r.success) throw new Error(`ps failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim().split("\n").map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) throw new Error(`ps: unparseable line: ${line}`);
    const sec = Math.floor(Date.parse(`${m[5]} UTC`) / 1000);
    return {
      pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]),
      startedAt: `${sec}.000000`,
      state: m[4].startsWith("Z") ? "zombie" : m[4].startsWith("T") ? "stopped" : "running",
    } satisfies ProcInfo;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/util/process/proc-table.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Break it on purpose, then restore**

Change `OFF_PPID` to 564 and confirm the first test fails. Change `rest[19]` to `rest[20]` on Linux
(run in CI) and confirm the stability test still passes but the `ps` comparison in Task 15 catches
it. Restore both.

- [ ] **Step 6: Commit**

```bash
git add src/util/process/proc-table.ts test/util/process/proc-table.test.ts
git commit -m "feat(process): read the process table with stable start times

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Launch records on disk

**Files:**
- Create: `src/util/process/records.ts`
- Test: `test/util/process/records.test.ts`

**Interfaces:**
- Consumes: `ProcInfo` (Task 1).
- Produces:
  ```ts
  export interface Owner { pid: number; startedAt: string; pgid: number }
  export interface LaunchRecord {
    version: 1; pid: number; startedAt: string; bootId: string | null;
    kind: "agent" | "group"; ident: string | null; stepId: number | null;
    worktree: string | null; command: string; owner: Owner;
  }
  export function processesDir(): string;
  export function recordFileName(r: { pid: number; startedAt: string }): string;
  export function writeRecord(r: LaunchRecord): void;               // throws loudly on any failure
  export function removeRecord(r: { pid: number; startedAt: string }): void; // loops until both names are gone
  export type Listed = { file: string; record: LaunchRecord; claimedBy: { pid: number; startedAt: string } | null };
  export function listRecords(): Listed[];
  export function claim(l: Listed, me: { pid: number; startedAt: string }): Listed | null;
  export function unclaim(l: Listed): void;  // renames back unless the owner has removed it
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/util/process/records.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rec from "../../../src/util/process/records.ts";

let state: string; const saved = process.env.XDG_STATE_HOME;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), "styre-rec-")); process.env.XDG_STATE_HOME = state; });
afterEach(() => { process.env.XDG_STATE_HOME = saved; });

const r = (pid = 4242): rec.LaunchRecord => ({
  version: 1, pid, startedAt: "123.000456", bootId: null, kind: "agent", ident: "ENG-1",
  stepId: 7, worktree: "/tmp/wt", command: "claude -p", owner: { pid: 1, startedAt: "1.000000", pgid: 1 },
});

test("the folder is a sibling of styre/, never inside it", () => {
  expect(rec.processesDir()).toBe(join(state, "styre-processes"));
});

test("write then list returns the record; remove deletes it", () => {
  rec.writeRecord(r());
  expect(rec.listRecords().map((l) => l.record.pid)).toEqual([4242]);
  rec.removeRecord(r());
  expect(rec.listRecords()).toEqual([]);
});

test("only exact names are listed; anything else is ignored and left alone", () => {
  rec.writeRecord(r());
  writeFileSync(join(rec.processesDir(), "notes.txt"), "keep me");
  writeFileSync(join(rec.processesDir(), "1-2.json.bak"), "keep me");
  expect(rec.listRecords().length).toBe(1);
  rec.removeRecord(r());
  expect(readdirSync(rec.processesDir()).sort()).toEqual(["1-2.json.bak", "notes.txt"]);
});

test("a claim renames with the claimer; a second claim fails; unclaim restores", () => {
  rec.writeRecord(r());
  const [l] = rec.listRecords();
  const c = rec.claim(l, { pid: 9, startedAt: "9.000000" });
  expect(c?.claimedBy).toEqual({ pid: 9, startedAt: "9.000000" });
  expect(rec.claim(l, { pid: 10, startedAt: "10.000000" })).toBeNull();
  rec.unclaim(c!);
  expect(rec.listRecords()[0].claimedBy).toBeNull();
});

test("removing a claimed record removes the claimed copy too (review round 2, N9)", () => {
  rec.writeRecord(r());
  rec.claim(rec.listRecords()[0], { pid: 9, startedAt: "9.000000" });
  rec.removeRecord(r());
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("unclaim does not resurrect a record the owner removed meanwhile", () => {
  rec.writeRecord(r());
  const c = rec.claim(rec.listRecords()[0], { pid: 9, startedAt: "9.000000" })!;
  rec.removeRecord(r());
  rec.unclaim(c);
  expect(rec.listRecords()).toEqual([]);
});

test("an unwritable state folder fails loudly (Review Focus 4)", () => {
  chmodSync(state, 0o500);
  try { expect(() => rec.writeRecord(r())).toThrow(); } finally { chmodSync(state, 0o700); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/util/process/records.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/util/process/records.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Launch records on disk (ENG-485 §5.3). One file per live long-running launch, for the whole
 *  machine, in a sibling of `styre/` so no repository slug can collide with it. */
export interface Owner { pid: number; startedAt: string; pgid: number }
export interface LaunchRecord {
  version: 1; pid: number; startedAt: string; bootId: string | null;
  kind: "agent" | "group"; ident: string | null; stepId: number | null;
  worktree: string | null; command: string; owner: Owner;
}
export type Listed = { file: string; record: LaunchRecord; claimedBy: { pid: number; startedAt: string } | null };

const RECORD = /^(\d+)-(\d+(?:\.\d{6})?)\.json$/;
const CLAIMED = /^(\d+)-(\d+(?:\.\d{6})?)\.json\.claimed-(\d+)-(\d+(?:\.\d{6})?)$/;

export function processesDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state"), "styre-processes");
}
export function recordFileName(r: { pid: number; startedAt: string }): string {
  return `${r.pid}-${r.startedAt}.json`;
}
export function writeRecord(r: LaunchRecord): void {
  const dir = processesDir();
  mkdirSync(dir, { recursive: true });
  const final = join(dir, recordFileName(r));
  const tmp = join(dir, `.${recordFileName(r)}.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, final);
}
function claimedNames(dir: string, base: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith(`${base}.claimed-`) && CLAIMED.test(n));
}
export function removeRecord(r: { pid: number; startedAt: string }): void {
  const dir = processesDir();
  const base = recordFileName(r);
  for (let i = 0; i < 50; i++) {
    try { unlinkSync(join(dir, base)); } catch {}
    for (const n of claimedNames(dir, base)) try { unlinkSync(join(dir, n)); } catch {}
    if (!existsSync(join(dir, base)) && claimedNames(dir, base).length === 0) return;
  }
  throw new Error(`could not remove launch record ${base} after 50 attempts`);
}
export function listRecords(): Listed[] {
  const dir = processesDir();
  if (!existsSync(dir)) return [];
  const out: Listed[] = [];
  for (const file of readdirSync(dir)) {
    const c = CLAIMED.exec(file);
    if (!RECORD.test(file) && !c) continue;
    let record: LaunchRecord;
    try { record = JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { continue; }
    out.push({ file, record, claimedBy: c ? { pid: Number(c[3]), startedAt: c[4] } : null });
  }
  return out;
}
export function claim(l: Listed, me: { pid: number; startedAt: string }): Listed | null {
  const dir = processesDir();
  const base = recordFileName(l.record);
  const to = `${base}.claimed-${me.pid}-${me.startedAt}`;
  try { renameSync(join(dir, l.file), join(dir, to)); } catch { return null; }
  return { file: to, record: l.record, claimedBy: me };
}
export function unclaim(l: Listed): void {
  const dir = processesDir();
  try { renameSync(join(dir, l.file), join(dir, recordFileName(l.record))); } catch {}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/util/process/records.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/util/process/records.ts test/util/process/records.test.ts
git commit -m "feat(process): launch records on disk with exact names and claims

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Stopping an agent tree and a command group

**Files:**
- Create: `src/util/process/stop.ts`
- Create: `test/lifecycle/fixtures/standin-agent.sh`, `test/lifecycle/fixtures/wrapper.sh`,
  `test/lifecycle/fixtures/stubborn-cli.sh`
- Test: `test/util/process/stop.test.ts`

**Interfaces:**
- Consumes: `listProcesses`, `ProcInfo`, `sameProcess` (Task 1).
- Produces:
  ```ts
  export interface StopReport { stopped: ProcInfo[]; survivors: ProcInfo[] }
  export interface StopDeps { list: () => ProcInfo[]; kill: (target: number, sig: NodeJS.Signals) => void; sleep: (ms: number) => Promise<void>; now: () => number }
  export const realStopDeps: StopDeps;
  export async function stopTree(root: { pid: number; startedAt: string }, how: "graceful" | "forced",
    opts: { graceMs: number; excludePgids: number[]; deps?: StopDeps; abort?: { forced: boolean } }): Promise<StopReport>;
  export async function stopGroup(pgid: number, how: "graceful" | "forced",
    opts: { graceMs: number; deps?: StopDeps; abort?: { forced: boolean } }): Promise<StopReport>;
  export function groupMembers(pgid: number, table: ProcInfo[]): ProcInfo[]; // live members, zombies excluded
  ```
- **`abort.forced`** is set by a second signal (§7.3). A stop that sees it skips the rest of its
  wait and moves to the forced stop.

- [ ] **Step 1: Write the stand-in scripts**

```sh
#!/bin/sh
# test/lifecycle/fixtures/standin-agent.sh — behaves like Claude Code where it matters (§11.1):
# runs a command in its OWN group; on TERM/INT/HUP stops that group and exits; on QUIT dies at once.
set -m                      # job control: the background job gets its own process group
sleep "${STANDIN_SLEEP:-300}" &   # the "tool command", leading its own group; tests set a unique value
TOOL=$!
echo "tool $TOOL" >&2
trap 'kill -TERM -$TOOL 2>/dev/null; exit 0' TERM INT HUP
trap 'kill -KILL $$' QUIT
wait
```

```sh
#!/bin/sh
# test/lifecycle/fixtures/wrapper.sh — runs its argument as a child WITHOUT exec.
"$@"
```

```sh
#!/bin/sh
# test/lifecycle/fixtures/stubborn-cli.sh — ignores SIGTERM (review round 1, finding 1).
trap '' TERM
while :; do sleep 1; done
```

Run: `chmod +x test/lifecycle/fixtures/*.sh`

- [ ] **Step 2: Write the failing tests**

```ts
// test/util/process/stop.test.ts
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { listProcesses, probe } from "../../../src/util/process/proc-table.ts";
import { stopGroup, stopTree } from "../../../src/util/process/stop.ts";

const FX = join(import.meta.dir, "../../lifecycle/fixtures");
const live: number[] = [];
afterEach(() => { for (const p of live.splice(0)) try { process.kill(p, "SIGKILL"); } catch {} });
const alive = (pid: number) => { const p = probe(pid); return p.kind === "alive" && p.info.state !== "zombie"; };
const start = (pid: number) => { const p = probe(pid); if (p.kind !== "alive") throw new Error("gone"); return p.info.startedAt; };
const myPgid = () => listProcesses().find((p) => p.pid === process.pid)!.pgid;
async function toolOf(agentPid: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const t = listProcesses().find((p) => p.ppid === agentPid && p.pgid === p.pid);
    if (t) return t.pid; await Bun.sleep(20);
  }
  throw new Error("tool never started");
}

test("graceful stop: the agent and its tool command in its own group are gone", async () => {
  const agent = Bun.spawn([join(FX, "standin-agent.sh")], { stderr: "pipe" }); live.push(agent.pid);
  const tool = await toolOf(agent.pid); live.push(tool);
  const rep = await stopTree({ pid: agent.pid, startedAt: start(agent.pid) }, "graceful", { graceMs: 5000, excludePgids: [myPgid()] });
  expect(rep.survivors).toEqual([]);
  expect(alive(agent.pid)).toBe(false); expect(alive(tool)).toBe(false);
});

test("a stubborn real CLI behind a wrapper that dies is still stopped by force (finding 1)", async () => {
  const w = Bun.spawn([join(FX, "wrapper.sh"), join(FX, "stubborn-cli.sh")]); live.push(w.pid);
  await Bun.sleep(200);
  const cli = listProcesses().find((p) => p.ppid === w.pid)!; live.push(cli.pid);
  const rep = await stopTree({ pid: w.pid, startedAt: start(w.pid) }, "graceful", { graceMs: 500, excludePgids: [myPgid()] });
  expect(alive(cli.pid)).toBe(false);
  expect(rep.survivors).toEqual([]);
});

test("Styre's own group is never signalled, even though the agent is in it (N1, Review Focus 1)", async () => {
  const agent = Bun.spawn([join(FX, "standin-agent.sh")]); live.push(agent.pid);
  const bystander = Bun.spawn(["sleep", "30"]); live.push(bystander.pid); // same group as us
  await toolOf(agent.pid);
  await stopTree({ pid: agent.pid, startedAt: start(agent.pid) }, "graceful", { graceMs: 2000, excludePgids: [myPgid()] });
  expect(alive(bystander.pid)).toBe(true);
  expect(alive(process.pid)).toBe(true);
});

test("a group the agent did not lead is never expanded (N1)", async () => {
  const other = Bun.spawn(["sh", "-c", "sleep 30"], { detached: true }); live.push(other.pid); // its own group
  // A stand-in agent whose command joins `other`'s group is simulated by a fake table:
  const table = listProcesses();
  const fake = { pid: 999_001, ppid: process.pid, pgid: myPgid(), startedAt: "1.000000", state: "running" as const };
  const joiner = { pid: 999_002, ppid: 999_001, pgid: other.pid, startedAt: "1.000001", state: "running" as const };
  const killed: number[] = [];
  await stopTree({ pid: fake.pid, startedAt: fake.startedAt }, "forced", {
    graceMs: 0, excludePgids: [myPgid()],
    deps: { list: () => [...table, fake, joiner], kill: (t) => { killed.push(t); }, sleep: async () => {}, now: Date.now },
  });
  expect(killed).not.toContain(-other.pid);
  expect(killed).not.toContain(other.pid);
});

test("a process that exits between listing and signalling is not a survivor (Review Focus 3)", async () => {
  const p = Bun.spawn(["sh", "-c", "sleep 0.05"]); live.push(p.pid);
  const rep = await stopTree({ pid: p.pid, startedAt: start(p.pid) }, "graceful", { graceMs: 1000, excludePgids: [myPgid()] });
  expect(rep.survivors).toEqual([]);
});

test("stopGroup on an already empty group returns at once (normal finish pays nothing)", async () => {
  const p = Bun.spawn(["sh", "-c", "exit 0"], { detached: true }); await p.exited;
  const t0 = performance.now();
  const rep = await stopGroup(p.pid, "graceful", { graceMs: 5000 });
  expect(performance.now() - t0).toBeLessThan(100);
  expect(rep.survivors).toEqual([]);
});

test("stopGroup stops a background child a command left in its group", async () => {
  const p = Bun.spawn(["sh", "-c", "sleep 30 & exit 0"], { detached: true }); await p.exited;
  const rep = await stopGroup(p.pid, "graceful", { graceMs: 2000 });
  expect(rep.stopped.length).toBeGreaterThan(0);
  expect(listProcesses().some((q) => q.pgid === p.pid && q.state !== "zombie")).toBe(false);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bun test test/util/process/stop.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

```ts
// src/util/process/stop.ts
import { listProcesses, type ProcInfo } from "./proc-table.ts";

/** Stop functions (ENG-485 §6). "Gone" is always read from the process table, including its state
 *  field; a zombie counts as gone, and kill(pid, 0) is never used (it succeeds on a zombie). */
export interface StopReport { stopped: ProcInfo[]; survivors: ProcInfo[] }
export interface StopDeps {
  list: () => ProcInfo[];
  kill: (target: number, sig: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
export const realStopDeps: StopDeps = {
  list: listProcesses,
  kill: (t, s) => { try { process.kill(t, s); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } },
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};
const POLL_MS = 50;
const CONFIRM_MS = 500;
const key = (p: { pid: number; startedAt: string }) => `${p.pid}:${p.startedAt}`;

export function groupMembers(pgid: number, table: ProcInfo[]): ProcInfo[] {
  return table.filter((p) => p.pgid === pgid && p.state !== "zombie");
}

/** Grow `seen` from `table`: every descendant of the root, plus every member of a group LED by a
 *  collected process (group id === its pid; the leader may have exited since, §6.1). Groups in
 *  `exclude` (Styre's own, the owner's) are never expanded. The collection only grows. */
function collect(root: { pid: number; startedAt: string }, table: ProcInfo[], seen: Map<string, ProcInfo>, exclude: Set<number>) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const rootNow = byPid.get(root.pid);
  if (rootNow && rootNow.startedAt === root.startedAt) seen.set(key(rootNow), rootNow);
  let grew = true;
  while (grew) {
    grew = false;
    const pids = new Set([...seen.values()].map((p) => p.pid));
    for (const p of table) {
      if (seen.has(key(p))) continue;
      const childOf = pids.has(p.ppid);
      const ledGroup = pids.has(p.pgid) && !exclude.has(p.pgid);
      if (childOf || ledGroup) { seen.set(key(p), p); grew = true; }
    }
  }
}
function stillAlive(seen: Map<string, ProcInfo>, table: ProcInfo[]): ProcInfo[] {
  const now = new Map(table.map((p) => [key(p), p]));
  return [...seen.values()].filter((p) => { const n = now.get(key(p)); return n !== undefined && n.state !== "zombie"; });
}

export async function stopTree(
  root: { pid: number; startedAt: string },
  how: "graceful" | "forced",
  opts: { graceMs: number; excludePgids: number[]; deps?: StopDeps; abort?: { forced: boolean } },
): Promise<StopReport> {
  const d = opts.deps ?? realStopDeps;
  const exclude = new Set(opts.excludePgids);
  const seen = new Map<string, ProcInfo>();
  collect(root, d.list(), seen, exclude);
  if (how === "graceful") {
    for (const p of stillAlive(seen, d.list())) d.kill(p.pid, "SIGTERM");
    const deadline = d.now() + opts.graceMs;
    while (d.now() < deadline && !opts.abort?.forced) {
      const t = d.list(); collect(root, t, seen, exclude);
      if (stillAlive(seen, t).length === 0) return { stopped: [...seen.values()], survivors: [] };
      await d.sleep(POLL_MS);
    }
  }
  const t = d.list(); collect(root, t, seen, exclude);
  for (const p of stillAlive(seen, t)) d.kill(p.pid, "SIGKILL");
  const confirmBy = d.now() + CONFIRM_MS;
  let survivors = stillAlive(seen, d.list());
  while (survivors.length > 0 && d.now() < confirmBy) { await d.sleep(POLL_MS); survivors = stillAlive(seen, d.list()); }
  return { stopped: [...seen.values()].filter((p) => !survivors.includes(p)), survivors };
}

export async function stopGroup(
  pgid: number,
  how: "graceful" | "forced",
  opts: { graceMs: number; deps?: StopDeps; abort?: { forced: boolean } },
): Promise<StopReport> {
  const d = opts.deps ?? realStopDeps;
  const first = groupMembers(pgid, d.list());
  if (first.length === 0) return { stopped: [], survivors: [] };
  const stopped = new Map(first.map((p) => [key(p), p]));
  if (how === "graceful") {
    d.kill(-pgid, "SIGTERM");
    const deadline = d.now() + opts.graceMs;
    while (d.now() < deadline && !opts.abort?.forced) {
      const m = groupMembers(pgid, d.list());
      if (m.length === 0) return { stopped: [...stopped.values()], survivors: [] };
      for (const p of m) stopped.set(key(p), p);
      await d.sleep(POLL_MS);
    }
  }
  d.kill(-pgid, "SIGKILL");
  const confirmBy = d.now() + CONFIRM_MS;
  let survivors = groupMembers(pgid, d.list());
  while (survivors.length > 0 && d.now() < confirmBy) { await d.sleep(POLL_MS); survivors = groupMembers(pgid, d.list()); }
  return { stopped: [...stopped.values()], survivors };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/util/process/stop.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Break it on purpose**

1. Remove the `!exclude.has(p.pgid)` condition. The bystander test must fail.
2. Replace the second `collect(...)` before SIGKILL with nothing. The stubborn CLI test must
   still pass, because the first listing collected the CLI while the wrapper was alive.
3. Remove the first `collect` as well, so the CLI is first seen after the wrapper died. That test
   must now fail.

Restore all three.

- [ ] **Step 7: Commit**

```bash
git add src/util/process/stop.ts test/util/process/stop.test.ts test/lifecycle/fixtures
git commit -m "feat(process): stop an agent tree and a command group without touching other groups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The door

**Files:**
- Create: `src/util/process/door.ts`
- Test: `test/util/process/door.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  ```ts
  export class RunInterrupted extends Error {}
  export function isStopping(): boolean;
  export function beginStopping(): void;            // called only by signals.ts
  export const stopAbort: { forced: boolean };      // flipped by a second signal
  export interface LaunchContext { ident: string | null; stepId: number | null; worktree: string | null; untrackedBefore?: string[]; dispatchRowId?: number }
  export interface LaunchSpec { argv: string[]; cwd: string; env: Record<string, string | undefined>; stdin?: Uint8Array; kind: "agent" | "group"; context: LaunchContext }
  export interface LaunchHandle {
    proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
    record: LaunchRecord;
    interrupted: boolean;                         // set when the handler stopped it
    stop(how: "graceful" | "forced"): Promise<StopReport>;
    finish(): Promise<StopReport>;                // after the leader exited: stop leftovers (group) and release
  }
  export function launch(spec: LaunchSpec): LaunchHandle;
  export function liveLaunches(): LaunchHandle[];
  export interface BlockingResult { exitCode: number | null; success: boolean; stdout: string; stderr: string; timedOut: boolean }
  export function runBlocking(argv: string[], opts: { cwd?: string; timeoutMs: number; env?: Record<string, string | undefined>; cleanup?: boolean; stdin?: Uint8Array }): BlockingResult;
  export function launchDiagnostic(argv: string[], opts: { timeoutMs: number }): BlockingResult;
  export interface InFlightStep { stepId: number; startedAt: string; ident: string; headAtStart: string | null; headAtStop: string | null }
  export function beginStep(s: Omit<InFlightStep, "headAtStop">): void;
  export function noteHead(sha: string): void;
  export function endStep(): void;
  export function inFlightStep(): InFlightStep | null;
  export function selfIdentity(): { pid: number; startedAt: string; pgid: number };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/util/process/door.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../../src/util/process/door.ts";
import { listRecords } from "../../../src/util/process/records.ts";
import { listProcesses } from "../../../src/util/process/proc-table.ts";

let state: string; const saved = process.env.XDG_STATE_HOME;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), "styre-door-")); process.env.XDG_STATE_HOME = state; door.__resetForTests(); });
afterEach(() => { process.env.XDG_STATE_HOME = saved; });
const ctx = { ident: "ENG-1", stepId: 1, worktree: null };

test("a launch is recorded on disk and in memory, and released after it finishes", async () => {
  const h = door.launch({ argv: ["sh", "-c", "exit 0"], cwd: process.cwd(), env: process.env, kind: "group", context: ctx });
  expect(door.liveLaunches()).toContain(h);
  expect(listRecords().map((l) => l.record.pid)).toEqual([h.proc.pid]);
  await h.proc.exited; await h.finish();
  expect(door.liveLaunches()).not.toContain(h);
  expect(listRecords()).toEqual([]);
});

test("group launches lead their own group; agent launches stay in ours", () => {
  const g = door.launch({ argv: ["sleep", "5"], cwd: process.cwd(), env: process.env, kind: "group", context: ctx });
  const a = door.launch({ argv: ["sleep", "5"], cwd: process.cwd(), env: process.env, kind: "agent", context: ctx });
  const t = listProcesses();
  expect(t.find((p) => p.pid === g.proc.pid)!.pgid).toBe(g.proc.pid);
  expect(t.find((p) => p.pid === a.proc.pid)!.pgid).toBe(door.selfIdentity().pgid);
  return Promise.all([g.stop("forced"), a.stop("forced")]);
});

test("an unwritable state folder stops what it just started and throws (Review Focus 4)", () => {
  chmodSync(state, 0o500);
  try {
    expect(() => door.launch({ argv: ["sleep", "30"], cwd: process.cwd(), env: process.env, kind: "group", context: ctx })).toThrow(/launch record/);
    expect(listProcesses().some((p) => p.ppid === process.pid && p.state !== "zombie")).toBe(false);
  } finally { chmodSync(state, 0o700); }
});

test("once stopping, launch and runBlocking refuse with RunInterrupted; cleanup and diagnostics still run", () => {
  door.beginStopping();
  expect(() => door.launch({ argv: ["true"], cwd: process.cwd(), env: process.env, kind: "group", context: ctx })).toThrow(door.RunInterrupted);
  expect(() => door.runBlocking(["true"], { timeoutMs: 1000 })).toThrow(door.RunInterrupted);
  expect(door.runBlocking(["true"], { timeoutMs: 1000, cleanup: true }).success).toBe(true);
  expect(door.launchDiagnostic(["true"], { timeoutMs: 1000 }).success).toBe(true);
});

test("runBlocking enforces its timeout", () => {
  const r = door.runBlocking(["sleep", "5"], { timeoutMs: 100 });
  expect(r.timedOut).toBe(true);
});

test("the in-flight step records headAtStart and the latest reported head", () => {
  door.beginStep({ stepId: 3, startedAt: "t", ident: "ENG-1", headAtStart: "aaa" });
  door.noteHead("bbb"); door.noteHead("ccc");
  expect(door.inFlightStep()).toEqual({ stepId: 3, startedAt: "t", ident: "ENG-1", headAtStart: "aaa", headAtStop: "ccc" });
  door.endStep();
  expect(door.inFlightStep()).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/util/process/door.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/util/process/door.ts
import { bootId, listProcesses, probe } from "./proc-table.ts";
import { type LaunchRecord, removeRecord, writeRecord } from "./records.ts";
import { type StopReport, stopGroup, stopTree } from "./stop.ts";

/** The door (ENG-485 §5.1): the ONLY code allowed to start a process (with proc-table.ts's `ps`
 *  fallback). Long-running launches are recorded in memory and on disk; blocking calls take a
 *  required timeout. While a stop is in progress (§7.3 step 1) it refuses everything except cleanup
 *  calls and diagnostics. */
export class RunInterrupted extends Error {
  constructor(message = "run interrupted by a stop signal") { super(message); this.name = "RunInterrupted"; }
}
export const GRACE_MS = 5_000;
let stopping = false;
export const stopAbort = { forced: false };
export function isStopping(): boolean { return stopping; }
export function beginStopping(): void { stopping = true; }

let self: { pid: number; startedAt: string; pgid: number } | null = null;
export function selfIdentity() {
  if (self) return self;
  const p = probe(process.pid);
  if (p.kind !== "alive") throw new Error("cannot read Styre's own process entry");
  self = { pid: process.pid, startedAt: p.info.startedAt, pgid: p.info.pgid };
  return self;
}

export interface LaunchContext { ident: string | null; stepId: number | null; worktree: string | null; untrackedBefore?: string[]; dispatchRowId?: number }
export interface LaunchSpec { argv: string[]; cwd: string; env: Record<string, string | undefined>; stdin?: Uint8Array; kind: "agent" | "group"; context: LaunchContext }
export interface LaunchHandle {
  proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  record: LaunchRecord;
  context: LaunchContext;
  interrupted: boolean;
  stop(how: "graceful" | "forced"): Promise<StopReport>;
  finish(): Promise<StopReport>;
}
const live = new Set<LaunchHandle>();
export function liveLaunches(): LaunchHandle[] { return [...live]; }

export function launch(spec: LaunchSpec): LaunchHandle {
  if (stopping) throw new RunInterrupted();
  const proc = Bun.spawn(spec.argv, {
    cwd: spec.cwd, env: spec.env,
    stdin: spec.stdin ?? "ignore", stdout: "pipe", stderr: "pipe",
    detached: spec.kind === "group",
  }) as LaunchHandle["proc"];
  const me = selfIdentity();
  const p = probe(proc.pid);
  const startedAt = p.kind === "alive" ? p.info.startedAt : "0";
  const record: LaunchRecord = {
    version: 1, pid: proc.pid, startedAt, bootId: bootId(), kind: spec.kind,
    ident: spec.context.ident, stepId: spec.context.stepId, worktree: spec.context.worktree,
    command: spec.argv.join(" ").slice(0, 200), owner: me,
  };
  try {
    if (p.kind === "alive") writeRecord(record);
  } catch (err) {
    try { process.kill(spec.kind === "group" ? -proc.pid : proc.pid, "SIGKILL"); } catch {}
    throw new Error(`could not write the launch record, so the launch was stopped: ${String(err)}`);
  }
  const doStop = async (how: "graceful" | "forced"): Promise<StopReport> =>
    spec.kind === "group"
      ? stopGroup(proc.pid, how, { graceMs: GRACE_MS, abort: stopAbort })
      : stopTree({ pid: proc.pid, startedAt }, how, { graceMs: GRACE_MS, excludePgids: [me.pgid], abort: stopAbort });
  const release = (rep: StopReport) => {
    if (rep.survivors.length === 0) { removeRecord(record); live.delete(handle); }
    return rep;
  };
  const handle: LaunchHandle = {
    proc, record, context: spec.context, interrupted: false,
    stop: async (how) => release(await doStop(how)),
    finish: async () => release(spec.kind === "group" ? await doStop("graceful") : { stopped: [], survivors: [] }),
  };
  live.add(handle);
  if (stopping) { handle.interrupted = true; void handle.stop("forced"); }
  return handle;
}

export interface BlockingResult { exitCode: number | null; success: boolean; stdout: string; stderr: string; timedOut: boolean }
function spawnBlocking(argv: string[], opts: { cwd?: string; timeoutMs: number; env?: Record<string, string | undefined>; stdin?: Uint8Array }): BlockingResult {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd, env: opts.env ?? process.env, stdin: opts.stdin, timeout: opts.timeoutMs });
  const timedOut = r.exitedDueToTimeout === true;
  return { exitCode: r.exitCode, success: r.success, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut };
}
export function runBlocking(argv: string[], opts: { cwd?: string; timeoutMs: number; env?: Record<string, string | undefined>; cleanup?: boolean; stdin?: Uint8Array }): BlockingResult {
  if (stopping && !opts.cleanup) throw new RunInterrupted();
  return spawnBlocking(argv, opts);
}
/** Only signals.ts, sweep.ts, leftovers.ts and proc-table.ts may call this (source guard, Task 7). */
export function launchDiagnostic(argv: string[], opts: { timeoutMs: number }): BlockingResult {
  return spawnBlocking(argv, { timeoutMs: opts.timeoutMs });
}

export interface InFlightStep { stepId: number; startedAt: string; ident: string; headAtStart: string | null; headAtStop: string | null }
let inFlight: InFlightStep | null = null;
export function beginStep(s: Omit<InFlightStep, "headAtStop">): void { inFlight = { ...s, headAtStop: s.headAtStart }; }
export function noteHead(sha: string): void { if (inFlight) inFlight.headAtStop = sha; }
export function endStep(): void { inFlight = null; }
export function inFlightStep(): InFlightStep | null { return inFlight ? { ...inFlight } : null; }

/** Test seam only. */
export function __resetForTests(): void { stopping = false; stopAbort.forced = false; live.clear(); inFlight = null; self = null; }
```

> **Note on `exitedDueToTimeout`:** confirm the property name on Bun 1.4's `SyncSubprocess` with a
> one-line test before relying on it. If it is absent, detect a timeout as `r.signalCode ===
> "SIGTERM"` with `r.exitCode === null`. Write the test that pins whichever is true.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/util/process/door.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/util/process/door.ts test/util/process/door.test.ts
git commit -m "feat(process): one door for every launch, with records and a stopping state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase B — Routing every launch through the door

### Task 5: `runCommand` and `runBoundedCommand` on the door

These now give each command a group, stop leftovers before reading output, and read output for at
most 5 s (§6.2). Together these fix the existing hang (review round 2, N6).

**Files:**
- Modify: `src/util/run-command.ts` (whole function body)
- Modify: `src/util/run-bounded-command.ts` (whole function body)
- Modify the callers that journal pids:
  - `src/dispatch/handlers.ts:1751,2008,2032`: delete the `onSpawn: (pid) => setPid(ctx.db, ctx.step.id, -pid)` lines.
  - `src/dispatch/code-review.ts:151-153`: delete the comment and the `onSpawn` line.
  - `src/dispatch/suite-observation.ts:87`, `src/dispatch/baseline-rerun.ts:66`: remove the
    `onSpawn` field from the option types.
- Test: `test/util/run-command.test.ts`, `test/util/run-bounded-command.test.ts` (extend)

**Interfaces:**
- Consumes: `launch`, `RunInterrupted`, `isStopping` (Task 4).
- Produces:
  - `runCommand(command, { cwd, timeoutMs, context? })` keeps returning `CommandResult` and throws
    `RunInterrupted` when the handler stopped it. `runBoundedCommand` keeps its signature, without
    `onSpawn`.
  - `context?: LaunchContext` defaults to `{ ident: null, stepId: null, worktree: opts.cwd }`.

- [ ] **Step 1: Write the failing tests** (append to `test/util/run-command.test.ts`)

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProcesses } from "../../src/util/process/proc-table.ts";
import * as door from "../../src/util/process/door.ts";

test("a background child holding the pipe no longer hangs runCommand (N6)", async () => {
  const t0 = performance.now();
  const r = await runCommand("sleep 6 & echo hi", { cwd: process.cwd(), timeoutMs: 2000 });
  expect(performance.now() - t0).toBeLessThan(2000 + 5000 + 1000);
  expect(r.stdout).toContain("hi");
});

test("a leftover in the command's group is stopped after a normal exit", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "styre-left-")), "pid");
  await runCommand(`sleep 30 & echo $! > "${file}"; exit 0`, { cwd: process.cwd(), timeoutMs: 5000 });
  const pid = Number(await Bun.file(file).text());
  expect(listProcesses().some((p) => p.pid === pid && p.state !== "zombie")).toBe(false);
});

test("a timeout stops the whole group, not just sh", async () => {
  const r = await runCommand("sleep 30 & sleep 30", { cwd: process.cwd(), timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
  expect(listProcesses().some((p) => p.ppid === process.pid && p.state !== "zombie")).toBe(false);
});

test("a command stopped by the handler throws RunInterrupted", async () => {
  const p = runCommand("sleep 30", { cwd: process.cwd(), timeoutMs: 60_000 });
  await Bun.sleep(100);
  door.beginStopping();
  for (const h of door.liveLaunches()) { h.interrupted = true; await h.stop("graceful"); }
  await expect(p).rejects.toBeInstanceOf(door.RunInterrupted);
  door.__resetForTests();
});
```

Add the same four cases to `test/util/run-bounded-command.test.ts`, calling `runBoundedCommand`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/util/run-command.test.ts test/util/run-bounded-command.test.ts`
Expected:
- the first test fails with a duration of about 6 s;
- the leftover test fails, because the pid is still alive;
- the interrupt test fails, because the promise resolves instead of throwing.

- [ ] **Step 3: Implement `runCommand`**

```ts
// src/util/run-command.ts — replace runCommand's body (keep the CommandResult type and doc comment,
// updating it: the command leads its own group; a timeout or a stop reaches every member; after a
// normal exit, leftovers are stopped before the output is read, for at most DRAIN_LIMIT_MS).
import { verifyEnv } from "../agent/agent-env.ts";
import { type LaunchContext, RunInterrupted, launch } from "./process/door.ts";

export const DRAIN_LIMIT_MS = 5_000;

async function readLimited(s: ReadableStream<Uint8Array>, limitMs: number): Promise<{ text: string; cut: boolean }> {
  const reader = s.getReader(); const dec = new TextDecoder(); let text = ""; let cut = false;
  const deadline = Date.now() + limitMs;
  while (true) {
    const left = deadline - Date.now();
    if (left <= 0) { cut = true; void reader.cancel(); break; }
    const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
    if (r === null) { cut = true; void reader.cancel(); break; }
    if (r.done) break;
    text += dec.decode(r.value, { stream: true });
  }
  return { text, cut };
}

export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; context?: LaunchContext },
): Promise<CommandResult> {
  const h = launch({
    argv: ["sh", "-c", command], cwd: opts.cwd, env: verifyEnv(process.env), kind: "group",
    context: opts.context ?? { ident: null, stepId: null, worktree: opts.cwd },
  });
  const out = readLimited(h.proc.stdout, opts.timeoutMs + DRAIN_LIMIT_MS);
  const err = readLimited(h.proc.stderr, opts.timeoutMs + DRAIN_LIMIT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    h.proc.exited.then(() => "exited" as const),
    new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), opts.timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (h.interrupted) throw new RunInterrupted();
  if (outcome === "timeout") {
    await h.stop("graceful");
    if (h.interrupted) throw new RunInterrupted();
    return { exitCode: null, stdout: "", stderr: "", timedOut: true };
  }
  await h.finish(); // §6.2: check the group, stop leftovers, THEN read the rest of the output
  if (h.interrupted) throw new RunInterrupted();
  const [o, e] = await Promise.all([out, err]);
  const note = o.cut || e.cut ? "\n[output read limit reached]" : "";
  return { exitCode: h.proc.exitCode, stdout: o.text, stderr: e.text + note, timedOut: false };
}
```

- [ ] **Step 4: Implement `runBoundedCommand`**

Same structure, keeping its existing behaviour:
- the 64 KiB capture that keeps the head and the tail (`capture`);
- `truncated`;
- `verifyEnv`;
- `stdio: ignore` for stdin.

Replace `spawn(... detached: true ...)` with `launch({ ..., kind: "group" })`. Replace `finish`'s
`process.kill(-proc.pid, "SIGKILL")` with `await h.finish()` on a normal exit, and with
`await h.stop("graceful")` on a timeout. Throw `RunInterrupted` when `h.interrupted`. Remove the
`onSpawn` option and its "PID journaling failed" branch.

- [ ] **Step 5: Run the tests**

Run: `bun test test/util test/dispatch`
Expected: PASS, including the existing suite observation and review probe tests.

- [ ] **Step 6: Commit**

```bash
git add src/util src/dispatch/handlers.ts src/dispatch/code-review.ts src/dispatch/suite-observation.ts src/dispatch/baseline-rerun.ts test/util
git commit -m "fix(process): give every command a group, stop leftovers before reading output

Fixes runCommand hanging while a background child holds its output pipe, and
stops a command that timed out's whole group instead of sh alone (ENG-485 §6.2).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Agent adapters on the door

**Files:**
- Modify: `src/agent/runner.ts`. Add `interrupted?: true` to `AgentRunResult` and remove `onSpawn`
  from `AgentRunInput`.
- Modify: `src/agent/providers/claude.ts:234-330`, `src/agent/providers/codex.ts:174-190`
- Modify: `src/agent/launch.ts`
- Modify: `src/dispatch/run-dispatch.ts:174`. Delete `onSpawn: (pid) => setPid(...)` and pass the
  `context` instead.
- Modify: `src/agent/fake-runner.ts`. It has no `onSpawn` to remove; keep it compiling.
- Test: `test/agent/providers/claude.test.ts`, `test/agent/launch.test.ts`,
  `test/lifecycle/agent-stop.test.ts` (new)

**Interfaces:**
- Consumes: `launch`, `RunInterrupted`, `GRACE_MS` (Task 4).
- Produces:
  - `AgentRunInput.context?: LaunchContext`;
  - `launchAgent` throws `RunInterrupted` when `result.interrupted`.
  - Timeout: `handle.stop("graceful")`. Startup refusal: `handle.stop("forced")`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/lifecycle/agent-stop.test.ts — the Claude adapter driven against the stand-in agent.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { claudeAgentRunner } from "../../src/agent/providers/claude.ts";
import { launchAgent } from "../../src/agent/launch.ts";
import * as door from "../../src/util/process/door.ts";

const FX = join(import.meta.dir, "fixtures");
const input = { prompt: "x", model: "m", allowedTools: ["Read"], cwd: process.cwd(), timeoutMs: 300 };
/** Count live processes whose command line contains `marker` (tests may spawn; the guard covers src/). */
const running = (marker: string) => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim().split("\n").filter(Boolean).length;
afterEach(() => { Bun.spawnSync(["pkill", "-9", "-f", "sleep 30[0-9]"]); door.__resetForTests(); });

test("a timeout stops the agent gracefully, so its command in its own group is gone too", async () => {
  process.env.STANDIN_SLEEP = "301";
  const r = await claudeAgentRunner(join(FX, "standin-agent.sh")).run(input);
  expect(r.timedOut).toBe(true);
  await Bun.sleep(100);
  expect(running("sleep 301")).toBe(0);
});

test("an agent launched through a wrapper is stopped completely on timeout", async () => {
  process.env.STANDIN_SLEEP = "302";
  const r = await claudeAgentRunner(join(FX, "wrapped-standin.sh")).run(input);
  expect(r.timedOut).toBe(true);
  await Bun.sleep(100);
  expect(running("standin-agent.sh")).toBe(0);
  expect(running("sleep 302")).toBe(0);
});

test("an agent stopped by the handler makes launchAgent throw RunInterrupted", async () => {
  process.env.STANDIN_SLEEP = "303";
  const p = launchAgent(claudeAgentRunner(join(FX, "standin-agent.sh")), { ...input, timeoutMs: 60_000 });
  await Bun.sleep(200);
  door.beginStopping();
  for (const h of door.liveLaunches()) { h.interrupted = true; await h.stop("graceful"); }
  await expect(p).rejects.toBeInstanceOf(door.RunInterrupted);
});
```

Also create the fixture `test/lifecycle/fixtures/wrapped-standin.sh`. It ignores the Claude
arguments the adapter passes and runs the stand-in as a child, without `exec`:

```sh
#!/bin/sh
# test/lifecycle/fixtures/wrapped-standin.sh — a wrapper that does NOT exec (§2.2).
"$(dirname "$0")/standin-agent.sh"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/lifecycle/agent-stop.test.ts`
Expected: FAIL. The adapter sends SIGKILL to the direct child only, so the stand-in's tool command
or the wrapped stand-in survives, and no `RunInterrupted` is thrown.

- [ ] **Step 3: Implement in `claude.ts`**

Replace the `Bun.spawn` block (lines 234–244) and the kills with the door:

```ts
const h = launch({
  argv: [command, ...buildClaudeArgs(input)], cwd: input.cwd, env: agentEnv(process.env),
  stdin: new TextEncoder().encode(input.prompt), kind: "agent",
  context: input.context ?? { ident: null, stepId: null, worktree: input.cwd },
});
const proc = h.proc;
spawned = h;
const kill = () => { void h.stop("forced"); }; // startup refusal: no tool has run yet
```

Then make these edits:
- **Timeout branch:** replace `kill(); stdoutRead.cancel(); …; proc.unref();` with
  `await h.stop("graceful"); stdoutRead.cancel(); stderrRead.cancel();`, then
  `if (h.interrupted) return { ...transportFailure("interrupted", false), interrupted: true };`.
- **After `await proc.exited` on the normal path:** call `await h.finish();`, then
  `if (h.interrupted) return { ...transportFailure("interrupted", false), interrupted: true };`.
- **In `catch`:** replace `spawned?.kill("SIGKILL")` with `await spawned?.stop("forced")`.
- **Delete** the `onSpawn` call and the "killed as a single process … ENG-485" comment, and replace
  it with: "The agent stays in Styre's terminal group (ENG-485 D4). Stops reach a wrapper's child
  and the agent's own command groups through the door (§6.1)."

Apply the same changes to `codex.ts:174-190`. It stays refused by `resolve.ts`, but must compile and
use the door.

- [ ] **Step 4: Implement the `launchAgent` conversion**

```ts
// src/agent/launch.ts — first line of launchAgent's body, after `const result = await runner.run(input);`
if (result.interrupted) throw new RunInterrupted(); // ENG-485 §7.5: shared by run and setup (N5)
```

Import `RunInterrupted` from `../util/process/door.ts`. Update the doc comment to say so.

- [ ] **Step 5: Run the tests**

Run: `bun test test/agent test/lifecycle test/dispatch test/setup`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent src/dispatch/run-dispatch.ts test/agent test/lifecycle
git commit -m "fix(agent): stop agents through the door, gracefully on timeout, reaching wrappers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Blocking calls through `runBlocking`, and the source guard

**Files:**
- Modify every `Bun.spawnSync`, `execFileSync` and `child_process` call site listed under "File
  structure → Modified", replacing it with `runBlocking(argv, { cwd, timeoutMs, env })`.
  - **Timeouts:**

    | Call | Timeout |
    |---|---|
    | local `git` | 30 000 ms |
    | network `git` (`ls-remote`, `push`, `fetch`; `worktree.ts:451,453,480`) | 120 000 ms |
    | `command -v` and `--version` | 5 000 ms |
    | `--help` (`preflight.ts:99`) | 10 000 ms |

  - **Cleanup calls:** mark only the baseline and replay worktree removals with `cleanup: true`
    (`src/dispatch/baseline-rerun.ts:96-99,170-176`, and the matching removal in
    `src/dispatch/replay-harness.ts`).
  - **Keep each call site's existing error behaviour.** `slug.ts` keeps its "null on any failure"
    contract: `runBlocking` returns a result for a missing working folder rather than throwing, so
    wrap it as `slug.ts` already does.
- Modify: `src/dispatch/worktree.ts`. The `git` and `gitRaw` helpers use `runBlocking`.
- Modify: `src/db/client.ts`, `src/db/migrate.ts`, `src/db/repos/run.ts`, if they spawn. Grep first.
- Create: `test/lifecycle/source-guard.test.ts`
- Modify: `test/setup/agent-confinement.test.ts`. Keep its `.run(` guard; it is a different rule.

**Interfaces:**
- Consumes: `runBlocking`, `launchDiagnostic` (Task 4).
- Produces: a build-time guarantee that only `src/util/process/door.ts` and
  `src/util/process/proc-table.ts` spawn, and that `launchDiagnostic` is called only from
  `src/util/process/{signals,sweep,leftovers,proc-table}.ts`.

- [ ] **Step 1: Write the failing guard test**

```ts
// test/lifecycle/source-guard.test.ts — ENG-485 §5.1. Parses imports and calls with the TypeScript
// compiler API, so text inside strings (src/testing/karma.ts:108) is not a false hit.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../..");
const SPAWN_ALLOWED = new Set(["src/util/process/door.ts", "src/util/process/proc-table.ts"]);
const DIAG_ALLOWED = new Set(["src/util/process/door.ts", "src/util/process/signals.ts", "src/util/process/sweep.ts", "src/util/process/leftovers.ts", "src/util/process/proc-table.ts"]);
const CHILD = new Set(["child_process", "node:child_process"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });
}
function offences(path: string): string[] {
  const rel = relative(ROOT, path);
  const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && CHILD.has(n.moduleSpecifier.text) && !SPAWN_ALLOWED.has(rel)) out.push(`${rel}: imports ${n.moduleSpecifier.text}`);
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText(sf);
      if ((t === "Bun.spawn" || t === "Bun.spawnSync") && !SPAWN_ALLOWED.has(rel)) out.push(`${rel}: calls ${t}`);
      if (/(^|\.)launchDiagnostic$/.test(t) && !DIAG_ALLOWED.has(rel)) out.push(`${rel}: calls launchDiagnostic`);
      if (t === "require" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && CHILD.has(n.arguments[0].text) && !SPAWN_ALLOWED.has(rel)) out.push(`${rel}: requires child_process`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("only the door and the process table start processes; only the stop machinery runs diagnostics", () => {
  expect(files(join(ROOT, "src")).flatMap(offences)).toEqual([]);
});

test("the guard catches a direct spawn (it can fail)", () => {
  const tmp = join(ROOT, "src", "__guard_probe__.ts");
  Bun.write(tmp, 'export const x = () => Bun.spawnSync(["true"]);\n');
  try { expect(offences(tmp).length).toBe(1); } finally { require("node:fs").unlinkSync(tmp); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/lifecycle/source-guard.test.ts`
Expected: FAIL. The first test lists about 25 offences; the second passes.

- [ ] **Step 3: Migrate each call site**

Work file by file, re-running the guard after each. A typical change:

```ts
// before (src/config/slug.ts:9)
const res = Bun.spawnSync(["git", ...args], { cwd });
return res.success ? res.stdout.toString().trim() : null;
// after
const res = runBlocking(["git", ...args], { cwd, timeoutMs: 30_000 });
return res.success ? res.stdout.trim() : null;
```

`stdout` is already a string in `BlockingResult`, so drop the `.toString()` calls.

- [ ] **Step 4: Run the guard and the full suite**

Run: `bun test test/lifecycle/source-guard.test.ts && bun test && bunx tsc --noEmit && bun run lint`
Expected: PASS, with zero offences.

- [ ] **Step 5: Commit**

```bash
git add -A src test/lifecycle/source-guard.test.ts
git commit -m "refactor(process): route every blocking call through the door with a timeout

Adds a source guard (TypeScript compiler API) that fails the build if anything
outside the door starts a process (ENG-485 §5.1).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase C — The journal and the interruption

### Task 8: The step journal: the in-flight step, the stopping check, no pids

**Files:**
- Modify: `src/engine/step-journal.ts:103-139`
- Modify: `src/db/repos/workflow-step.ts`. `markRunning` keeps the `pid` option, but callers pass
  none. Delete `setPid` once no caller remains.
- Modify: `src/daemon/advance.ts:141` (pass `readHead`) and its `opts` type
- Modify: `src/dispatch/worktree.ts:74-84` (`commitWorktree`), `:437-440` (`resetWorktreeHard`), and
  `src/dispatch/run-dispatch.ts:354`. Each calls `noteHead(newSha)` after moving HEAD.
- Modify: `src/cli/run.ts` and `src/cli/park.ts`, where they call `runTicket`/`advance`. Pass
  `readHead: () => branchHeadSha(repoPath, branch)`.
- Test: `test/engine/step-journal-stopping.test.ts` (new)

**Interfaces:**
- Consumes: `beginStep`, `endStep`, `noteHead`, `isStopping`, `RunInterrupted` (Task 4).
- Produces:
  - `RunStepParams.readHead?: () => string | null`;
  - `runStep` registers the step in flight for effectful steps, and never records a result while
    stopping.

- [ ] **Step 1: Write the failing tests**

```ts
// test/engine/step-journal-stopping.test.ts
import { expect, test } from "bun:test";
import { openTestDb } from "../helpers/db.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";
import * as door from "../../src/util/process/door.ts";

test("while stopping, a step that RETURNS is not recorded and RunInterrupted is thrown", async () => {
  door.__resetForTests();
  const { db, ticketId } = openTestDb();
  const p = runStep(db, { ticketId, stepKey: "s", stepType: "t", effectful: true, readHead: () => "aaa",
    execute: async () => { door.beginStopping(); return { ok: true }; } });
  await expect(p).rejects.toBeInstanceOf(door.RunInterrupted);
  expect(steps.getByKey(db, ticketId, "s")!.status).toBe("running");
  door.__resetForTests();
});

test("while stopping, a step that THROWS an ordinary error is not marked failed", async () => {
  door.__resetForTests();
  const { db, ticketId } = openTestDb();
  const p = runStep(db, { ticketId, stepKey: "s", stepType: "t", effectful: true,
    execute: async () => { door.beginStopping(); throw new Error("Baseline execution unavailable"); } });
  await expect(p).rejects.toBeInstanceOf(door.RunInterrupted);
  expect(steps.getByKey(db, ticketId, "s")!.status).toBe("running");
  door.__resetForTests();
});

test("the in-flight step carries headAtStart and is cleared after the step", async () => {
  door.__resetForTests();
  const { db, ticketId } = openTestDb();
  let seen: ReturnType<typeof door.inFlightStep> = null;
  await runStep(db, { ticketId, stepKey: "s", stepType: "t", effectful: true, readHead: () => "aaa",
    execute: async () => { door.noteHead("bbb"); seen = door.inFlightStep(); return 1; } });
  expect(seen).toMatchObject({ headAtStart: "aaa", headAtStop: "bbb" });
  expect(door.inFlightStep()).toBeNull();
});

test("runStep no longer journals a pid", async () => {
  const { db, ticketId } = openTestDb();
  await runStep(db, { ticketId, stepKey: "s", stepType: "t", effectful: true,
    execute: async (step) => { expect(steps.getById(db, step.id)!.pid).toBeNull(); return 1; } });
});
```

If `test/helpers/db.ts` has no `openTestDb` that returns a ticket, add one in this task that
migrates a database held in memory and inserts one ticket. Base it on the existing helpers in that
file.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/engine/step-journal-stopping.test.ts`
Expected: FAIL. The step is `succeeded` or `failed`, and the pid is `process.pid`.

- [ ] **Step 3: Implement**

```ts
// src/engine/step-journal.ts — in runStep, replace the effectful block and the try/catch:
if (params.effectful) {
  steps.markRunning(db, step.id, { idempotencyKey: params.idempotencyKey ?? null }); // ENG-485 §5.5: no pid
  const running = steps.getById(db, step.id)!;
  beginStep({ stepId: step.id, startedAt: running.started_at ?? nowUtc(), ident: params.ident ?? String(params.ticketId), headAtStart: params.readHead?.() ?? null });
}
const current = steps.getById(db, step.id);
if (!current) throw new Error(`runStep: step ${step.id} vanished`);
try {
  let result: unknown;
  try {
    result = await params.execute(current);
  } catch (err) {
    if (isStopping()) throw new RunInterrupted(); // §7.5: never record a result while stopping
    throw err;
  }
  if (isStopping()) throw new RunInterrupted();
  db.transaction(() => { steps.markSucceeded(db, step.id, result); params.onSucceed?.(current); })();
  const finished = steps.getById(db, step.id);
  if (!finished) throw new Error(`runStep: step ${step.id} vanished after success`);
  return { step: finished, result, replayed: false };
} catch (err) {
  if (err instanceof ParkSignal || err instanceof RunInterrupted) throw err; // leave 'running'
  steps.markFailed(db, step.id, err);
  throw err;
} finally {
  if (params.effectful) endStep();
}
```

Add `ident?: string` and `readHead?: () => string | null` to `RunStepParams`, and pass
`ident: ticket.ident` and `readHead: opts?.readHead` from `advance.ts:141`. Check where `started_at`
is set: if `markRunning` does not set it, set it there in the same statement, and assert it in the
test.

In `worktree.ts`, `commitWorktree` calls `noteHead(sha)` before returning when `changed` is true,
and `resetWorktreeHard` calls `noteHead(sha)` after the reset. The same goes for the inline reset in
`run-dispatch.ts:354`, which now uses `resetWorktreeHard`.

Also delete the `onSpawn`/`setPid` imports this leaves unused.

- [ ] **Step 4: Run the tests**

Run: `bun test test/engine test/daemon test/dispatch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine src/daemon/advance.ts src/db/repos/workflow-step.ts src/dispatch src/cli/run.ts src/cli/park.ts test/engine test/helpers
git commit -m "feat(journal): track the step in flight and record nothing while stopping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Recording the interruption, and matching it on resume

**Files:**
- Create: `src/util/process/interruption.ts`
- Modify: `src/telemetry/emitter.ts`. Export `toEvent` and `runCtx`; no behaviour change.
- Modify: `src/daemon/recover.ts` (whole file)
- Modify: `src/cli/park.ts:414`. Pass `{ inPlace, repoPath, branch, acceptHead: args.acceptHead }`
  to `recover`.
- Modify: `src/cli/run.ts:308-331` (`--fresh`) and `src/cli/clean.ts` (`reapEffort`). In in-place
  mode, call `undoInterruptedEdits` before discarding the checkpoint.
- Test: `test/lifecycle/interruption.test.ts`

**Interfaces:**
- Consumes: `InFlightStep`, `liveLaunches` (Task 4); `undoAttempt` and `resetWorktreeHard`
  (`worktree.ts`); `decrementAttempt` and `appendEvent`; `completeDispatch`.
- Produces:
  ```ts
  export interface InterruptionPayload {
    event: "interrupted"; stepId: number; attempt: number; startedAt: string; signal: string;
    worktree: string | null; untrackedBefore: string[] | null; dispatchRowId: number | null;
    headAtStart: string | null; headAtStop: string | null;
  }
  export function recordInterruption(dbPath: string, a: { ticketId: number; signal: string; step: InFlightStep | null; agent: LaunchContext | null }): EventLogRow | null;
  export function findInterruption(db: Database, step: WorkflowStepRow): InterruptionPayload | null;
  export function undoInterruptedEdits(p: InterruptionPayload, mode: { inPlace: boolean; repoPath: string }): string | null; // returns a message to print, or null
  export function resetBranchAfterInterruption(db: Database, p: InterruptionPayload, ctx: { inPlace: boolean; repoPath: string; branch: string; acceptHead: boolean }): string | null;
  // recover.ts
  export interface RecoverCtx { inPlace: boolean; repoPath: string; branch: string; acceptHead: boolean; warn: (line: string) => void }
  export function recover(db: Database, ctx?: RecoverCtx): { reset: number; interrupted: number; warned: number };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/lifecycle/interruption.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeTicketDb, makeGitProject } from "../helpers/lifecycle.ts"; // created in Step 3
import { findInterruption, recordInterruption } from "../../src/util/process/interruption.ts";
import { recover } from "../../src/daemon/recover.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";

test("the handler's write gives back the attempt, stores the attempt after the decrement, and closes the dispatch", () => {
  const t = makeTicketDb(); // a running step at attempt 2, with an open dispatch row
  const row = recordInterruption(t.path, { ticketId: t.ticketId, signal: "SIGINT",
    step: { stepId: t.stepId, startedAt: t.startedAt, ident: "ENG-1", headAtStart: null, headAtStop: null },
    agent: { ident: "ENG-1", stepId: t.stepId, worktree: "/w", untrackedBefore: ["old.txt"], dispatchRowId: t.dispatchRowId } });
  expect(row!.kind).toBe("note");
  const db = new Database(t.path);
  const step = steps.getById(db, t.stepId)!;
  expect(step.attempt).toBe(1);
  expect(findInterruption(db, step)).toMatchObject({ attempt: 1, untrackedBefore: ["old.txt"], signal: "SIGINT" });
  expect(db.query("SELECT outcome, partial FROM dispatch WHERE id = ?").get(t.dispatchRowId)).toEqual({ outcome: "interrupted", partial: 1 });
});

test("recover treats a matched step as an interruption: no markFailed, even for a suite step", () => {
  const t = makeTicketDb({ stepKey: "verify:suite" });
  recordInterruption(t.path, { ticketId: t.ticketId, signal: "SIGTERM", step: { stepId: t.stepId, startedAt: t.startedAt, ident: "ENG-1", headAtStart: null, headAtStop: null }, agent: null });
  const db = new Database(t.path);
  const out = recover(db);
  expect(out.interrupted).toBe(1);
  const s = steps.getById(db, t.stepId)!;
  expect(s.status).toBe("pending"); expect(s.error_json).toBeNull();
});

test("an unmatched running step takes today's crash path", () => {
  const t = makeTicketDb({ stepKey: "verify:suite" });
  const db = new Database(t.path);
  recover(db);
  expect(JSON.parse(steps.getById(db, t.stepId)!.error_json!).message).toContain("verification execution interrupted");
});

test("a checks commit interrupted before its rollback is reset on resume, and its dispatch marked reverted (M1)", () => {
  const g = makeGitProject(); // repo with branch at commit A; a step in flight that committed B
  recordInterruption(g.dbPath, { ticketId: g.ticketId, signal: "SIGINT",
    step: { stepId: g.stepId, startedAt: g.startedAt, ident: "ENG-1", headAtStart: g.A, headAtStop: g.B }, agent: null });
  const db = new Database(g.dbPath);
  recover(db, { inPlace: true, repoPath: g.repo, branch: g.branch, acceptHead: false, warn: () => {} });
  expect(g.head()).toBe(g.A);
  expect(db.query("SELECT outcome, branch_head_sha FROM dispatch WHERE id = ?").get(g.dispatchRowId)).toEqual({ outcome: "reverted", branch_head_sha: g.A });
});

test("--accept-head keeps the operator's commit and resets nothing (N1)", () => {
  const g = makeGitProject();
  recordInterruption(g.dbPath, { ticketId: g.ticketId, signal: "SIGINT",
    step: { stepId: g.stepId, startedAt: g.startedAt, ident: "ENG-1", headAtStart: g.A, headAtStop: g.B }, agent: null });
  const C = g.commitAsOperator();
  recover(new Database(g.dbPath), { inPlace: true, repoPath: g.repo, branch: g.branch, acceptHead: true, warn: () => {} });
  expect(g.head()).toBe(C);
});

test("a moved head (not by the step) is never reset, even without --accept-head", () => {
  const g = makeGitProject();
  recordInterruption(g.dbPath, { ticketId: g.ticketId, signal: "SIGINT",
    step: { stepId: g.stepId, startedAt: g.startedAt, ident: "ENG-1", headAtStart: g.A, headAtStop: g.B }, agent: null });
  const C = g.commitAsOperator();
  const lines: string[] = [];
  recover(new Database(g.dbPath), { inPlace: true, repoPath: g.repo, branch: g.branch, acceptHead: false, warn: (l) => lines.push(l) });
  expect(g.head()).toBe(C);
  expect(lines.join("\n")).toContain("remain");
});

test("an older checkpoint's journaled pid produces a warning and no stop (N12)", () => {
  const t = makeTicketDb({ pid: process.pid });
  const lines: string[] = [];
  const out = recover(new Database(t.path), { inPlace: false, repoPath: "/x", branch: "b", acceptHead: false, warn: (l) => lines.push(l) });
  expect(out.warned).toBe(1);
  expect(lines[0]).toContain(String(process.pid));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/lifecycle/interruption.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the helpers**

Create `test/helpers/lifecycle.ts` from the existing `test/helpers/db.ts` and
`test/helpers/git-project.ts`:
- **`makeTicketDb(opts?)`:** migrates a temporary file database, inserts a ticket, a `running`
  workflow step at attempt 2 (the given `stepKey`, default `implement:dispatch`), and an open
  dispatch row for that step. When `opts.pid` is given, it sets the step's `pid` to it. It returns
  `{ path, ticketId, stepId, startedAt, dispatchRowId }`.
- **`makeGitProject()`:** creates a repo on branch `b` with commit A, then commit B on `b`, and the
  same rows as `makeTicketDb`, with the dispatch row's `branch_head_sha = B`. It returns
  `{ repo, branch, A, B, dbPath, ticketId, stepId, startedAt, dispatchRowId, head(), commitAsOperator() }`.

- [ ] **Step 4: Implement `interruption.ts`**

```ts
// src/util/process/interruption.ts
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { appendEvent } from "../../db/repos/event-log.ts";
import { completeDispatch } from "../../db/repos/dispatch.ts";
import * as steps from "../../db/repos/workflow-step.ts";
import type { WorkflowStepRow } from "../../db/repos/workflow-step.ts";
import { nowUtc } from "../time.ts";
import type { InFlightStep, LaunchContext } from "./door.ts";
import { runBlocking } from "./door.ts";
import { undoAttempt } from "../../dispatch/worktree.ts";

export interface InterruptionPayload {
  event: "interrupted"; stepId: number; attempt: number; startedAt: string; signal: string;
  worktree: string | null; untrackedBefore: string[] | null; dispatchRowId: number | null;
  headAtStart: string | null; headAtStop: string | null;
}

/** §7.3 step 6: one synchronous transaction on the handler's OWN connection (the run's connection is
 *  read only by now). Acts only on the step in flight (R5); stores the attempt AFTER the decrement (R6). */
export function recordInterruption(dbPath: string, a: { ticketId: number; signal: string; step: InFlightStep | null; agent: LaunchContext | null }) {
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 2000;");
  try {
    return db.transaction(() => {
      if (!a.step) return appendEvent(db, { ticketId: a.ticketId, kind: "note", reason: "interrupted", payload: { event: "interrupted", signal: a.signal } });
      steps.decrementAttempt(db, a.step.stepId);
      const attempt = steps.getById(db, a.step.stepId)!.attempt;
      const payload: InterruptionPayload = {
        event: "interrupted", stepId: a.step.stepId, attempt, startedAt: a.step.startedAt, signal: a.signal,
        worktree: a.agent?.worktree ?? null, untrackedBefore: a.agent?.untrackedBefore ?? null,
        dispatchRowId: a.agent?.dispatchRowId ?? null, headAtStart: a.step.headAtStart, headAtStop: a.step.headAtStop,
      };
      if (payload.dispatchRowId !== null) completeDispatch(db, payload.dispatchRowId, { outcome: "interrupted", endedAt: nowUtc(), partial: 1 });
      return appendEvent(db, { ticketId: a.ticketId, kind: "note", reason: "interrupted", payload: { ...payload } });
    })();
  } finally { db.close(); }
}

export function findInterruption(db: Database, step: WorkflowStepRow): InterruptionPayload | null {
  const rows = db.query<{ payload_json: string }, [number]>(
    "SELECT payload_json FROM event_log WHERE ticket_id = ? AND kind = 'note' AND reason = 'interrupted' ORDER BY seq DESC",
  ).all(step.ticket_id);
  for (const r of rows) {
    const p = JSON.parse(r.payload_json) as InterruptionPayload;
    if (p.event === "interrupted" && p.stepId === step.id && p.attempt === step.attempt && p.startedAt === step.started_at) return p;
  }
  return null;
}

export function undoInterruptedEdits(p: InterruptionPayload, mode: { inPlace: boolean; repoPath: string }): string | null {
  if (!mode.inPlace || p.untrackedBefore === null || p.worktree === null) return null; // worktree mode: rebuilt fresh (R1)
  if (!existsSync(p.worktree)) return `styre: skipped undoing the interrupted step's edits: ${p.worktree} no longer exists`;
  undoAttempt(p.worktree, new Set(p.untrackedBefore));
  return null;
}

/** §7.5: reset only when the interruption matched, the step moved HEAD, nobody else has moved it
 *  since, and --accept-head was not given (N1). Marks the step's dispatches since its start reverted (N2). */
export function resetBranchAfterInterruption(db: Database, p: InterruptionPayload, ctx: { inPlace: boolean; repoPath: string; branch: string; acceptHead: boolean }): string | null {
  if (p.headAtStart === null || p.headAtStop === null || p.headAtStart === p.headAtStop) return null;
  const cur = runBlocking(["git", "rev-parse", `refs/heads/${ctx.branch}`], { cwd: ctx.repoPath, timeoutMs: 30_000 });
  const current = cur.success ? cur.stdout.trim() : null;
  if (ctx.acceptHead || current !== p.headAtStop)
    return `styre: the interrupted step's commits remain under the current HEAD (${current ?? "unknown"}); nothing was reset`;
  const r = ctx.inPlace
    ? runBlocking(["git", "reset", "--hard", p.headAtStart], { cwd: ctx.repoPath, timeoutMs: 30_000 })
    : runBlocking(["git", "branch", "-f", ctx.branch, p.headAtStart], { cwd: ctx.repoPath, timeoutMs: 30_000 });
  if (!r.success) return `styre: could not return ${ctx.branch} to ${p.headAtStart} (${r.stderr.trim()}); the step's commits remain`;
  db.query("UPDATE dispatch SET outcome = 'reverted', branch_head_sha = ? WHERE step_id = ? AND started_at >= ?").run(p.headAtStart, p.stepId, p.startedAt);
  return null;
}
```

Check the exact module name of `appendEvent` (it lives in `src/db/repos/`; grep
`export function appendEvent`) and fix the import.

- [ ] **Step 5: Rewrite `recover.ts`**

```ts
// src/daemon/recover.ts
import type { Database } from "bun:sqlite";
import * as steps from "../db/repos/workflow-step.ts";
import { StepExecutionError } from "../engine/step-journal.ts";
import { probe } from "../util/process/proc-table.ts";
import { findInterruption, resetBranchAfterInterruption, undoInterruptedEdits } from "../util/process/interruption.ts";
import { isSuiteStep } from "./verification-retry.ts";

export interface RecoverCtx { inPlace: boolean; repoPath: string; branch: string; acceptHead: boolean; warn: (line: string) => void }

/** Crash and interruption recovery (control-loop §6.1, ENG-485 §7.5). Kills nothing: the sweep
 *  (src/util/process/sweep.ts) already stopped any orphan from its launch record. */
export function recover(db: Database, ctx?: RecoverCtx): { reset: number; interrupted: number; warned: number } {
  const running = steps.listByStatus(db, "running");
  let interrupted = 0, warned = 0;
  for (const step of running) {
    if (step.pid !== null && probe(step.pid).kind !== "gone") {
      ctx?.warn(`styre: step '${step.step_key}' was interrupted by an older Styre; pid ${step.pid} may still be running and cannot be identified, so nothing was stopped`);
      warned++;
    }
    const p = findInterruption(db, step);
    if (p) {
      interrupted++;
      if (ctx) {
        const undo = undoInterruptedEdits(p, ctx); if (undo) ctx.warn(undo);
        const reset = resetBranchAfterInterruption(db, p, ctx); if (reset) ctx.warn(reset);
      }
      steps.resetToPending(db, step.id);
      continue;
    }
    if (isSuiteStep(step)) steps.markFailed(db, step.id, new StepExecutionError("verification execution interrupted"));
    steps.resetToPending(db, step.id);
  }
  return { reset: running.length, interrupted, warned };
}
```

In `park.ts:414`, replace `recover(db, realRecoverDeps())` with
`recover(db, { inPlace, repoPath: project.target_repo, branch, acceptHead: args.acceptHead === true, warn: (l) => process.stderr.write(`${l}\n`) })`.
In `run.ts:353`, use `recover(db)`. Delete `realRecoverDeps` and `RecoverDeps`, and update
`test/daemon/recover.test.ts` to the new signature.

For `--fresh` (`run.ts`, before `rmSync(checkpointDir…)`) and `clean` (`reapEffort`, before
`rmSync`), in in-place mode only:
1. Open the checkpoint database read only.
2. For each `running` step with a matched interruption, call `undoInterruptedEdits`.
3. Close the database.

These run after the live lock check, as review round 4 noted.

- [ ] **Step 6: Run the tests**

Run: `bun test test/lifecycle/interruption.test.ts test/daemon test/cli`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/util/process/interruption.ts src/daemon/recover.ts src/cli src/telemetry/emitter.ts test/lifecycle test/helpers test/daemon
git commit -m "feat(recover): record interruptions in one transaction and treat them as free on resume

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The signal handler

**Files:**
- Create: `src/util/process/signals.ts`
- Test: `test/lifecycle/signals.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 9; `toEvent`, `runCtx` (exported in Task 9); `stdoutSink`.
- Produces:
  ```ts
  export const HANDLER_DEADLINE_MS = 6_500;
  export interface HandlerCtx {
    command: "run" | "setup";
    run?: { db: Database; dbPath: string; ticketId: number; ident: string } | null;   // set once the run db is open
    releaseLock?: () => void;
    shutdownAnalytics?: (ms: number) => Promise<void>;
    resumeHint?: () => string | null;
  }
  export interface HandlerDeps { stderr: (s: string) => void; emit: (row: EventLogRow) => void; reraise: (sig: NodeJS.Signals) => void; exit: (code: number) => void; now: () => number; leftovers: (stopped: LaunchHandle[], budgetMs: number) => string[] }
  export function installStopHandlers(ctx: HandlerCtx, deps?: Partial<HandlerDeps>): { setRun(r: HandlerCtx["run"]): void; dispose(): void };
  export async function suspendStopHandlers<T>(fn: () => T | Promise<T>): Promise<T>;
  export async function handleStopSignal(sig: NodeJS.Signals, ctx: HandlerCtx, deps: HandlerDeps): Promise<void>; // exported for tests
  ```

- [ ] **Step 1: Write the failing tests** (they drive `handleStopSignal` with injected dependencies)

```ts
// test/lifecycle/signals.test.ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import { handleStopSignal } from "../../src/util/process/signals.ts";
import { makeTicketDb } from "../helpers/lifecycle.ts";
import { Database } from "bun:sqlite";

const FX = join(import.meta.dir, "fixtures");
function deps(clock = { t: 0 }) {
  const out = { err: [] as string[], emitted: [] as unknown[], reraised: [] as string[], exited: [] as number[] };
  return { out, d: {
    stderr: (s: string) => out.err.push(s), emit: (r: unknown) => out.emitted.push(r),
    reraise: (s: NodeJS.Signals) => out.reraised.push(s), exit: (c: number) => out.exited.push(c),
    now: () => Date.now(), leftovers: () => [],
  } };
}

test("Ctrl-C: signals go out before any write, the message order is exact, and the exit re-raises", async () => {
  door.__resetForTests();
  const h = door.launch({ argv: [join(FX, "standin-agent.sh")], cwd: process.cwd(), env: process.env, kind: "agent", context: { ident: "ENG-1", stepId: 1, worktree: null } });
  await Bun.sleep(200);
  const { out, d } = deps();
  let wroteBeforeSignal = false;
  const origKill = process.kill; let killed = false;
  (process as any).kill = (...a: any[]) => { killed = true; return (origKill as any).apply(process, a); };
  d.stderr = (s: string) => { if (!killed) wroteBeforeSignal = true; out.err.push(s); };
  try { await handleStopSignal("SIGINT", { command: "run", run: null }, d); } finally { (process as any).kill = origKill; }
  expect(wroteBeforeSignal).toBe(false);
  expect(out.err[0]).toBe("styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…\n");
  expect(out.err.some((l) => /^styre: stopped the agent \(pid \d+\) and \d+ of its commands\.\n$/.test(l))).toBe(true);
  expect(out.reraised).toEqual(["SIGINT"]);
  expect(h.interrupted).toBe(true);
  door.__resetForTests();
});

test("SIGTERM opens with the reason", async () => {
  door.__resetForTests();
  const { out, d } = deps();
  await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
  expect(out.err[0]).toBe("styre: received a stop request (SIGTERM) — cleaning up…\n");
  door.__resetForTests();
});

test("the run connection becomes read only and the interruption is written through a second connection", async () => {
  door.__resetForTests();
  const t = makeTicketDb();
  const db = new Database(t.path);
  door.beginStep({ stepId: t.stepId, startedAt: t.startedAt, ident: "ENG-1", headAtStart: null });
  const { out, d } = deps();
  await handleStopSignal("SIGINT", { command: "run", run: { db, dbPath: t.path, ticketId: t.ticketId, ident: "ENG-1" } }, d);
  expect(() => db.query("UPDATE ticket SET title = 'x'").run()).toThrow(/readonly/);
  expect(out.emitted.length).toBe(1);
  expect(out.err.at(-1)).toBe("styre: run interrupted; resume with: styre run --resume ENG-1\n");
  door.__resetForTests();
});

test("the whole handler finishes inside the 6.5 s deadline even with slow leftovers and analytics", async () => {
  door.__resetForTests();
  const { d } = deps();
  d.leftovers = () => { const e = Date.now() + 3000; while (Date.now() < e) {} return []; };
  door.launch({ argv: ["sleep", "30"], cwd: process.cwd(), env: process.env, kind: "agent", context: { ident: "ENG-1", stepId: 1, worktree: process.cwd() } });
  const t0 = Date.now();
  await handleStopSignal("SIGTERM", { command: "run", run: null, shutdownAnalytics: (ms) => Bun.sleep(Math.min(ms, 5000)) }, d);
  expect(Date.now() - t0).toBeLessThan(6_600);
  door.__resetForTests();
});

test("if the re-raise does not end the process (a container's first process), it exits 128 + n", async () => {
  door.__resetForTests();
  const { out, d } = deps();
  await handleStopSignal("SIGTERM", { command: "run", run: null }, d);
  expect(out.exited).toEqual([143]);
  door.__resetForTests();
});
```

In the last test the injected `reraise` returns normally, which simulates the container case.
`handleStopSignal` must then call `deps.exit(128 + n)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/lifecycle/signals.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/util/process/signals.ts
import type { Database } from "bun:sqlite";
import { stdoutSink } from "../../telemetry/emit.ts";
import { runCtx, toEvent } from "../../telemetry/emitter.ts";
import type { EventLogRow } from "../../db/repos/event-log.ts";
import { beginStopping, inFlightStep, type LaunchHandle, liveLaunches, stopAbort } from "./door.ts";
import { recordInterruption } from "./interruption.ts";
import { checkLeftovers } from "./leftovers.ts";
import { constants } from "node:os";

export const HANDLER_DEADLINE_MS = 6_500;
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
export interface HandlerCtx {
  command: "run" | "setup";
  run?: { db: Database; dbPath: string; ticketId: number; ident: string } | null;
  releaseLock?: () => void;
  shutdownAnalytics?: (ms: number) => Promise<void>;
}
export interface HandlerDeps { stderr: (s: string) => void; emit: (row: EventLogRow) => void; reraise: (sig: NodeJS.Signals) => void; exit: (code: number) => void; now: () => number; leftovers: (stopped: LaunchHandle[], budgetMs: number) => string[] }

let first: NodeJS.Signals | null = null;
export async function handleStopSignal(sig: NodeJS.Signals, ctx: HandlerCtx, d: HandlerDeps): Promise<void> {
  if (first !== null) { stopAbort.forced = true; d.stderr("styre: forcing stop…\n"); return; }
  first = sig;
  const deadline = d.now() + HANDLER_DEADLINE_MS;
  // 1. close the door; the run's connection becomes read only (§7.3 step 1)
  beginStopping();
  try { ctx.run?.db.exec("PRAGMA query_only = ON;"); } catch {}
  // 2. signals go out synchronously, BEFORE any write (§2.5)
  const launches = liveLaunches();
  for (const h of launches) h.interrupted = true;
  const stops = launches.map((h) => h.stop("graceful"));
  // 3. speak
  d.stderr(sig === "SIGINT"
    ? "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…\n"
    : `styre: received a stop request (${sig}) — cleaning up…\n`);
  // 4. wait, leaving 1.5 s for the rest
  const graceEnds = deadline - 1_500;
  const reports = await Promise.race([Promise.all(stops), waitUntil(graceEnds, d).then(() => { stopAbort.forced = true; return Promise.all(stops); })]);
  // 5. leftovers, within what remains minus 1 s
  const budget = deadline - d.now() - 1_000;
  const agents = launches.filter((h) => h.record.kind === "agent");
  const leftoverLines = agents.length === 0 ? [] : budget > 200 ? d.leftovers(agents, budget) : ["styre: the leftover check was skipped: no time left before the stop deadline\n"];
  // 6. record (styre run only), on the handler's own connection
  const agent = launches.find((h) => h.record.kind === "agent")?.context ?? null;
  let row: EventLogRow | null = null;
  if (ctx.run) { try { row = recordInterruption(ctx.run.dbPath, { ticketId: ctx.run.ticketId, signal: sig, step: inFlightStep(), agent }); } catch (e) { d.stderr(`styre: could not record the interruption: ${String(e)}\n`); } }
  // 7. telemetry + outcome
  if (row && ctx.run) { try { d.emit(row); } catch {} }
  const agentReport = reports[launches.findIndex((h) => h.record.kind === "agent")];
  if (agentReport) d.stderr(`styre: stopped the agent (pid ${launches.find((h) => h.record.kind === "agent")!.record.pid}) and ${Math.max(0, agentReport.stopped.length - 1)} of its commands.\n`);
  for (const rep of reports) for (const s of rep.survivors) d.stderr(`styre: could not stop pid ${s.pid}; stop it with: kill -9 ${s.pid}\n`);
  for (const l of leftoverLines) d.stderr(l);
  if (ctx.run) d.stderr(`styre: run interrupted; resume with: styre run --resume ${ctx.run.ident}\n`);
  // 8. exit: analytics (bounded), lock LAST (R7), re-raise, fallback
  const left = deadline - d.now();
  if (left > 50 && ctx.shutdownAnalytics) { try { await Promise.race([ctx.shutdownAnalytics(left - 50), Bun.sleep(left - 50)]); } catch {} }
  try { ctx.releaseLock?.(); } catch {}
  d.reraise(sig);
  d.exit(128 + (constants.signals[sig] ?? 0));
}
function waitUntil(t: number, d: HandlerDeps) { return Bun.sleep(Math.max(0, t - d.now())); }

let installed: Map<NodeJS.Signals, () => void> | null = null;
let activeCtx: HandlerCtx | null = null;
const realDeps = (): HandlerDeps => ({
  stderr: (s) => { try { process.stderr.write(s); } catch {} },
  emit: (row) => { if (activeCtx?.run) stdoutSink(toEvent(row, runCtx(activeCtx.run.db))); },
  reraise: (sig) => { for (const [s, h] of installed ?? []) process.removeListener(s, h); process.kill(process.pid, sig); },
  exit: (code) => process.exit(code),
  now: () => Date.now(),
  leftovers: (stopped, budgetMs) => checkLeftovers({ stopped, timeoutMs: budgetMs }),
});
export function installStopHandlers(ctx: HandlerCtx, deps?: Partial<HandlerDeps>) {
  activeCtx = ctx;
  // §7.1: a write after hangup must not kill Styre mid stop (§2.5)
  process.stdout.on("error", () => {}); process.stderr.on("error", () => {});
  const d = { ...realDeps(), ...deps };
  installed = new Map(SIGNALS.map((s) => [s, () => { void handleStopSignal(s, ctx, d); }]));
  for (const [s, h] of installed) process.on(s, h);
  return {
    setRun: (r: HandlerCtx["run"]) => { ctx.run = r; },
    dispose: () => { for (const [s, h] of installed ?? []) process.removeListener(s, h); installed = null; activeCtx = null; },
  };
}
/** §7.1: setup's blocking prompt() would otherwise hold Ctrl-C until Enter (review round 1, finding 3). */
export async function suspendStopHandlers<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = installed;
  for (const [s, h] of saved ?? []) process.removeListener(s, h);
  try { return await fn(); } finally { for (const [s, h] of saved ?? []) process.on(s, h); }
}
export function __resetSignalsForTests() { first = null; installed = null; activeCtx = null; }
```

Make the following refinements while implementing, and add a test for each:
- **The agent report line counts commands.** Count only the processes stopped other than the agent
  itself.
- **The survivor line names the command.** Read the record's `command`, or `ps -o command=` via
  `launchDiagnostic`, so it matches the exact message
  `styre: could not stop <command> (pid <pid>); stop it with: kill -9 <pid>`.
- **Reset `first` in `__resetSignalsForTests`,** and call it in each test's cleanup.

- [ ] **Step 4: Run the tests**

Run: `bun test test/lifecycle/signals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/process/signals.ts test/lifecycle/signals.test.ts
git commit -m "feat(process): the stop signal handler — one deadline, read only db, exact messages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Wiring the handler into `run`, `resume`, `setup`, the error boundary and the outbox

**Files:**
- Modify: `src/cli/run.ts`
  - Install the handlers after config is resolved and before any launch.
  - Call `setRun` right after `openDb`, passing `{ db, dbPath, ticketId, ident }`.
  - Pass `releaseLock`, and an analytics shutdown bounded by `ms`.
- Modify: `src/cli/park.ts` (resume), the same way.
- Modify: `src/cli/setup.ts`
  - Install the handlers with `command: "setup"`.
  - Wrap both `globalThis.prompt` calls (`:200`, `:259`) in `suspendStopHandlers`.
  - Before each `writeFileSync` (`:268` and the environment file), add
    `if (isStopping()) throw new RunInterrupted();`.
- Modify: `src/cli/output.ts` (`guard`). If `isStopping()`, swallow the error and return, whatever
  its type (review round 4, m1). Do the same in `run.ts`'s catch: skip `analytics.cliError` while
  stopping.
- Modify: `src/daemon/projector.ts` (`drainOutbox`). At the top of the loop body, add
  `if (isStopping()) break;` (m2).
- Test: `test/lifecycle/wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 10.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```ts
// test/lifecycle/wiring.test.ts
import { expect, test } from "bun:test";
import * as door from "../../src/util/process/door.ts";
import { guard } from "../../src/cli/output.ts";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { makeOutboxDb } from "../helpers/lifecycle.ts"; // add: a db with 3 pending rows and counting ports

test("an error while stopping is an interruption: no 'internal error' line, no exit code change (m1)", async () => {
  door.__resetForTests(); door.beginStopping();
  const writes: string[] = []; const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: string) => { writes.push(s); return true; };
  const before = process.exitCode;
  try { await guard("run", async () => { throw new Error("attempt to write a readonly database"); }); }
  finally { (process.stderr as any).write = orig; }
  expect(writes.join("")).not.toContain("internal error");
  expect(process.exitCode).toBe(before);
  door.__resetForTests();
});

test("the outbox drain sends nothing once stopping (m2)", async () => {
  door.__resetForTests();
  const o = makeOutboxDb();
  door.beginStopping();
  const r = await drainOutbox(o.db, o.ports);
  expect(r.sent).toBe(0); expect(o.calls()).toBe(0);
  door.__resetForTests();
});
```

Add a third test, for setup at the prompt. Run the compiled entry point under a pseudo terminal
(see Task 15's `pty` helper), send Ctrl-C at the prompt, and assert that setup exits at once with
status 130 and wrote no `profile.json`. Implement it in Task 15, where the pty helper exists, and
reference it here.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/lifecycle/wiring.test.ts`
Expected: FAIL. `guard` prints "internal error", and the drain sends 3.

- [ ] **Step 3: Implement the changes listed under Files**

In `run.ts`:

```ts
const stopHandlers = installStopHandlers({ command: "run", run: null,
  releaseLock: () => { if (lock) releaseRunLock(lock); },
  shutdownAnalytics: async (ms) => { await Promise.race([analytics?.shutdown(), Bun.sleep(ms)]); } });
// … after openDb(dbPath) and the run row:
stopHandlers.setRun({ db, dbPath, ticketId: /* from ingest */, ident });
// … in finally, after the normal path: stopHandlers.dispose();
```

Get `ticketId` from the inserted or ingested ticket row. If it is only known after `runTicket`
begins, call `setRun` from inside `runTicket`'s ingest callback. Add an `onTicket` option to
`runTicket` for that.

- [ ] **Step 4: Run the tests**

Run: `bun test test/lifecycle test/cli test/daemon`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli src/daemon/projector.ts test/lifecycle test/helpers
git commit -m "feat(cli): install the stop handlers in run, resume and setup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase D — The sweep and the leftover check

### Task 12: The leftover check

**Files:**
- Create: `src/util/process/leftovers.ts`
- Modify: `src/daemon/advance.ts`. After an agent dispatch step finishes, start
  `checkLeftoversInBackground(...)` and do not await it.
- Modify: `src/cli/run.ts`, `src/cli/setup.ts`. On normal exit, await pending checks up to their own
  timeout, then run the §7.7 check that the set of live launches held in memory is empty. If it is
  not: stop what remains, print what was stopped, and set exit code 70 (`EXIT.INTERNAL`).
- Test: `test/lifecycle/leftovers.test.ts`

**Interfaces:**
- Consumes: `listProcesses` (Task 1), `launchDiagnostic` and `liveLaunches` (Task 4).
- Produces:
  ```ts
  export const LEFTOVER_TIMEOUT_MS = 5_000;
  export interface Leftover { pid: number; command: string; cwd: string }
  // `since` is a start time token from proc-table (a launch's record.startedAt, or nowToken()).
  export function findLeftovers(a: { worktree: string; since: string; timeoutMs: number; viaDiagnostic: boolean }): Leftover[] | "skipped";
  export function checkLeftovers(a: { stopped: LaunchHandle[]; timeoutMs: number }): string[];  // the handler's step 5
  export function checkLeftoversInBackground(a: { worktree: string; since: string; report: (lines: string[]) => void }): Promise<void>;
  export function pendingLeftoverChecks(): Promise<void>;
  export function formatLeftover(l: Leftover): string; // the exact §9.4 line
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/lifecycle/leftovers.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLeftovers, formatLeftover } from "../../src/util/process/leftovers.ts";
import { nowToken } from "../../src/util/process/proc-table.ts";

test("a detached nohup process in the worktree is reported, not stopped", async () => {
  const wt = mkdtempSync(join(tmpdir(), "styre wt ")); // a space in the path (Review Focus 2)
  const since = nowToken();
  Bun.spawnSync(["sh", "-c", `cd "${wt}" && nohup sleep 30 >/dev/null 2>&1 &`]);
  await Bun.sleep(200);
  const found = findLeftovers({ worktree: wt, since, timeoutMs: 5000, viaDiagnostic: false });
  expect(found).not.toBe("skipped");
  const hit = (found as any[]).find((l) => l.command.includes("sleep 30"));
  expect(hit).toBeDefined();
  expect(formatLeftover(hit)).toBe(`styre: the agent left "${hit.command}" (pid ${hit.pid}) running in the worktree; stop it with: kill ${hit.pid} (if it is not yours)\n`);
  process.kill(hit.pid, "SIGKILL");
});

test("the worktree reached through a symlink still matches (Review Focus 2)", async () => {
  const real = mkdtempSync(join(tmpdir(), "styre-real-"));
  const link = join(mkdtempSync(join(tmpdir(), "styre-link-")), "wt"); symlinkSync(real, link);
  const since = nowToken();
  Bun.spawnSync(["sh", "-c", `cd "${real}" && nohup sleep 31 >/dev/null 2>&1 &`]);
  await Bun.sleep(200);
  const found = findLeftovers({ worktree: link, since, timeoutMs: 5000, viaDiagnostic: false }) as any[];
  const hit = found.find((l) => l.command.includes("sleep 31"));
  expect(hit).toBeDefined(); process.kill(hit.pid, "SIGKILL");
});

test("a process that started before the window is not reported", async () => {
  const wt = mkdtempSync(join(tmpdir(), "styre-wt-"));
  Bun.spawnSync(["sh", "-c", `cd "${wt}" && nohup sleep 32 >/dev/null 2>&1 &`]);
  await Bun.sleep(1200);
  const since = nowToken();
  const found = findLeftovers({ worktree: wt, since, timeoutMs: 5000, viaDiagnostic: false }) as any[];
  expect(found.some((l) => l.command.includes("sleep 32"))).toBe(false);
  Bun.spawnSync(["pkill", "-f", "sleep 32"]);
});
```

These tests spawn fixtures with `Bun.spawnSync`. That is allowed because the source guard covers
`src/` only.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/lifecycle/leftovers.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

The implementation:
- **Linux:** read `/proc/<pid>/cwd` with `readlinkSync`, no process launched.
- **macOS:** run `lsof -a -d cwd -Fpn -u <uid>`:
  - after a step, through `launch` with kind `group` and a 5 s timeout;
  - from the handler or the sweep, through `launchDiagnostic`.
- **Time window:** a process qualifies when
  `tokenValue(p.startedAt) >= tokenValue(since)`, using `listProcesses()` start times. Both are
  proc-table tokens on the same clock, so no conversion is needed.
- **For `checkLeftovers`:** run `findLeftovers` for each stopped agent launch, with
  `worktree = h.context.worktree` and `since = h.record.startedAt`, sharing `timeoutMs`.
- **Matching:** compare `realpathSync(cwd)` with `realpathSync(worktree)` as a path prefix.
- **Exclusions:** leave out every process that belongs to a live launch's tree or group (Task 3's
  `collect` applied to each live record) and Styre itself.
- **Command text:** get it with `ps -o command= -p <pid>` through the diagnostic path, truncated to
  120 characters.
- **Timeouts:** a timeout returns `"skipped"`.
- **Background checks:** `checkLeftoversInBackground` stores its promise in a module set, and
  `pendingLeftoverChecks()` awaits them all.

- [ ] **Step 4: Run the tests**

Run: `bun test test/lifecycle/leftovers.test.ts`
Expected: PASS on macOS locally, and on Linux in CI (Task 15).

- [ ] **Step 5: Commit**

```bash
git add src/util/process/leftovers.ts src/daemon/advance.ts src/cli/run.ts src/cli/setup.ts test/lifecycle/leftovers.test.ts
git commit -m "feat(process): report detached leftovers in the worktree, never stop them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The sweep, in every command

**Files:**
- Create: `src/util/process/sweep.ts`
- Modify: `src/cli/run.ts`, `src/cli/park.ts`, `src/cli/setup.ts`, `src/cli/ls.ts`, `src/cli/clean.ts`,
  `src/cli/migrate.ts`, `src/cli/notify.ts`. Call `await sweepOrphans(...)` first in each command
  body, inside `guard`.
- Test: `test/lifecycle/sweep.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4, 12.
- Produces:
  ```ts
  export interface SweepResult { stopped: LaunchRecord[]; failed: LaunchRecord[]; stale: number; leftoverLines: string[] }
  export async function sweepOrphans(deps?: { stderr?: (s: string) => void }): Promise<SweepResult>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/lifecycle/sweep.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecords, writeRecord } from "../../src/util/process/records.ts";
import { probe, listProcesses } from "../../src/util/process/proc-table.ts";
import { sweepOrphans } from "../../src/util/process/sweep.ts";

const FX = join(import.meta.dir, "fixtures");
let state: string; const saved = process.env.XDG_STATE_HOME;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), "styre-sweep-")); process.env.XDG_STATE_HOME = state; });
afterEach(() => { process.env.XDG_STATE_HOME = saved; });
const startOf = (pid: number) => { const p = probe(pid); if (p.kind !== "alive") throw new Error("gone"); return p.info; };

/** A fake "dead Styre": a short-lived process whose identity we record as the owner. */
async function deadOwner() { const p = Bun.spawn(["true"]); const info = startOf(p.pid); await p.exited; await Bun.sleep(50); return info; }

test("an orphaned agent whose owner is dead is stopped, with the exact message", async () => {
  const owner = await deadOwner();
  const agent = Bun.spawn([join(FX, "standin-agent.sh")]); await Bun.sleep(200);
  const a = startOf(agent.pid);
  writeRecord({ version: 1, pid: a.pid, startedAt: a.startedAt, bootId: null, kind: "agent", ident: "ENG-9", stepId: 1, worktree: null, command: "standin", owner: { pid: owner.pid, startedAt: owner.startedAt, pgid: owner.pgid } });
  const lines: string[] = [];
  const r = await sweepOrphans({ stderr: (s) => lines.push(s) });
  expect(r.stopped.length).toBe(1);
  expect(lines).toContain(`styre: stopped an orphaned agent from ENG-9 (pid ${a.pid}), left running when Styre was force quit\n`);
  expect(probe(agent.pid).kind === "gone" || (probe(agent.pid) as any).info?.state === "zombie").toBe(true);
  expect(listRecords()).toEqual([]);
});

test("a live owner's launch is left alone (Review Focus 5)", async () => {
  const me = startOf(process.pid);
  const child = Bun.spawn(["sleep", "30"]); const c = startOf(child.pid);
  writeRecord({ version: 1, pid: c.pid, startedAt: c.startedAt, bootId: null, kind: "group", ident: "ENG-8", stepId: 1, worktree: null, command: "sleep", owner: { pid: me.pid, startedAt: me.startedAt, pgid: me.pgid } });
  const r = await sweepOrphans({ stderr: () => {} });
  expect(r.stopped).toEqual([]);
  expect(probe(child.pid).kind).toBe("alive");
  expect(listRecords().length).toBe(1);
  child.kill("SIGKILL");
});

test("a reused pid (start time differs) is left alone, reported, and the record deleted", async () => {
  const owner = await deadOwner();
  const victim = Bun.spawn(["sleep", "30"]); const v = startOf(victim.pid);
  writeRecord({ version: 1, pid: v.pid, startedAt: "1.000000", bootId: null, kind: "agent", ident: "ENG-7", stepId: 1, worktree: null, command: "old", owner: { pid: owner.pid, startedAt: owner.startedAt, pgid: owner.pgid } });
  const lines: string[] = [];
  const r = await sweepOrphans({ stderr: (s) => lines.push(s) });
  expect(r.stale).toBe(1); expect(probe(victim.pid).kind).toBe("alive");
  expect(lines.join("")).toContain(String(v.pid));
  expect(listRecords()).toEqual([]);
  victim.kill("SIGKILL");
});

test("a script that started Styre without job control survives the sweep (N1, Review Focus 1)", async () => {
  // The script and the agent share a group whose id is the script's pid.
  const script = Bun.spawn(["sh", "-c", `"${join(FX, "standin-agent.sh")}" & wait`], { detached: true });
  await Bun.sleep(300);
  const agentInfo = listProcesses().find((p) => p.ppid === script.pid)!;
  const owner = await deadOwner();
  writeRecord({ version: 1, pid: agentInfo.pid, startedAt: agentInfo.startedAt, bootId: null, kind: "agent", ident: "ENG-6", stepId: 1, worktree: null, command: "standin", owner: { pid: owner.pid, startedAt: owner.startedAt, pgid: script.pid } });
  await sweepOrphans({ stderr: () => {} });
  expect(probe(script.pid).kind).toBe("alive");
  script.kill("SIGKILL");
});

test("a claim left by a dead sweeper is retaken (finding 8)", async () => {
  const owner = await deadOwner(); const sweeper = await deadOwner();
  const agent = Bun.spawn(["sleep", "30"]); const a = startOf(agent.pid);
  writeRecord({ version: 1, pid: a.pid, startedAt: a.startedAt, bootId: null, kind: "agent", ident: "ENG-5", stepId: 1, worktree: null, command: "sleep", owner: { pid: owner.pid, startedAt: owner.startedAt, pgid: owner.pgid } });
  const { claim } = await import("../../src/util/process/records.ts");
  claim(listRecords()[0], { pid: sweeper.pid, startedAt: sweeper.startedAt });
  const r = await sweepOrphans({ stderr: () => {} });
  expect(r.stopped.length).toBe(1);
});

test("two sweeps at once stop an orphan exactly once", async () => {
  const owner = await deadOwner();
  const agent = Bun.spawn(["sleep", "30"]); const a = startOf(agent.pid);
  writeRecord({ version: 1, pid: a.pid, startedAt: a.startedAt, bootId: null, kind: "agent", ident: "ENG-4", stepId: 1, worktree: null, command: "sleep", owner: { pid: owner.pid, startedAt: owner.startedAt, pgid: owner.pgid } });
  const [x, y] = await Promise.all([sweepOrphans({ stderr: () => {} }), sweepOrphans({ stderr: () => {} })]);
  expect(x.stopped.length + y.stopped.length).toBe(1);
});
```

For the Linux boot ID case, add one more test that runs only when `process.platform === "linux"`.
It writes a record with `bootId: "not-this-boot"` and asserts the record is treated as stale.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/lifecycle/sweep.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/util/process/sweep.ts
import { bootId, probe, sameProcess } from "./proc-table.ts";
import { claim, type LaunchRecord, listRecords, type Listed, removeRecord, unclaim } from "./records.ts";
import { stopGroup, stopTree } from "./stop.ts";
import { GRACE_MS, selfIdentity } from "./door.ts";
import { findLeftovers, formatLeftover } from "./leftovers.ts";

export interface SweepResult { stopped: LaunchRecord[]; failed: LaunchRecord[]; stale: number; leftoverLines: string[] }

const isAlive = (who: { pid: number; startedAt: string }) => { const p = probe(who.pid); return p.kind === "not-allowed" || (p.kind === "alive" && p.info.state !== "zombie" && sameProcess(who, p.info)); };

/** §8: run first by every command. Stops orphans whose owning Styre is gone, after the identity
 *  check; never touches a live run's launches or anything outside the exact record names. */
export async function sweepOrphans(deps?: { stderr?: (s: string) => void }): Promise<SweepResult> {
  const say = deps?.stderr ?? ((s: string) => { try { process.stderr.write(s); } catch {} });
  const me = selfIdentity();
  const res: SweepResult = { stopped: [], failed: [], stale: 0, leftoverLines: [] };
  for (const l of listRecords()) {
    if (l.claimedBy && isAlive(l.claimedBy) && l.claimedBy.pid !== me.pid) continue; // another live sweeper
    const mine: Listed | null = claim(l, me);
    if (!mine) continue;
    const r = mine.record;
    if (isAlive(r.owner)) { unclaim(mine); continue; } // a live run's launch
    const boot = bootId();
    const p = probe(r.pid);
    const same = (r.bootId === null || r.bootId === boot) && p.kind === "alive" && sameProcess(r, p.info) && p.info.state !== "zombie";
    if (p.kind === "alive" && !same && p.info.state !== "zombie") { say(`styre: pid ${r.pid} from ${r.ident ?? "an unknown run"} was reused by another program; it was left alone\n`); res.stale++; }
    if (same) {
      const rep = r.kind === "group"
        ? await stopGroup(r.pid, "graceful", { graceMs: GRACE_MS })
        : await stopTree(r, "graceful", { graceMs: GRACE_MS, excludePgids: [me.pgid, r.owner.pgid] });
      if (rep.survivors.length > 0) { res.failed.push(r); unclaim(mine); for (const s of rep.survivors) say(`styre: could not stop pid ${s.pid}; stop it with: kill -9 ${s.pid}\n`); continue; }
      res.stopped.push(r);
      if (r.kind === "agent") say(`styre: stopped an orphaned agent from ${r.ident ?? "an unknown run"} (pid ${r.pid}), left running when Styre was force quit\n`);
    }
    if (r.worktree) {
      const found = findLeftovers({ worktree: r.worktree, since: r.startedAt, timeoutMs: 5_000, viaDiagnostic: true });
      if (found === "skipped") res.leftoverLines.push("styre: the leftover check was skipped (timeout)\n");
      else for (const f of found) res.leftoverLines.push(formatLeftover(f));
    }
    removeRecord(r);
  }
  for (const l of res.leftoverLines) say(l);
  return res;
}
```

Wire it into each command: `await sweepOrphans();` as the first statement inside the `guard` body.
For `ls`, also print the stopped records in its output: a "stopped orphans" section on stdout, since
`ls` is a human command. The sweep's own lines go to stderr.

- [ ] **Step 4: Run the tests**

Run: `bun test test/lifecycle/sweep.test.ts test/cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/process/sweep.ts src/cli test/lifecycle/sweep.test.ts
git commit -m "feat(process): every command sweeps orphans left by kill -9 before doing anything else

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase E — End to end, live, docs

### Task 14: End-to-end interruption through real steps

**Files:**
- Test: `test/lifecycle/e2e-interrupt.test.ts`. It uses `test/helpers/run-harness.ts` and
  `dispatch-fixtures.ts`.

**Interfaces:**
- Consumes everything above.

- [ ] **Step 1: Write the tests**

Drive a real `runTicket` through the existing run harness, with a `FakeAgentRunner` replaced by the
stand-in agent through `claudeAgentRunner(join(FX, "standin-agent.sh"))`. The stand-in never emits
a result, so set a long timeout and trigger the handler programmatically:
`handleStopSignal("SIGINT", ctx, deps)` with `reraise` and `exit` stubbed.

For each case, assert after resume:
- the step is redone;
- the attempt count equals its value before the interrupted attempt;
- the dispatch row is `interrupted` with `partial = 1`;
- in in-place mode, the checkout is back to its state before the dispatch;
- the run database was not written by run code during the stop: compare a row count snapshot
  taken just before the signal with one just after, excluding the handler's single note row.

The cases:
1. **Interrupted in the implement dispatch:** the agent launch.
2. **Interrupted during a suite:** `runBoundedCommand`.
3. **Interrupted during an acceptance check:** `runCommand`.
4. **Interrupted between launches:** inside a blocking `git` call's window. Simulate it by calling
   `beginStopping` from a `readHead` stub.
5. **Interrupted during the checks step's test run, after its commit (M1).** The branch returns to
   `headAtStart` on resume.
6. **Case 5, followed by an operator commit and `--accept-head`:** the commit is kept.
7. **Interrupted while a baseline worktree exists (m3):** no `styre-baseline-*` worktree remains
   registered (`git worktree list`).

- [ ] **Step 2: Run them**

Run: `bun test test/lifecycle/e2e-interrupt.test.ts`
Expected: PASS. Any failure here is a bug in Tasks 4–13. Fix it in the owning task's file, with a
unit test there first.

- [ ] **Step 3: Commit**

```bash
git add test/lifecycle/e2e-interrupt.test.ts test/helpers
git commit -m "test(lifecycle): interrupt and resume through real steps at every launch site

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Real terminal and signal tests in CI, on Linux virtual machines, macOS and a container

**Files:**
- Create: `test/lifecycle/pty.ts`. It runs a command under a real pseudo terminal with `script`:
  `script -q /dev/null <cmd>` on macOS, `script -qfc "<cmd>" /dev/null` on Linux. It writes `\x03`
  (Ctrl-C) or `\x1c` (Ctrl-\) to its stdin.
- Create: `test/lifecycle/terminal.test.ts`
- Modify: `.github/workflows/ci.yml`. Add a `lifecycle` job with this matrix:
  - `runs-on: [ubuntu-latest, ubuntu-24.04-arm, macos-15]`, running
    `bun test test/lifecycle test/util/process`;
  - plus a `container` job on `ubuntu-latest` that runs the compiled binary as the container's first
    process: `docker run --rm --init=false`, with `docker stop`, asserting exit status 143.

**Interfaces:**
- Consumes: the compiled binary (`bun run build`) and the stand-in fixtures.

- [ ] **Step 1: Write the terminal tests**

Each test:
1. Builds a tiny driver script (`test/lifecycle/fixtures/drive-run.ts`) that installs the stop
   handlers, launches the stand-in agent through the door, and waits.
2. Runs it under `pty.ts`.
3. Sends the keystroke.

| Case | Assert |
|---|---|
| Ctrl-C | exit status 130; the stand-in and its `sleep 300` are gone within 5 s; stderr contains the exact stopping line |
| Ctrl-\ | exit 131; the orphaned `sleep 300` is **reported** with the exact leftover line (D13). The test then kills it. |
| `kill -TERM <driver pid>` | 143 |
| closing the pty (terminal close) while a suite group runs | exit 129; the group is gone (finding 4) |
| a second Ctrl-C within 1 s | the forcing line appears; exit 130 |
| `styre setup` at its prompt, using a fixture repo that triggers the approval prompt, then Ctrl-C | setup exits 130 at once and writes no `profile.json` (finding 3) |
| the Bun #30189 guard: each command's handler fires on SIGTERM | the command prints the stop line |

- [ ] **Step 2: Run them locally on macOS**

Run: `bun run build && bun test test/lifecycle/terminal.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the CI jobs and push**

```yaml
# .github/workflows/ci.yml (append)
  lifecycle:
    strategy:
      fail-fast: false
      matrix:
        runner: [ubuntu-latest, ubuntu-24.04-arm, macos-15]
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7 (node24)
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6  # v2
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: bun test test/lifecycle test/util/process
  lifecycle-container:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7 (node24)
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6  # v2
      - run: bun install --frozen-lockfile && bun run build
      - run: bash test/lifecycle/container-first-process.sh
```

`test/lifecycle/container-first-process.sh` builds a minimal image with the binary and the driver as
the entry point, starts it, waits for the stand-in, runs `docker stop`, and asserts that
`docker inspect` reports `ExitCode` 143 and that no stand-in process remains.

- [ ] **Step 4: Confirm the CI jobs pass on the PR branch**

Run: `git push` and check the new jobs.
Expected: green on all four. A failure on one platform is a real platform difference. Fix it in
the owning task, with a test.

- [ ] **Step 5: Commit**

```bash
git add test/lifecycle .github/workflows/ci.yml
git commit -m "test(lifecycle): real terminal, signal and container tests on Linux VMs and macOS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Live tests with the real `claude` CLI, the control run, and GitHub's cancel

**Files:**
- Create: `scripts/smoke-lifecycle.ts`
- Create: `.github/workflows/lifecycle-live.yml` (`workflow_dispatch` only)

**Interfaces:**
- Consumes: the real `claude` CLI (≥ 2.1.280); the `ANTHROPIC_API_KEY` secret in CI.

- [ ] **Step 1: Write the smoke script**

It repeats the design's §2.1 experiment:
- a throwaway git repo with a slow `test.sh` (`sleep 97.3x`);
- the real Claude adapter, with the prompt "Run this project's test suite with the Bash tool:
  `sh test.sh` (in the foreground, with a 300000 ms timeout), then report whether it passed.";
- tools `["Read", "Bash(sh:*)"]`;
- model `claude-haiku-4-5-20251001`.

It does three things:
1. **Records** `claude --version`, and confirms that the agent's command group is led by its
   direct child (R8).
2. **Control run.** Checks out `main` in a temporary worktree and runs the same scenarios against
   it with `bun run`. `kill` and `kill -9` must leave the agent running. If the control does not
   leak, it prints "probes are blind" and exits 1.
3. **New code.** For each of Ctrl-C (through the pty helper), `kill`, `kill -9` followed by `styre ls`,
   and timeout, it asserts that:
   - the agent and the `sleep` are gone within 5 s (except Ctrl-\, which must be reported);
   - the exit status is as expected.

Usage: `bun run scripts/smoke-lifecycle.ts [model]`

- [ ] **Step 2: Run it on macOS**

Run: `bun run scripts/smoke-lifecycle.ts`
Expected: "PASS: control leaked (probes can see failure); every scenario held".

- [ ] **Step 3: Run it on the operator's physical Linux laptop**

Ask the operator to wake the laptop and enable SSH. Then run:
```bash
ssh rajatgoyal@192.168.4.66 'cd ~/code/styre && git fetch && git checkout feat/eng-485-process-lifecycle && bun install && bun run scripts/smoke-lifecycle.ts'
```

Expected: the same PASS line. If the laptop is unavailable, say so in the PR. Do not skip it
silently.

- [ ] **Step 4: Add the manual GitHub workflow, including a real `run:` step cancel (D14)**

```yaml
# .github/workflows/lifecycle-live.yml
name: lifecycle-live
on: workflow_dispatch
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7 (node24)
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6  # v2
      - run: bun install --frozen-lockfile && npm i -g @anthropic-ai/claude-code
      - run: bun run scripts/smoke-lifecycle.ts
        env: { ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" }
  cancel-with-exec:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7 (node24)
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6  # v2
      - run: bun install --frozen-lockfile && bun run build
      - name: long run, cancelled by the job timeout of 3 minutes
        run: exec bun test/lifecycle/fixtures/drive-run.ts --marker cancel-exec
      - if: always()
        run: bash test/lifecycle/assert-cancel.sh cancel-exec graceful
  cancel-without-exec:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7 (node24)
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6  # v2
      - run: bun install --frozen-lockfile && bun run build
      - run: bun test/lifecycle/fixtures/drive-run.ts --marker cancel-noexec
      - if: always()
        run: bash test/lifecycle/assert-cancel.sh cancel-noexec killed
```

`drive-run.ts --marker` writes its stop line and the signal it received to `/tmp/<marker>.log`.
`assert-cancel.sh` checks the log:
- **`graceful`:** the handler ran and printed the stop line.
- **`killed`:** no handler line, and no stand-in process remains after the step.

This records what GitHub actually does with and without `exec` on Ubuntu's bash 5. A timeout may
take a different path from a manual cancel, which the research left unconfirmed. Run the workflow
twice, once letting the timeout fire and once cancelling by hand, and record both results in the
PR.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-lifecycle.ts .github/workflows/lifecycle-live.yml test/lifecycle
git commit -m "test(lifecycle): live smoke with a control run, and GitHub cancel with and without exec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Latency measurement, docs, and the PR

**Files:**
- Create: `scripts/measure-lifecycle-latency.ts`
- Modify: `SECURITY.md`, `CLAUDE.md`, `docs/architecture/control-loop.md`,
  `docs/architecture/runtime-parameters.md`, `docs/architecture/conventions.md`,
  `docs/architecture/brainstorm.md` (§11 changelog entry only; append, never rewrite)

- [ ] **Step 1: Write and run the latency measurement**

The script runs 50 normal dispatches with a fast stand-in agent that exits at once, through
`runAgentDispatch` on a temporary repo. It does this on `main` (checked out in a temporary worktree)
and on the branch, and prints the median and p90 for each. It also measures:
- the sweep with an empty folder (1000 calls);
- `stopGroup` on an empty group;
- the `headAtStart` `rev-parse` per step;
- the time from a step's end to the next step's start, with and without the background leftover
  check.

Run: `bun run scripts/measure-lifecycle-latency.ts`
Expected: the median dispatch difference is within noise, and the script prints both numbers. Put
the table in the PR description. If the difference is not within noise, stop and report it to the
operator, which matches the ticket's acceptance criterion.

- [ ] **Step 2: Update the docs**

- **`SECURITY.md`:**
  - remove the wrapper gap;
  - add the limits from §12: `kill -9` (cleanup on the next command), the unrecorded spawn window,
    detached leftovers reported but not stopped, Ctrl-\ (D13), Ctrl-Z (D9), GitHub without `exec`
    (D14), and one possible duplicate Slack post.
- **`CLAUDE.md`, the "non-obvious invariants" list:** add "One door: only `src/util/process/door.ts`
  (and `proc-table.ts`'s `ps` fallback) starts processes; a source guard enforces it (ENG-485)."
- **`control-loop.md` §6.1:** crash recovery is the sweep plus the reset, and an interruption is
  free.
- **`runtime-parameters.md`:**
  - exit statuses 130, 143, 129 and 131 on a signal;
  - every stop and sweep message, verbatim;
  - the `exec styre run …` form for GitHub Actions, and what happens without it.
- **`conventions.md`:** the `styre-processes/` state folder.
- **`brainstorm.md` §11:** one changelog entry for ENG-485, linking the design and this plan.

- [ ] **Step 3: Full verification**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: all clean.

Then run the suite with `claude` and `codex` removed from `PATH`, as for PR #151:

```bash
env PATH="$(echo "$PATH" | tr ':' '\n' | grep -v -e claude -e '\.local/bin' | paste -sd: -)" bun test
```

- [ ] **Step 4: Commit the docs**

```bash
git add SECURITY.md CLAUDE.md docs/architecture scripts/measure-lifecycle-latency.ts
git commit -m "docs: the agent process lifecycle (ENG-485)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Independent review, then the PR**

1. Dispatch an independent adversarial reviewer over the exact HEAD.
2. Fix its findings, with tests.
3. Review again until the verdict is ship.
4. Write `.claude/reviews/$(git rev-parse HEAD).md` with `reviewed-sha:` and `reviewed-remote:`
   lines.
5. Push, then run the bare `gh pr create`.

The title is `feat(process): stop, interrupt and recover agent runs as whole process trees`. The
body ends with "🤖 Generated with [Claude Code](https://claude.com/claude-code)". Never merge.

---

## Self-review notes (for the executor)

**Spec coverage:**

| Spec section | Task |
|---|---|
| §5.1 the door | 4, 7 |
| §5.2 record contents | 1, 2, 4 |
| §5.3 storage | 2 |
| §5.4 identity | 1, 13 |
| §5.5 replacements | 5, 6, 8, 9 |
| §6.1 agent stop | 3, 6 |
| §6.2 command stop | 3, 5 |
| §6.3 triggers | 5, 6, 10, 13 |
| §7.1 handler installation | 10, 11 |
| §7.3 the handler sequence | 10 |
| §7.4 deadline | 10 |
| §7.5 run code during a stop | 6, 8, 9, 11 |
| §7.6 limits | 10, 15, 17 |
| §7.7 normal exit | 12 |
| §8 sweep | 13 |
| §9 leftovers | 12 |
| §10 providers | 6 |
| §11 tests | 3, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16 |
| §11.4 latency | 17 |
| §12 docs | 17 |

**Two values to confirm first, since this plan cannot run them:**
- **Task 0** decides the macOS start time source.
- **Task 4** confirms Bun's `spawnSync` timeout property name.

Both are written as explicit checks, not assumptions.
