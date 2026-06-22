import { agentEnv } from "../agent-env.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "../runner.ts";

// agentEnv (the cred scrub) is shared with the verify sink (run-command.ts); see ../agent-env.ts.
export { agentEnv } from "../agent-env.ts";

/** The Claude `claude -p` argv (pure). Flag names are CLI-version-specific — verified against a
 *  real `claude` run in the Task 7 smoke; the core never depends on these. */
export function buildClaudeArgs(input: { model: string; allowedTools: string[] }): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    input.model,
    "--allowedTools",
    input.allowedTools.join(" "),
  ];
}

/** Best-effort parse of `claude -p --output-format json` usage (forensic only). Field names
 *  are smoke-verified in Task 7. */
export function parseClaudeJson(stdout: string): {
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
} {
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>;
    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return {
      costUsd: num(obj.total_cost_usd),
      tokensIn: num(usage.input_tokens),
      tokensOut: num(usage.output_tokens),
    };
  } catch {
    return { costUsd: null, tokensIn: null, tokensOut: null };
  }
}

/** The Claude adapter: spawn `<command> -p …` in the worktree, feed the prompt on stdin,
 *  capture stdout/exit under a timeout, parse usage. The ONLY place that knows Claude's CLI.
 *  Exercised by the manual smoke (Task 7), where flags + JSON fields are confirmed.
 *
 *  Timeout is a HARD progress bound (mirrors util/run-command.ts): we race `proc.exited` against
 *  the timer rather than awaiting it unconditionally, so a `claude` (or forked child holding the
 *  stdout pipe) that ignores SIGTERM or wedges in IO can never hang the single-threaded run loop.
 *  On timeout we SIGKILL and resolve PROMPTLY — without awaiting `proc.exited` or draining pipes,
 *  either of which can stall on the same wedged child. The normal path drains stdout/stderr
 *  concurrently with the exit wait (avoids the large-output pipe-buffer deadlock). */
export function claudeAgentRunner(command = "claude"): AgentRunner {
  return {
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const transportFailure = (stderr: string, timedOut: boolean): AgentRunResult => ({
        completed: false,
        exitCode: null,
        stdout: "",
        stderr,
        timedOut,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      });
      const proc = Bun.spawn([command, ...buildClaudeArgs(input)], {
        cwd: input.cwd,
        env: agentEnv(process.env),
        stdin: new TextEncoder().encode(input.prompt),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (input.onSpawn && typeof proc.pid === "number") {
        input.onSpawn(proc.pid);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
      });
      try {
        const outcome = await Promise.race([proc.exited.then(() => "exited" as const), timeoutP]);
        if (outcome === "timeout") {
          proc.kill("SIGKILL");
          return transportFailure("dispatch timed out", true);
        }
        const exitCode = await proc.exited;
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const usage = parseClaudeJson(stdout);
        return { completed: exitCode === 0, exitCode, stdout, stderr, timedOut: false, ...usage };
      } catch (err) {
        return transportFailure(String(err), false);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
