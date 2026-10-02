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
  // The ps fallback reports whole seconds, so "now" must be floored the same way to stay on its clock.
  if (loadSysctl() === null) return `${Math.floor(ms / 1000)}.000000`;
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
