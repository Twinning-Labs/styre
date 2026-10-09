// ENG-485 section 7: the stop signal handler. On SIGINT, SIGTERM, SIGHUP or SIGQUIT it owns the
// whole interruption (D15): it closes the door, makes the run's connection read only, sends the stop
// signals before writing anything, speaks, waits for the stops, reports leftovers, records the
// interruption on its own connection, writes the telemetry event, reports the outcome, makes the
// cleanups the run code still holds, and exits as Styre would have without a handler. Everything
// runs against one deadline (section 7.4); a second signal forces every stop still in progress.
import type { Database } from "bun:sqlite";
import { constants } from "node:os";
import type { EventLogRow } from "../../db/repos/event-log.ts";
import { stdoutSink } from "../../telemetry/emit.ts";
import { runCtx, toEvent } from "../../telemetry/emitter.ts";
import {
  type LaunchContext,
  type LaunchHandle,
  beginStopping,
  describeProcess,
  inFlightStep,
  liveLaunches,
  runDeferredCleanups,
  stopAbort,
} from "./door.ts";
import { recordInterruption } from "./interruption.ts";
import { checkLeftovers, skippedLine } from "./leftovers.ts";
import {
  type CoreDumpState,
  restoreCoreDumps,
  saveCoreDumps,
  turnOffCoreDumps,
  turnOffCoreDumpsForPrompt,
} from "./proc-table.ts";
import type { StopReport } from "./stop.ts";

/** One deadline for the whole handler, from the first signal (section 7.4). */
export const HANDLER_DEADLINE_MS = 6_500;
/** Graceful stops are cut short to leave this much of the deadline for the steps after them. */
const AFTER_STOPS_MS = 1_500;
/** Once the stops are forced, how long to wait for them to confirm (section 7.4: under 0.5 s, plus
 *  one listing). A stop still unsettled after it is reported as unconfirmed. */
const FORCED_WAIT_MS = 600;
/** The leftover check gets what is left of the deadline minus this. */
const AFTER_LEFTOVERS_MS = 1_000;
/** Below this budget the leftover check is skipped, and the skip is said. */
const MIN_LEFTOVER_MS = 200;
/** Kept back from the analytics shutdown for the lock release, the re-raise and the exit. */
const EXIT_RESERVE_MS = 150;
/** Kept back from a held cleanup's budget for what follows its blocking call (the folder removal). */
const CLEANUP_MARGIN_MS = 100;
/** Below this budget a held cleanup is skipped, and its manual finish said. */
const MIN_CLEANUP_MS = 100;
/** How long the re-raised signal gets to end the process before the fallback exit. */
const RERAISE_WAIT_MS = 100;
/** The longest one survivor's `ps` may take. */
const DESCRIBE_MS = 1_000;

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

export interface HandlerCtx {
  command: "run" | "setup";
  /** Set once the run database is open (`styre run` only). The handler reads it once, at the
   *  signal (R26): a run that is null, or whose connection is already closed, at that moment is
   *  not recorded. So the run code (Task 11) must neither close this connection nor call
   *  `setRun(null)` while the door is stopping; it may only do so on a normal exit. */
  run?: { db: Database; dbPath: string; ticketId: number; ident: string } | null;
  releaseLock?: () => void;
  /** Shut analytics down within `ms`. */
  shutdownAnalytics?: (ms: number) => Promise<void>;
}
export interface HandlerDeps {
  stderr: (s: string) => void;
  /** Writes the interruption's note as telemetry; `db` is the run's connection read at the signal. */
  emit: (row: EventLogRow, db: Database) => void;
  reraise: (sig: NodeJS.Signals) => void;
  exit: (code: number) => void;
  now: () => number;
  leftovers: (stopped: LaunchHandle[], budgetMs: number) => string[];
  /** Turn core dumps off for this process (before the SIGQUIT re-raise); throws when it cannot. */
  noCore: () => void;
}

type Outcome = { rep: StopReport } | { err: unknown };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Resolves true when `p` settles within `ms`, false otherwise. Never rejects; the timer is
 *  cleared either way, and keeps the process alive while it runs (the handler must finish). */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  const settled = p.then(
    () => true,
    () => true,
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

/** A copy that later changes by run code cannot reach (R18). */
function snapshot(c: LaunchContext | undefined): LaunchContext | null {
  if (!c) return null;
  return { ...c, ...(c.untrackedBefore ? { untrackedBefore: [...c.untrackedBefore] } : {}) };
}

let first: NodeJS.Signals | null = null;
/** Set by the second signal, so a third one says nothing more. */
let forcing = false;

/** Section 7.3. Exported for tests; production reaches it through `installStopHandlers`. */
export async function handleStopSignal(
  sig: NodeJS.Signals,
  ctx: HandlerCtx,
  d: HandlerDeps,
): Promise<void> {
  const say = (s: string): void => {
    try {
      d.stderr(s);
    } catch {
      /* nowhere to say it */
    }
  };
  if (first !== null) {
    // A second signal: every stop still in progress skips the rest of its grace period. The exit
    // still uses the first signal.
    stopAbort.forced = true;
    if (!forcing) say("styre: forcing stop…\n");
    forcing = true;
    return;
  }
  first = sig;
  const exitSig = sig;
  const deadline = d.now() + HANDLER_DEADLINE_MS;
  try {
    // 1. Close the door, and make the run's connection read only. From here run code can neither
    //    start a process nor write the run database.
    beginStopping();
    // The run is read once, here (R26). A connection that refuses the pragma is closed: the run
    // has ended or is ending, so there is nothing to record (section 7.3 step 6).
    const run = ctx.run ?? null;
    let runOpen = false;
    if (run) {
      try {
        run.db.exec("PRAGMA query_only = ON;");
        runOpen = true;
      } catch {
        /* already closed: nothing can write through it, and nothing is recorded */
      }
    }
    const recordable = ctx.command === "run" && run !== null && runOpen ? run : null;
    // Read what the recording needs now, before any await lets run code move on (R18).
    const step = inFlightStep();
    const launches = liveLaunches();
    // The in-flight step's open dispatch first: it holds until the dispatch row is completed, while
    // the agent's launch leaves the live set as soon as the agent has exited (A F3).
    const agentContext = snapshot(
      step?.dispatch ?? launches.find((h) => h.record.kind === "agent")?.context,
    );

    // 2. Send the stop signals, synchronously, before writing anything (section 2.5): each stop
    //    sends its first signal before its first await.
    const outcomes: (Outcome | undefined)[] = launches.map(() => undefined);
    const stops = launches.map((h, i) => {
      h.interrupted = true;
      return h.stop("graceful").then(
        (rep) => {
          outcomes[i] = { rep };
        },
        (err: unknown) => {
          outcomes[i] = { err };
        },
      );
    });

    // 3. Speak.
    say(
      sig === "SIGINT"
        ? "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…\n"
        : `styre: received a stop request (${sig}) — cleaning up…\n`,
    );

    // 4. Wait for the stops, cut short to leave time for the rest; then force what is left.
    const all = Promise.all(stops);
    if (!(await within(all, deadline - AFTER_STOPS_MS - d.now()))) {
      stopAbort.forced = true;
      await within(all, FORCED_WAIT_MS);
    }

    // 5. Leftovers, for each agent launch that was stopped, within what is left minus 1 s.
    const checked = launches.filter(
      (h) => h.record.kind === "agent" && h.context.worktree !== null,
    );
    let leftoverLines: string[] = [];
    if (checked.length > 0) {
      const budget = deadline - d.now() - AFTER_LEFTOVERS_MS;
      if (budget >= MIN_LEFTOVER_MS) {
        try {
          leftoverLines = d.leftovers(checked, budget);
        } catch (err) {
          leftoverLines = [skippedLine(message(err))];
        }
      } else {
        leftoverLines = [skippedLine("no time was left before the stop deadline")];
      }
    }

    // 6. Record the interruption: `styre run` only, one transaction on the handler's own connection.
    let row: EventLogRow | null = null;
    if (recordable) {
      try {
        row = recordInterruption(recordable.dbPath, {
          ticketId: recordable.ticketId,
          signal: sig,
          step,
          agent: agentContext,
        });
      } catch (err) {
        say(`styre: could not record the interruption: ${message(err)}\n`);
      }
    }

    // 7. The telemetry event, then the outcome.
    if (row && recordable) {
      try {
        d.emit(row, recordable.db);
      } catch (err) {
        say(`styre: could not write the interruption's telemetry event: ${message(err)}\n`);
      }
    }
    const lines: string[] = [];
    const survivorLines: string[] = [];
    launches.forEach((h, i) => {
      const o = outcomes[i];
      const pid = h.record.pid;
      if (o === undefined || "err" in o) {
        const why = o === undefined ? "it did not finish in time" : message(o.err);
        const target = h.record.kind === "group" ? `-- -${pid}` : String(pid);
        survivorLines.push(
          `styre: could not confirm that ${h.record.command} (pid ${pid}) stopped (${why}); if it is still running, stop it with: kill -9 ${target}\n`,
        );
        return;
      }
      const { rep } = o;
      const left = new Set(rep.survivors.map((p) => `${p.pid}:${p.startedAt}`));
      if (h.record.kind === "agent" && !rep.survivors.some((p) => p.pid === pid)) {
        // Only processes this stop signalled, other than the agent itself, that are gone now.
        const n = rep.signalled.filter(
          (p) => p.pid !== pid && !left.has(`${p.pid}:${p.startedAt}`),
        ).length;
        lines.push(`styre: stopped the agent (pid ${pid}) and ${n} of its commands.\n`);
      }
      for (const s of rep.survivors) {
        const ms = Math.min(DESCRIBE_MS, deadline - EXIT_RESERVE_MS - d.now());
        const command = ms >= 50 ? describeProcess(s.pid, h.record.command, ms) : h.record.command;
        survivorLines.push(
          `styre: could not stop ${command} (pid ${s.pid}); stop it with: kill -9 ${s.pid}\n`,
        );
      }
    });
    for (const l of [...lines, ...survivorLines, ...leftoverLines]) say(l);
    if (recordable) {
      say(`styre: run interrupted; resume with: styre run --resume ${recordable.ident}\n`);
    }
  } catch (err) {
    say(`styre: the stop handler failed: ${message(err)}\n`);
  } finally {
    // The cleanups the run code would make in its own `finally`, such as removing a baseline
    // worktree from the target repo (m3). The exit below does not wait for the run code to unwind,
    // so they are made here: after the stops, so nothing still uses what they remove, and after
    // the record, so a slow one can never cost the interruption its record (I1). While stopping,
    // the run code's own release leaves them held, so only this makes them. Each gets what is
    // left of the deadline, short of the exit's reserve and a margin; with too little left one is
    // skipped and its manual finish said.
    for (const why of runDeferredCleanups(() => {
      const ms = deadline - EXIT_RESERVE_MS - CLEANUP_MARGIN_MS - d.now();
      return ms >= MIN_CLEANUP_MS ? ms : 0;
    })) {
      say(`styre: could not clean up after the run: ${why}\n`);
    }
    // 8. Exit as Styre would have without a handler.
    const left = deadline - EXIT_RESERVE_MS - d.now();
    const shutdown = ctx.shutdownAnalytics;
    if (shutdown && left > 0) {
      await within(
        Promise.resolve().then(() => shutdown(left)),
        left,
      );
    }
    // The run lock goes last, so a --resume started meanwhile cannot overlap this run (R7).
    try {
      ctx.releaseLock?.();
    } catch (err) {
      say(`styre: could not release the run lock: ${message(err)}\n`);
    }
    // Ctrl-\ ends Styre by SIGQUIT (131, D13), whose default action dumps core: a Bun core is
    // gigabytes. The other stop signals dump nothing.
    if (exitSig === "SIGQUIT") {
      try {
        d.noCore();
      } catch (err) {
        say(`styre: could not turn off core dumps before exiting: ${message(err)}\n`);
      }
    }
    try {
      d.reraise(exitSig);
    } catch {
      /* the fallback below still exits */
    }
    // Still alive: a container's first process ignores the re-raised signal (section 2.5).
    const wait = Math.min(RERAISE_WAIT_MS, Math.max(20, deadline - d.now()));
    await new Promise((r) => setTimeout(r, wait));
    d.exit(128 + (constants.signals[exitSig] ?? 0));
  }
}

let installed: Map<NodeJS.Signals, () => void> | null = null;
let streamsGuarded = false;

function removeInstalled(): void {
  for (const [s, h] of installed ?? []) process.removeListener(s, h);
}

function realDeps(): HandlerDeps {
  return {
    stderr: (s) => {
      try {
        process.stderr.write(s);
      } catch {
        /* the terminal is gone */
      }
    },
    emit: (row, db) => stdoutSink(toEvent(row, runCtx(db))),
    reraise: (sig) => {
      removeInstalled();
      process.kill(process.pid, sig);
    },
    exit: (code) => process.exit(code),
    now: () => Date.now(),
    leftovers: (stopped, budgetMs) => checkLeftovers({ stopped, timeoutMs: budgetMs }),
    noCore: turnOffCoreDumps,
  };
}

/** Section 7.1: `styre run` and `styre setup` install the handlers. `deps` replaces parts of the
 *  real dependencies (tests). */
export function installStopHandlers(
  ctx: HandlerCtx,
  deps?: Partial<HandlerDeps>,
): { setRun(r: HandlerCtx["run"]): void; dispose(): void } {
  if (installed) throw new Error("the stop handlers are already installed");
  if (!streamsGuarded) {
    // A write after the terminal has closed must not end Styre in the middle of a stop (2.5).
    process.stdout.on("error", () => {});
    process.stderr.on("error", () => {});
    streamsGuarded = true;
  }
  const d: HandlerDeps = { ...realDeps(), ...deps };
  const mine = new Map<NodeJS.Signals, () => void>(
    SIGNALS.map((s) => [
      s,
      () => {
        handleStopSignal(s, ctx, d).catch(() => {
          /* the handler says its own failures */
        });
      },
    ]),
  );
  installed = mine;
  for (const [s, h] of mine) process.on(s, h);
  return {
    setRun: (r) => {
      ctx.run = r;
    },
    dispose: () => {
      if (installed !== mine) return;
      removeInstalled();
      installed = null;
    },
  };
}

/** The core dump calls around a prompt (proc-table.ts), and where their failures are said. */
export interface PromptCores {
  save: () => CoreDumpState;
  off: () => void;
  restore: (saved: CoreDumpState) => void;
  say: (line: string) => void;
}
const PROMPT_CORES: PromptCores = {
  save: saveCoreDumps,
  off: turnOffCoreDumpsForPrompt,
  restore: restoreCoreDumps,
  say: (line) => {
    try {
      process.stderr.write(line);
    } catch {
      /* nowhere to say it */
    }
  },
};

/**
 * Section 7.1: setup's blocking prompt() would otherwise hold Ctrl-C until Enter (review round 1,
 * finding 3). While `fn` runs a signal has its default effect; the handlers come back after. Every
 * prompt that runs with the handlers suspended goes through here: setup's missing command prompts
 * (resolveCommands) and its approval prompt.
 *
 * A signal's default effect for Ctrl-\ is a core dump, so core dumps are off while `fn` runs
 * (amendment 2026-10-08): the state is saved, turned off (the soft limit only), and given back in
 * the `finally`, whether `fn` answers, throws or meets the end of input. A failure on either side is
 * said in one line, and the prompt and setup go on.
 */
export async function suspendStopHandlers<T>(
  fn: () => T | Promise<T>,
  cores: PromptCores = PROMPT_CORES,
): Promise<T> {
  // Core dumps go off while the handlers are still installed, and come back only once the handlers
  // are back: a Ctrl-\ in between would otherwise dump core (final review A F5).
  let kept: CoreDumpState | null = null;
  try {
    kept = cores.save();
    cores.off();
  } catch (err) {
    cores.say(`styre: could not turn off core dumps for the prompt: ${message(err)}\n`);
  }
  const saved = installed;
  for (const [s, h] of saved ?? []) process.removeListener(s, h);
  try {
    return await fn();
  } finally {
    if (saved && installed === saved) for (const [s, h] of saved) process.on(s, h);
    if (kept !== null) {
      try {
        cores.restore(kept);
      } catch (err) {
        cores.say(`styre: could not restore core dumps after the prompt: ${message(err)}\n`);
      }
    }
  }
}

/** Test seam only: the core dump calls setup's prompts use. */
export function __promptCoresForTests(): PromptCores {
  return PROMPT_CORES;
}

/** Test seam only: the real dependencies, so a test can check what they are wired to. */
export function __realDepsForTests(): HandlerDeps {
  return realDeps();
}

/** Test seam only. */
export function __resetSignalsForTests(): void {
  removeInstalled();
  installed = null;
  first = null;
  forcing = false;
}
