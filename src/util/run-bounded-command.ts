import { commandEnv } from "./process/command-temp.ts";
import { type LaunchHandle, RunInterrupted, launch } from "./process/door.ts";
import { DRAIN_LIMIT_MS, readPipe } from "./process/read-pipe.ts";
import { type CommandResult, reportSurvivors, survivorNote } from "./run-command.ts";

/** POSIX review probes: cap the entire process and pipe lifetime and the captured output.
 *
 *  The command leads a process group of its own (through the door, ENG-485 section 6.2). A timeout
 *  or a stop reaches every member of the group, and after a normal exit anything left running is
 *  stopped before the rest of the output is read, for at most DRAIN_LIMIT_MS. This is not an OS
 *  sandbox against hostile code. Throws RunInterrupted when the stop handler stopped the command or
 *  the door was already closed. stdin is ignored. */
export async function runBoundedCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<CommandResult & { truncated: boolean }> {
  let h: LaunchHandle;
  try {
    h = launch({
      argv: ["sh", "-c", command],
      cwd: opts.cwd,
      env: commandEnv(),
      kind: "group",
      context: { ident: null, stepId: null, worktree: opts.cwd },
    });
  } catch (error) {
    if (error instanceof RunInterrupted) throw error;
    return { exitCode: null, timedOut: false, stdout: "", stderr: String(error), truncated: false };
  }
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const cap = 64 * 1024;
  // Keep the beginning AND latest output. Retaining only a prefix hides the command phase
  // active at timeout, even when downstream diagnostics ask for the log's tail.
  const capture = (previous: string, next: string) => {
    const combined = previous + next;
    if (combined.length <= cap) return combined;
    truncated = true;
    return combined.slice(0, cap / 2) + combined.slice(-cap / 2);
  };
  const out = readPipe(h.proc.stdout, (t) => {
    stdout = capture(stdout, t);
  });
  const err = readPipe(h.proc.stderr, (t) => {
    stderr = capture(stderr, t);
  });
  const result = (
    exitCode: number | null,
    timedOut: boolean,
    notes: string[],
  ): CommandResult & { truncated: boolean } => ({
    exitCode,
    timedOut,
    stdout,
    stderr: notes.length ? [stderr, ...notes].filter(Boolean).join("\n") : stderr,
    truncated,
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
    const rep = outcome === "timeout" ? await h.stop("graceful") : await h.finish();
    if (h.interrupted) throw new RunInterrupted();
    reportSurvivors(h, rep.survivors);
    const [outDone, errDone] = await Promise.all([
      out.finish(DRAIN_LIMIT_MS),
      err.finish(DRAIN_LIMIT_MS),
    ]);
    if (!(outDone && errDone)) truncated = true;
    const notes = [
      outDone && errDone ? "" : "[output read limit reached]",
      survivorNote(rep.survivors),
    ].filter(Boolean);
    // A command killed by a signal has no exit code of its own (Bun reports 128 + n for it).
    const code = outcome === "timeout" || h.proc.signalCode ? null : h.proc.exitCode;
    return result(code, outcome === "timeout", notes);
  } finally {
    clearTimeout(timer);
    out.cancel();
    err.cancel();
  }
}
