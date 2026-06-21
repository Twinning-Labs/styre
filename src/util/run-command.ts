export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run one shell command in `cwd` under a timeout, capturing ground-truth exit state.
 *  Daemon-only: used by the verify steps to run the project-profile commands (B2). The
 *  `timedOut` flag is set in the kill callback so a true timeout is never confused with
 *  a command that merely exited non-zero. */
export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stdout, stderr, timedOut };
  } catch (err) {
    clearTimeout(timer);
    return { exitCode: null, stdout: "", stderr: String(err), timedOut };
  }
}
