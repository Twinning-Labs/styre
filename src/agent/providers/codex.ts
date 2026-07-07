import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv } from "../agent-env.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner, FailureCause } from "../runner.ts";

/** DEC-CX-3: translate the provider-neutral tool allowlist to Codex's OS sandbox. Any write/exec
 *  token ⇒ workspace-write (writes confined to cwd); read-only otherwise. WebSearch/WebFetch ⇒
 *  restore network (Codex disables it under workspace-write by default). Per-command Bash scoping
 *  is not expressible in Codex's sandbox — accepted fidelity loss (spec DEC-CX-3). */
export function sandboxForTools(allowedTools: string[]): {
  mode: "read-only" | "workspace-write";
  network: boolean;
} {
  const hasWrite = allowedTools.some(
    (t) => t === "Write" || t === "Edit" || t === "Bash" || t.startsWith("Bash("),
  );
  const network = allowedTools.some((t) => t === "WebSearch" || t === "WebFetch");
  return { mode: hasWrite ? "workspace-write" : "read-only", network };
}

/** The `codex` argv (pure). Ground truth from a real `codex` self-review (2026-07-07): `--ask-for-
 *  approval` and `--search` are GLOBAL flags and MUST precede the `exec` subcommand — the installed
 *  CLI rejects `codex exec --ask-for-approval never …`. Styre owns the run contract, so we also
 *  pass `--ephemeral` (no session persistence — Styre's journal is the durable record, avoids
 *  `.codex` churn) and `--ignore-user-config`/`--ignore-rules` (local Codex config/execpolicy must
 *  not alter runner behavior; target-repo AGENTS.md handling is a separate deliberate choice).
 *  Flag names are CLI-version-specific — pinned by the manual smoke; the core never depends on them. */
export function buildCodexArgs(input: {
  model: string;
  allowedTools: string[];
  cwd: string;
  outputPath: string;
}): string[] {
  const { mode, network } = sandboxForTools(input.allowedTools);
  return [
    // GLOBAL flags (before the subcommand)
    "--ask-for-approval",
    "never",
    ...(network ? ["--search"] : []), // native web-search tool (network_access alone doesn't enable it)
    // subcommand + its flags
    "exec",
    "--json",
    "--model",
    input.model,
    "--cd",
    input.cwd,
    "--sandbox",
    mode,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-o",
    input.outputPath,
    ...(mode === "workspace-write" && network
      ? ["-c", "sandbox_workspace_write.network_access=true"]
      : []),
    "-", // read the prompt from stdin
  ];
}

/** Best-effort parse of the `--json` JSONL stream's `turn.completed` usage (forensic only). Codex
 *  reports no USD cost → costUsd is always null (the interface tolerates it). */
export function parseCodexUsage(stdout: string): {
  costUsd: null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheRead: number | null;
  cacheCreate: null;
} {
  const empty = {
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cacheRead: null,
    cacheCreate: null,
  } as const;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "turn.completed") {
      const usage = (obj.usage ?? {}) as Record<string, unknown>;
      return {
        costUsd: null,
        tokensIn: num(usage.input_tokens),
        tokensOut: num(usage.output_tokens),
        cacheRead: num(usage.cached_input_tokens),
        cacheCreate: null,
      };
    }
  }
  return empty;
}

/** Map a Codex death to a provider-neutral cause (ENG-164). The ONLY place that knows Codex's
 *  marker strings; the exact set is pinned by tests + the manual smoke. */
export function classifyCodexFailure(
  stderr: string,
  stdout: string,
): { cause: FailureCause; resetAt: string | null } {
  const text = `${stderr}\n${stdout}`;
  if (/rate limit|usage limit|too many requests|\b429\b/i.test(text)) {
    const m = text.match(/resets?\s+([^\n]+)/i);
    return { cause: "session-limit", resetAt: m ? m[1].trim() : null };
  }
  // Tightened (bare "insufficient" would misclassify "insufficient permissions" as credits).
  if (
    /insufficient_quota|insufficient balance|billing|quota|out of credit|exceeded your current quota/i.test(
      text,
    )
  ) {
    return { cause: "out-of-credits", resetAt: null };
  }
  return { cause: "transient", resetAt: null };
}

/** The Codex adapter: spawn `codex exec`, feed the prompt on stdin, capture the JSONL usage stream
 *  on stdout + the final message from `--output-last-message`, under the same HARD timeout bound as
 *  the Claude adapter (race proc.exited vs the timer, SIGKILL + prompt resolve on timeout). */
export function codexAgentRunner(command = "codex"): AgentRunner {
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
      const msgDir = mkdtempSync(join(tmpdir(), "styre-codex-msg-"));
      const outputPath = join(msgDir, "final.txt");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const codexArgs = buildCodexArgs({
          model: input.model,
          allowedTools: input.allowedTools,
          cwd: input.cwd,
          outputPath,
        });
        const proc = Bun.spawn([command, ...codexArgs], {
          cwd: input.cwd,
          env: agentEnv(process.env),
          stdin: new TextEncoder().encode(input.prompt),
          stdout: "pipe",
          stderr: "pipe",
        });
        if (input.onSpawn && typeof proc.pid === "number") input.onSpawn(proc.pid);
        const timeoutP = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
        });
        const outcome = await Promise.race([proc.exited.then(() => "exited" as const), timeoutP]);
        if (outcome === "timeout") {
          proc.kill("SIGKILL");
          return transportFailure("dispatch timed out", true);
        }
        const exitCode = await proc.exited;
        const [rawStdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const usage = parseCodexUsage(rawStdout);
        let finalMessage = "";
        try {
          finalMessage = readFileSync(outputPath, "utf8");
        } catch {
          /* absent → handled below */
        }
        if (exitCode === 0 && finalMessage.length > 0) {
          return {
            completed: true,
            exitCode,
            stdout: finalMessage,
            stderr,
            timedOut: false,
            ...usage,
          };
        }
        if (exitCode === 0) {
          // clean exit but no final message = a broken dispatch → transport failure, never an empty
          // verdict. Preserve the real exitCode (0) for forensics; routing uses cause/completed.
          return {
            ...transportFailure("codex produced no final message", false),
            exitCode,
            stderr,
            ...usage,
          };
        }
        const { cause, resetAt } = classifyCodexFailure(stderr, rawStdout);
        return {
          completed: false,
          exitCode,
          stdout: finalMessage,
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
        rmSync(msgDir, { recursive: true, force: true }); // clean the temp dir, not just the file
      }
    },
  };
}
