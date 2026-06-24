# Profile Runtime Context — Agent-Prose Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the hybrid probe's agent-prose half: a mandatory setup-time agent (Sonnet, read-only repo tools) that writes rich `detail` prose and resolves `unknown` runtime-context sections, while the deterministic scan flags remain the gate's ground truth.

**Architecture:** A new `src/setup/enrich.ts` runs one bounded-retry agent call via the existing `AgentRunner` (no worktree/db/ticket), parses a validated `styre-setup-enrich` sidecar, and merges it over the deterministic scan (`mergeScanAndEnrichment`: scan flags win, agent enriches detail + resolves `unknown`). `runSetup` becomes async and threads an injected runner so tests use `FakeAgentRunner`; the citty command constructs the real runner and enforces the `ANTHROPIC_API_KEY` precondition.

**Tech Stack:** TypeScript + Bun, zod, `bun test`. Reuses `AgentRunner`/`selectAgentRunner`/`modelForTier`/`extractSidecar`/`allowlistFor`/`renderPrompt`/`FakeAgentRunner`.

**Spec:** `docs/brainstorms/2026-06-23-profile-runtime-context-enrichment-design.md`
**Branch:** `feat/profile-runtime-context` (same branch as PR #28 — ships the complete feature).

## Global Constraints

- **Scan flags are ground truth (E5).** The agent enriches `detail` everywhere and proposes a flag ONLY where the scan was `unknown`; it can NEVER override a confident (`present`/`absent`, or non-`unknown` `type`/`mechanism`) scan flag.
- **Mandatory engagement (E1).** `styre setup` requires `ANTHROPIC_API_KEY`; the precondition is checked in the citty command wrapper (so the testable `runSetup` core stays env-free via an injected runner).
- **Retry-then-fail (E2).** Up to 3 attempts, exponential backoff; on exhaustion `enrichRuntimeContext` throws → `runSetup` writes no profile (existing untouched on re-probe). No degraded-write path.
- **Capability isolation (move 4).** Enrichment tools are read-only `["Read","Grep","Glob"]` via a new `"setup:enrich"` allowlist entry; no write/Bash/gh/Linear. `cwd = repoDir`; `agentEnv` already scrubs `LINEAR_API_KEY`/`GITHUB_TOKEN`.
- **Model tier (E4):** `standard` (Sonnet) via `modelForTier(config, "standard")`.
- **Structured output via zod (§3a):** the agent's output goes through `extractSidecar` + `EnrichmentSchema`; an absent/malformed sidecar is a transport failure (retry), not a parsed decision.
- **No `ProfileSchema` field change, no `src/db/schema.sql` change.** Enrichment only fills existing `detail`/`presence`/`type`/`mechanism` fields.
- **Test runner `bun test`. Full gate per task:** `bun run lint && bun run typecheck && bun test && bun run build` all clean before each commit.

---

### Task 1: Enrichment schema + `mergeScanAndEnrichment`

**Files:**
- Modify: `src/dispatch/profile.ts` (export the three enum schemas; reuse them in `ProfileSchema`)
- Create: `src/setup/enrichment-schema.ts` (the `EnrichmentSchema`)
- Modify: `src/setup/merge.ts` (add `mergeScanAndEnrichment`)
- Test: `test/setup/enrichment-merge.test.ts`

**Interfaces:**
- Consumes: `RuntimeContext` and the new exported enums from `src/dispatch/profile.ts`.
- Produces: `EnrichmentSchema` (zod) + `type Enrichment` from `enrichment-schema.ts`; `mergeScanAndEnrichment(scan: RuntimeContext, enr: Enrichment): RuntimeContext` from `merge.ts`. Exported enums: `PresenceEnum`, `TopologyTypeEnum`, `ReleaseMechanismEnum`.

- [ ] **Step 1: Export the enum schemas from `profile.ts`**

In `src/dispatch/profile.ts`, add the three exported enums near the top (after the imports) and reference them in the existing schemas (behavior-preserving — same literals, same defaults):

```ts
export const PresenceEnum = z.enum(["present", "absent", "unknown"]);
export const TopologyTypeEnum = z.enum([
  "web-service", "web-n-tier", "desktop", "mobile-ios",
  "mobile-android", "cli", "library", "hybrid", "unknown",
]);
export const ReleaseMechanismEnum = z.enum([
  "semantic-release", "app-store", "installer", "signed-binary", "none", "unknown",
]);
```

Then replace the inline `z.enum([...])` uses:
- `_TriStateBase.presence`: `presence: PresenceEnum.default("unknown")`
- `_DataStateBase.presence`: `presence: PresenceEnum.default("unknown")`
- `_TopologyBase.type`: `type: TopologyTypeEnum.default("unknown")`
- `_ReleasePackagingBase.mechanism`: `mechanism: ReleaseMechanismEnum.default("unknown")`

- [ ] **Step 2: Run the existing profile tests to confirm the refactor is behavior-preserving**

Run: `bun test test/dispatch/profile.test.ts`
Expected: PASS (unchanged — same literals/defaults).

- [ ] **Step 3: Write the failing merge test**

Create `test/setup/enrichment-merge.test.ts`:

```ts
import { expect, test } from "bun:test";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";
import { EnrichmentSchema } from "../../src/setup/enrichment-schema.ts";
import { mergeScanAndEnrichment } from "../../src/setup/merge.ts";

const scan = (o: unknown) => RuntimeContextSchema.parse(o);
const enr = (o: unknown) => EnrichmentSchema.parse(o);

const fullEnrichment = {
  topology: { detail: "" },
  data: { detail: "" },
  caching: { detail: "" },
  observability: { detail: "" },
  configSecrets: { detail: "" },
  documentation: { detail: "" },
  releasePackaging: { detail: "" },
};

test("agent detail wins over terse scan detail", () => {
  const m = mergeScanAndEnrichment(
    scan({ caching: { presence: "present", detail: "ioredis" } }),
    enr({ ...fullEnrichment, caching: { detail: "Redis session cache, 15m TTL" } }),
  );
  expect(m.caching.detail).toBe("Redis session cache, 15m TTL");
  expect(m.caching.presence).toBe("present"); // scan flag unchanged
});

test("empty agent detail keeps the scan's terse detail", () => {
  const m = mergeScanAndEnrichment(
    scan({ caching: { presence: "present", detail: "ioredis" } }),
    enr({ ...fullEnrichment, caching: { detail: "   " } }),
  );
  expect(m.caching.detail).toBe("ioredis");
});

test("agent presence is honored only where scan is unknown", () => {
  const m = mergeScanAndEnrichment(
    scan({ data: { presence: "unknown" } }),
    enr({ ...fullEnrichment, data: { presence: "present", detail: "found sqlite" } }),
  );
  expect(m.data.presence).toBe("present");
  expect(m.data.detail).toBe("found sqlite");
});

test("agent CANNOT override a confident scan flag", () => {
  const m = mergeScanAndEnrichment(
    scan({ data: { presence: "absent" } }),
    enr({ ...fullEnrichment, data: { presence: "present", detail: "x" } }),
  );
  expect(m.data.presence).toBe("absent"); // scan wins
});

test("a section left unknown by both stays unknown", () => {
  const m = mergeScanAndEnrichment(
    scan({ caching: { presence: "unknown" } }),
    enr({ ...fullEnrichment, caching: { detail: "could not tell" } }),
  );
  expect(m.caching.presence).toBe("unknown");
});

test("topology.type and releasePackaging.mechanism follow the same rule", () => {
  const m = mergeScanAndEnrichment(
    scan({ topology: { type: "unknown" }, releasePackaging: { mechanism: "semantic-release" } }),
    enr({ ...fullEnrichment, topology: { type: "cli", detail: "bin entry" }, releasePackaging: { mechanism: "installer", detail: "x" } }),
  );
  expect(m.topology.type).toBe("cli"); // scan unknown → agent proposal
  expect(m.releasePackaging.mechanism).toBe("semantic-release"); // scan confident → agent ignored
});

test("migrationTool: scan wins, agent fills only when scan absent", () => {
  const a = mergeScanAndEnrichment(
    scan({ data: { presence: "present", migrationTool: "prisma" } }),
    enr({ ...fullEnrichment, data: { migrationTool: "drizzle", detail: "" } }),
  );
  expect(a.data.migrationTool).toBe("prisma");
  const b = mergeScanAndEnrichment(
    scan({ data: { presence: "present" } }),
    enr({ ...fullEnrichment, data: { migrationTool: "alembic", detail: "" } }),
  );
  expect(b.data.migrationTool).toBe("alembic");
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test test/setup/enrichment-merge.test.ts`
Expected: FAIL — `enrichment-schema.ts` / `mergeScanAndEnrichment` do not exist.

- [ ] **Step 5: Create the enrichment schema**

Create `src/setup/enrichment-schema.ts`:

```ts
import { z } from "zod";
import { PresenceEnum, ReleaseMechanismEnum, TopologyTypeEnum } from "../dispatch/profile.ts";

// Section objects are required (the prompt asks for all 7); `detail` defaults to "" so an
// agent that emits a section but omits its detail still parses. An omitted whole section makes
// the parse fail → extractSidecar reports "malformed" → enrichRuntimeContext retries. The
// optional presence/type/mechanism are PROPOSALS, honored by the merge only where scan==unknown.
const triSection = z.object({ presence: PresenceEnum.optional(), detail: z.string().default("") });
const dataSection = z.object({
  presence: PresenceEnum.optional(),
  migrationTool: z.string().optional(),
  detail: z.string().default(""),
});
const topologySection = z.object({ type: TopologyTypeEnum.optional(), detail: z.string().default("") });
const releaseSection = z.object({ mechanism: ReleaseMechanismEnum.optional(), detail: z.string().default("") });

export const EnrichmentSchema = z.object({
  topology: topologySection,
  data: dataSection,
  caching: triSection,
  observability: triSection,
  configSecrets: triSection,
  documentation: triSection,
  releasePackaging: releaseSection,
});

export type Enrichment = z.infer<typeof EnrichmentSchema>;
```

- [ ] **Step 6: Implement `mergeScanAndEnrichment`**

Append to `src/setup/merge.ts` (keep the existing `mergeRuntimeContext`):

```ts
import type { Enrichment } from "./enrichment-schema.ts";

type Presence = "present" | "absent" | "unknown";

const pickDetail = (agent: string, scan: string): string =>
  agent.trim() !== "" ? agent : scan;

// scan flag wins unless it's unknown, then the agent's proposal (if any), else unknown.
const mergePresence = (scan: Presence, agent?: Presence): Presence =>
  scan !== "unknown" ? scan : (agent ?? "unknown");

/** Layer 1+2 of the probe: the deterministic scan is ground truth for flags; the agent
 *  enriches detail everywhere and resolves only sections the scan left `unknown`. */
export function mergeScanAndEnrichment(scan: RuntimeContext, enr: Enrichment): RuntimeContext {
  const migrationTool = scan.data.migrationTool ?? enr.data.migrationTool;
  return {
    topology: {
      type: scan.topology.type !== "unknown" ? scan.topology.type : (enr.topology.type ?? "unknown"),
      detail: pickDetail(enr.topology.detail, scan.topology.detail),
    },
    data: {
      presence: mergePresence(scan.data.presence, enr.data.presence),
      detail: pickDetail(enr.data.detail, scan.data.detail),
      ...(migrationTool ? { migrationTool } : {}),
    },
    caching: {
      presence: mergePresence(scan.caching.presence, enr.caching.presence),
      detail: pickDetail(enr.caching.detail, scan.caching.detail),
    },
    observability: {
      presence: mergePresence(scan.observability.presence, enr.observability.presence),
      detail: pickDetail(enr.observability.detail, scan.observability.detail),
    },
    configSecrets: {
      presence: mergePresence(scan.configSecrets.presence, enr.configSecrets.presence),
      detail: pickDetail(enr.configSecrets.detail, scan.configSecrets.detail),
    },
    documentation: {
      presence: mergePresence(scan.documentation.presence, enr.documentation.presence),
      detail: pickDetail(enr.documentation.detail, scan.documentation.detail),
    },
    releasePackaging: {
      mechanism:
        scan.releasePackaging.mechanism !== "unknown"
          ? scan.releasePackaging.mechanism
          : (enr.releasePackaging.mechanism ?? "unknown"),
      detail: pickDetail(enr.releasePackaging.detail, scan.releasePackaging.detail),
    },
  };
}
```

Note: `merge.ts` already imports `RuntimeContext` (used by `mergeRuntimeContext`); reuse that import.

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test test/setup/enrichment-merge.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 8: Full gate + commit**

Run: `bun run lint && bun run typecheck && bun test && bun run build`
Expected: all clean.

```bash
git add src/dispatch/profile.ts src/setup/enrichment-schema.ts src/setup/merge.ts test/setup/enrichment-merge.test.ts
git commit -m "feat(setup): enrichment schema + scan/agent merge (scan flags ground truth)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `enrichRuntimeContext` — the bounded-retry agent call

**Files:**
- Modify: `src/dispatch/tool-allowlists.ts` (add `"setup:enrich"`)
- Create: `prompts/setup-enrich.md`
- Create: `src/setup/enrich.ts`
- Test: `test/setup/enrich.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`/`AgentRunInput` (`src/agent/runner.ts`); `AgentConfig` + `modelForTier` (`src/config/agent-config.ts`); `allowlistFor` (`src/dispatch/tool-allowlists.ts`); `extractSidecar` (`src/dispatch/sidecar.ts`); `renderPrompt` (`src/dispatch/render-prompt.ts`); `EnrichmentSchema` (Task 1); `mergeScanAndEnrichment` (Task 1); `RuntimeContext` (`src/dispatch/profile.ts`).
- Produces: `type EnrichDeps = { runner: AgentRunner; agentConfig: AgentConfig; sleep?: (ms: number) => Promise<void> }` and `enrichRuntimeContext(repoDir: string, scan: RuntimeContext, deps: EnrichDeps): Promise<RuntimeContext>` from `src/setup/enrich.ts`.

- [ ] **Step 1: Add the `setup:enrich` tool allowlist**

In `src/dispatch/tool-allowlists.ts`, add to `ALLOWLISTS`:

```ts
  "setup:enrich": [...READ_ONLY],
```

- [ ] **Step 2: Create the prompt template**

Create `prompts/setup-enrich.md`:

```markdown
You are enriching the runtime-context section of a Styre project profile for the repository at the current working directory. A deterministic scan has already set ground-truth flags from hard signals; your job is to write specific, grounded prose for each section and to resolve sections the scan could not determine. You have read-only tools (Read, Grep, Glob) — open the relevant files to ground your prose. Do NOT write or modify anything.

Deterministic scan results (treat the flags as ground truth — do not contradict a `present`/`absent` flag):

- Topology: {{scan_topology}} — {{scan_topology_detail}}
- Data/persistence: {{scan_data}} — {{scan_data_detail}} (migration tool: {{scan_data_migration_tool}})
- Caching: {{scan_caching}} — {{scan_caching_detail}}
- Observability: {{scan_observability}} — {{scan_observability_detail}}
- Config/secrets: {{scan_config_secrets}} — {{scan_config_secrets_detail}}
- Documentation: {{scan_documentation}} — {{scan_documentation_detail}}
- Release/packaging: {{scan_release}} — {{scan_release_detail}}

For EACH section, write a `detail` string: concrete, specific prose grounded in the actual files (e.g. "Postgres via Prisma; migrations in prisma/migrations; soft-delete columns on users"). Never read secret values — you may note that a `.env.example` exists, but do not open `.env` files.

For any section the scan marked `unknown`, investigate the repo and, if you can determine it, set `presence` to `present` or `absent` (for topology set `type`, for release set `mechanism`). If you still cannot tell, omit the proposal (leave it out) and say so in `detail`. Do NOT set presence/type/mechanism for sections the scan already resolved — only enrich their `detail`.

Emit exactly one fenced block:

```styre-setup-enrich
{
  "topology": { "type": "cli", "detail": "…" },
  "data": { "presence": "present", "migrationTool": "prisma", "detail": "…" },
  "caching": { "presence": "absent", "detail": "…" },
  "observability": { "detail": "…" },
  "configSecrets": { "detail": "…" },
  "documentation": { "detail": "…" },
  "releasePackaging": { "mechanism": "semantic-release", "detail": "…" }
}
```

Include all seven keys. Only include `presence`/`type`/`mechanism` when you are proposing a value for a section the scan left `unknown`.
```

- [ ] **Step 3: Write the failing test**

Create `test/setup/enrich.test.ts`:

```ts
import { expect, test } from "bun:test";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";
import { enrichRuntimeContext } from "../../src/setup/enrich.ts";
import type { AgentRunResult } from "../../src/agent/runner.ts";

const scan = (o: unknown) => RuntimeContextSchema.parse(o);
const ok = (stdout: string): AgentRunResult => ({
  completed: true, exitCode: 0, stdout, stderr: "", timedOut: false,
  costUsd: null, tokensIn: null, tokensOut: null,
});
const sidecar = (json: string) => `Here you go.\n\`\`\`styre-setup-enrich\n${json}\n\`\`\`\n`;
const noSleep = () => Promise.resolve();

const FULL = {
  topology: { detail: "a cli" },
  data: { detail: "no db" },
  caching: { detail: "no cache" },
  observability: { detail: "pino logs" },
  configSecrets: { detail: "env vars" },
  documentation: { detail: "README + docs/" },
  releasePackaging: { detail: "semantic-release" },
};

test("enrich merges agent prose over the scan", async () => {
  const runner = new FakeAgentRunner(() =>
    ok(sidecar(JSON.stringify({ ...FULL, caching: { detail: "Redis, 15m TTL" } }))),
  );
  const out = await enrichRuntimeContext(
    "/tmp/repo",
    scan({ caching: { presence: "present", detail: "ioredis" } }),
    { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: noSleep },
  );
  expect(out.caching.detail).toBe("Redis, 15m TTL");
  expect(out.caching.presence).toBe("present");
});

test("enrich resolves an unknown section from the agent proposal", async () => {
  const runner = new FakeAgentRunner(() =>
    ok(sidecar(JSON.stringify({ ...FULL, data: { presence: "present", migrationTool: "prisma", detail: "pg" } }))),
  );
  const out = await enrichRuntimeContext(
    "/tmp/repo",
    scan({ data: { presence: "unknown" } }),
    { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: noSleep },
  );
  expect(out.data.presence).toBe("present");
  expect(out.data.migrationTool).toBe("prisma");
});

test("enrich passes read-only tools and the standard-tier model, cwd=repoDir", async () => {
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(FULL))));
  await enrichRuntimeContext("/tmp/repo", scan({}), { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: noSleep });
  const input = runner.inputs[0];
  expect(input?.allowedTools).toEqual(["Read", "Grep", "Glob"]);
  expect(input?.model).toBe("claude-sonnet-4-6");
  expect(input?.cwd).toBe("/tmp/repo");
});

test("enrich retries a malformed sidecar then throws after 3 attempts", async () => {
  const runner = new FakeAgentRunner(() => ok("no sidecar here"));
  await expect(
    enrichRuntimeContext("/tmp/repo", scan({}), { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: noSleep }),
  ).rejects.toThrow(/failed after 3 attempts/);
  expect(runner.inputs.length).toBe(3);
});

test("enrich retries a non-completed result then succeeds on a later attempt", async () => {
  let n = 0;
  const runner = new FakeAgentRunner((): AgentRunResult => {
    n += 1;
    if (n < 2) return { ...ok(""), completed: false, exitCode: 1 };
    return ok(sidecar(JSON.stringify(FULL)));
  });
  const out = await enrichRuntimeContext("/tmp/repo", scan({}), {
    runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: noSleep,
  });
  expect(out.topology.detail).toBe("a cli");
  expect(runner.inputs.length).toBe(2);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test test/setup/enrich.test.ts`
Expected: FAIL — `src/setup/enrich.ts` does not exist.

- [ ] **Step 5: Implement `enrichRuntimeContext`**

Create `src/setup/enrich.ts`:

```ts
import type { AgentConfig } from "../config/agent-config.ts";
import { modelForTier } from "../config/agent-config.ts";
import type { AgentRunner } from "../agent/runner.ts";
import type { RuntimeContext } from "../dispatch/profile.ts";
import { renderPrompt } from "../dispatch/render-prompt.ts";
import { extractSidecar } from "../dispatch/sidecar.ts";
import { allowlistFor } from "../dispatch/tool-allowlists.ts";
import setupEnrichTemplate from "../../prompts/setup-enrich.md" with { type: "text" };
import { EnrichmentSchema } from "./enrichment-schema.ts";
import { mergeScanAndEnrichment } from "./merge.ts";

export type EnrichDeps = {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  /** Injected so tests skip real backoff; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

const ENRICH_TIMEOUT_MS = 300_000; // 5 min
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 8_000, 20_000];
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Seed the scan findings into the enrichment prompt. */
function enrichVars(scan: RuntimeContext): Record<string, string> {
  return {
    scan_topology: scan.topology.type,
    scan_topology_detail: scan.topology.detail,
    scan_data: scan.data.presence,
    scan_data_detail: scan.data.detail,
    scan_data_migration_tool: scan.data.migrationTool ?? "",
    scan_caching: scan.caching.presence,
    scan_caching_detail: scan.caching.detail,
    scan_observability: scan.observability.presence,
    scan_observability_detail: scan.observability.detail,
    scan_config_secrets: scan.configSecrets.presence,
    scan_config_secrets_detail: scan.configSecrets.detail,
    scan_documentation: scan.documentation.presence,
    scan_documentation_detail: scan.documentation.detail,
    scan_release: scan.releasePackaging.mechanism,
    scan_release_detail: scan.releasePackaging.detail,
  };
}

/** Mandatory setup-time agent enrichment (E1). Bounded retry-then-fail (E2): on exhaustion this
 *  throws, and the caller writes no profile. Scan flags stay ground truth — the merge only lets
 *  the agent enrich detail and resolve `unknown` sections (E5). */
export async function enrichRuntimeContext(
  repoDir: string,
  scan: RuntimeContext,
  deps: EnrichDeps,
): Promise<RuntimeContext> {
  const sleep = deps.sleep ?? realSleep;
  const model = modelForTier(deps.agentConfig, "standard");
  const allowedTools = allowlistFor("setup:enrich");
  const prompt = renderPrompt(setupEnrichTemplate, enrichVars(scan));

  let lastReason = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await deps.runner.run({
      prompt,
      model,
      allowedTools,
      cwd: repoDir,
      timeoutMs: ENRICH_TIMEOUT_MS,
    });
    if (result.completed && !result.timedOut) {
      const parsed = extractSidecar(result.stdout, EnrichmentSchema, { fence: "styre-setup-enrich" });
      if (parsed.ok) return mergeScanAndEnrichment(scan, parsed.value);
      lastReason = `sidecar ${parsed.reason}: ${parsed.detail}`;
    } else {
      lastReason = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? 0);
  }
  throw new Error(
    `enrichRuntimeContext: agent enrichment failed after ${MAX_ATTEMPTS} attempts: ${lastReason}`,
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/setup/enrich.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 7: Full gate + commit**

Run: `bun run lint && bun run typecheck && bun test && bun run build`
Expected: all clean.

```bash
git add src/dispatch/tool-allowlists.ts prompts/setup-enrich.md src/setup/enrich.ts test/setup/enrich.test.ts
git commit -m "feat(setup): enrichRuntimeContext — bounded-retry setup-time agent call

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire enrichment into `runSetup` + the `ANTHROPIC_API_KEY` precondition

**Files:**
- Modify: `src/cli/setup.ts` (`runSetup` async + injected deps; `setupCommand.run` async + precondition + real runner; `credNote`)
- Test: `test/cli/setup.test.ts` (inject `FakeAgentRunner` into every `runSetup` call; precondition behavior)

**Interfaces:**
- Consumes: `enrichRuntimeContext` + `EnrichDeps` (Task 2); `selectAgentRunner` (`src/agent/registry.ts`); `claudeAgentRunner` (`src/agent/providers/claude.ts`); `DEFAULT_AGENT_CONFIG` (`src/config/agent-config.ts`).
- Produces: `runSetup` is now `async` and its args gain `deps: EnrichDeps`; returns `Promise<{ outPath; profile; needsInput }>`. `setupCommand.run` enforces `ANTHROPIC_API_KEY` and constructs the real runner.

- [ ] **Step 1: Write the failing tests**

Add to `test/cli/setup.test.ts` (and see Step 4 for updating the existing calls). Add a shared fake-deps helper at the top of the file, after the imports:

```ts
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import type { EnrichDeps } from "../../src/setup/enrich.ts";

// A no-op enrichment: emits all sections with empty detail and no presence proposals, so the
// merge leaves the deterministic scan unchanged (keeps existing setup assertions valid).
const NOOP_ENRICH = {
  topology: { detail: "" }, data: { detail: "" }, caching: { detail: "" },
  observability: { detail: "" }, configSecrets: { detail: "" },
  documentation: { detail: "" }, releasePackaging: { detail: "" },
};
function fakeDeps(enrichment: unknown = NOOP_ENRICH): EnrichDeps {
  const runner = new FakeAgentRunner(() => ({
    completed: true, exitCode: 0,
    stdout: `\`\`\`styre-setup-enrich\n${JSON.stringify(enrichment)}\n\`\`\``,
    stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
  }));
  return { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: () => Promise.resolve() };
}
```

Then the new behavior tests:

```ts
test("runSetup writes the agent-enriched detail into the profile", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  const enrichment = { ...NOOP_ENRICH, documentation: { detail: "README + docs/ with mkdocs" } };
  const { profile } = await runSetup({ repo, out, deps: fakeDeps(enrichment) });
  expect(profile.runtimeContext.documentation.detail).toBe("README + docs/ with mkdocs");
});

test("runSetup throws and writes no profile when enrichment fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  const failing: EnrichDeps = {
    runner: new FakeAgentRunner(() => ({
      completed: true, exitCode: 0, stdout: "no sidecar", stderr: "",
      timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
    })),
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: () => Promise.resolve(),
  };
  await expect(runSetup({ repo, out, deps: failing })).rejects.toThrow(/failed after 3 attempts/);
  expect(existsSync(out)).toBe(false);
});
```

(`existsSync` is already imported in this file; if not, add it to the `node:fs` import.)

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bun test test/cli/setup.test.ts`
Expected: FAIL — `runSetup` is sync / has no `deps` param.

- [ ] **Step 3: Make `runSetup` async and enrich between probe and merge**

In `src/cli/setup.ts`, update the imports:

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { claudeAgentRunner } from "../agent/providers/claude.ts";
import { selectAgentRunner } from "../agent/registry.ts";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { configDir } from "../config/paths.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import type { EnrichDeps } from "../setup/enrich.ts";
import { enrichRuntimeContext } from "../setup/enrich.ts";
import { mergeRuntimeContext } from "../setup/merge.ts";
import { probeProfile } from "../setup/probe.ts";
```

Replace `runSetup` with the async version:

```ts
/** Probe a repo, enrich its runtime context via the agent, and write the profile JSON. Testable
 *  core (the citty command is a thin wrapper that supplies the real runner + cred precondition). */
export async function runSetup(args: {
  repo: string;
  out?: string;
  checks?: string;
  slug?: string;
  force?: boolean;
  reprobe?: boolean;
  deps: EnrichDeps;
}): Promise<{ outPath: string; profile: Profile; needsInput: string[] }> {
  const repoDir = resolve(args.repo);
  if (!existsSync(repoDir)) throw new Error(`setup: repo path not found: ${repoDir}`);
  if (args.checks !== undefined && !CHECKS.has(args.checks)) {
    throw new Error(`setup: --checks must be github|external|none (got '${args.checks}')`);
  }
  const clean = args.force === true || args.reprobe === true;
  const scanProfile = probeProfile(repoDir, {
    slug: args.slug,
    checksSystem: args.checks as "github" | "external" | "none" | undefined,
  });
  // Layer 1+2: deterministic scan, then mandatory agent enrichment (throws on failure → no write).
  const enriched = await enrichRuntimeContext(repoDir, scanProfile.runtimeContext, args.deps);
  let profile: Profile = { ...scanProfile, runtimeContext: enriched };

  const outPath =
    args.out && args.out.length > 0
      ? resolve(args.out)
      : join(configDir(), profile.slug, "profile.json");
  if (existsSync(outPath) && !clean) {
    // Layer 3: idempotent re-probe — enrich without clobbering operator-resolved runtime context.
    const existing = loadProfile(outPath);
    profile = {
      ...profile,
      runtimeContext: mergeRuntimeContext(existing.runtimeContext, profile.runtimeContext),
    };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`);
  return { outPath, profile, needsInput: unknownRuntimeSections(profile) };
}
```

- [ ] **Step 4: Update the existing `runSetup` calls in the test file**

In `test/cli/setup.test.ts`, every existing `runSetup({...})` call must become `await runSetup({ ..., deps: fakeDeps() })` and its test must be `async`. The existing merge/reprobe tests use `fakeDeps()` (the no-op enrichment), so the deterministic scan they assert on is unchanged. For example the existing preserve-on-re-probe test becomes:

```ts
test("re-running setup preserves an operator-resolved section", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  await runSetup({ repo, out, deps: fakeDeps() });
  const p = JSON.parse(readFileSync(out, "utf8"));
  p.runtimeContext.caching = { presence: "present", detail: "redis (operator)" };
  writeFileSync(out, JSON.stringify(p));
  const { profile } = await runSetup({ repo, out, deps: fakeDeps() });
  expect(profile.runtimeContext.caching.presence).toBe("present");
  expect(profile.runtimeContext.caching.detail).toBe("redis (operator)");
});
```

Apply the same `async` + `await runSetup({..., deps: fakeDeps()})` change to the `--reprobe` test and any other `runSetup` caller in the file. (The `unknownRuntimeSections` unit test does not call `runSetup` and is unchanged.)

- [ ] **Step 5: Add the precondition + real runner to the command wrapper; update `credNote`**

In `src/cli/setup.ts`, make `setupCommand.run` async, enforce the key, and build the real runner:

```ts
  async run({ args }) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("setup: ANTHROPIC_API_KEY is required (runtime-context prose enrichment)");
    }
    const runner = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() });
    const { outPath, profile, needsInput } = await runSetup({
      repo: args.repo,
      out: args.out,
      checks: args.checks,
      slug: args.slug,
      force: args.force,
      reprobe: args.reprobe,
      deps: { runner, agentConfig: DEFAULT_AGENT_CONFIG },
    });
    console.log(`setup: wrote ${outPath}`);
    if (needsInput.length > 0) {
      const lines = needsInput.map((s) => `         - ${s}`).join("\n");
      console.log(
        `setup: NEEDS INPUT — the probe could not determine these runtime-context sections.\n       Edit ${outPath} and set presence/detail (or re-run after adding tooling):\n${lines}`,
      );
    }
    const note = credNote(profile);
    if (note) console.log(`setup: ${note}`);
    console.log(`setup: run with  styre run <ticket> --profile ${outPath}`);
  },
```

Update `credNote` — `ANTHROPIC_API_KEY` is now enforced upfront, so drop it from the note (keep the run-time creds):

```ts
/** Non-fatal note about creds a later `styre run` will need. */
function credNote(profile: Profile): string | null {
  const missing: string[] = [];
  if (profile.checksSystem === "github" && !process.env.GITHUB_TOKEN)
    missing.push("GITHUB_TOKEN (PR/push + checks)");
  if (!process.env.LINEAR_API_KEY) missing.push("LINEAR_API_KEY (ticket ingest + projection)");
  return missing.length > 0 ? `note — not set for \`styre run\`: ${missing.join(", ")}` : null;
}
```

- [ ] **Step 6: Run the setup tests**

Run: `bun test test/cli/setup.test.ts`
Expected: PASS (existing tests updated to `async`+`fakeDeps`, plus the 2 new tests).

- [ ] **Step 7: Full gate + commit**

Run: `bun run lint && bun run typecheck && bun test && bun run build`
Expected: all clean. (If any OTHER test file calls `runSetup`, update it the same way — `grep -rn "runSetup(" test/` to confirm; only `test/cli/setup.test.ts` should.)

```bash
git add src/cli/setup.ts test/cli/setup.test.ts
git commit -m "feat(setup): wire mandatory agent enrichment into runSetup + key precondition

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** §4 architecture (3-layer async pipeline) → Tasks 1 (merge) + 3 (wiring); §5 agent call (tier/tools/timeout/retry/sidecar/prompt) → Task 2; §6 merge semantics → Task 1; §7 auth precondition + failure → Task 3; §8 testing → tests in every task incl. the existing-test ripple (Task 3 Step 4). §3 decisions E1–E5 all mapped. §9 out-of-scope respected (no ProfileSchema/schema.sql change — Task 1 only exports enums + fills existing fields).
- **DI for testability:** `EnrichDeps.sleep` is injected so retry tests don't wait real backoff; the real timer is the default. The `ANTHROPIC_API_KEY` precondition lives in the command wrapper, so `runSetup` stays env-free.
- **Ground-truth invariant:** `mergeScanAndEnrichment` only consults the agent's `presence`/`type`/`mechanism` when the scan value is `unknown` (Task 1 Step 6 + tests in Step 3) — the gate's flags can never be weakened by agent self-report.
- **Type consistency:** `EnrichDeps`, `enrichRuntimeContext(repoDir, scan, deps)`, `mergeScanAndEnrichment(scan, enr)`, `EnrichmentSchema`, the exported enums, and the `styre-setup-enrich` fence are used identically across tasks.
- **No-op enrichment fixture** keeps the existing setup assertions valid once enrichment becomes mandatory (Task 3 Step 1 `NOOP_ENRICH`/`fakeDeps`).
