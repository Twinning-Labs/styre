// The pure logic of ENG-485's live checks (Task 16): scripts/smoke-lifecycle.ts, which drives the
// real `claude` CLI, and scripts/simulate-github-cancel.ts, which replays GitHub's cancel sequence
// against the compiled binary. Nothing here starts, reads or signals a process; the tests
// (test/lifecycle/live-smoke.test.ts) feed it stand-in tables and texts.

/** The fields of a process table row these checks read (a subset of proc-table.ts's ProcInfo). */
export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: string;
}

/** How a process ended: an exit code, or the signal that ended it. */
export interface Ended {
  code: number | null;
  signal: string | null;
}

/** The longest a stop may take: the grace period, 5 s (D8). */
export const STOP_WINDOW_MS = 5_000;

/**
 * The agent the driver launched: on `leafPid`'s parent chain, the process whose parent is
 * `driverPid`. Null when the chain never reaches the driver (or loops, or leaves the table).
 */
export function agentAbove(leafPid: number, driverPid: number, table: Proc[]): Proc | null {
  const byPid = new Map(table.map((q) => [q.pid, q]));
  const seen = new Set<number>();
  let cur = byPid.get(leafPid);
  while (cur !== undefined && !seen.has(cur.pid)) {
    if (cur.ppid === driverPid) return cur;
    seen.add(cur.pid);
    cur = byPid.get(cur.ppid);
  }
  return null;
}

/**
 * R8 (spec 6.1): the group that the agent's test command runs in is led by a direct child of the
 * agent. That is what lets a stop take the group in while the agent lives.
 */
export function groupLedByChild(
  leaf: Proc,
  agent: Proc,
  table: Proc[],
): { ok: boolean; why: string } {
  if (leaf.pgid === agent.pgid)
    return { ok: false, why: `the command shares the agent's group ${agent.pgid}` };
  const leader = table.find((q) => q.pid === leaf.pgid);
  if (leader === undefined)
    return { ok: false, why: `no process leads group ${leaf.pgid} (its leader has exited)` };
  if (leader.ppid !== agent.pid)
    return {
      ok: false,
      why: `group ${leaf.pgid} is led by pid ${leader.pid}, whose parent ${leader.ppid} is not the agent ${agent.pid}`,
    };
  return {
    ok: true,
    why: `group ${leaf.pgid} is led by pid ${leader.pid}, a direct child of the agent ${agent.pid}`,
  };
}

/** The version in `claude --version`'s output ("2.1.292 (Claude Code)"), or null. */
export function parseClaudeVersion(text: string): string | null {
  const m = /^(\d+\.\d+\.\d+)\b/m.exec(text.trim());
  return m ? (m[1] as string) : null;
}

/** Whether dotted version `v` is at least `min`, compared number by number. */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** What the agent run returned, as the driver reports it. */
export interface DriverResult {
  completed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  interrupted: boolean;
}

/** What scripts/smoke-lifecycle-driver.ts said on stderr: its `smoke-driver: …` lines. */
export interface DriverSaid {
  handlers: "installed" | "none" | null;
  /** When the dispatch began (epoch ms), so a timeout's instant is known. */
  dispatchAt: number | null;
  result: DriverResult | null;
}

export function parseDriver(text: string): DriverSaid {
  const handlers = /^smoke-driver: handlers (installed|none)$/m.exec(text);
  const dispatch = /^smoke-driver: dispatch (\d+)$/m.exec(text);
  const result = /^smoke-driver: result (.*)$/m.exec(text);
  let parsed: DriverResult | null = null;
  if (result) {
    try {
      parsed = JSON.parse(result[1] as string) as DriverResult;
    } catch {
      parsed = null;
    }
  }
  return {
    handlers: handlers ? (handlers[1] as "installed" | "none") : null,
    dispatchAt: dispatch ? Number(dispatch[1]) : null,
    result: parsed,
  };
}

/** What one scenario must show. */
export interface Expectation {
  exit: Ended;
  /** Lines Styre must have said (a string must appear as a whole line). */
  lines: (string | RegExp)[];
  /** Lines that must not appear. */
  absent?: RegExp[];
  /** Ctrl-\ (D13): the test's sleep may outlive the stop, but then this pid must be reported. */
  reportSleep?: number;
}

/** What one scenario showed. Times are counted from the scenario's trigger. */
export interface Observation {
  exit: Ended | null;
  /** When the agent was first seen gone, or null if it was still running when the watch ended. */
  agentGoneMs: number | null;
  sleepGoneMs: number | null;
  /** Whether the sleep was still running at the end of the watch. */
  sleepAliveAtEnd: boolean;
  /** Everything Styre said on stderr. */
  stderr: string;
}

const hasLine = (text: string, want: string | RegExp): boolean =>
  typeof want === "string" ? text.split("\n").includes(want) : want.test(text);

/** Every way the observation misses the expectation, in words; empty when the scenario held. */
export function judge(want: Expectation, seen: Observation): string[] {
  const out: string[] = [];
  if (seen.exit === null) out.push("the process did not exit in time");
  else if (seen.exit.code !== want.exit.code || seen.exit.signal !== want.exit.signal)
    out.push(`exit ${JSON.stringify(seen.exit)}, expected ${JSON.stringify(want.exit)}`);
  const late = (ms: number | null): boolean => ms === null || ms > STOP_WINDOW_MS;
  if (late(seen.agentGoneMs))
    out.push(`the agent was still running ${STOP_WINDOW_MS} ms after the trigger`);
  if (want.reportSleep === undefined) {
    if (late(seen.sleepGoneMs))
      out.push(`the test's sleep was still running ${STOP_WINDOW_MS} ms after the trigger`);
  } else if (seen.sleepAliveAtEnd) {
    const pid = want.reportSleep;
    const named = new RegExp(
      `^styre: the agent left ".*" \\(pid ${pid}\\) running in the worktree; stop it with: kill ${pid} \\(if it is not yours\\)$`,
      "m",
    );
    if (!named.test(seen.stderr))
      out.push(`the sleep (pid ${pid}) outlived the stop and was not reported`);
  }
  for (const l of want.lines) if (!hasLine(seen.stderr, l)) out.push(`missing line: ${String(l)}`);
  for (const re of want.absent ?? [])
    if (re.test(seen.stderr)) out.push(`unexpected line matching ${String(re)}`);
  return out;
}

/** One control scenario's outcome, read after the stop window. */
export interface ControlResult {
  name: string;
  agentAlive: boolean;
  sleepAlive: boolean;
}

/**
 * The control (main, before ENG-485) must leak in every control scenario: `kill` and `kill -9`
 * leave the agent and its sleep running (spec 2.1). If any did not, the probes cannot see the
 * failure they look for, and a pass would mean nothing.
 */
export function controlVerdict(results: ControlResult[]): { blind: boolean; why: string } {
  if (results.length === 0) return { blind: true, why: "no control scenario ran" };
  const why = results
    .filter((r) => !r.agentAlive || !r.sleepAlive)
    .map(
      (r) =>
        `${r.name}: the agent was ${r.agentAlive ? "running" : "gone"} and its sleep ${r.sleepAlive ? "running" : "gone"}`,
    );
  return { blind: why.length > 0, why: why.join("; ") };
}

/**
 * GitHub's cancel of a `run:` step, from actions/runner src/Runner.Sdk/ProcessInvoker.cs
 * (CancelAndKillProcessTree, SendSignal, ProcessExitedHandler): SIGINT to the step's process by pid,
 * up to 7.5 s for it to exit; then SIGTERM, up to 2.5 s; then Process.Kill() (SIGKILL, that pid
 * only). Once the process has exited while something still holds its output pipes, the runner
 * waits 5 s more and ends the step.
 */
export const GITHUB_CANCEL = { sigintWaitMs: 7_500, sigtermWaitMs: 2_500, pipeWaitMs: 5_000 };

/** What one simulated cancel did. */
export interface CancelObservation {
  /** The signals the simulated runner sent, in order. */
  sent: string[];
  stepEnded: Ended;
  /** Everything Styre said on stderr while the step ran. */
  stderr: string;
  agentPid: number;
  /** Whether each was still running when the simulated step ended. */
  styreAlive: boolean;
  agentAlive: boolean;
  toolAlive: boolean;
}

const OPENING_INT =
  "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…";
const HANDLER_LINE = /^styre: (?:stopping —|received a stop request)/m;

/**
 * graceful: Styre was the process GitHub signalled (D14's `exec`): the first SIGINT ended the step
 * by SIGINT, Styre said it was stopping and that it stopped this agent, and nothing is left.
 * orphaned: the step's bash took the signals and Styre heard none: the step needed SIGTERM, Styre
 * said nothing, and Styre, the agent and its tool all still run (until the job's cleanup).
 */
export function cancelVerdict(o: CancelObservation): {
  kind: "graceful" | "orphaned" | "other";
  why: string[];
} {
  const graceful: string[] = [];
  if (o.sent.join(",") !== "SIGINT") graceful.push(`signals sent: ${o.sent.join(", ")}`);
  if (o.stepEnded.signal !== "SIGINT") graceful.push(`step ended ${JSON.stringify(o.stepEnded)}`);
  if (!o.stderr.split("\n").includes(OPENING_INT)) graceful.push("no stopping line");
  const stopped = `styre: stopped the agent (pid ${o.agentPid}) and 1 of its commands.`;
  if (!o.stderr.split("\n").includes(stopped)) graceful.push(`no line "${stopped}"`);
  if (o.styreAlive || o.agentAlive || o.toolAlive) graceful.push("something still runs");
  if (graceful.length === 0) return { kind: "graceful", why: [] };

  const orphaned: string[] = [];
  if (!o.sent.includes("SIGTERM")) orphaned.push("the step ended before SIGTERM");
  if (HANDLER_LINE.test(o.stderr)) orphaned.push("Styre's handler spoke");
  if (!(o.styreAlive && o.agentAlive && o.toolAlive)) orphaned.push("not everything still runs");
  if (orphaned.length === 0) return { kind: "orphaned", why: [] };
  return {
    kind: "other",
    why: [`not graceful: ${graceful.join("; ")}`, `not orphaned: ${orphaned.join("; ")}`],
  };
}
