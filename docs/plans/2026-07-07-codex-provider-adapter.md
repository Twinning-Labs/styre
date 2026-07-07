# Codex Provider Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI's `codex` CLI as a second, config-selected agent provider behind Styre's existing `AgentRunner` boundary, and close the three "designed-but-unwired" gaps Codex surfaces.

**Architecture:** A new `src/agent/providers/codex.ts` adapter mirrors `claude.ts` (spawn `codex exec`, translate the tool allowlist to Codex's OS sandbox, parse the JSONL usage stream, read the final message from `--output-last-message`). Around it: pin the `AgentRunResult.stdout` contract (final-message text) and retrofit the Claude adapter to it; widen the verify-env credential denylist to all provider keys; and wire config-driven provider selection through the config file the CLI already loads. Claude stays the binary default; Codex is opt-in via `config.json`.

**Tech Stack:** TypeScript + Bun (`bun test`, `bun:test`), zod, single-binary CLI (`citty`). No new dependencies.

**Spec:** `docs/brainstorms/2026-07-07-codex-provider-adapter-design.md` (DEC-CX-1..9).

## Global Constraints

- **Runtime/test:** Bun. Tests use `import { expect, test } from "bun:test"` and live under `test/` mirroring `src/`. Run one file: `bun test test/<path>.test.ts`. Full suite: `bun test`.
- **Gates that must stay green after every task:** `bun test`, `tsc --noEmit` (`bun run typecheck`), `biome check .` (`bun run lint`).
- **Core stays provider-neutral (DEC-AG-1..5):** the core routes only on the neutral `FailureCause = "session-limit" | "out-of-credits" | "transient"` (`src/agent/runner.ts:3`); provider-specific flags, output parsing, and marker strings live ONLY inside `src/agent/providers/<provider>.ts`.
- **CI never invokes a real agent CLI.** Real-CLI paths are exercised only by shell-stub fakes in unit tests and by the gated manual smoke.
- **Capability isolation (F4):** `agentEnv` passes the agent's API key through; `verifyEnv` must strip every provider key so agent-authored verify code cannot read it.
- **Workflow:** branch `feat/codex-provider-brainstorm` (already pushed, PR #54). No commits to `main`, no auto-merge, operator merges. PR title is Conventional Commits.
- **Already landed on this branch (do not redo):** DEC-CX-9 `.gitignore` (`.claude/worktrees/`, `.codex/`, `AGENTS.md`) is committed.
- **Commit style:** Conventional Commits; each task ends with a commit. Frequent commits, TDD (failing test first).

---

### Task 1: Pin the `stdout` contract + retrofit the Claude adapter (DEC-CX-4)

Make `AgentRunResult.stdout` mean "the agent's final assistant message as plain text" and change the Claude adapter to honor it (extract the envelope's `result` field), fixing the latent bug where the fenced sidecar block was JSON-escaped inside the `--output-format json` envelope and never matched `extractSidecar`.

**Files:**
- Modify: `src/agent/runner.ts` (document the contract on `stdout`)
- Modify: `src/agent/providers/claude.ts` (add `assistantText`, unwrap into `stdout`)
- Test: `test/agent/providers/claude.test.ts` (add unwrap + sidecar-regression assertions)

**Interfaces:**
- Consumes: `extractSidecar(output, schema)` from `src/dispatch/sidecar.ts` (unchanged) — regexes a ```` ```styre-sidecar ```` block out of its `output` arg.
- Produces: `assistantText(rawStdout: string): string` (exported from `claude.ts`) — returns `envelope.result` when it is a string, else the raw input. `claudeAgentRunner(...).run(...)` now returns `stdout` = `assistantText(rawEnvelope)`; usage still parsed from the raw envelope.

- [ ] **Step 1: Write the failing test**

Add to `test/agent/providers/claude.test.ts` (import `assistantText` and `extractSidecar`):

```ts
import { extractSidecar } from "../../../src/dispatch/sidecar.ts";
import { z } from "zod";
// add assistantText to the existing import from claude.ts

test("assistantText unwraps the envelope result field, falling back to raw", () => {
  const raw = JSON.stringify({ result: "hello\nworld", usage: { input_tokens: 1 } });
  expect(assistantText(raw)).toBe("hello\nworld");
  // no result field → raw passthrough (never the string "undefined")
  const noResult = JSON.stringify({ usage: { input_tokens: 1 } });
  expect(assistantText(noResult)).toBe(noResult);
  expect(assistantText("not json")).toBe("not json");
});

test("a claude success carrying a sidecar block yields extractable stdout (regression)", async () => {
  const sidecar = "```styre-sidecar\n" + JSON.stringify({ n: 5 }) + "\n```";
  // real claude wraps assistant text (incl. the fenced block) inside the json envelope's `result`
  const envelope = JSON.stringify({ result: `done\n${sidecar}`, usage: { input_tokens: 1 } });
  const cli = fakeCli("claude-sidecar", `cat <<'EOF'\n${envelope}\nEOF`);
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(true);
  const parsed = extractSidecar(r.stdout, z.object({ n: z.number() }));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.n).toBe(5);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/agent/providers/claude.test.ts`
Expected: FAIL — `assistantText` is not exported; the regression test's `extractSidecar` returns `{ ok: false }` because today `r.stdout` is the raw envelope (escaped newlines don't match the fence regex).

- [ ] **Step 3: Add `assistantText` and unwrap into `stdout` in `src/agent/providers/claude.ts`**

Add the helper (near `parseClaudeJson`):

```ts
/** DEC-CX-4: the stdout contract is "the final assistant message as plain text". `claude -p
 *  --output-format json` returns an envelope whose `result` field carries that text; unwrap it.
 *  Falls back to the raw string when `result` is absent/non-string (never emits "undefined"). */
export function assistantText(rawStdout: string): string {
  try {
    const obj = JSON.parse(rawStdout) as Record<string, unknown>;
    return typeof obj.result === "string" ? obj.result : rawStdout;
  } catch {
    return rawStdout;
  }
}
```

In `run(...)`, after `const [stdout, stderr] = await Promise.all([...])` and `const usage = parseClaudeJson(stdout);`, add:

```ts
const finalText = assistantText(stdout); // usage stays parsed from the RAW envelope above
```

Change the two return sites to emit `finalText` as `stdout` (keep passing the RAW `stdout` to `classifyFailure`, whose markers may live in the envelope):

```ts
if (exitCode === 0) {
  return { completed: true, exitCode, stdout: finalText, stderr, timedOut: false, ...usage };
}
const { cause, resetAt } = classifyFailure(stderr, stdout);
return { completed: false, exitCode, stdout: finalText, stderr, timedOut: false, ...usage, cause, resetAt };
```

- [ ] **Step 4: Document the contract on `src/agent/runner.ts`**

Replace the `stdout` field line in `AgentRunResult` with a documented one:

```ts
  /** DEC-CX-4 CONTRACT: the agent's final assistant message as plain, unescaped text (real
   *  newlines) — NOT a provider envelope. Token/cost accounting lives only in the fields below.
   *  Sidecar/structured-output extraction (dispatch/sidecar.ts) reads this. */
  stdout: string;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/agent/providers/claude.test.ts && bun run typecheck`
Expected: PASS (incl. the pre-existing "run captures a clean exit" test — its envelope has no `result` field, so `stdout` falls back to the raw envelope and its assertions, which don't check `stdout`, are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/agent/runner.ts src/agent/providers/claude.ts test/agent/providers/claude.test.ts
git commit -m "fix(agent): pin stdout=final-message contract; unwrap claude envelope result"
```

---

### Task 2: Widen `verifyEnv` to all provider keys + add `requiredEnvFor` (DEC-CX-6)

Close the F4 hole (under Codex, `verifyEnv` would leave `OPENAI_API_KEY` readable) and add a pure provider→required-key map the setup gate will use in Task 5. Both changes are additive and independently testable.

**Files:**
- Modify: `src/agent/agent-env.ts` (union denylist)
- Modify: `src/config/agent-config.ts` (add `requiredEnvFor`)
- Test: `test/agent/agent-env.test.ts` (extend), `test/config/agent-config.test.ts` (create)

**Interfaces:**
- Produces: `VERIFY_ENV_DENYLIST` now includes `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`. `requiredEnvFor(provider: string): string | undefined` returns the env var name a provider needs to authenticate (`claude → "ANTHROPIC_API_KEY"`, `codex → "OPENAI_API_KEY"`), else `undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent/agent-env.test.ts`:

```ts
test("verifyEnv strips every provider key (F4 holds for codex too)", () => {
  const e = verifyEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "o",
    CODEX_API_KEY: "c",
    CODEX_ACCESS_TOKEN: "t",
  });
  expect(e.PATH).toBe("/usr/bin");
  expect(e.ANTHROPIC_API_KEY).toBeUndefined();
  expect(e.OPENAI_API_KEY).toBeUndefined();
  expect(e.CODEX_API_KEY).toBeUndefined();
  expect(e.CODEX_ACCESS_TOKEN).toBeUndefined();
});

test("agentEnv keeps OPENAI_API_KEY (codex CLI needs it)", () => {
  const e = agentEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "o", GITHUB_TOKEN: "g" });
  expect(e.OPENAI_API_KEY).toBe("o");
  expect(e.GITHUB_TOKEN).toBeUndefined();
});
```

**Append** to the EXISTING `test/config/agent-config.test.ts` (it already has 4 tests — do NOT recreate it, or they are silently deleted). Add `requiredEnvFor` to its existing `agent-config.ts` import, then append:

```ts
test("requiredEnvFor maps providers to their auth env var", () => {
  expect(requiredEnvFor("claude")).toBe("ANTHROPIC_API_KEY");
  expect(requiredEnvFor("codex")).toBe("OPENAI_API_KEY");
  expect(requiredEnvFor("unknown")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/agent/agent-env.test.ts test/config/agent-config.test.ts`
Expected: FAIL — `OPENAI_API_KEY` still present in `verifyEnv`; `requiredEnvFor` not exported.

- [ ] **Step 3: Widen the denylist in `src/agent/agent-env.ts`**

```ts
export const AGENT_ENV_DENYLIST = ["LINEAR_API_KEY", "GITHUB_TOKEN"];
// F4 (DEC-CX-6): strip EVERY provider's agent key from verify — agent-authored code runs there.
export const VERIFY_ENV_DENYLIST = [
  ...AGENT_ENV_DENYLIST,
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
];
```

Update the `agentEnv` docstring line to say it keeps the selected provider's key (Anthropic *or* OpenAI); no code change to `agentEnv`/`scrub` needed (it already passes through anything not in `AGENT_ENV_DENYLIST`).

- [ ] **Step 4: Add `requiredEnvFor` to `src/config/agent-config.ts`**

```ts
/** Provider → the env var it needs to authenticate its CLI (DEC-CX-6). Used by the setup gate. */
const PROVIDER_REQUIRED_ENV: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};

export function requiredEnvFor(provider: string): string | undefined {
  return PROVIDER_REQUIRED_ENV[provider];
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `bun test test/agent/agent-env.test.ts test/config/agent-config.test.ts test/util/run-command.test.ts && bun run typecheck`
Expected: PASS (the existing `run-command.test.ts` "cannot read ANTHROPIC_API_KEY" test still holds — Anthropic remains stripped).

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent-env.ts src/config/agent-config.ts test/agent/agent-env.test.ts test/config/agent-config.test.ts
git commit -m "fix(agent): strip all provider keys from verifyEnv; add requiredEnvFor (F4)"
```

---

### Task 3: The Codex adapter (DEC-CX-1/2/3)

New `src/agent/providers/codex.ts` implementing `AgentRunner` via `codex exec`, fully self-contained (no wiring yet).

**Files:**
- Create: `src/agent/providers/codex.ts`
- Test: `test/agent/providers/codex.test.ts`, `test/agent/providers/classify-codex-failure.test.ts`

**Interfaces:**
- Consumes: `AgentRunInput`, `AgentRunResult`, `AgentRunner`, `FailureCause` from `../runner.ts`; `agentEnv` from `../agent-env.ts`.
- Produces (all exported):
  - `sandboxForTools(allowedTools: string[]): { mode: "read-only" | "workspace-write"; network: boolean }`
  - `buildCodexArgs(input: { model: string; allowedTools: string[]; cwd: string; outputPath: string }): string[]`
  - `parseCodexUsage(stdout: string): { costUsd: null; tokensIn: number | null; tokensOut: number | null; cacheRead: number | null; cacheCreate: null }`
  - `classifyCodexFailure(stderr: string, stdout: string): { cause: FailureCause; resetAt: string | null }`
  - `codexAgentRunner(command?: string): AgentRunner` (default `"codex"`)

- [ ] **Step 1: Write the failing tests**

Create `test/agent/providers/codex.test.ts`:

```ts
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexArgs,
  codexAgentRunner,
  parseCodexUsage,
  sandboxForTools,
} from "../../../src/agent/providers/codex.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "styre-codex-")));

function fakeCli(name: string, body: string): string {
  const path = join(cwd, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const runInput = { prompt: "hi", model: "m", allowedTools: ["Read"], cwd, timeoutMs: 5000 };

test("sandboxForTools maps read-only vs write and web access", () => {
  expect(sandboxForTools(["Read", "Grep", "Glob"])).toEqual({ mode: "read-only", network: false });
  expect(sandboxForTools(["Read", "Write", "Edit", "Bash(pytest:*)"])).toEqual({
    mode: "workspace-write",
    network: false,
  });
  // design:dispatch: write + web → workspace-write with network restored (DEC-CX-3)
  expect(sandboxForTools(["Read", "Write", "WebSearch", "WebFetch"])).toEqual({
    mode: "workspace-write",
    network: true,
  });
});

test("buildCodexArgs assembles exec, sandbox, model, cd, non-interactive flags", () => {
  const args = buildCodexArgs({
    model: "gpt-x",
    allowedTools: ["Read", "Write", "WebFetch"],
    cwd: "/wt",
    outputPath: "/tmp/out.txt",
  });
  const s = args.join(" ");
  expect(args[0]).toBe("exec");
  expect(s).toContain("--model gpt-x");
  expect(s).toContain("--cd /wt");
  expect(s).toContain("--sandbox workspace-write");
  expect(s).toContain("--ask-for-approval never");
  expect(s).toContain("--skip-git-repo-check");
  expect(s).toContain("--output-last-message /tmp/out.txt");
  expect(s).toContain("-c sandbox_workspace_write.network_access=true");
  expect(args[args.length - 1]).toBe("-"); // prompt on stdin
});

test("buildCodexArgs omits the network override for a read-only dispatch", () => {
  const args = buildCodexArgs({ model: "m", allowedTools: ["Read"], cwd: "/wt", outputPath: "/o" });
  expect(args.join(" ")).toContain("--sandbox read-only");
  expect(args.join(" ")).not.toContain("network_access");
});

test("parseCodexUsage reads turn.completed usage from the JSONL stream", () => {
  const jsonl = [
    '{"type":"thread.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}',
  ].join("\n");
  const u = parseCodexUsage(jsonl);
  expect(u.tokensIn).toBe(24763);
  expect(u.tokensOut).toBe(122);
  expect(u.cacheRead).toBe(24448);
  expect(u.costUsd).toBeNull();
  expect(parseCodexUsage("garbage\n{bad").tokensIn).toBeNull();
});

test("run reads the final message from --output-last-message and parses usage", async () => {
  // fake codex: extract the -o path from argv, write the final message there, emit JSONL on stdout
  const cli = fakeCli(
    "codex-ok",
    [
      "out=",
      'while [ $# -gt 0 ]; do if [ "$1" = "--output-last-message" ]; then out="$2"; fi; shift; done',
      "printf '%s' 'done\n```styre-sidecar\n{\"n\":5}\n```' > \"$out\"",
      `echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3,"cached_input_tokens":7}}'`,
    ].join("\n"),
  );
  const r = await codexAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(true);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("```styre-sidecar");
  expect(r.tokensIn).toBe(10);
  expect(r.cacheRead).toBe(7);
  expect(r.costUsd).toBeNull();
});

test("run SIGKILLs and returns promptly on a process that traps SIGTERM and hangs", async () => {
  const cli = fakeCli("codex-hang", "trap '' TERM\nsleep 30");
  const start = Date.now();
  const r = await codexAgentRunner(cli).run({ ...runInput, timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
  expect(r.completed).toBe(false);
  expect(Date.now() - start).toBeLessThan(5000);
  expect(r.cause).toBe("transient");
});
```

Create `test/agent/providers/classify-codex-failure.test.ts`:

```ts
import { expect, test } from "bun:test";
import { classifyCodexFailure } from "../../../src/agent/providers/codex.ts";

test("rate/usage limit → session-limit", () => {
  expect(classifyCodexFailure("Error: rate limit reached", "").cause).toBe("session-limit");
  expect(classifyCodexFailure("", "429 Too Many Requests").cause).toBe("session-limit");
});

test("quota/billing → out-of-credits", () => {
  expect(classifyCodexFailure("You exceeded your current quota", "").cause).toBe("out-of-credits");
  expect(classifyCodexFailure("insufficient_quota / billing", "").cause).toBe("out-of-credits");
});

test("anything else → transient", () => {
  expect(classifyCodexFailure("connection reset", "").cause).toBe("transient");
  expect(classifyCodexFailure("", "").resetAt).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/agent/providers/codex.test.ts test/agent/providers/classify-codex-failure.test.ts`
Expected: FAIL — `src/agent/providers/codex.ts` does not exist.

- [ ] **Step 3: Create `src/agent/providers/codex.ts`**

```ts
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

/** The `codex exec` argv (pure). Flag names are CLI-version-specific — confirmed by the manual
 *  smoke; the core never depends on these. */
export function buildCodexArgs(input: {
  model: string;
  allowedTools: string[];
  cwd: string;
  outputPath: string;
}): string[] {
  const { mode, network } = sandboxForTools(input.allowedTools);
  const args = [
    "exec",
    "--json",
    "--model",
    input.model,
    "--cd",
    input.cwd,
    "--sandbox",
    mode,
    "--ask-for-approval",
    "never",
    "--skip-git-repo-check",
    "--output-last-message",
    input.outputPath,
  ];
  if (mode === "workspace-write" && network) {
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  args.push("-"); // read the prompt from stdin
  return args;
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
  const empty = { costUsd: null, tokensIn: null, tokensOut: null, cacheRead: null, cacheCreate: null } as const;
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
  if (/quota|insufficient|billing|out of credit|exceeded your current/i.test(text)) {
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
      const outputPath = join(mkdtempSync(join(tmpdir(), "styre-codex-msg-")), "final.txt");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const codexArgs = buildCodexArgs({
          model: input.model,
          allowedTools: input.allowedTools,
          cwd: input.cwd,
          outputPath,
        });
        const proc = Bun.spawn(
          [command, ...codexArgs],
          {
            cwd: input.cwd,
            env: agentEnv(process.env),
            stdin: new TextEncoder().encode(input.prompt),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
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
          return { completed: true, exitCode, stdout: finalMessage, stderr, timedOut: false, ...usage };
        }
        if (exitCode === 0) {
          // clean exit but no final message = a broken dispatch → transport failure, never an empty verdict
          return { ...transportFailure("codex produced no final message", false), stderr, ...usage };
        }
        const { cause, resetAt } = classifyCodexFailure(stderr, rawStdout);
        return { completed: false, exitCode, stdout: finalMessage, stderr, timedOut: false, ...usage, cause, resetAt };
      } catch (err) {
        return transportFailure(String(err), false);
      } finally {
        clearTimeout(timer);
        rmSync(outputPath, { force: true });
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test test/agent/providers/codex.test.ts test/agent/providers/classify-codex-failure.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/providers/codex.ts test/agent/providers/codex.test.ts test/agent/providers/classify-codex-failure.test.ts
git commit -m "feat(agent): codex provider adapter (codex exec, sandbox translation, jsonl usage)"
```

---

### Task 4: Codex preset + `agent` config field + `resolveAgentRunner` (DEC-CX-5/7)

Add the built-in Codex preset, let the runtime config file carry an `agent` block, and centralize adapter selection in one helper. No entrypoint behavior changes yet (default still resolves Claude), so all existing e2e tests stay green.

**Files:**
- Modify: `src/config/agent-config.ts` (add `CODEX_PRESET`)
- Modify: `src/config/runtime-config.ts` (add optional `agent` field)
- Create: `src/agent/resolve.ts`
- Test: `test/agent/resolve.test.ts`

**Interfaces:**
- Consumes: `AgentConfigSchema`, `AgentConfig`, `DEFAULT_AGENT_CONFIG` (`src/config/agent-config.ts`); `claudeAgentRunner`, `codexAgentRunner`; `selectAgentRunner`.
- Produces: `CODEX_PRESET: AgentConfig`; `RuntimeConfig.agent?: AgentConfig`; `resolveAgentRunner(config: AgentConfig): AgentRunner` (`src/agent/resolve.ts`) — builds the full built-in adapter map and selects by `config.provider`.

- [ ] **Step 1: Write the failing test**

Create `test/agent/resolve.test.ts`:

```ts
import { expect, test } from "bun:test";
import { resolveAgentRunner } from "../../src/agent/resolve.ts";
import { CODEX_PRESET, DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";

test("resolveAgentRunner returns a runner for claude and for codex", () => {
  expect(typeof resolveAgentRunner(DEFAULT_AGENT_CONFIG).run).toBe("function");
  expect(typeof resolveAgentRunner(CODEX_PRESET).run).toBe("function");
  expect(CODEX_PRESET.provider).toBe("codex");
});

test("resolveAgentRunner throws for an unregistered provider", () => {
  expect(() =>
    resolveAgentRunner({ provider: "nope", models: { deep: "d", standard: "s", cheap: "c" } }),
  ).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/agent/resolve.test.ts`
Expected: FAIL — `resolve.ts` and `CODEX_PRESET` do not exist.

- [ ] **Step 3: Add `CODEX_PRESET` to `src/config/agent-config.ts`**

```ts
/** Built-in Codex preset (DEC-CX-7). Model ids are OPERATOR-SET config, not core truth — these are
 *  drop-in defaults to confirm/override in workspace config.json. */
export const CODEX_PRESET: AgentConfig = {
  provider: "codex",
  command: "codex",
  models: { deep: "gpt-5.4", standard: "gpt-5.4-codex", cheap: "gpt-5.4-codex-mini" },
};
```

- [ ] **Step 4: Add the optional `agent` field to `src/config/runtime-config.ts`**

Add the import and field:

```ts
import { AgentConfigSchema } from "./agent-config.ts";
// ...inside RuntimeConfigSchema, add:
  // DEC-CX-5: the agent provider + per-tier models. Absent → the binary Claude preset.
  agent: AgentConfigSchema.optional(),
```

(`DEFAULT_RUNTIME_CONFIG = RuntimeConfigSchema.parse({})` keeps `agent` as `undefined`.)

- [ ] **Step 5: Create `src/agent/resolve.ts`**

```ts
import type { AgentConfig } from "../config/agent-config.ts";
import { claudeAgentRunner } from "./providers/claude.ts";
import { codexAgentRunner } from "./providers/codex.ts";
import { selectAgentRunner } from "./registry.ts";
import type { AgentRunner } from "./runner.ts";

/** Build the full built-in adapter map and select the configured provider (DEC-CX-5). The wiring
 *  layer (CLI entrypoints, smoke) — NOT the core control loop — is where providers are imported. */
export function resolveAgentRunner(config: AgentConfig): AgentRunner {
  return selectAgentRunner(config, {
    claude: () => claudeAgentRunner(config.command),
    codex: () => codexAgentRunner(config.command),
  });
}
```

- [ ] **Step 6: Run to verify pass (and nothing regressed)**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS (full suite — this task is additive; no entrypoint changed yet).

- [ ] **Step 7: Commit**

```bash
git add src/config/agent-config.ts src/config/runtime-config.ts src/agent/resolve.ts test/agent/resolve.test.ts
git commit -m "feat(config): codex preset, runtime agent config field, resolveAgentRunner"
```

---

### Task 5: Rewire the entrypoints + provider-aware setup gate + smoke (DEC-CX-5/6)

Switch all four call sites from the hardcoded `selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude })` to `resolveAgentRunner(agentConfig)`, sourcing `agentConfig` from the loaded config. Make the setup credential gate check the configured provider's key (preserving the `ANTHROPIC_API_KEY` message on the default path). Default behavior is unchanged (no `agent` block ⇒ Claude), so existing e2e/CLI tests stay green.

**Files:**
- Modify: `src/cli/run.ts:111,114`
- Modify: `src/cli/park.ts:272-273`
- Modify: `src/cli/setup.ts:194-235` (add `--config`, provider-aware gate, resolve)
- Modify: `scripts/smoke-agent.ts` (use `resolveAgentRunner`; optional `--provider` via argv)

**Interfaces:**
- Consumes: `resolveAgentRunner` (Task 4), `requiredEnvFor` (Task 2), `DEFAULT_AGENT_CONFIG`, `RuntimeConfigSchema`.
- Produces: no new exports; `agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG` threaded to `resolveAgentRunner` and `buildDispatchRegistry`/`runSetup`.

- [ ] **Step 1: Rewire `src/cli/run.ts`**

Replace the import of `claudeAgentRunner`/`selectAgentRunner` (lines 5-6) with `import { resolveAgentRunner } from "../agent/resolve.ts";`. Then replace lines 111-114:

```ts
      const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG;
      const runner = resolveAgentRunner(agentConfig);
      const registry = buildDispatchRegistry({
        runner,
        agentConfig,
```

- [ ] **Step 2: Rewire `src/cli/park.ts`**

Replace the `claudeAgentRunner`/`selectAgentRunner` imports (lines 13-14) with `import { resolveAgentRunner } from "../agent/resolve.ts";` (keep `DEFAULT_AGENT_CONFIG`). Replace lines 272-273:

```ts
        runner: resolveAgentRunner(runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG),
        agentConfig: runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG,
```

- [ ] **Step 3: Rewire `src/cli/setup.ts` (add `--config`, provider-aware gate)**

Fix the imports by **editing existing lines** (do NOT add duplicate import statements — `setup.ts` already imports `DEFAULT_AGENT_CONFIG` at `:7` and `DEFAULT_RUNTIME_CONFIG` at `:9`; duplicate bindings fail `tsc`, and unmerged same-module imports fail `biome check`):
- `:2` — add `readFileSync`: `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";`
- `:5-6` — replace the `claudeAgentRunner` + `selectAgentRunner` imports with a single `import { resolveAgentRunner } from "../agent/resolve.ts";`
- `:7` — merge in `requiredEnvFor`: `import { DEFAULT_AGENT_CONFIG, requiredEnvFor } from "../config/agent-config.ts";`
- `:9` — merge in `RuntimeConfigSchema`: `import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../config/runtime-config.ts";`

Add a `config` arg to the command `args` block (next to `force`):

```ts
    config: { type: "string", description: "Path to a runtime config.json (selects the agent provider)" },
```

Replace the gate + runner (lines 222-234):

```ts
    const agentConfig =
      args.config && args.config.length > 0
        ? (RuntimeConfigSchema.parse(JSON.parse(readFileSync(args.config, "utf8"))).agent ??
          DEFAULT_AGENT_CONFIG)
        : DEFAULT_AGENT_CONFIG;
    const requiredKey = requiredEnvFor(agentConfig.provider);
    if (requiredKey && !process.env[requiredKey]) {
      throw new Error(
        `setup: ${requiredKey} is required for provider '${agentConfig.provider}' (runtime-context prose enrichment)`,
      );
    }
    const runner = resolveAgentRunner(agentConfig);
    const { outPath, profile, needsInput } = await runSetup({
      repo,
      out: args.out,
      checks: args.checks,
      slug: args.slug,
      force: args.force,
      reprobe: args.reprobe,
      trustAgentCommands: args["trust-agent-commands"] === true,
      deps: { runner, agentConfig },
    });
```

(Note: the default path keeps `requiredKey === "ANTHROPIC_API_KEY"`, so the error still matches `setup-inplace-discovery.test.ts`'s `/ANTHROPIC_API_KEY/`.)

- [ ] **Step 4: Update `scripts/smoke-agent.ts`**

Replace the `claudeAgentRunner`/`selectAgentRunner` imports with `import { resolveAgentRunner } from "../src/agent/resolve.ts";` and add `import { CODEX_PRESET } from "../src/config/agent-config.ts";`. Replace lines 18-19:

```ts
const provider = process.argv[3]; // optional: "codex"
const config = provider === "codex" ? CODEX_PRESET : DEFAULT_AGENT_CONFIG;
const runner = resolveAgentRunner(config);
```

- [ ] **Step 5: Run the full suite + gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS. Specifically verify `test/cli/setup-inplace-discovery.test.ts` still passes (default provider = claude ⇒ gate throws `/ANTHROPIC_API_KEY/`), and the run/park e2e tests still drive Claude by default.

- [ ] **Step 6: Commit**

```bash
git add src/cli/run.ts src/cli/park.ts src/cli/setup.ts scripts/smoke-agent.ts
git commit -m "feat(cli): config-driven provider selection; provider-aware setup gate"
```

---

### Task 6: Docs — correct the §3a description + changelog pointer (DEC-CX-8c)

**Files:**
- Modify: `docs/architecture/control-loop.md:145-149`
- Modify: `docs/architecture/brainstorm.md` (append to §11 Changelog, line ~422 — append-only)

- [ ] **Step 1: Correct the §3a mechanism description in `control-loop.md`**

Replace the "forced-schema tool calls (Anthropic SDK constrained decoding)" bullet with a provider-neutral, implementation-accurate description:

```markdown
- structured values are submitted via a **validated sidecar**: the agent emits a fenced
  ```` ```styre-sidecar ```` JSON block that the runner extracts and zod-validates
  (`dispatch/sidecar.ts`); an absent/malformed block is a transport failure (re-dispatch), never a
  verdict. (Provider-native constrained decoding — e.g. Codex `--output-schema` — is a possible
  future hardening, DEC-CX-8b; the fenced sidecar is provider-independent and ships today.)
```

- [ ] **Step 2: Append a changelog pointer to `brainstorm.md` §11 (do NOT rewrite history)**

Add a new dated bullet at the end of the §11 Changelog list:

```markdown
- **2026-07-07 — Codex added as a second agent provider.** Sibling `src/agent/providers/codex.ts`
  behind the unchanged `AgentRunner` seam; closed three designed-but-unwired gaps (config-driven
  provider selection, the `stdout`=final-message contract with a Claude retrofit, provider-parametric
  capability gates incl. the F4 verifyEnv fix). Claude stays the binary default. Design:
  `docs/brainstorms/2026-07-07-codex-provider-adapter-design.md`; plan:
  `docs/plans/2026-07-07-codex-provider-adapter.md`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/control-loop.md docs/architecture/brainstorm.md
git commit -m "docs(architecture): correct §3a to fenced-sidecar; changelog Codex provider"
```

---

## Manual smoke (gated — NOT CI, run once before merge)

With a real `codex` CLI installed + `OPENAI_API_KEY` set, against a throwaway git repo:

```bash
bun run scripts/smoke-agent.ts /path/to/throwaway-repo codex
```

Confirm: `completed: true`, a non-empty `stdout` (the final message), and `usage.tokensIn/tokensOut` populated (`costUsd` null is expected). This is the only place the real `codex exec` flags + JSONL shape + `--output-last-message` behavior are validated (mirrors Task 7 for Claude). If real flags differ, fix ONLY `src/agent/providers/codex.ts` — the core needs no change.

## Self-Review notes (spec coverage)

- DEC-CX-1 Codex sibling adapter → Task 3. DEC-CX-2 `codex exec` flags → Task 3 `buildCodexArgs`.
  DEC-CX-3 allowedTools→sandbox + network parity → Task 3 `sandboxForTools`. DEC-CX-4 stdout
  contract + Claude retrofit → Task 1. DEC-CX-5 config-driven selection → Tasks 4-5. DEC-CX-6
  verifyEnv union + provider gate → Tasks 2, 5. DEC-CX-7 Codex preset + null cost → Tasks 3-4.
  DEC-CX-8c §3a doc correction → Task 6. DEC-CX-9 gitignore → already committed on this branch.
- DEC-CX-8a (neutral capability descriptor) and DEC-CX-8b/8d (Codex `--output-schema`, full config
  precedence merge) are explicitly deferred follow-ups — no task, by design.

## Independent review (2026-07-07)

A fresh, code-grounded reviewer verified every task against the source. Verdict: architecture
sound, all file:line anchors match, type contracts hold, sequencing compiles at each step, and the
setup gate still trips `/ANTHROPIC_API_KEY/` on the default path. Two literal-execution traps were
found and patched into this plan:

- **Task 2 (was HIGH):** `test/config/agent-config.test.ts` already exists with 4 tests — the step
  now says **append**, not create, so those tests aren't silently deleted.
- **Task 5 (was MEDIUM):** `setup.ts` already imports `DEFAULT_AGENT_CONFIG` (`:7`) and
  `DEFAULT_RUNTIME_CONFIG` (`:9`) — the step now **merges** `requiredEnvFor`/`RuntimeConfigSchema`
  into those lines instead of adding duplicate imports (which would fail `tsc` + `biome`).

Accepted as-is (no change): the codex clean-exit-but-empty branch reporting `exitCode: null` (routes
on `cause`, adapter-localized); and all `codex exec` flags / JSONL fields being smoke-verified only
(confined to `codex.ts`, `parseCodexUsage` is best-effort so a wrong field yields `null`, never a
false test pass). Note: the PR head branch is `feat/codex-provider-brainstorm`; the local worktree
branch is `worktree-feat+codex-provider-brainstorm` — commit/PR steps target the checked-out branch.
