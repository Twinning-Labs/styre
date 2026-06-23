# Profile Runtime Context — Agent-Prose Enrichment (D4 second half) — Design

**Date:** 2026-06-23
**Branch:** `feat/profile-runtime-context` (same branch/PR as the base feature — PR #28)
**Status:** Approved design, ready for implementation planning
**Completes:** the hybrid probe's agent-prose half (decision **D4**) from
`2026-06-23-profile-runtime-context-design.md`, which was deferred at planning time and is now being built in to ship the full feature.

---

## 1. Problem

The base runtime-context feature ships the **deterministic** half of the hybrid probe (D4): a signal-scan sets each section's presence **flag** (ground truth for the gate) and a terse `detail` string from the matched signals (e.g. `"ioredis, pino"`). The approved design's D4 is a *hybrid* probe — the second half is a setup-time **agent** that writes rich, grounded prose `detail` (e.g. *"Redis for session cache, ~15min TTL, invalidated on logout"*) and resolves sections the scan left `unknown`. Without it, the context reaching the design agent is shallow signal-strings, which undercuts the whole leverage of the feature (rich CDOT context driving better design-stage reasoning). This spec builds that second half.

## 2. Current state (grounding)

- **`AgentRunner.run()`** (`src/agent/runner.ts`) is a single-shot, stateless call: `{ prompt, model, allowedTools, cwd, timeoutMs, onSpawn? } → { completed, exitCode, stdout, stderr, timedOut, costUsd, tokens… }`. No worktree/session/db needed at the runner level.
- The heavy `runAgentDispatch` (`src/dispatch/run-dispatch.ts`) requires a ticket, worktree, db, step journal, commit, and postcondition — **not** used here.
- **Construction:** `selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() })` + `modelForTier(config, tier)` (`src/agent/tiers.ts`, `src/config/agent-config.ts`).
- **Auth:** the runner spawns `claude -p` with `agentEnv(process.env)` (`src/agent/agent-env.ts`) — which scrubs `LINEAR_API_KEY`/`GITHUB_TOKEN` but passes `ANTHROPIC_API_KEY`. So an agent call makes the currently **creds-free** `styre setup` require `ANTHROPIC_API_KEY`.
- **Structured output:** `extractSidecar(stdout, zodSchema, { fence })` (`src/dispatch/sidecar.ts`) → `{ ok, value } | { ok:false, reason:"absent"|"malformed" }`. Reusable.
- **Tools:** `allowlistFor(handlerKey)` (`src/dispatch/tool-allowlists.ts`) is the central capability-isolation chokepoint; `READ_ONLY = ["Read","Grep","Glob"]`.
- **Tests:** `FakeAgentRunner` (`src/agent/fake-runner.ts`) is a drop-in `AgentRunner` returning a canned result — enables hermetic testing with no CLI spawn.
- **Base feature (this branch):** `detectRuntimeContext` (deterministic scan, `src/setup/detect-runtime.ts`), `mergeRuntimeContext` (operator-preserving re-probe, `src/setup/merge.ts`), `runSetup` (`src/cli/setup.ts`).

## 3. Design decisions (approved)

| # | Decision | Choice |
|---|----------|--------|
| E1 | Engagement | **Mandatory.** Setup always runs enrichment; `ANTHROPIC_API_KEY` becomes required for `styre setup` everywhere (incl. CI). The creds-free property is deliberately dropped. |
| E2 | Call-failure behavior | **Retry-then-fail.** Up to 3 attempts with exponential backoff; on exhaustion, `enrichRuntimeContext` throws → `runSetup` writes no profile (existing one untouched on re-probe). No degraded-write path — prose is a hard requirement of a valid profile. |
| E3 | Evidence gathering | **Read-only repo tools, seeded.** The prompt seeds the scan findings; the agent gets `["Read","Grep","Glob"]` scoped to the repo dir to open the flagged files and write grounded prose. No write/Bash/gh/Linear. |
| E4 | Model tier | **`standard` (Sonnet 4.6).** Config-overridable via `modelForTier`. |
| E5 | Merge semantics | **Scan flags are ground truth.** The agent enriches `detail` everywhere and proposes a flag **only** where the scan was `unknown`; it can never override a confident scan flag. |

## 4. Architecture & flow

New module **`src/setup/enrich.ts`**. `detectRuntimeContext` stays pure/sync; enrichment is a separate async step so the agent never pollutes the deterministic path.

`runSetup` becomes **async** and orchestrates a three-layer pipeline:

```
1. detectRuntimeContext(repoDir)              → scan: flags (ground truth) + terse detail   [sync, pure]
2. enrichRuntimeContext(repoDir, scan, deps)  → agent: rich detail + proposed flags          [async, agent]
                                                 where scan was `unknown`
   probed = mergeScanAndEnrichment(scan, enrichment)   ── layers 1+2 ──
3. if existing && !clean: mergeRuntimeContext(existing, probed)   → operator-resolved survives [sync, Task 4]
   → write profile, recompute needsInput
```

**Dependency injection for testability:** `enrichRuntimeContext(repoDir, scanned, deps)` takes `deps = { runner: AgentRunner; agentConfig: AgentConfig }`. `runSetup` gains an injected `deps` param; tests pass a `FakeAgentRunner`, and the citty `setupCommand.run` constructs the real runner via `selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() })`.

**Cred precondition lives in the command wrapper, not the core:** `setupCommand.run` checks `ANTHROPIC_API_KEY` is present (error upfront if missing) and builds the real runner. `runSetup`/`enrichRuntimeContext` take the runner as an injected dependency and do **not** read the env — so the core stays hermetically testable without a key.

## 5. The agent call (`enrichRuntimeContext`)

- **Tools & sandbox:** add `"setup:enrich": [...READ_ONLY]` to `ALLOWLISTS`; call `allowlistFor("setup:enrich")` → `["Read","Grep","Glob"]`. `cwd = repoDir`. No write/Bash/outward tools; `agentEnv` scrubs Linear/GitHub tokens. The agent reads the target repo read-only (no worktree).
- **Model:** `modelForTier(deps.agentConfig, "standard")`.
- **Timeout:** `300_000` ms (5 min).
- **Retry-then-fail (E2):** up to 3 attempts; backoff ~2s/8s/20s between attempts. An attempt **fails** if the result is not `completed`, is `timedOut`, or the sidecar is absent/malformed (transport failure per §3a). After 3 failures, throw `enrichRuntimeContext: agent enrichment failed after 3 attempts: <reason>`.
- **Structured output:** the agent emits a `styre-setup-enrich` fenced block, parsed by `extractSidecar(stdout, EnrichmentSchema, { fence: "styre-setup-enrich" })`:

```ts
const Presence = z.enum(["present", "absent", "unknown"]);
const EnrichmentSchema = z.object({
  topology:         z.object({ type: TopologyEnum.optional(),     detail: z.string().default("") }),
  data:             z.object({ presence: Presence.optional(), migrationTool: z.string().optional(), detail: z.string().default("") }),
  caching:          z.object({ presence: Presence.optional(),      detail: z.string().default("") }),
  observability:    z.object({ presence: Presence.optional(),      detail: z.string().default("") }),
  configSecrets:    z.object({ presence: Presence.optional(),      detail: z.string().default("") }),
  documentation:    z.object({ presence: Presence.optional(),      detail: z.string().default("") }),
  releasePackaging: z.object({ mechanism: ReleaseEnum.optional(),  detail: z.string().default("") }),
});
```
`TopologyEnum`/`ReleaseEnum` reuse the profile's enums. The optional `presence`/`type`/`mechanism` are *proposals* — honored by the merge only where the scan was `unknown`.

- **Prompt:** new `prompts/setup-enrich.md` (text-imported template, `{{var}}` substitution). Seeded with each section's scan result (detected presence + terse detail + signal evidence) via vars. Instructs the agent to: open the flagged files (prisma schema, cache config, tracing init, migration dir, etc.) and write specific grounded prose per section; for any `unknown` section, investigate and propose `present`/`absent` (+ `type`/`mechanism` where relevant) with detail; emit the `styre-setup-enrich` sidecar.

## 6. Merge semantics (`mergeScanAndEnrichment(scan, enrichment): RuntimeContext`)

Pure function. The agent enriches detail and resolves only the genuinely ambiguous sections; scan flags remain ground truth.

| Field | Rule |
|---|---|
| `detail` (all sections) | Agent detail wins when non-empty (`.trim() !== ""`); else keep scan's terse detail. |
| `presence` (data, caching, observability, configSecrets, documentation) | Scan wins when `present`/`absent`. Agent's proposed `presence` honored **only** where scan === `unknown`. Else stays `unknown`. |
| `topology.type` / `releasePackaging.mechanism` | Scan wins unless `unknown`, then agent's proposed `type`/`mechanism`; else `unknown`. |
| `data.migrationTool` | Scan value wins; agent's honored only where scan didn't set one. |

The result is the **"probed"** `runtimeContext` fed to layer-3 `mergeRuntimeContext(existing, probed)` — so operator-resolved values still survive a re-probe (Task 4 unchanged). `--reprobe`/`--force` regenerates scan+agent fully (no layer-3 merge).

**Consequences:** the agent can upgrade `unknown`→`present`/`absent` (reducing operator bubble-up) but never overrides a confident scan flag — so the gate's ground-truth flags are never weakened by agent self-report. A section left `unknown` by both scan and agent still bubbles up.

## 7. Auth, precondition & failure behavior

- **Precondition (E1):** `setupCommand.run` errors immediately if `ANTHROPIC_API_KEY` is unset: `setup: ANTHROPIC_API_KEY is required (prose enrichment)`. `credNote` is updated to list `ANTHROPIC_API_KEY` as required for setup (not just `styre run`).
- **Failure (E2):** on enrichment exhaustion, `runSetup` propagates the throw; the command exits non-zero and **no profile is written** (first run) / the **existing profile is left untouched** (re-probe). The operator re-runs when the API recovers.

## 8. Testing strategy

- **`enrich.ts` unit tests** (`test/setup/enrich.test.ts`, `FakeAgentRunner`):
  - merge rules: agent detail wins over terse; agent `presence` honored only where scan `unknown`; agent cannot override a confident scan flag; `migrationTool`/`topology.type`/`releasePackaging.mechanism` precedence.
  - sidecar absent/malformed → retried then throws after 3 attempts (assert attempt count via the fake runner's recorded `inputs`).
  - a `not completed` / `timedOut` result → retried then throws.
- **`runSetup` async tests** (`test/cli/setup.test.ts`, injected `FakeAgentRunner`):
  - success → profile's `runtimeContext.detail` carries the agent prose; an `unknown` scan section resolved by the agent is reflected; `needsInput` recomputed from the enriched+merged profile.
  - agent failure after retries → `runSetup` rejects; no profile file written (and on re-probe, the existing file is byte-unchanged).
  - re-probe still preserves an operator-resolved section (layer-3 merge intact).
- **Command-wrapper test:** missing `ANTHROPIC_API_KEY` → `setupCommand` path errors before any agent call. (Core `runSetup` is unaffected — it takes the injected runner.)
- **Existing-test ripple:** every current `runSetup`/`probeProfile` test must inject a `FakeAgentRunner` (since enrichment is now mandatory in `runSetup`). `probeProfile`/`detectRuntimeContext` stay sync and agent-free, so their direct tests are unchanged.
- **Full gate:** `bun run lint` + `bun run typecheck` + `bun test` + `bun run build` all clean (lesson from the base branch: implementers must run the full gate per task, not just `bun test`).

## 9. Out of scope (unchanged from base)

- ENG-169 interface-contract types · ENG-176 reviewer-persona enforcement · ENG-177 release-stage generalization · per-ticket `styre_config` (plane-owned).
- The deterministic gate (`validateCdotImpact`) is untouched — it reads scan-ground-truth flags, which this spec never lets the agent override.

## 10. Invariant compliance

- **Capability isolation (move 4):** read-only tools only; no write/Bash/gh/Linear; `agentEnv` scrubs outward creds. The agent reads the target repo read-only; there is no writable surface.
- **Ground truth over self-report:** scan flags (deterministic) remain the gate's input; the agent's proposed flags are honored only where the scan had no ground truth (`unknown`), never over a confident scan result.
- **Structured output via validated zod (§3a):** the agent's output goes through `extractSidecar` + `EnrichmentSchema`; an absent/malformed sidecar is a transport failure (retry), not a parsed decision.
- **Open-core seam:** no `ProfileSchema` change — enrichment only fills existing `detail`/`presence` fields. `styre setup`'s cred contract changes (now needs `ANTHROPIC_API_KEY`) — a documented behavior change, recorded here and in the base feature's deferral note.
- **No SQLite schema change.**
