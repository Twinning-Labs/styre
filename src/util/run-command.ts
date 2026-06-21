export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run one shell command in `cwd` under a timeout, capturing ground-truth exit state.
 *  Daemon-only: used by the verify steps to run the project-profile commands (B2).
 *
 *  On timeout we resolve PROMPTLY (race the exit against the timer) and best-effort
 *  SIGKILL the process — we do NOT await `proc.exited` or drain the pipes first. A shell
 *  that forks its command (`sh -c "sleep 5"` under dash on Linux) can leave a child holding
 *  the inherited stdout pipe open after the shell is killed, which stalls `exited`/drain
 *  until that child ends on its own. Returning on the timer makes the timeout deterministic
 *  regardless of child cleanup. On the normal path stdout/stderr are drained concurrently
 *  with the exit wait (avoids the large-output pipe-buffer deadlock). */
export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
  });
  try {
    const outcome = await Promise.race([proc.exited.then(() => "exited" as const), timeoutP]);
    if (outcome === "timeout") {
      proc.kill("SIGKILL");
      return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    }
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut: false };
  } catch (err) {
    return { exitCode: null, stdout: "", stderr: String(err), timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}
