import { bootId, probe } from "./proc-table.ts";
import { type LaunchRecord, removeRecord, writeRecord } from "./records.ts";
import { type StopDeps, type StopReport, stopGroup, stopTree } from "./stop.ts";

/**
 * The door (ENG-485 section 5.1): the only code allowed to start a process, apart from the `ps`
 * fallback in proc-table.ts. Long running launches are recorded in memory and on disk. Blocking
 * calls take a required timeout. Once a stop begins (section 7.3 step 1) the door refuses every
 * launch and every blocking call, except cleanup calls and diagnostics.
 */
export class RunInterrupted extends Error {
  constructor(message = "run interrupted by a stop signal") {
    super(message);
    this.name = "RunInterrupted";
  }
}

/** How long a graceful stop waits between SIGTERM and SIGKILL (D8). */
export const GRACE_MS = 5_000;

let stopping = false;
/** Flipped by a second stop signal; every stop in progress then skips the rest of its grace wait. */
export const stopAbort = { forced: false };

export function isStopping(): boolean {
  return stopping;
}
/** Called only by signals.ts. */
export function beginStopping(): void {
  stopping = true;
}

let self: { pid: number; startedAt: string; pgid: number } | null = null;
/** This process's own identity, read once from the process table. It is the `owner` of every record. */
export function selfIdentity(): { pid: number; startedAt: string; pgid: number } {
  if (self) return self;
  const p = probe(process.pid);
  if (p.kind !== "alive") throw new Error("cannot read Styre's own process entry");
  self = { pid: process.pid, startedAt: p.info.startedAt, pgid: p.info.pgid };
  return self;
}

export interface LaunchContext {
  ident: string | null;
  stepId: number | null;
  worktree: string | null;
  untrackedBefore?: string[];
  dispatchRowId?: number;
}
export interface LaunchSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin?: Uint8Array;
  kind: "agent" | "group";
  context: LaunchContext;
}
export interface LaunchHandle {
  proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  record: LaunchRecord;
  context: LaunchContext;
  /** Set by the signal handler when it stopped this launch. */
  interrupted: boolean;
  /** Stop the launch. The record is removed only when nothing is left alive (section 5.3). */
  stop(how: "graceful" | "forced"): Promise<StopReport>;
  /** Stop whatever is left of the launch (graceful), then release the record if nothing survives. */
  finish(): Promise<StopReport>;
}

const live = new Set<LaunchHandle>();
export function liveLaunches(): LaunchHandle[] {
  return [...live];
}

/** Test seam: lets a test make a stop see survivors. Production never sets it. */
let stopDeps: StopDeps | undefined;
export function __setStopDepsForTests(deps: StopDeps | undefined): void {
  stopDeps = deps;
}

export function launch(spec: LaunchSpec): LaunchHandle {
  if (stopping) throw new RunInterrupted();
  const me = selfIdentity(); // read before spawning: a failure here must not leave a child behind
  const proc = Bun.spawn(spec.argv, {
    cwd: spec.cwd,
    env: spec.env,
    stdin: spec.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // A command leads a group of its own so the whole group can be stopped (D7). An agent stays in
    // Styre's terminal group (D4).
    detached: spec.kind === "group",
  }) as LaunchHandle["proc"];

  let startedAt = "0";
  let record: LaunchRecord;
  try {
    const p = probe(proc.pid);
    // A process that is already gone has nothing to record; the handle below still works.
    if (p.kind === "alive") startedAt = p.info.startedAt;
    record = {
      version: 1,
      pid: proc.pid,
      startedAt,
      bootId: bootId(),
      kind: spec.kind,
      ident: spec.context.ident,
      stepId: spec.context.stepId,
      worktree: spec.context.worktree,
      command: spec.argv.join(" ").slice(0, 200),
      owner: me,
    };
    if (p.kind === "alive") writeRecord(record);
  } catch (err) {
    // An unrecorded launch is an orphan waiting to happen: stop what was just started, then say so.
    try {
      process.kill(spec.kind === "group" ? -proc.pid : proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    throw new Error(
      `could not write the launch record for pid ${proc.pid}, so the launch was stopped: ${String(err)}`,
    );
  }

  const doStop = (how: "graceful" | "forced"): Promise<StopReport> =>
    spec.kind === "group"
      ? stopGroup(proc.pid, how, { graceMs: GRACE_MS, abort: stopAbort, deps: stopDeps })
      : stopTree({ pid: proc.pid, startedAt }, how, {
          graceMs: GRACE_MS,
          excludePgids: [me.pgid],
          abort: stopAbort,
          deps: stopDeps,
        });
  const release = (rep: StopReport): StopReport => {
    // A survivor still holds this subprocess; it must not keep Bun's event loop alive and stop
    // Styre from exiting (the operator was told how to stop it).
    if (rep.survivors.length > 0) proc.unref();
    if (rep.survivors.length === 0) {
      removeRecord(record); // may throw after its own deadline: a loud failure, never swallowed
      live.delete(handle);
    }
    return rep;
  };
  const handle: LaunchHandle = {
    proc,
    record,
    context: spec.context,
    interrupted: false,
    stop: async (how) => release(await doStop(how)),
    // Both kinds stop what is left, so a record is never released while anything it covers is alive
    // (section 5.3). An agent or a group that already exited returns at once.
    finish: async () => release(await doStop("graceful")),
  };
  live.add(handle);
  return handle;
}

export interface BlockingResult {
  exitCode: number | null;
  success: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnBlocking(
  argv: string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    env?: Record<string, string | undefined>;
    stdin?: Uint8Array;
  },
): BlockingResult {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error(`a blocking call needs a positive timeout, got ${opts.timeoutMs}`);
  }
  const r = Bun.spawnSync(argv, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdin: opts.stdin,
    timeout: opts.timeoutMs,
    // SIGKILL, so a program that ignores SIGTERM cannot outlast its bound.
    killSignal: "SIGKILL",
  });
  return {
    exitCode: r.exitCode,
    success: r.success,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    timedOut: r.exitedDueToTimeout === true,
  };
}

/** Test seam: replaces the process start of `runBlocking` (not of `launchDiagnostic`), so a test can
 *  hand a call site a timed out or failed result. Production never sets it. */
let blockingOverride: ((argv: string[], opts: { timeoutMs: number }) => BlockingResult) | undefined;
export function __setBlockingForTests(fn: typeof blockingOverride): void {
  blockingOverride = fn;
}

/** A blocking call, such as `git`. Refused once a stop has begun, unless it is marked `cleanup`
 *  (it only releases something the run had taken). */
export function runBlocking(
  argv: string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    env?: Record<string, string | undefined>;
    cleanup?: boolean;
    stdin?: Uint8Array;
  },
): BlockingResult {
  if (stopping && !opts.cleanup) throw new RunInterrupted();
  if (blockingOverride) return blockingOverride(argv, opts);
  return spawnBlocking(argv, opts);
}

/** Works while the door is closed and is never recorded. Only signals.ts, sweep.ts, leftovers.ts
 *  and proc-table.ts may call it (source guard). */
export function launchDiagnostic(argv: string[], opts: { timeoutMs: number }): BlockingResult {
  return spawnBlocking(argv, { timeoutMs: opts.timeoutMs });
}

/** The command line of a live process, for the operator-facing survivor line (spec section 7.3
 *  names the survivor's own command, not the launch's). Truncated to 120 characters; `fallback`
 *  (the launch record's command) is used only when the process table cannot be read. */
export function describeProcess(pid: number, fallback: string): string {
  let text = "";
  try {
    const r = spawnBlocking(["ps", "-o", "command=", "-p", String(pid)], { timeoutMs: 5_000 });
    if (r.success) text = r.stdout.split("\n")[0]?.trim() ?? "";
  } catch {
    /* unreadable: use the fallback */
  }
  return (text === "" ? fallback : text).slice(0, 120);
}

export interface InFlightStep {
  stepId: number;
  startedAt: string;
  ident: string;
  headAtStart: string | null;
  headAtStop: string | null;
}
let inFlight: InFlightStep | null = null;
/** The step being run now. `headAtStop` starts as `headAtStart` and follows `noteHead`. */
export function beginStep(s: Omit<InFlightStep, "headAtStop">): void {
  inFlight = { ...s, headAtStop: s.headAtStart };
}
export function noteHead(sha: string): void {
  if (inFlight) inFlight.headAtStop = sha;
}
export function endStep(): void {
  inFlight = null;
}
export function inFlightStep(): InFlightStep | null {
  return inFlight ? { ...inFlight } : null;
}

/** Test seam only. */
export function __resetForTests(): void {
  stopping = false;
  stopAbort.forced = false;
  live.clear();
  inFlight = null;
  self = null;
  stopDeps = undefined;
  blockingOverride = undefined;
}
