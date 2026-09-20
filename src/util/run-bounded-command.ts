import { spawn } from "node:child_process";
import { verifyEnv } from "../agent/agent-env.ts";
import type { CommandResult } from "./run-command.ts";

/** POSIX review probes: cap the entire process/pipe lifetime and captured output. A process group
 * lets timeout cleanup reach ordinary descendants; this is not an OS sandbox against hostile code. */
export function runBoundedCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; onSpawn?: (pid: number) => void },
): Promise<CommandResult & { truncated: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], {
      cwd: opts.cwd,
      env: verifyEnv(process.env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const cap = 64 * 1024;
    const finish = (exitCode: number | null, timedOut: boolean, error?: string) => {
      let resultExitCode = exitCode;
      let resultError = error;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc.pid) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            resultError = `process-group cleanup failed: ${String(err)}`;
            resultExitCode = null;
          }
        }
      }
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.unref();
      resolve({
        exitCode: resultExitCode,
        timedOut,
        stdout,
        stderr: resultError ? `${stderr}\n${resultError}` : stderr,
        truncated,
      });
    };
    const timer = setTimeout(() => finish(null, true), opts.timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      truncated ||= stdout.length + text.length > cap;
      stdout = (stdout + text).slice(0, cap);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      truncated ||= stderr.length + text.length > cap;
      stderr = (stderr + text).slice(0, cap);
    });
    proc.on("error", (err) => finish(null, false, String(err)));
    proc.on("close", (code) => finish(code, false));
    if (proc.pid) {
      try {
        opts.onSpawn?.(proc.pid);
      } catch (error) {
        finish(null, false, `PID journaling failed: ${String(error)}`);
      }
    }
  });
}
