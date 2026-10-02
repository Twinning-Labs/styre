import { verifyEnv } from "../agent/agent-env.ts";
import { type LaunchContext, type LaunchHandle, RunInterrupted, launch } from "./process/door.ts";
import { DRAIN_LIMIT_MS, readPipe } from "./process/read-pipe.ts";

export { DRAIN_LIMIT_MS };

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run one shell command in `cwd` under a timeout, capturing ground truth exit state.
 *  Daemon only: used by the verify steps to run the project profile commands (B2).
 *
 *  Capability isolation (move 4): the command is **agent authored worktree code** (the implement
 *  agent wrote the source and tests this build or test runs), so it is spawned with the daemon's
 *  creds scrubbed (`verifyEnv`: no LINEAR_API_KEY, GITHUB_TOKEN or ANTHROPIC_API_KEY).
 *
 *  Process handling (ENG-485 section 6.2): the command leads a process group of its own (through the
 *  door). A timeout or a stop reaches every member of the group, not `sh` alone. After a normal exit,
 *  anything the command left running is stopped BEFORE the output is read, and the rest of the output
 *  is read for at most DRAIN_LIMIT_MS, so a background child holding the pipe can never hang the
 *  caller. Output is read while the command runs, so a large output cannot stall it. Throws
 *  RunInterrupted when the stop handler stopped the command or the door was already closed.
 *
 *  A known limit (spec 6.2, R11): a command in a group of its own has no controlling terminal, so
 *  one that opens /dev/tty (sudo, an ssh passphrase or host key prompt, a git username prompt)
 *  fails at once with ENXIO instead of prompting. Styre's own commands never do this; commands from
 *  the project profile or an agent might. */
export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; context?: LaunchContext },
): Promise<CommandResult> {
  let h: LaunchHandle;
  try {
    h = launch({
      argv: ["sh", "-c", command],
      cwd: opts.cwd,
      env: verifyEnv(process.env),
      kind: "group",
      context: opts.context ?? { ident: null, stepId: null, worktree: opts.cwd },
    });
  } catch (err) {
    if (err instanceof RunInterrupted) throw err;
    return { exitCode: null, stdout: "", stderr: String(err), timedOut: false };
  }
  let stdout = "";
  let stderr = "";
  const out = readPipe(h.proc.stdout, (t) => {
    stdout += t;
  });
  const err = readPipe(h.proc.stderr, (t) => {
    stderr += t;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      h.proc.exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (h.interrupted) throw new RunInterrupted();
    if (outcome === "timeout") {
      const rep = await h.stop("graceful");
      if (h.interrupted) throw new RunInterrupted();
      reportSurvivors(h, rep.survivors);
      return {
        exitCode: null,
        stdout: "",
        stderr: survivorNote(rep.survivors),
        timedOut: true,
      };
    }
    const exitCode = await h.proc.exited;
    const rep = await h.finish(); // check the group and stop leftovers, THEN read the rest
    if (h.interrupted) throw new RunInterrupted();
    reportSurvivors(h, rep.survivors);
    const [outDone, errDone] = await Promise.all([
      out.finish(DRAIN_LIMIT_MS),
      err.finish(DRAIN_LIMIT_MS),
    ]);
    const notes = [
      outDone && errDone ? "" : "[output read limit reached]",
      survivorNote(rep.survivors),
    ].filter(Boolean);
    return {
      exitCode,
      stdout,
      stderr: notes.length ? [stderr, ...notes].filter(Boolean).join("\n") : stderr,
      timedOut: false,
    };
  } finally {
    clearTimeout(timer);
    out.cancel();
    err.cancel();
  }
}

/** Tell the operator, on Styre's own stderr, about each process a stop could not end (spec 9.4
 *  wording). Most callers look only at the exit code, so the note in the result is not enough. */
export function reportSurvivors(h: LaunchHandle, survivors: { pid: number }[]): void {
  for (const p of survivors) {
    process.stderr.write(
      `styre: could not stop ${h.record.command} (pid ${p.pid}); stop it with: kill -9 ${p.pid}\n`,
    );
  }
}

/** A line for stderr when a stop left processes alive: never claim a clean group. */
export function survivorNote(survivors: { pid: number }[]): string {
  return survivors.length === 0
    ? ""
    : `[could not stop leftover processes: ${survivors.map((p) => p.pid).join(", ")}]`;
}

/** Injectable command executor with the same contract as the native runner. */
export type CmdRunner = typeof runCommand;
