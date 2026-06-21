import type { AgentRunInput, AgentRunResult, AgentRunner } from "../runner.ts";

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
 *  Exercised by the manual smoke (Task 7), where flags + JSON fields are confirmed. */
export function claudeAgentRunner(command = "claude"): AgentRunner {
  return {
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const proc = Bun.spawn([command, ...buildClaudeArgs(input)], {
        cwd: input.cwd,
        stdin: new TextEncoder().encode(input.prompt),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (input.onSpawn && typeof proc.pid === "number") {
        input.onSpawn(proc.pid);
      }
      const timer = setTimeout(() => proc.kill(), input.timeoutMs);
      try {
        const exitCode = await proc.exited;
        clearTimeout(timer);
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const timedOut = exitCode !== 0 && stdout === "";
        const usage = parseClaudeJson(stdout);
        return { completed: exitCode === 0, exitCode, stdout, stderr, timedOut, ...usage };
      } catch (err) {
        clearTimeout(timer);
        return {
          completed: false,
          exitCode: null,
          stdout: "",
          stderr: String(err),
          timedOut: true,
          costUsd: null,
          tokensIn: null,
          tokensOut: null,
        };
      }
    },
  };
}
