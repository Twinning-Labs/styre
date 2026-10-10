// src/util/process/proc-table.ts
import { readFileSync, readdirSync } from "node:fs";

/** One snapshot of a process (ENG-485 §5.2). `startedAt` is an opaque token that is stable for the
 *  life of the process and never depends on locale or timezone; compare it only for equality. */
export type ProcState = "running" | "zombie" | "stopped";
export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: string;
  state: ProcState;
}
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
export function tokenValue(t: string): number {
  return Number.parseFloat(t);
}
let clkTck: number | null = null;
/**
 * "Now" on the clock process start times are read on, never behind a process that already started:
 * the leftover check ends its window here, and a process that started in the same tick must be in
 * it.
 */
export function nowToken(): string {
  if (process.platform === "linux") {
    if (clkTck === null) {
      const r = Bun.spawnSync(["getconf", "CLK_TCK"], { timeout: 5_000 }); // allowed: proc-table spawns
      clkTck = r.success ? Number(r.stdout.toString().trim()) : 100;
    }
    return String(uptimeTicks(readFileSync("/proc/uptime", "utf8"), clkTck));
  }
  // The ps fallback reports whole seconds, so "now" must be floored the same way to stay on its clock.
  if (loadSysctl() === null) return `${Math.floor(Date.now() / 1000)}.000000`;
  // Start times are in microseconds: Date.now() is whole milliseconds, up to 999 µs behind them.
  const { sec, usec } = timeOfDay();
  return `${sec}.${String(usec).padStart(6, "0")}`;
}

/**
 * /proc/uptime (seconds with two decimals) as whole clock ticks, in integers. Through floating point
 * `1024.09 * 100` is 102408.99999999999, whose floor is a tick behind a process that started in
 * that tick.
 */
export function uptimeTicks(text: string, tck: number): number {
  const m = /^(\d+)\.(\d\d)\s/.exec(text);
  if (!m) throw new Error(`unexpected /proc/uptime: ${JSON.stringify(text)}`);
  return Math.floor(((Number(m[1]) * 100 + Number(m[2])) * tck) / 100);
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
// Offsets verified in Task 0 on arm64 (struct kinfo_proc, LP64); x86_64 is verified in CI.
const KINFO_SIZE = 648;
const OFF_START_SEC = 0;
const OFF_START_USEC = 8;
const OFF_STAT = 36;
const OFF_PID = 40;
const OFF_PPID = 560;
const OFF_PGID = 564;
const SZOMB = 5;
const SSTOP = 4;

let forcePsFallback = false;
/** Test seam: make the macOS reader behave as if sysctl were unavailable, so the `ps` path runs. */
export function _forcePsFallbackForTest(on: boolean): void {
  forcePsFallback = on;
}

let sysctlFn:
  | ((mib: Int32Array, n: number, buf: Uint8Array | null, len: BigUint64Array) => number)
  | null
  | undefined;
let timeOfDayFn: ((tv: Uint8Array) => number) | undefined;
function loadSysctl() {
  if (forcePsFallback) return null;
  if (sysctlFn !== undefined) return sysctlFn;
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
      gettimeofday: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    sysctlFn = (mib, n, buf, len) =>
      lib.symbols.sysctl(ptr(mib), n, buf ? ptr(buf) : null, ptr(len), null, 0n) as number;
    timeOfDayFn = (tv) => lib.symbols.gettimeofday(ptr(tv), null) as number;
  } catch {
    sysctlFn = null;
  }
  return sysctlFn;
}
/** The wall clock in microseconds, the clock and unit of `p_starttime`. Only after `loadSysctl()`
 *  succeeded. struct timeval is a 64-bit tv_sec then a 32-bit tv_usec on every macOS target. */
function timeOfDay(): { sec: bigint; usec: number } {
  const tv = new Uint8Array(16);
  if (timeOfDayFn === undefined || timeOfDayFn(tv) !== 0) throw new Error("gettimeofday failed");
  const v = new DataView(tv.buffer);
  return { sec: v.getBigInt64(0, true), usec: v.getInt32(8, true) };
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
  return r.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (!m) throw new Error(`ps: unparseable line: ${line}`);
      const sec = Math.floor(Date.parse(`${m[5]} UTC`) / 1000);
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pgid: Number(m[3]),
        startedAt: `${sec}.000000`,
        state: m[4].startsWith("Z") ? "zombie" : m[4].startsWith("T") ? "stopped" : "running",
      } satisfies ProcInfo;
    });
}

// ---- no core dump on Ctrl-\ (amendment 2026-10-08) -------------------------------------------------
// Called by the stop handler (signals.ts) just before it re-raises SIGQUIT. It lives here because
// this is the one module the source guard lets call libc through bun:ffi (beside the door).

/** RLIMIT_CORE: 4 on Linux (asm-generic/resource.h, no override) and on macOS (sys/resource.h). */
const RLIMIT_CORE = 4;
/** PR_SET_DUMPABLE and PR_GET_DUMPABLE (linux/prctl.h). */
const PR_SET_DUMPABLE = 4;
const PR_GET_DUMPABLE = 3;

interface CoreCalls {
  setrlimit(resource: number, rlim: BigUint64Array): number;
  getrlimit(resource: number, rlim: BigUint64Array): number;
  prctl: ((option: number, arg: bigint) => number) | null;
}
let coreCalls: CoreCalls | null = null;
function calls(): CoreCalls {
  if (coreCalls !== null) return coreCalls;
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const linux = process.platform === "linux";
  const rl = { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } as const;
  const lib = dlopen(linux ? "libc.so.6" : "/usr/lib/libSystem.B.dylib", {
    setrlimit: rl,
    getrlimit: rl,
    // int prctl(int option, unsigned long arg2, ...): the dumpable calls read arg2 only.
    ...(linux
      ? {
          prctl: {
            args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
            returns: FFIType.i32,
          },
        }
      : {}),
  });
  const s = lib.symbols as Record<string, (...a: unknown[]) => unknown>;
  coreCalls = {
    // struct rlimit is two rlim_t, each 64 bits on every target Styre builds for (macOS
    // __uint64_t; Linux unsigned long on x86_64 and arm64).
    setrlimit: (r, rlim) => s.setrlimit?.(r, ptr(rlim)) as number,
    getrlimit: (r, rlim) => s.getrlimit?.(r, ptr(rlim)) as number,
    prctl: linux ? (o, a) => s.prctl?.(o, a, 0n, 0n, 0n) as number : null,
  };
  return coreCalls;
}

/**
 * Turn core dumps off for this process, just before the SIGQUIT re-raise. Two calls, because one
 * is not enough everywhere:
 * - the core limit to 0 (setrlimit): macOS writes a core to /cores only within this limit, and so
 *   does Linux when core_pattern names a file;
 * - on Linux, the process marked not dumpable (prctl PR_SET_DUMPABLE 0): when core_pattern pipes to
 *   a program (Ubuntu's apport, systemd-coredump) the kernel ignores the core limit and runs the
 *   program anyway, but it starts no dump at all for a process that is not dumpable. Its side
 *   effects (the /proc entries owned by root, no ptrace attach) cannot matter this late: nothing
 *   reads them before the exit.
 * Throws when a call fails; the handler says so and still re-raises.
 */
export function turnOffCoreDumps(): void {
  const c = calls();
  if (c.setrlimit(RLIMIT_CORE, new BigUint64Array([0n, 0n])) !== 0)
    throw new Error("setrlimit(RLIMIT_CORE) failed");
  if (c.prctl !== null && c.prctl(PR_SET_DUMPABLE, 0n) !== 0)
    throw new Error("prctl(PR_SET_DUMPABLE) failed");
}

/** The core dump state a prompt changes and gives back: the soft and hard core limits, and on
 *  Linux the dumpable flag (null elsewhere). */
export interface CoreDumpState {
  soft: bigint;
  hard: bigint;
  dumpable: number | null;
}

/** Read this process's core dump state, to give it back after a prompt. Read only. */
export function saveCoreDumps(): CoreDumpState {
  const c = calls();
  const rlim = new BigUint64Array(2);
  if (c.getrlimit(RLIMIT_CORE, rlim) !== 0) throw new Error("getrlimit(RLIMIT_CORE) failed");
  let dumpable: number | null = null;
  if (c.prctl !== null) {
    dumpable = c.prctl(PR_GET_DUMPABLE, 0n);
    if (dumpable < 0) throw new Error("prctl(PR_GET_DUMPABLE) failed");
  }
  return { soft: rlim[0] as bigint, hard: rlim[1] as bigint, dumpable };
}

/**
 * Turn core dumps off while setup waits at a prompt with the stop handlers suspended, so a Ctrl-\
 * there (SIGQUIT's default action) writes no core. Unlike `turnOffCoreDumps` it lowers only the
 * soft limit: a process that is not privileged can never raise its hard limit again (getrlimit(2);
 * macOS setrlimit(2)), and `restoreCoreDumps` must be able to give the soft limit back. On Linux the
 * process is also marked not dumpable (a pipe core_pattern ignores the limit). Throws when a call
 * fails.
 */
export function turnOffCoreDumpsForPrompt(): void {
  const c = calls();
  const rlim = new BigUint64Array(2);
  if (c.getrlimit(RLIMIT_CORE, rlim) !== 0) throw new Error("getrlimit(RLIMIT_CORE) failed");
  if (c.setrlimit(RLIMIT_CORE, new BigUint64Array([0n, rlim[1] as bigint])) !== 0)
    throw new Error("setrlimit(RLIMIT_CORE) failed");
  if (c.prctl !== null && c.prctl(PR_SET_DUMPABLE, 0n) !== 0)
    throw new Error("prctl(PR_SET_DUMPABLE) failed");
}

/**
 * Give back the state `saveCoreDumps` read: the soft and hard limits as they were, and on Linux the
 * dumpable flag (setting 1 again gives the /proc/<pid> files back to the process's own user,
 * proc_pid(5)). Fails, and throws, if the hard limit was lowered meanwhile: it cannot be raised
 * again.
 */
export function restoreCoreDumps(saved: CoreDumpState): void {
  const c = calls();
  if (c.setrlimit(RLIMIT_CORE, new BigUint64Array([saved.soft, saved.hard])) !== 0)
    throw new Error("setrlimit(RLIMIT_CORE) failed");
  if (
    c.prctl !== null &&
    saved.dumpable !== null &&
    c.prctl(PR_SET_DUMPABLE, BigInt(saved.dumpable)) !== 0
  )
    throw new Error("prctl(PR_SET_DUMPABLE) failed");
}

/** This process's soft core limit (a decimal string) and, on Linux, its dumpable flag. Read only;
 *  for the tests of `turnOffCoreDumps`. */
export function coreDumpState(): { limit: string; dumpable: number | null } {
  const c = calls();
  const rlim = new BigUint64Array(2);
  if (c.getrlimit(RLIMIT_CORE, rlim) !== 0) throw new Error("getrlimit(RLIMIT_CORE) failed");
  return {
    limit: String(rlim[0]),
    dumpable: c.prctl === null ? null : c.prctl(PR_GET_DUMPABLE, 0n),
  };
}
