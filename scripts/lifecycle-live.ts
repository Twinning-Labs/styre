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

/**
 * The control's code (operator decision, 2026-10-08): the branch `baseline/pre-eng-485`, main at
 * 9f51460 before ENG-485. Not `main`: once ENG-485 is merged, main has the stop handlers and the
 * control would stop its agent. Found locally, or as the remote's branch after a fetch.
 */
export const BASELINE_BRANCH = "baseline/pre-eng-485";
export const BASELINE_REFS = [
  `refs/heads/${BASELINE_BRANCH}`,
  `refs/remotes/origin/${BASELINE_BRANCH}`,
];
/** The file that holds ENG-485's stop handlers: the control's code must not have it. */
export const SIGNALS_FILE = "src/util/process/signals.ts";

/** Why the baseline cannot be the control (`resolved`: the first of BASELINE_REFS that exists),
 *  or null when it can. */
export function baselineProblem(resolved: string | null, hasSignals: boolean): string | null {
  if (resolved === null)
    return `no branch ${BASELINE_BRANCH} (looked for ${BASELINE_REFS.join(" and ")}); fetch it: git fetch origin ${BASELINE_BRANCH}:${BASELINE_REFS[1]}`;
  if (hasSignals)
    return `${resolved} has ${SIGNALS_FILE}: it is not code from before ENG-485, so it cannot be the control`;
  return null;
}

/** The control's driver must run without stop handlers, the new code's with them. */
export function handlersProblem(
  code: "control" | "new",
  said: "installed" | "none" | null,
): string | null {
  if (said === null) return "the driver never said whether it installed the stop handlers";
  if (code === "control" && said !== "none")
    return "the control installed stop handlers: it is not code from before ENG-485";
  if (code === "new" && said !== "installed") return "the new code installed no stop handlers";
  return null;
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
 * R8 (spec 6.1): the group Claude Code makes for a tool command is led by the agent's direct child,
 * so a stop takes it in while the agent lives. The check walks the sleep's parent chain up to the
 * agent: the agent's direct child on it must lead a group of its own, and every process on the
 * chain below the agent must sit in a group led by a process on that chain, which the stop
 * collects as a descendant. A shell with job control can nest the test in a group of its own
 * below the command group; that still holds, and the reason says so.
 */
export function r8Check(leaf: Proc, agent: Proc, table: Proc[]): { ok: boolean; why: string } {
  const byPid = new Map(table.map((q) => [q.pid, q]));
  const chain: Proc[] = [];
  const seen = new Set<number>();
  for (let cur: Proc | undefined = leaf; cur !== undefined && !seen.has(cur.pid); ) {
    chain.push(cur);
    seen.add(cur.pid);
    if (cur.ppid === agent.pid) break;
    cur = byPid.get(cur.ppid);
  }
  const child = chain[chain.length - 1];
  if (child === undefined || child.ppid !== agent.pid)
    return { ok: false, why: `pid ${leaf.pid} is not below the agent ${agent.pid}` };
  if (child.pgid !== child.pid)
    return {
      ok: false,
      why: `pid ${child.pid}, the agent's direct child, is in group ${child.pgid}, not a group of its own`,
    };
  const onChain = new Set(chain.map((q) => q.pid));
  for (const q of chain)
    if (!onChain.has(q.pgid))
      return {
        ok: false,
        why: `pid ${q.pid} is in group ${q.pgid}, which no process on its chain leads`,
      };
  const head = `the command group ${child.pgid} is led by pid ${child.pid}, the agent's direct child`;
  return {
    ok: true,
    why:
      leaf.pgid === child.pgid
        ? `${head}; the test runs in that group`
        : `${head}; the test runs in group ${leaf.pgid}, led by pid ${leaf.pgid} below it`,
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
  /** Ctrl-\ (D13): the test's sleep may outlive the stop, but then Styre must have reported it
   *  with the exact leftover line for this pid and command. */
  reportSleep?: { pid: number; command: string };
  /** Other processes that must be gone within the window too, by name (a wrapper's real CLI):
   *  each is read from the observation's `alsoGoneMs`, and one never watched counts as running. */
  alsoGone?: string[];
  /** Pairs of lines where the first must come before the second (a follow-up command's sweep
   *  line before its own refusal). A pair with either line missing is out of order. */
  before?: [string | RegExp, string | RegExp][];
}

/** What one scenario showed. Times are counted from the scenario's trigger. */
export interface Observation {
  exit: Ended | null;
  /** When the agent was first seen gone, or null if it was still running when the watch ended. */
  agentGoneMs: number | null;
  sleepGoneMs: number | null;
  /** Everything Styre said on stderr. */
  stderr: string;
  /** When each process named in the expectation's `alsoGone` was first seen gone, or null. */
  alsoGoneMs?: Record<string, number | null>;
}

const hasLine = (text: string, want: string | RegExp): boolean =>
  typeof want === "string" ? text.split("\n").includes(want) : want.test(text);

/** The index of the first line of `text` that is `want` (whole) or matches it; -1 if none. */
const lineIndex = (text: string, want: string | RegExp): number =>
  text
    .split("\n")
    .findIndex((l) =>
      typeof want === "string"
        ? l === want
        : new RegExp(want.source, want.flags.replace("g", "")).test(l),
    );

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
  } else if (late(seen.sleepGoneMs)) {
    const { pid, command } = want.reportSleep;
    const line = `styre: the agent left "${command}" (pid ${pid}) running in the worktree; stop it with: kill ${pid} (if it is not yours)`;
    if (!hasLine(seen.stderr, line))
      out.push(`the sleep (pid ${pid}) outlived the stop and was not reported`);
  }
  for (const name of want.alsoGone ?? [])
    if (late(seen.alsoGoneMs?.[name] ?? null))
      out.push(`the ${name} was still running ${STOP_WINDOW_MS} ms after the trigger`);
  for (const l of want.lines) if (!hasLine(seen.stderr, l)) out.push(`missing line: ${String(l)}`);
  for (const [a, b] of want.before ?? []) {
    const i = lineIndex(seen.stderr, a);
    const j = lineIndex(seen.stderr, b);
    if (i < 0 || j < 0 || i >= j) out.push(`"${String(a)}" did not come before "${String(b)}"`);
  }
  for (const re of want.absent ?? [])
    if (re.test(seen.stderr)) out.push(`unexpected line matching ${String(re)}`);
  return out;
}

/** One control scenario's outcome, read after the stop window. */
export interface ControlResult {
  name: string;
  agentAlive: boolean;
  sleepAlive: boolean;
  /** A wrapper scenario's real CLI (the wrapper's child), when there is one. */
  cliAlive?: boolean;
  /** What the old code leaves running in this scenario; by default the agent and its sleep. */
  leaks?: ("agent" | "sleep" | "cli")[];
}

/**
 * The control (main, before ENG-485) must leak in every control scenario: `kill` and `kill -9`
 * leave the agent and its sleep running (spec 2.1). If any did not, the probes cannot see the
 * failure they look for, and a pass would mean nothing.
 */
export function controlVerdict(results: ControlResult[]): { blind: boolean; why: string } {
  if (results.length === 0) return { blind: true, why: "no control scenario ran" };
  const what = { agent: "agent", sleep: "test's sleep", cli: "real CLI" } as const;
  const why = results.flatMap((r) => {
    if (r.leaks === undefined)
      return !r.agentAlive || !r.sleepAlive
        ? [
            `${r.name}: the agent was ${r.agentAlive ? "running" : "gone"} and its sleep ${r.sleepAlive ? "running" : "gone"}`,
          ]
        : [];
    const alive = { agent: r.agentAlive, sleep: r.sleepAlive, cli: r.cliAlive === true };
    return r.leaks.filter((k) => !alive[k]).map((k) => `${r.name}: the ${what[k]} was gone`);
  });
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

/**
 * The long step of each cancel job in .github/workflows/lifecycle-live.yml, as its `run:` text
 * (test/lifecycle/live-smoke.test.ts checks the workflow carries exactly this), which
 * scripts/simulate-github-cancel.ts runs as GitHub does. It records its own pid first; with `exec`
 * that pid becomes Styre's.
 */
export function cancelStep(exec: boolean): string {
  return `echo "step $$" >"$CANCEL_PIDS"\n${exec ? "exec " : ""}"$STYRE" setup "$CANCEL_REPO" --config "$CANCEL_CONFIG" --out "$CANCEL_OUT" 2>"$CANCEL_LOG"\n`;
}

/** The smoke's usage line (N1: an explicit mode, so no mistake can start a live run). */
export const SMOKE_USAGE =
  "usage: bun run scripts/smoke-lifecycle.ts --live|--standin [--model <claude model>]";
export const DEFAULT_SMOKE_MODEL = "claude-haiku-4-5-20251001";

/**
 * The smoke's arguments: exactly one of `--live` (real dispatches, which cost money) and
 * `--standin` (the free mode), and optionally `--model <claude-…>`. Anything else, a misspelled
 * mode included, is an error: the script then prints the usage and runs nothing.
 */
export function parseSmokeArgs(
  argv: string[],
): { mode: "live" | "standin"; model: string } | { error: string } {
  let mode: "live" | "standin" | null = null;
  let model: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--live" || a === "--standin") {
      if (mode !== null) return { error: `more than one mode (${a})` };
      mode = a === "--live" ? "live" : "standin";
    } else if (a === "--model") {
      const m = argv[i + 1];
      if (model !== null) return { error: "--model given twice" };
      if (m === undefined || !/^claude-[a-z0-9.-]+$/.test(m))
        return { error: `--model needs a claude model name, not ${m ?? "nothing"}` };
      model = m;
      i++;
    } else return { error: `unknown argument ${a}` };
  }
  if (mode === null) return { error: "no mode: give --live or --standin" };
  return { mode, model: model ?? DEFAULT_SMOKE_MODEL };
}
