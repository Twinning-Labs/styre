// test/lifecycle/fixtures/drive-run.ts: Styre's stop handling around one launch, for the terminal
// tests (test/lifecycle/terminal.test.ts, Task 15). It installs the real stop handlers (real stderr,
// re-raise and exit), launches through the door, says on stderr what it launched, then "ready", and
// waits for a signal.
//
// What it launches, by its first argument:
//   agent    the stand-in agent (standin-agent.sh), working in $DRIVE_WORKTREE: it runs a tool command
//            in a group of its own, stops it on SIGTERM, SIGINT or SIGHUP, and dies at once on SIGQUIT
//            (Claude Code's Ctrl-\ behaviour, D13). Says `agent <pid>` and `tool <pid>`.
//   stubborn an agent that ignores SIGINT, SIGTERM and SIGHUP (stubborn-agent.sh), so only a forced
//            stop ends it. Says `agent <pid>` and `tool <pid>`.
//   group    a command group, as a suite runs (`sh -c 'sleep … & sleep …; wait'`). Says `group <pid>`.
//
// With $DRIVE_DB (and $DRIVE_TICKET, $DRIVE_STEP, $DRIVE_STARTED) it is `styre run` with a run
// database and a step in flight, so the interruption is recorded there. With $DRIVE_SLOW the
// analytics shutdown takes 300 ms, as a real one can, so a write's failure after the terminal has
// closed has time to surface. With $DRIVE_ERRORS it appends the code of every failed stderr write to
// that file; with $DRIVE_LOG, everything it writes to stderr.
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { beginStep, launch } from "../../../src/util/process/door.ts";
import { installStopHandlers } from "../../../src/util/process/signals.ts";

const mode = process.argv[2] ?? "agent";
const errorsFile = process.env.DRIVE_ERRORS;
if (errorsFile) {
  process.stderr.on("error", (err) => {
    appendFileSync(errorsFile, `${(err as NodeJS.ErrnoException).code ?? err.message}\n`);
  });
}

// With $DRIVE_LOG every stderr write is also appended to that file, before it goes to the terminal:
// the test can read what Styre said after the terminal itself is gone.
const logFile = process.env.DRIVE_LOG;
if (logFile) {
  const write = process.stderr.write.bind(process.stderr) as (...a: unknown[]) => boolean;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    appendFileSync(logFile, chunk);
    return write(chunk, ...rest);
  }) as typeof process.stderr.write;
}

const dbPath = process.env.DRIVE_DB;
let run: { db: Database; dbPath: string; ticketId: number; ident: string } | null = null;
if (dbPath) {
  run = {
    db: new Database(dbPath),
    dbPath,
    ticketId: Number(process.env.DRIVE_TICKET),
    ident: "ENG-1",
  };
  beginStep({
    stepId: Number(process.env.DRIVE_STEP),
    startedAt: process.env.DRIVE_STARTED ?? "",
    ident: "ENG-1",
    headAtStart: null,
  });
}

installStopHandlers({
  command: "run",
  run,
  ...(process.env.DRIVE_SLOW
    ? { shutdownAnalytics: (ms: number) => Bun.sleep(Math.min(ms, 300)) }
    : {}),
});

const say = (s: string): void => {
  process.stderr.write(s);
};

if (mode === "group") {
  const n = process.env.STANDIN_SLEEP ?? "300";
  const h = launch({
    argv: ["sh", "-c", `sleep ${n} & sleep ${n}; wait`],
    cwd: process.cwd(),
    env: process.env,
    kind: "group",
    context: { ident: "ENG-1", stepId: null, worktree: null },
  });
  say(`group ${h.record.pid}\n`);
} else {
  const fixture = mode === "stubborn" ? "stubborn-agent.sh" : "standin-agent.sh";
  const worktree = process.env.DRIVE_WORKTREE ?? process.cwd();
  const h = launch({
    argv: ["bash", join(import.meta.dir, fixture)],
    cwd: worktree,
    env: process.env,
    kind: "agent",
    context: { ident: "ENG-1", stepId: null, worktree },
  });
  say(`agent ${h.record.pid}\n`);
  // The agent says `tool <pid>` once its traps are set: pass it on, then let go of the pipe.
  const reader = h.proc.stderr.getReader();
  let text = "";
  while (!/tool \d+\n/.test(text)) {
    const r = await reader.read();
    if (r.done) break;
    text += new TextDecoder().decode(r.value);
  }
  reader.releaseLock();
  const tool = /tool (\d+)\n/.exec(text);
  say(tool ? `tool ${tool[1]}\n` : "no tool\n");
}
say("ready\n");
setInterval(() => {}, 1_000);
