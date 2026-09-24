import { agentEnv } from "../agent-env.ts";
import { toolNamesFor } from "../capabilities.ts";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  EffectiveCapabilities,
  FailureCause,
} from "../runner.ts";

// agentEnv keeps ANTHROPIC_API_KEY for the agent CLI; the verify sink (run-command.ts) uses the
// stricter verifyEnv (also strips ANTHROPIC_API_KEY). See ../agent-env.ts.
export { agentEnv } from "../agent-env.ts";

/** The permission mode every Claude dispatch runs in (ENG-476). `dontAsk` refuses, without
 *  prompting, any tool use the allowlist does not pre-approve. It is pinned on the command line
 *  and re-checked against the CLI's own init report, so an inherited or configured mode (e.g.
 *  `auto`, `bypassPermissions`) can never widen a step. */
export const CLAUDE_PERMISSION_MODE = "dontAsk";

/** The Claude `claude -p` argv (pure). ENG-476 capability isolation, verified live on Claude Code
 *  2.1.280 against a hostile setup (planted secret outside the project, permissive user mode,
 *  permissive project settings):
 *  - `--restricted` ignores user/project/local settings files and confines file tools to the
 *    working directory — without it a step read a secret outside the worktree and wrote outside it;
 *  - `--tools` sets the AVAILABLE tool set to exactly the step's tools (`--allowedTools` only
 *    grants permission; alone it left every built-in, plugin and MCP tool available);
 *  - `--allowedTools` keeps the scoped permissions (e.g. `Bash(npm test:*)`);
 *  - `--permission-mode dontAsk` denies everything not pre-approved, whatever mode is inherited;
 *  - `--strict-mcp-config` with no `--mcp-config` loads no MCP servers;
 *  - `stream-json` (which `-p` requires `--verbose` for) exposes the init event the adapter uses
 *    to report the effective tool set. The preflight probes `--help` for every one of these. */
export function buildClaudeArgs(input: { model: string; allowedTools: string[] }): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--restricted",
    "--tools",
    toolNamesFor(input.allowedTools).join(","),
    "--allowedTools",
    input.allowedTools.join(" "),
    "--permission-mode",
    CLAUDE_PERMISSION_MODE,
    "--strict-mcp-config",
  ];
}

/** The flags `buildClaudeArgs` depends on, as the preflight must find them in `claude --help`.
 *  `dontAsk` is a permission-mode choice, not a flag, but a CLI without it cannot honor the mode. */
export const CLAUDE_REQUIRED_HELP_TOKENS = [
  "--restricted",
  "--tools",
  "--allowedTools",
  "--permission-mode",
  "dontAsk",
  "--strict-mcp-config",
  "stream-json",
];

/** The init event and final result envelope of a `stream-json` run. Either is null when absent.
 *  Non-JSON lines are ignored (the CLI prints nothing else on stdout, but a partial write on a
 *  killed process must not throw). */
export function parseClaudeStream(stdout: string): {
  init: { tools: string[]; permissionMode: string | null } | null;
  result: Record<string, unknown> | null;
} {
  let init: { tools: string[]; permissionMode: string | null } | null = null;
  let result: Record<string, unknown> | null = null;
  for (const raw of stdout.split("\n")) {
    const text = raw.trim();
    if (text === "") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "system" && obj.subtype === "init") {
      const tools = Array.isArray(obj.tools)
        ? obj.tools.filter((t): t is string => typeof t === "string")
        : [];
      init = {
        tools,
        permissionMode: typeof obj.permissionMode === "string" ? obj.permissionMode : null,
      };
    } else if (obj.type === "result") {
      result = obj;
    }
  }
  return { init, result };
}

/** What the CLI reports the agent was given (ENG-476). The tool set is compared against the
 *  step's allowlist by the core; the permission mode is Claude-specific, so it is checked here. */
export function claudeCapabilities(
  init: {
    tools: string[];
    permissionMode: string | null;
  } | null,
): EffectiveCapabilities {
  if (init === null) {
    return { tools: null, error: "claude emitted no init event; the tool set is unverifiable" };
  }
  if (init.permissionMode !== CLAUDE_PERMISSION_MODE) {
    return {
      tools: init.tools,
      error: `claude ran in permission mode '${init.permissionMode ?? "unknown"}', not '${CLAUDE_PERMISSION_MODE}'`,
    };
  }
  return { tools: init.tools, error: null };
}

/** Best-effort parse of the result envelope's usage (forensic only): the final `result` event of
 *  a `stream-json` run carries the same fields `--output-format json` printed. */
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

/** DEC-CX-4: the stdout contract is "the final assistant message as plain text". The result
 *  envelope's `result` field carries that text; unwrap it.
 *  Falls back to the raw string when `result` is absent/non-string (never emits "undefined"). */
export function assistantText(rawStdout: string): string {
  try {
    const obj = JSON.parse(rawStdout) as Record<string, unknown>;
    return typeof obj.result === "string" ? obj.result : rawStdout;
  } catch {
    return rawStdout;
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
/** Minimum `claude` CLI version this adapter's flag surface is verified against (ENG-326). Raised
 *  to 2.1.280 by ENG-476: the capability-isolation flags were verified live on exactly that
 *  version (`scripts/smoke-isolation.ts`); older versions are not claimed. The preflight also
 *  probes `--help` for every pinned flag. Single source of truth for the preflight probe. */
export const CLAUDE_MIN_CLI_VERSION = "2.1.280";

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
        const stream = parseClaudeStream(stdout);
        // The result envelope is the one line the old `json` format printed; without it (a crash
        // mid-stream) fall back to the raw text so a failure stays diagnosable.
        const envelope = stream.result === null ? stdout : JSON.stringify(stream.result);
        const usage = parseClaudeJson(envelope);
        const finalText = assistantText(envelope); // usage stays parsed from the RAW envelope above
        const capabilities = claudeCapabilities(stream.init);
        if (exitCode === 0) {
          return {
            completed: true,
            exitCode,
            stdout: finalText,
            stderr,
            timedOut: false,
            ...usage,
            capabilities,
          };
        }
        const { cause, resetAt } = classifyFailure(stderr, stdout);
        return {
          completed: false,
          exitCode,
          stdout: finalText,
          stderr,
          timedOut: false,
          ...usage,
          cause,
          resetAt,
          capabilities,
        };
      } catch (err) {
        return transportFailure(String(err), false);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
