# M3b — Provider-Agnostic Real Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M2's mock `design:dispatch` / `implement:dispatch` handlers with real agent dispatch behind a **provider-agnostic boundary** — the core depends only on a generic `AgentRunner` (the Claude CLI is one config-selected adapter, not an assumption), and a step's model comes from config via abstract tiers.

**Architecture:** A generic `AgentRunner` interface (`src/agent/`) is the only thing the dispatch flow knows; providers are config-selected adapters (`selectAgentRunner`), with a Claude adapter shipping as the default-but-optional preset under `src/agent/providers/`. Steps map to abstract tiers (`deep`/`standard`/`cheap`, `resolveTier`) and `AgentConfig.models[tier]` gives the provider's model id. `runAgentDispatch` chains the M3a pieces (renderPrompt+CL-PROFILE → ensureWorktree → insertDispatch → run via the injected `AgentRunner` → journal the subprocess pid → commitWorktree(CL-COMMIT) → completeDispatch → postcondition). A `FakeAgentRunner` drives all offline tests; the real Claude adapter is exercised only by a manual smoke. This implements the provider-agnostic design (`docs/brainstorms/2026-06-21-provider-agnostic-agent-design.md`) and retires M3a's hardcoded `src/dispatch/models.ts`.

**Tech Stack:** Bun, `bun:sqlite`, `bun test`, Biome (`organizeImports` on), zod. Host dep: the configured agent CLI (e.g. `claude`) — only when that provider is selected; smoke-only otherwise.

## Global Constraints

- **Runtime is Bun**; `bun:sqlite`; `bun test`; `Bun.spawn` for the real agent CLI (inside the adapter only). No new deps.
- **Vendor-neutral core (DEC-AG-1):** the dispatch flow depends only on `AgentRunner`; it never imports a specific provider. Providers are config-selected adapters; the Claude adapter is one preset. `claude` is a host dep only when the Claude provider is configured — never assumed.
- **Abstract tiers (DEC-AG-2):** `resolveTier(handlerKey)` → `deep|standard|cheap`; the model id is `AgentConfig.models[tier]`. Loopback escalation = `standard → deep`.
- **The real agent CLI is isolated behind `AgentRunner`** — every test uses `FakeAgentRunner`; CI never invokes a real agent. Only the manual smoke (Task 7) runs the real adapter.
- **Capability isolation (move 4):** the dispatch passes the per-step allowlist (`allowlistFor`, M3a) to the runner; the adapter translates it to the provider's flag (Claude: `--allowedTools`); the worktree is the only writable surface; no outward tools. **CL-COMMIT:** the daemon commits via `commitWorktree` with a deterministic message carrying `dispatch_id`; the agent never commits.
- **Single-writer (B2):** the handler runs inside `runStep`'s `execute`; it returns the result the daemon journals. **Handlers throw on failure** (so `runStep` marks the step failed and `advanceOneStep`'s catch routes to failure-policy, keying off row status). Never return a "failed" sentinel.
- **CL-PROFILE:** unresolved prompt placeholders → `runAgentDispatch` throws a setup error. **CL-POSTCOND:** each dispatch has a daemon-checked postcondition (design → a plan doc committed under `docs/plans/`; implement → non-empty diff); a clean run that fails it is that step's failure (thrown).
- **Crash orphan-kill (control-loop §6.1):** the real agent subprocess pid is journaled into `workflow_step.pid` (via `setPid`) so `recover()` kills the orphaned worker, not the daemon.
- **Timeouts:** the real adapter + the git helper run under a timeout (per-stage: design 60m, others 30m — minimal-loop §4); a timed-out run is a transport failure.
- **Timestamps stored UTC (DS-1)**; conventions: `.ts` imports; `verbatimModuleSyntax` (`import type`); **Biome `organizeImports` is enabled** — run `bun run lint`, apply `biome check --write .` to organize imports; `noNonNullAssertion`; double quotes; 2-space/100-col; `noUnusedLocals`/`noUnusedParameters`.
- **Before committing each task:** `bun test && bun run lint && bun run typecheck` clean (M0–M3a + prior M3b tasks green).
- **`.superpowers/sdd/` is gitignored — never `git add -f` a report.**
- **Dev workflow:** branch-only (`feat/m3b-dispatch-real`); no commits to `main`; Conventional Commits; no auto-merge. TDD throughout.

### Interfaces you build on (M3a/M2/M1)
M3a: `allowlistFor(handlerKey)`, `renderPrompt`, `loadProfile`/`Profile`, `ensureWorktree`/`commitWorktree`, dispatch repo (`nextSeq`/`insertDispatch`/`completeDispatch`). M2/M1: `StepRegistry`/`StepHandler`/`HandlerContext {db,ticket,step,workUnitId}`; `runStep`; `getProject` (has `target_repo`); `work-unit` repo; `workflow-step` repo. **Note:** M3a's `src/dispatch/models.ts` is RETIRED by Task 2 (replaced by `src/agent/tiers.ts` + config).

> **CLI-version risk (Task 3 only):** the real Claude adapter's flags (`--allowedTools` etc.) and `--output-format json` field names are CLI-version-specific. They live in `src/agent/providers/claude.ts` (`buildClaudeArgs`/`parseClaudeJson`, pure + tested for shape) and are **verified against a real `claude` run in Task 7's smoke**, then corrected. All other code depends only on the fixed `AgentRunResult` shape.

---

### Task 1: repo extensions — `setPid` + ticket branch

**Files:**
- Modify: `src/db/repos/workflow-step.ts` (add `setPid`)
- Modify: `src/db/repos/ticket.ts` (add `branch_name`/`branch_prefix`/`type_label` to `TicketRow`; add `setBranch`)
- Create: `src/agent/branch.ts` (`branchNameFor`)
- Test: `test/db/repos/m3b-repo-ext.test.ts`
- Test: `test/agent/branch.test.ts`

**Interfaces:**
- Produces:
  - `setPid(db, id: number, pid: number | null): void` (`workflow-step.ts`).
  - `TicketRow` gains `branch_name: string | null`, `branch_prefix: string | null`, `type_label: string | null`; `setBranch(db, id: number, branchName: string): void` (`ticket.ts`).
  - `branchNameFor(ticket: { ident: string; branch_name: string | null; branch_prefix: string | null }): string` (`src/agent/branch.ts`).

- [ ] **Step 1: Write the failing test** — `test/db/repos/m3b-repo-ext.test.ts`

```ts
import { expect, test } from "bun:test";
import { getTicket, insertTicket, setBranch } from "../../../src/db/repos/ticket.ts";
import { getById, insertPending, setPid } from "../../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("setPid sets and clears the workflow_step pid", () => {
  const { db, ticketId } = makeTestDb();
  const step = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  setPid(db, step.id, 4242);
  expect(getById(db, step.id)?.pid).toBe(4242);
  setPid(db, step.id, null);
  const after = getById(db, step.id);
  db.close();
  expect(after?.pid).toBeNull();
});

test("ticket exposes branch fields and setBranch persists branch_name", () => {
  const { db, projectId } = makeTestDb();
  const id = insertTicket(db, { projectId, ident: "ENG-9" });
  const before = getTicket(db, id);
  setBranch(db, id, "feat/ENG-9-slug");
  const after = getTicket(db, id);
  db.close();
  expect(before?.branch_name).toBeNull();
  expect(after?.branch_name).toBe("feat/ENG-9-slug");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/db/repos/m3b-repo-ext.test.ts`
Expected: FAIL — `setPid`/`setBranch` not exported.

- [ ] **Step 3: Add `setPid` to `src/db/repos/workflow-step.ts`** (append; keep existing exports/imports)

```ts
export function setPid(db: Database, id: number, pid: number | null): void {
  db.query("UPDATE workflow_step SET pid = $pid, updated_at = $now WHERE id = $id").run({
    $pid: pid,
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 4: Extend `src/db/repos/ticket.ts`** — `TicketRow` + `COLS` + `setBranch`

Replace the `TicketRow` interface and `COLS`:

```ts
export interface TicketRow {
  id: number;
  project_id: number;
  ident: string;
  stage: string;
  status: string;
  track: string | null;
  needs_docs: number;
  branch_name: string | null;
  branch_prefix: string | null;
  type_label: string | null;
}

const COLS =
  "id, project_id, ident, stage, status, track, needs_docs, branch_name, branch_prefix, type_label";
```

Append `setBranch` (keep all other functions unchanged):

```ts
export function setBranch(db: Database, id: number, branchName: string): void {
  db.query("UPDATE ticket SET branch_name = $b, updated_at = $now WHERE id = $id").run({
    $b: branchName,
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 5: Write the failing test** — `test/agent/branch.test.ts`

```ts
import { expect, test } from "bun:test";
import { branchNameFor } from "../../src/agent/branch.ts";

test("uses an explicit branch_name when present", () => {
  expect(branchNameFor({ ident: "ENG-9", branch_name: "feat/ENG-9-x", branch_prefix: "feat" })).toBe("feat/ENG-9-x");
});

test("derives from prefix + ident when branch_name is null", () => {
  expect(branchNameFor({ ident: "ENG-9", branch_name: null, branch_prefix: "fix" })).toBe("fix/ENG-9");
});

test("defaults the prefix to feat when both are null", () => {
  expect(branchNameFor({ ident: "ENG-9", branch_name: null, branch_prefix: null })).toBe("feat/ENG-9");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/agent/branch.test.ts`
Expected: FAIL — `Cannot find module '../../src/agent/branch.ts'`.

- [ ] **Step 7: Create `src/agent/branch.ts`**

```ts
/** The feature branch for a ticket: an explicit branch_name wins; else `<prefix>/<ident>`
 *  (prefix defaults to "feat"; Bug tickets use "fix" via branch_prefix). */
export function branchNameFor(ticket: {
  ident: string;
  branch_name: string | null;
  branch_prefix: string | null;
}): string {
  if (ticket.branch_name) {
    return ticket.branch_name;
  }
  return `${ticket.branch_prefix ?? "feat"}/${ticket.ident}`;
}
```

- [ ] **Step 8: Run both tests + full suite**

Run: `bun test test/db/repos/m3b-repo-ext.test.ts test/agent/branch.test.ts && bun test`
Expected: the two new files PASS; full suite stays green (the `TicketRow` widening is additive).

- [ ] **Step 9: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/db/repos/workflow-step.ts src/db/repos/ticket.ts src/agent/branch.ts test/db/repos/m3b-repo-ext.test.ts test/agent/branch.test.ts
git commit -m "feat(m3b): workflow_step.setPid + ticket branch fields + branchNameFor"
```

---

### Task 2: the agent boundary — `AgentRunner`, tiers, config, registry (retire `models.ts`)

**Files:**
- Create: `src/agent/runner.ts`
- Create: `src/agent/tiers.ts`
- Create: `src/agent/fake-runner.ts`
- Create: `src/config/agent-config.ts`
- Create: `src/agent/registry.ts`
- Delete: `src/dispatch/models.ts`, `test/dispatch/models.test.ts`
- Test: `test/agent/tiers.test.ts`
- Test: `test/config/agent-config.test.ts`
- Test: `test/agent/registry.test.ts`

**Interfaces:**
- Produces:
  - `src/agent/runner.ts`: `interface AgentRunInput { prompt: string; model: string; allowedTools: string[]; cwd: string; timeoutMs: number; onSpawn?: (pid: number) => void }`; `interface AgentRunResult { completed: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; costUsd: number | null; tokensIn: number | null; tokensOut: number | null }`; `interface AgentRunner { run(input: AgentRunInput): Promise<AgentRunResult> }`.
  - `src/agent/tiers.ts`: `type Tier = "deep" | "standard" | "cheap"`; `resolveTier(handlerKey: string, opts?: { loopback?: boolean }): Tier` (throws for non-agent keys).
  - `src/agent/fake-runner.ts`: `class FakeAgentRunner implements AgentRunner` (ctor takes a handler `(input) => AgentRunResult | Promise<AgentRunResult>`; records `inputs`; fires `onSpawn(424242)`).
  - `src/config/agent-config.ts`: `AgentConfigSchema` (zod); `type AgentConfig = z.infer<...>` = `{ provider: string; command?: string; models: { deep: string; standard: string; cheap: string } }`; `DEFAULT_AGENT_CONFIG` (the Claude preset); `parseAgentConfig(raw): AgentConfig`; `modelForTier(config: AgentConfig, tier: Tier): string`.
  - `src/agent/registry.ts`: `type AdapterFactory = () => AgentRunner`; `selectAgentRunner(config: AgentConfig, adapters: Record<string, AdapterFactory>): AgentRunner` (throws if `config.provider` has no registered adapter).

- [ ] **Step 1: Retire the hardcoded models module**

Run: `git rm src/dispatch/models.ts test/dispatch/models.test.ts`
Expected: both deleted. (They have no consumers yet — M3b's dispatch is not built — so removal is clean. The generic `resolveTier` + config replace them.)

- [ ] **Step 2: Write the failing tests** — `test/agent/tiers.test.ts`, `test/config/agent-config.test.ts`, `test/agent/registry.test.ts`

`test/agent/tiers.test.ts`:
```ts
import { expect, test } from "bun:test";
import { resolveTier } from "../../src/agent/tiers.ts";

test("design + review are the deep tier", () => {
  expect(resolveTier("design:dispatch")).toBe("deep");
  expect(resolveTier("design:review")).toBe("deep");
  expect(resolveTier("review")).toBe("deep");
});

test("implement is standard, deep on loopback", () => {
  expect(resolveTier("implement:dispatch")).toBe("standard");
  expect(resolveTier("implement:dispatch", { loopback: true })).toBe("deep");
});

test("extract/docs/pr-ensure are the cheap tier", () => {
  expect(resolveTier("design:extract")).toBe("cheap");
  expect(resolveTier("docs:revise")).toBe("cheap");
  expect(resolveTier("merge:pr-ensure")).toBe("cheap");
});

test("an unknown handlerKey throws", () => {
  expect(() => resolveTier("verify:integration")).toThrow();
});
```

`test/config/agent-config.test.ts`:
```ts
import { expect, test } from "bun:test";
import { DEFAULT_AGENT_CONFIG, modelForTier, parseAgentConfig } from "../../src/config/agent-config.ts";

test("the default config is the Claude preset", () => {
  expect(DEFAULT_AGENT_CONFIG.provider).toBe("claude");
  expect(DEFAULT_AGENT_CONFIG.command).toBe("claude");
  expect(DEFAULT_AGENT_CONFIG.models.deep).toBe("claude-opus-4-8");
  expect(DEFAULT_AGENT_CONFIG.models.standard).toBe("claude-sonnet-4-6");
  expect(DEFAULT_AGENT_CONFIG.models.cheap).toBe("claude-haiku-4-5-20251001");
});

test("parseAgentConfig validates a custom provider config", () => {
  const cfg = parseAgentConfig({ provider: "acme", command: "acme-cli", models: { deep: "a-big", standard: "a-mid", cheap: "a-small" } });
  expect(cfg.provider).toBe("acme");
  expect(modelForTier(cfg, "standard")).toBe("a-mid");
});

test("parseAgentConfig rejects a config missing a tier model", () => {
  expect(() => parseAgentConfig({ provider: "x", models: { deep: "d", standard: "s" } })).toThrow();
});

test("modelForTier resolves each tier", () => {
  expect(modelForTier(DEFAULT_AGENT_CONFIG, "deep")).toBe("claude-opus-4-8");
  expect(modelForTier(DEFAULT_AGENT_CONFIG, "cheap")).toBe("claude-haiku-4-5-20251001");
});
```

`test/agent/registry.test.ts`:
```ts
import { expect, test } from "bun:test";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { selectAgentRunner } from "../../src/agent/registry.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";

const ok = { completed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };

test("selectAgentRunner returns the adapter for the configured provider", () => {
  const runner = new FakeAgentRunner(() => ok);
  const selected = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => runner });
  expect(selected).toBe(runner);
});

test("selectAgentRunner throws for an unregistered provider", () => {
  expect(() => selectAgentRunner({ provider: "nope", models: { deep: "d", standard: "s", cheap: "c" } }, {})).toThrow();
});

test("FakeAgentRunner records inputs and fires onSpawn", async () => {
  const seen: number[] = [];
  const runner = new FakeAgentRunner(() => ok);
  await runner.run({ prompt: "p", model: "m", allowedTools: [], cwd: "/tmp", timeoutMs: 1, onSpawn: (pid) => seen.push(pid) });
  expect(seen).toEqual([424242]);
  expect(runner.inputs[0]?.prompt).toBe("p");
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bun test test/agent/tiers.test.ts test/config/agent-config.test.ts test/agent/registry.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Create `src/agent/runner.ts`**

```ts
export interface AgentRunInput {
  prompt: string;
  model: string;
  allowedTools: string[];
  cwd: string;
  timeoutMs: number;
  onSpawn?: (pid: number) => void;
}

export interface AgentRunResult {
  completed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** The provider-neutral agent boundary. The core depends only on this; a provider
 *  (Claude, etc.) is a config-selected adapter implementing it. */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
```

- [ ] **Step 5: Create `src/agent/tiers.ts`**

```ts
/** Abstract capability tiers (DEC-AG-2): a step maps to a tier; config maps tier → model id
 *  per provider. deep = design/review, standard = implement, cheap = mechanical steps. */
export type Tier = "deep" | "standard" | "cheap";

const TIERS: Record<string, Tier> = {
  "design:dispatch": "deep",
  "design:review": "deep",
  review: "deep",
  "implement:dispatch": "standard",
  "design:extract": "cheap",
  "docs:revise": "cheap",
  "merge:pr-ensure": "cheap",
};

/** Resolve the tier for an agent handlerKey. implement escalates to deep on a loopback retry
 *  (control-loop §8 P4). Non-agent steps never dispatch. */
export function resolveTier(handlerKey: string, opts?: { loopback?: boolean }): Tier {
  if (handlerKey === "implement:dispatch" && opts?.loopback) {
    return "deep";
  }
  const tier = TIERS[handlerKey];
  if (tier === undefined) {
    throw new Error(`resolveTier: no tier for handlerKey '${handlerKey}'`);
  }
  return tier;
}
```

- [ ] **Step 6: Create `src/agent/fake-runner.ts`**

```ts
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./runner.ts";

/** Test double for AgentRunner: scripts agent behavior (the handler may write files into
 *  `cwd` to simulate the agent editing the worktree) and returns a scripted result. */
export class FakeAgentRunner implements AgentRunner {
  readonly inputs: AgentRunInput[] = [];
  constructor(
    private readonly handler: (input: AgentRunInput) => AgentRunResult | Promise<AgentRunResult>,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.inputs.push(input);
    if (input.onSpawn) {
      input.onSpawn(424242);
    }
    return this.handler(input);
  }
}
```

- [ ] **Step 7: Create `src/config/agent-config.ts`**

```ts
import { z } from "zod";
import type { Tier } from "../agent/tiers.ts";

/** Agent provider + per-tier model ids (DEC-AG-3). Lives in workspace config; the binary
 *  default is the Claude preset. The core resolves a step's model via the tier, never a
 *  hardcoded id. */
export const AgentConfigSchema = z.object({
  provider: z.string(),
  command: z.string().optional(),
  models: z.object({
    deep: z.string(),
    standard: z.string(),
    cheap: z.string(),
  }),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: "claude",
  command: "claude",
  models: {
    deep: "claude-opus-4-8",
    standard: "claude-sonnet-4-6",
    cheap: "claude-haiku-4-5-20251001",
  },
};

export function parseAgentConfig(raw: unknown): AgentConfig {
  return AgentConfigSchema.parse(raw);
}

export function modelForTier(config: AgentConfig, tier: Tier): string {
  return config.models[tier];
}
```

- [ ] **Step 8: Create `src/agent/registry.ts`**

```ts
import type { AgentConfig } from "../config/agent-config.ts";
import type { AgentRunner } from "./runner.ts";

export type AdapterFactory = () => AgentRunner;

/** Pick the agent adapter for the configured provider. The daemon supplies the adapter map
 *  (e.g. `{ claude: () => claudeAgentRunner(config.command) }`); tests supply a fake. An
 *  unregistered provider is a setup error (GOAL-INSTALL touchpoint). The core never imports
 *  a provider directly. */
export function selectAgentRunner(
  config: AgentConfig,
  adapters: Record<string, AdapterFactory>,
): AgentRunner {
  const factory = adapters[config.provider];
  if (!factory) {
    throw new Error(`selectAgentRunner: no adapter registered for provider '${config.provider}'`);
  }
  return factory();
}
```

- [ ] **Step 9: Run the tests + full suite**

Run: `bun test test/agent/tiers.test.ts test/config/agent-config.test.ts test/agent/registry.test.ts && bun test`
Expected: the three new files PASS; full suite green (the deleted `models.test.ts` is gone; nothing else referenced `models.ts`).

- [ ] **Step 10: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean (no dangling import of the deleted `models.ts`).

- [ ] **Step 11: Commit**

```bash
git add src/agent/runner.ts src/agent/tiers.ts src/agent/fake-runner.ts src/config/agent-config.ts src/agent/registry.ts test/agent/tiers.test.ts test/config/agent-config.test.ts test/agent/registry.test.ts src/dispatch/models.ts test/dispatch/models.test.ts
git commit -m "feat(m3b): provider-agnostic agent boundary (AgentRunner/tiers/config/registry); retire models.ts"
```

---

### Task 3: the Claude provider adapter

**Files:**
- Create: `src/agent/providers/claude.ts`
- Test: `test/agent/providers/claude.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`/`AgentRunInput`/`AgentRunResult` (Task 2).
- Produces (all on `src/agent/providers/claude.ts`):
  - `buildClaudeArgs(input: { model: string; allowedTools: string[] }): string[]` — the `claude -p` argv (pure).
  - `parseClaudeJson(stdout: string): { costUsd: number | null; tokensIn: number | null; tokensOut: number | null }` — best-effort usage parse; nulls on failure.
  - `claudeAgentRunner(command?: string): AgentRunner` — the real adapter (`Bun.spawn`), command defaulting to `"claude"`; smoke-verified in Task 7.

- [ ] **Step 1: Write the failing test** — `test/agent/providers/claude.test.ts`

```ts
import { expect, test } from "bun:test";
import { buildClaudeArgs, parseClaudeJson } from "../../../src/agent/providers/claude.ts";

test("buildClaudeArgs assembles -p, json output, model, and allowed tools", () => {
  const args = buildClaudeArgs({ model: "claude-opus-4-8", allowedTools: ["Read", "Write"] });
  expect(args).toContain("-p");
  expect(args).toContain("--model");
  expect(args).toContain("claude-opus-4-8");
  expect(args.join(" ")).toContain("Read");
});

test("parseClaudeJson extracts usage, tolerating missing fields", () => {
  const good = parseClaudeJson(JSON.stringify({ total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 3 } }));
  expect(good.costUsd).toBe(0.5);
  expect(good.tokensIn).toBe(10);
  const bad = parseClaudeJson("not json");
  expect(bad).toEqual({ costUsd: null, tokensIn: null, tokensOut: null });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/agent/providers/claude.test.ts`
Expected: FAIL — `Cannot find module '../../../src/agent/providers/claude.ts'`.

- [ ] **Step 3: Create `src/agent/providers/claude.ts`**

```ts
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
```

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/agent/providers/claude.test.ts && bun test`
Expected: PASS (`claudeAgentRunner` is not invoked — smoke-only); full suite green.

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/agent/providers/claude.ts test/agent/providers/claude.test.ts
git commit -m "feat(m3b): Claude provider adapter (spawn + arg/json helpers)"
```

---

### Task 4: prompt assets + dispatch-vars builder

**Files:**
- Create: `prompts/design.md`, `prompts/implement.md`
- Create: `src/md.d.ts`
- Create: `src/dispatch/prompt-vars.ts`
- Test: `test/dispatch/prompt-vars.test.ts`

**Interfaces:**
- Consumes: `Profile` (M3a `profile.ts`); `renderPrompt`/`placeholders` (M3a).
- Produces: `prompts/design.md`, `prompts/implement.md` (text-imported templates); `DESIGN_TEMPLATE`/`IMPLEMENT_TEMPLATE` + `designVars(ticket, profile)` / `implementVars(ticket, unit, profile)` (`src/dispatch/prompt-vars.ts`).

- [ ] **Step 1: Create `prompts/design.md`** (only references vars the builder provides)

```markdown
You are designing ticket {{ident}} ("{{title}}") in the project {{slug}}.

Write a brainstorm + implementation plan as a committed markdown file under `docs/plans/`,
with `linear: {{ident}}` frontmatter. Per work-unit, state: kind, files to touch, whether it
is behavioral (and how it's tested), the verify check-types, and dependencies — as prose.

Project stack notes: {{stack}}
```

- [ ] **Step 2: Create `prompts/implement.md`**

```markdown
You are implementing work-unit {{unit_seq}} ({{unit_kind}}) of ticket {{ident}} in {{slug}}.

Work-unit: {{unit_title}}

Write the code AND its tests in the worktree. Do not commit — the daemon commits.
Run the project's build/test as you go: {{test_command}}

Project stack notes: {{stack}}
```

- [ ] **Step 3: Create `src/md.d.ts`** (type `.md` text imports)

```ts
declare module "*.md" {
  const content: string;
  export default content;
}
```

- [ ] **Step 4: Write the failing test** — `test/dispatch/prompt-vars.test.ts`

```ts
import { expect, test } from "bun:test";
import { DESIGN_TEMPLATE, IMPLEMENT_TEMPLATE, designVars, implementVars } from "../../src/dispatch/prompt-vars.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/demo", commands: { test: "bun test" }, promptVars: { stack: "Bun + SQLite" } });
const ticket = { ident: "ENG-9", title: "Add widget" };
const unit = { seq: 2, kind: "backend", title: "API" };

test("designVars resolves every placeholder in the design template", () => {
  const vars = designVars(ticket, profile);
  expect(renderPrompt(DESIGN_TEMPLATE, vars).ok).toBe(true);
  for (const name of placeholders(DESIGN_TEMPLATE)) {
    expect(name in vars).toBe(true);
  }
});

test("implementVars resolves every placeholder in the implement template", () => {
  const vars = implementVars(ticket, unit, profile);
  expect(renderPrompt(IMPLEMENT_TEMPLATE, vars).ok).toBe(true);
  for (const name of placeholders(IMPLEMENT_TEMPLATE)) {
    expect(name in vars).toBe(true);
  }
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/prompt-vars.ts'`.

- [ ] **Step 6: Create `src/dispatch/prompt-vars.ts`**

```ts
import type { Profile } from "./profile.ts";
import designTemplate from "../../prompts/design.md" with { type: "text" };
import implementTemplate from "../../prompts/implement.md" with { type: "text" };

export const DESIGN_TEMPLATE = designTemplate;
export const IMPLEMENT_TEMPLATE = implementTemplate;

export function designVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return { ident: ticket.ident, title: ticket.title ?? "", slug: profile.slug, ...profile.promptVars };
}

export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: { seq: number; kind: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    slug: profile.slug,
    unit_seq: String(unit.seq),
    unit_kind: unit.kind,
    unit_title: unit.title ?? "",
    test_command: profile.commands.test ?? "",
    ...profile.promptVars,
  };
}
```

- [ ] **Step 7: Run the test + build (templates must embed)**

Run: `bun test test/dispatch/prompt-vars.test.ts && bun test && bun run lint && bun run typecheck && bun run build && ./dist/styre --version`
Expected: PASS; full suite green; binary builds (the `.md` templates embed via the text import like `schema.sql`).

- [ ] **Step 8: Commit**

```bash
git add prompts/design.md prompts/implement.md src/md.d.ts src/dispatch/prompt-vars.ts test/dispatch/prompt-vars.test.ts
git commit -m "feat(m3b): prompt templates + dispatch-vars builders"
```

---

### Task 5: `runAgentDispatch` orchestration

**Files:**
- Create: `src/dispatch/run-dispatch.ts`
- Test: `test/dispatch/run-dispatch.test.ts`

**Interfaces:**
- Consumes: `AgentRunner` (Task 2); `resolveTier` (Task 2); `AgentConfig`/`modelForTier` (Task 2); `Profile`; `allowlistFor`; `renderPrompt`; `ensureWorktree`/`commitWorktree`; dispatch repo (`nextSeq`/`insertDispatch`/`completeDispatch`); `setPid` (Task 1); `HandlerContext`.
- Produces:
  - `interface DispatchDeps { runner: AgentRunner; agentConfig: AgentConfig; profile: Profile; repoPath: string; worktreePath: string; branch: string; timeoutMs: number }`
  - `interface DispatchSpec { handlerKey: string; template: string; vars: Record<string, string>; loopback?: boolean; postcondition: (args: { worktreePath: string; changed: boolean; sha: string }) => void }`
  - `runAgentDispatch(ctx: HandlerContext, deps: DispatchDeps, spec: DispatchSpec): Promise<{ dispatchId: string; sha: string; changed: boolean }>`.

Flow: renderPrompt (CL-PROFILE → throw on miss) → `ensureWorktree` → `resolveTier`+`modelForTier` → allocate `dispatch_id` (`<ident>-d<seq>`) + `insertDispatch` (capture the row) → `runner.run` (`onSpawn` → `setPid`) → on `!completed`/`timedOut`: `completeDispatch(outcome:"dispatch-failed")` + throw → `commitWorktree` (CL-COMMIT, message `"<dispatchId> <handlerKey>"`) → run `postcondition` (on throw: `completeDispatch(outcome:"postcondition-failed")` + rethrow) → `completeDispatch(outcome:"clean-success", sha, usage)`.

- [ ] **Step 1: Write the failing test** — `test/dispatch/run-dispatch.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-rd-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

function ctxFor(db: ReturnType<typeof makeTestDb>["db"], ticketId: number): HandlerContext {
  const step = insertPending(db, { ticketId, stepKey: "implement:wu1:dispatch", stepType: "dispatch" });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  return { db, ticket, step, workUnitId: null };
}

function depsFor(repo: string, wt: string) {
  return { agentConfig: DEFAULT_AGENT_CONFIG, profile: parseProfile({ slug: "demo", targetRepo: repo }), repoPath: repo, worktreePath: wt, branch: "feat/ENG-1", timeoutMs: 1000 };
}

test("runs the agent, commits its edits (CL-COMMIT), records the dispatch with the standard-tier model", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: 0.1, tokensIn: 5, tokensOut: 2 };
  });
  const out = await runAgentDispatch(ctxFor(db, ticketId), { runner, ...depsFor(repo, wt) }, {
    handlerKey: "implement:dispatch",
    template: "implement {{ident}}",
    vars: { ident: "ENG-1" },
    postcondition: ({ changed }) => { if (!changed) throw new Error("empty diff"); },
  });
  const rows = listByTicket(db, ticketId);
  db.close();
  expect(out.changed).toBe(true);
  expect(out.sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(rows[0]?.outcome).toBe("clean-success");
  expect(rows[0]?.model).toBe("claude-sonnet-4-6"); // standard tier via DEFAULT_AGENT_CONFIG
});

test("a CL-PROFILE miss throws before running the agent", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  let ran = false;
  const runner = new FakeAgentRunner(() => { ran = true; return { completed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }; });
  const call = runAgentDispatch(ctxFor(db, ticketId), { runner, ...depsFor(repo, join(repo, "..", `wt2-${Date.now()}`)) }, {
    handlerKey: "implement:dispatch", template: "needs {{missing}}", vars: {}, postcondition: () => {},
  });
  await expect(call).rejects.toThrow(/CL-PROFILE|missing/);
  db.close();
  expect(ran).toBe(false);
});

test("a postcondition failure throws and records postcondition-failed", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const runner = new FakeAgentRunner(() => ({ completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }));
  const call = runAgentDispatch(ctxFor(db, ticketId), { runner, ...depsFor(repo, join(repo, "..", `wt3-${Date.now()}`)) }, {
    handlerKey: "implement:dispatch", template: "implement {{ident}}", vars: { ident: "ENG-1" },
    postcondition: ({ changed }) => { if (!changed) throw new Error("empty diff"); },
  });
  await expect(call).rejects.toThrow(/empty diff/);
  const rows = listByTicket(db, ticketId);
  db.close();
  expect(rows[0]?.outcome).toBe("postcondition-failed");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/run-dispatch.ts'`.

- [ ] **Step 3: Create `src/dispatch/run-dispatch.ts`**

```ts
import { completeDispatch, insertDispatch, nextSeq } from "../db/repos/dispatch.ts";
import { setPid } from "../db/repos/workflow-step.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { modelForTier } from "../config/agent-config.ts";
import type { AgentRunner } from "../agent/runner.ts";
import { resolveTier } from "../agent/tiers.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import { nowUtc } from "../util/time.ts";
import type { Profile } from "./profile.ts";
import { renderPrompt } from "./render-prompt.ts";
import { allowlistFor } from "./tool-allowlists.ts";
import { commitWorktree, ensureWorktree } from "./worktree.ts";

export interface DispatchDeps {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  profile: Profile;
  repoPath: string;
  worktreePath: string;
  branch: string;
  timeoutMs: number;
}

export interface DispatchSpec {
  handlerKey: string;
  template: string;
  vars: Record<string, string>;
  loopback?: boolean;
  postcondition: (args: { worktreePath: string; changed: boolean; sha: string }) => void;
}

function dispatchId(ident: string, seq: number): string {
  return `${ident}-d${String(seq).padStart(4, "0")}`;
}

/** The shared real-dispatch flow (control-loop §4), provider-agnostic: render (CL-PROFILE) →
 *  worktree → run the agent via the injected AgentRunner (model from the tier+config; pid
 *  journaled for orphan-kill) → daemon-commit (CL-COMMIT) → record the dispatch → enforce the
 *  postcondition (CL-POSTCOND). Throws on CL-PROFILE miss, transport failure, or postcondition
 *  failure (→ failure-policy). */
export async function runAgentDispatch(
  ctx: HandlerContext,
  deps: DispatchDeps,
  spec: DispatchSpec,
): Promise<{ dispatchId: string; sha: string; changed: boolean }> {
  const rendered = renderPrompt(spec.template, spec.vars);
  if (!rendered.ok) {
    throw new Error(`CL-PROFILE: unresolved prompt vars: ${rendered.missing.join(", ")}`);
  }

  ensureWorktree(deps.repoPath, deps.branch, deps.worktreePath);

  const seq = nextSeq(ctx.db, ctx.ticket.id);
  const did = dispatchId(ctx.ticket.ident, seq);
  const tier = resolveTier(spec.handlerKey, { loopback: spec.loopback });
  const model = modelForTier(deps.agentConfig, tier);
  const inserted = insertDispatch(ctx.db, {
    ticketId: ctx.ticket.id,
    dispatchId: did,
    seq,
    workUnitId: ctx.workUnitId,
    stepId: ctx.step.id,
    stage: ctx.ticket.stage,
    model,
    startedAt: nowUtc(),
    worktreePath: deps.worktreePath,
  });

  const result = await deps.runner.run({
    prompt: rendered.prompt,
    model,
    allowedTools: allowlistFor(spec.handlerKey),
    cwd: deps.worktreePath,
    timeoutMs: deps.timeoutMs,
    onSpawn: (pid) => setPid(ctx.db, ctx.step.id, pid),
  });

  if (!result.completed || result.timedOut) {
    completeDispatch(ctx.db, inserted.id, { outcome: "dispatch-failed", endedAt: nowUtc() });
    throw new Error(`dispatch ${did} transport failure (exit ${result.exitCode}, timedOut=${result.timedOut})`);
  }

  const { sha, changed } = commitWorktree(deps.worktreePath, `${did} ${spec.handlerKey}`);
  const completion = {
    branchHeadSha: sha,
    endedAt: nowUtc(),
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };
  try {
    spec.postcondition({ worktreePath: deps.worktreePath, changed, sha });
  } catch (err) {
    completeDispatch(ctx.db, inserted.id, { outcome: "postcondition-failed", ...completion });
    throw err;
  }
  completeDispatch(ctx.db, inserted.id, { outcome: "clean-success", ...completion });
  return { dispatchId: did, sha, changed };
}
```

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/dispatch/run-dispatch.test.ts && bun test`
Expected: PASS (3 tests); full suite green.

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/run-dispatch.ts test/dispatch/run-dispatch.test.ts
git commit -m "feat(m3b): runAgentDispatch orchestration (provider-agnostic, tier→model)"
```

---

### Task 6: real handlers + `buildDispatchRegistry`

**Files:**
- Create: `src/dispatch/handlers.ts`
- Test: `test/dispatch/handlers.test.ts`

**Interfaces:**
- Consumes: `runAgentDispatch`/`DispatchDeps` (Task 5); `AgentRunner` + `AgentConfig` (Task 2); `designVars`/`implementVars`/`DESIGN_TEMPLATE`/`IMPLEMENT_TEMPLATE` (Task 4); `branchNameFor` (Task 1); `StepRegistry`/`HandlerContext` (M2); `getProject`; work-unit `getById`/`setStatus`; `Profile`.
- Produces:
  - `interface RegistryDeps { runner: AgentRunner; agentConfig: AgentConfig; profile: Profile; worktreeRoot: string; timeoutMs?: number }`
  - `buildDispatchRegistry(deps: RegistryDeps): StepRegistry` — registers real `design:dispatch` + `implement:dispatch` (other handlerKeys come in later milestones).

- [ ] **Step 1: Write the failing test** — `test/dispatch/handlers.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-h-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

function registryFor(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({ runner, agentConfig: DEFAULT_AGENT_CONFIG, profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "bun test" } }), worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wtroot-")) });
}

test("implement:dispatch runs the agent, commits, sets the unit verifying", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const runner = new FakeAgentRunner((input) => { writeFileSync(join(input.cwd, "impl.ts"), "export const y = 2;\n"); return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }; });

  const outcome = await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const afterUnit = getUnit(db, unit.id);
  const dispatches = listByTicket(db, ticketId);
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(afterUnit?.status).toBe("verifying");
  expect(step?.status).toBe("succeeded");
  expect(dispatches[0]?.model).toBe("claude-sonnet-4-6");
});

test("implement:dispatch with an empty diff fails the step (postcondition → failure-policy)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const runner = new FakeAgentRunner(() => ({ completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }));
  const outcome = await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/handlers.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/handlers.ts'`.

- [ ] **Step 3: Create `src/dispatch/handlers.ts`**

```ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProject } from "../db/repos/project.ts";
import { getById as getUnit, setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { branchNameFor } from "../agent/branch.ts";
import type { AgentRunner } from "../agent/runner.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { StepRegistry } from "../daemon/step-registry.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import type { Profile } from "./profile.ts";
import { DESIGN_TEMPLATE, IMPLEMENT_TEMPLATE, designVars, implementVars } from "./prompt-vars.ts";
import type { DispatchDeps } from "./run-dispatch.ts";
import { runAgentDispatch } from "./run-dispatch.ts";

export interface RegistryDeps {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  profile: Profile;
  worktreeRoot: string;
  timeoutMs?: number;
}

const DESIGN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function depsFor(ctx: HandlerContext, deps: RegistryDeps, timeoutMs: number): DispatchDeps {
  const project = getProject(ctx.db, ctx.ticket.project_id);
  if (!project) {
    throw new Error(`handler: project ${ctx.ticket.project_id} not found`);
  }
  return {
    runner: deps.runner,
    agentConfig: deps.agentConfig,
    profile: deps.profile,
    repoPath: project.target_repo,
    worktreePath: join(deps.worktreeRoot, ctx.ticket.ident),
    branch: branchNameFor(ctx.ticket),
    timeoutMs,
  };
}

/** Register the real worktree-agent handlers (control-loop §4 S1a/S2b), provider-agnostic.
 *  Other handlerKeys (extract/review → M5; verify → M4; merge → M6) are added later. */
export function buildDispatchRegistry(deps: RegistryDeps): StepRegistry {
  const registry = new StepRegistry();

  registry.register("design:dispatch", async (ctx: HandlerContext) =>
    runAgentDispatch(ctx, depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS), {
      handlerKey: "design:dispatch",
      template: DESIGN_TEMPLATE,
      vars: designVars(ctx.ticket, deps.profile),
      postcondition: ({ worktreePath, changed }) => {
        const plansDir = join(worktreePath, "docs", "plans");
        const hasPlan =
          changed && existsSync(plansDir) && readdirSync(plansDir).some((f) => f.endsWith(".md"));
        if (!hasPlan) {
          throw new Error("design:dispatch postcondition: no plan committed under docs/plans/");
        }
      },
    }),
  );

  registry.register("implement:dispatch", async (ctx: HandlerContext) => {
    if (ctx.workUnitId === null) {
      throw new Error("implement:dispatch: missing workUnitId");
    }
    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (!unit) {
      throw new Error(`implement:dispatch: work_unit ${ctx.workUnitId} not found`);
    }
    const result = await runAgentDispatch(ctx, depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS), {
      handlerKey: "implement:dispatch",
      template: IMPLEMENT_TEMPLATE,
      vars: implementVars(ctx.ticket, unit, deps.profile),
      postcondition: ({ changed }) => {
        if (!changed) {
          throw new Error("implement:dispatch postcondition: empty diff");
        }
      },
    });
    setUnitStatus(ctx.db, unit.id, "verifying");
    return result;
  });

  return registry;
}
```

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/dispatch/handlers.test.ts && bun test`
Expected: PASS (2 tests); full suite green.

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/handlers.test.ts
git commit -m "feat(m3b): real design:dispatch + implement:dispatch handlers + registry"
```

---

### Task 7: offline real-handler e2e + manual smoke

**Files:**
- Create: `test/dispatch/real-dispatch-e2e.test.ts`
- Create: `scripts/smoke-agent.ts`
- Create: `docs/design/m3b-smoke.md`

**Interfaces:**
- Consumes: `buildDispatchRegistry` + `FakeAgentRunner`; `advanceOneStep`; repos. The smoke uses `claudeAgentRunner` (Task 3) + `selectAgentRunner` + `DEFAULT_AGENT_CONFIG`.
- Produces: an offline e2e proving the REAL `design:dispatch` handler (with a fake agent) commits a plan and the step succeeds; a runnable manual smoke against the real provider; and a smoke doc.

This task adds NO new production modules. If a bug surfaces in an owning module, STOP and report it.

- [ ] **Step 1: Write the offline e2e** — `test/dispatch/real-dispatch-e2e.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-e2e-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

test("real design:dispatch handler (fake agent) commits a plan and the step succeeds", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "docs", "plans");
    Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(join(dir, "ENG-1-plan.md"), "---\nlinear: ENG-1\n---\nplan\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({ runner, agentConfig: DEFAULT_AGENT_CONFIG, profile: parseProfile({ slug: "demo", targetRepo: repo, promptVars: { stack: "bun" } }), worktreeRoot: mkdtempSync(join(tmpdir(), "styre-e2ewt-")) });

  const outcome = await advanceOneStep(db, ticketId, registry);
  db.close();
  expect(outcome).toEqual({ kind: "stepped", stepKey: "design:dispatch" });
});
```

- [ ] **Step 2: Run the offline e2e**

Run: `bun test test/dispatch/real-dispatch-e2e.test.ts`
Expected: PASS. If it stalls or a handler throws unexpectedly, STOP and report which module is at fault (don't patch the test around it).

- [ ] **Step 3: Write the manual smoke** — `scripts/smoke-agent.ts`

```ts
// Manual smoke (NOT run in CI): exercises the REAL configured provider via selectAgentRunner.
// Usage: bun run scripts/smoke-agent.ts <path-to-git-repo>
// Requires the configured agent CLI installed + authenticated (default provider: claude).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAgentRunner } from "../src/agent/providers/claude.ts";
import { selectAgentRunner } from "../src/agent/registry.ts";
import { DEFAULT_AGENT_CONFIG, modelForTier } from "../src/config/agent-config.ts";
import { resolveTier } from "../src/agent/tiers.ts";
import { allowlistFor } from "../src/dispatch/tool-allowlists.ts";
import { ensureWorktree } from "../src/dispatch/worktree.ts";

const repo = process.argv[2];
if (!repo) {
  throw new Error("usage: bun run scripts/smoke-agent.ts <git-repo-path>");
}
const config = DEFAULT_AGENT_CONFIG;
const runner = selectAgentRunner(config, { claude: () => claudeAgentRunner(config.command) });
const wt = join(mkdtempSync(join(tmpdir(), "styre-smoke-")), "wt");
ensureWorktree(repo, "feat/styre-smoke", wt);
const result = await runner.run({
  prompt: "Create a file HELLO.txt containing the word styre. Do not commit.",
  model: modelForTier(config, resolveTier("implement:dispatch")),
  allowedTools: allowlistFor("implement:dispatch"),
  cwd: wt,
  timeoutMs: 5 * 60 * 1000,
  onSpawn: (pid) => console.log("agent pid:", pid),
});
console.log("completed:", result.completed, "exit:", result.exitCode, "timedOut:", result.timedOut);
console.log("usage:", { costUsd: result.costUsd, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
console.log("stdout (first 500):", result.stdout.slice(0, 500));
```

- [ ] **Step 4: Document the smoke + verify the real flags/JSON** — `docs/design/m3b-smoke.md`

Write `docs/design/m3b-smoke.md`: prerequisites (the configured agent CLI + auth; default provider Claude), how to run `bun run scripts/smoke-agent.ts <repo>`, and — **after running it once against the real CLI** — the confirmed flags (`--allowedTools` vs `--allowed-tools`?) and `--output-format json` field names for cost/tokens. If they differ from `buildClaudeArgs`/`parseClaudeJson` in `src/agent/providers/claude.ts`, fix those two functions (+ update Task 3's tests), commit, and note the correction here. If the agent CLI is unavailable in this environment, document the smoke as pending + flags unverified — do NOT block the offline suite on it.

- [ ] **Step 5: Run the FULL suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all M0–M3a + M3b tests pass (the smoke script is not a test); Biome clean; `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add test/dispatch/real-dispatch-e2e.test.ts scripts/smoke-agent.ts docs/design/m3b-smoke.md
git commit -m "test(m3b): offline real-handler e2e + manual agent smoke + smoke doc"
```

---

## M3b acceptance criteria

- [ ] The core dispatch flow depends only on the generic `AgentRunner`; the Claude CLI lives behind `src/agent/providers/claude.ts`, selected by config via `selectAgentRunner`. The hardcoded `models.ts` is gone.
- [ ] A step's model is resolved by `resolveTier` + `AgentConfig.models[tier]` (default = Claude preset); loopback escalates `standard → deep`.
- [ ] `runAgentDispatch` renders (CL-PROFILE), worktrees, runs the agent (journaling the subprocess pid), daemon-commits (CL-COMMIT), records the `dispatch` row, and enforces the postcondition — tested with `FakeAgentRunner` + real git + real DB.
- [ ] Real `design:dispatch` + `implement:dispatch` handlers via `buildDispatchRegistry`; a failing dispatch routes through failure-policy.
- [ ] Offline e2e: the real handlers (fake agent) drive `design:dispatch` (commits a plan).
- [ ] A manual smoke exists; the real Claude flags + JSON shape are verified (or documented pending).
- [ ] `bun test` green; `bun run lint && bun run typecheck` clean; the binary builds (templates embed).

## Out of scope (later milestones)

- **`design:extract` / `design:review` / `review`** (structured-judgment via the M3a sidecar) — **M5**.
- **Real verify** (S3/S4 daemon-run profile commands, checks-system) — **M4**.
- **Rebase**, **projector / merge / external effects** — later (M6).
- **The continuous daemon, agent committer-identity config, the `styre run/daemon` commands, full 4-tier config precedence loading `AgentConfig` from workspace config.json** — **M8** (M3b uses `DEFAULT_AGENT_CONFIG` / injected config).
- **Additional provider adapters** beyond Claude — added under `src/agent/providers/` with zero core changes when needed.

## Done / handoff

When M3b merges, the substrate runs a ticket through **design + implement with real, provider-agnostic agent dispatch** (verify/review/merge still mocked/daemon-stubbed). Next: **M4 — Verify real** (ground-truth profile commands + checks-system).
