import { agentEnv } from "../agent-env.ts";
import { toolNamesFor, toolSetMismatch } from "../capabilities.ts";
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
  for (const line of stdout.split("\n")) {
    const obj = parseJsonObject(line);
    if (obj === null) continue;
    if (obj.type === "system" && obj.subtype === "init") init = initFrom(obj);
    else if (obj.type === "result") result = obj;
  }
  return { init, result };
}

/** A line parsed as a JSON object, or null for blank, non-JSON or non-object lines. */
function parseJsonObject(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (text === "") return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function initFrom(obj: Record<string, unknown>): {
  tools: string[];
  permissionMode: string | null;
} {
  const tools = Array.isArray(obj.tools)
    ? obj.tools.filter((t): t is string => typeof t === "string")
    : [];
  return {
    tools,
    permissionMode: typeof obj.permissionMode === "string" ? obj.permissionMode : null,
  };
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
        // ENG-476: confinement is checked the moment the CLI reports it, not after the agent has
        // worked. A wrong tool set or mode — or any agent action before the report — kills the
        // process at once, so an unconfined agent never gets to act.
        const gate = startupGate(toolNamesFor(input.allowedTools), () => proc.kill("SIGKILL"));
        const stdoutP = readLines(proc.stdout, gate.onLine);
        const stderrP = new Response(proc.stderr).text();
        const timeoutP = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
        });
        const outcome = await Promise.race([proc.exited.then(() => "exited" as const), timeoutP]);
        if (outcome === "timeout") {
          proc.kill("SIGKILL");
          return transportFailure("dispatch timed out", true);
        }
        const exitCode = await proc.exited;
        const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
        const stream = parseClaudeStream(stdout);
        const plainText = nonJsonLines(stdout);
        // The final result event is the one line the old `json` format printed. Without it (a
        // crash mid-stream) only the CLI's own plain-text lines are kept — never the transcript,
        // whose tool results can hold file contents.
        const envelope = stream.result === null ? null : JSON.stringify(stream.result);
        const usage =
          envelope === null
            ? { costUsd: null, tokensIn: null, tokensOut: null, cacheRead: null, cacheCreate: null }
            : parseClaudeJson(envelope);
        const finalText = envelope === null ? plainText : assistantText(envelope);
        if (exitCode === 0 && gate.fault() === null) {
          return {
            completed: true,
            exitCode,
            stdout: finalText,
            stderr,
            timedOut: false,
            ...usage,
            capabilities: claudeCapabilities(stream.init),
          };
        }
        // Classify from stderr and the result text only (review of ENG-476): tool results in the
        // stream can quote a limit marker or carry secrets into the reset text.
        const resultText = typeof stream.result?.result === "string" ? stream.result.result : "";
        const { cause, resetAt } = classifyFailure(stderr, `${resultText}\n${plainText}`);
        return {
          completed: false,
          exitCode,
          stdout: finalText,
          stderr,
          timedOut: false,
          ...usage,
          cause,
          resetAt,
          // A killed-at-startup run reports why; a run that died before reporting reports nothing
          // (an ordinary failure, not a confinement fault); otherwise report what it had.
          capabilities:
            gate.fault() ?? (stream.init === null ? undefined : claudeCapabilities(stream.init)),
        };
      } catch (err) {
        return transportFailure(String(err), false);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Watches stream-json lines as they arrive (ENG-476). On the init event it checks the tool set
 *  and permission mode; on an agent action (an `assistant` or `user` event) before any init it
 *  treats the run as unverified. Either fault calls `kill` once and is reported by `fault()`. */
export function startupGate(
  expectedTools: readonly string[],
  kill: () => void,
): { onLine: (line: string) => void; fault: () => EffectiveCapabilities | null } {
  let decided = false;
  let fault: EffectiveCapabilities | null = null;
  const stop = (f: EffectiveCapabilities) => {
    fault = f;
    decided = true;
    kill();
  };
  return {
    onLine(line: string) {
      if (decided) return;
      const obj = parseJsonObject(line);
      if (obj === null) return;
      if (obj.type === "system" && obj.subtype === "init") {
        const caps = claudeCapabilities(initFrom(obj));
        const problem = caps.error ?? toolSetMismatch(expectedTools, caps.tools ?? []);
        if (problem !== null) {
          stop({ tools: caps.tools, error: `stopped at startup: ${problem}` });
        } else {
          decided = true;
        }
        return;
      }
      if (obj.type === "assistant" || obj.type === "user") {
        stop({ tools: null, error: "stopped: the agent acted before claude reported its tools" });
      }
    },
    fault: () => fault,
  };
}

/** Read a byte stream to text, calling `onLine` for every complete line as it arrives. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let all = "";
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    all += chunk;
    pending += chunk;
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      onLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  }
  const tail = decoder.decode();
  all += tail;
  pending += tail;
  if (pending.trim() !== "") onLine(pending);
  return all;
}

/** The lines of `stdout` that are not JSON events: the CLI's own plain-text messages. */
function nonJsonLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "" && parseJsonObject(l) === null)
    .join("\n");
}
