import { agentEnv } from "../agent-env.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner, FailureCause } from "../runner.ts";

// agentEnv keeps ANTHROPIC_API_KEY for the agent CLI; the verify sink (run-command.ts) uses the
// stricter verifyEnv (also strips ANTHROPIC_API_KEY). See ../agent-env.ts.
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
  cacheRead: number | null;
  cacheCreate: number | null;
} {
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>;
    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return {
      costUsd: num(obj.total_cost_usd),
      tokensIn: num(usage.input_tokens),
      tokensOut: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
    };
  } catch {
    return { costUsd: null, tokensIn: null, tokensOut: null, cacheRead: null, cacheCreate: null };
  }
}

/** Map a Claude `claude -p` death to a provider-neutral cause (ENG-164). The ONLY place that
 *  knows Claude's marker strings. A session-limit death is a clean non-zero exit carrying the
 *  marker on stderr/stdout, so both streams are searched. */
export function classifyFailure(
  stderr: string,
  stdout: string,
): { cause: FailureCause; resetAt: string | null } {
  const text = `${stderr}\n${stdout}`;
  if (/hit your session limit|session limit|usage limit reached/i.test(text)) {
    const m = text.match(/resets?\s+([^\n]+)/i);
    return { cause: "session-limit", resetAt: m ? m[1].trim() : null };
  }
  if (/out of credit|insufficient credit|credit balance is too low/i.test(text)) {
    return { cause: "out-of-credits", resetAt: null };
  }
  return { cause: "transient", resetAt: null };
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
        cacheRead: null,
        cacheCreate: null,
        cause: "transient",
        resetAt: null,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
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
        const timeoutP = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
        });
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
        if (exitCode === 0) {
          return { completed: true, exitCode, stdout, stderr, timedOut: false, ...usage };
        }
        const { cause, resetAt } = classifyFailure(stderr, stdout);
        return {
          completed: false,
          exitCode,
          stdout,
          stderr,
          timedOut: false,
          ...usage,
          cause,
          resetAt,
        };
      } catch (err) {
        return transportFailure(String(err), false);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
