# Provider-Agnostic Agent Boundary — Design

> The core must not assume Claude. The agent is a **configured provider behind a generic
> `AgentRunner`**, swappable with zero core changes. This supersedes the Claude-specific
> dispatch references in the frozen substrate docs (`minimal-loop §3`, `build-operations §4`,
> `control-loop §4`). Status: approved 2026-06-21.

---

## 1. Why

The first cut of the dispatch layer welded the **core** to one vendor: a `ClaudeRunner` boundary,
`src/dispatch/models.ts` hardcoding `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5`,
and `claude` as an unconditional host dependency. That contradicts the open-core ethos — the OSS
core is meant to be a clean, generic substrate, not a Claude wrapper. Another AI agent must be able
to take Claude's place, and "no `claude` on this host" must be a valid configuration.

## 2. Decisions

- **DEC-AG-1 — Generic boundary, config-selected provider.** The core control flow depends only on
  an `AgentRunner` interface. Providers are **adapters** chosen at runtime from config
  (`agent.provider`); the core never imports or assumes a specific provider. A **Claude adapter
  ships in-core as one built-in provider preset** (out-of-box usability), but it is selected by
  config, not assumed. `claude` is a host dep **only when the Claude provider is configured**.
  Swapping agents = a different adapter + config, **zero core changes**.
- **DEC-AG-2 — Abstract tiers.** Steps map to a provider-neutral tier: `deep | standard | cheap`
  (`resolveTier(handlerKey)`, replacing the hardcoded `resolveModel`). Mapping: **deep** = design +
  review (hardest reasoning), **standard** = implement (coding), **cheap** = extract/docs/pr-ensure
  (mechanical). The loopback escalation (control-loop §8 P4) becomes **standard → deep**.
- **DEC-AG-3 — Models in config, Claude preset as the default.** `AgentConfig =
  { provider: string; command?: string; models: { deep; standard; cheap } }`. A step's model id =
  `agentConfig.models[resolveTier(handlerKey)]`. Agent config lives in workspace `config.json` per
  the existing 4-tier precedence (ticket > workspace > profile > defaults — "models" belong to
  workspace config, build-operations §4). The **binary default** is the Claude preset:
  `{ provider: "claude", command: "claude", models: { deep: "claude-opus-4-8",
  standard: "claude-sonnet-4-6", cheap: "claude-haiku-4-5-20251001" } }`.
- **DEC-AG-4 — Retire `src/dispatch/models.ts`.** Replaced by `src/agent/tiers.ts` (`resolveTier`,
  `Tier`) + config-driven model lookup; the hardcoded model ids become the Claude-preset default in
  config (not in core logic). Everything else in M3a is already provider-neutral and stays:
  `tool-allowlists` (generic tool NAMES — the adapter translates them to the provider's flag, e.g.
  Claude's `--allowedTools`), the `dispatch` repo, `profile`, `render-prompt`, `sidecar`, `worktree`.
- **DEC-AG-5 — The substrate invariants are unchanged.** §3a (validated interface), CL-COMMIT
  (daemon commits), capability isolation (move 4), CL-PROFILE, exactly-once/replay — all are
  provider-neutral and unaffected. Only the *model ids* and the *CLI invocation* were vendor-specific;
  those move behind the adapter + config. The frozen docs' `claude -p` / Opus-Sonnet-Haiku mentions
  are superseded by this design (recorded in `brainstorm.md §11` + pointer notes in the docs).

## 3. Architecture

```
src/agent/
  runner.ts            # AgentRunner interface + AgentRunInput/AgentRunResult (provider-neutral)
  tiers.ts             # type Tier = "deep"|"standard"|"cheap"; resolveTier(handlerKey)
  registry.ts          # selectAgentRunner(config): AgentRunner  (picks the adapter by provider)
  fake-runner.ts       # FakeAgentRunner (scripts agent behavior for offline tests)
  providers/
    claude.ts          # the Claude adapter: spawn `<command> -p …`, claude-style args + json parse
src/config/
  agent-config.ts      # AgentConfig (zod) + the default Claude preset
```

- `interface AgentRunner { run(input: AgentRunInput): Promise<AgentRunResult> }`.
  `AgentRunInput { prompt; model; allowedTools: string[]; cwd; timeoutMs; onSpawn?(pid) }`.
  `AgentRunResult { completed; exitCode; stdout; stderr; timedOut; costUsd; tokensIn; tokensOut }`.
- `selectAgentRunner(config)` maps `config.agent.provider` → a registered adapter; unknown provider
  or a missing host command → a clear **setup error** (a GOAL-INSTALL touchpoint). The daemon wires
  the selected runner once and injects it into the dispatch step; tests inject `FakeAgentRunner`.
- The Claude adapter is the **only** place that knows `claude`'s flags (`-p`, `--allowedTools`,
  `--output-format json`) and output shape. A second provider is a sibling file under `providers/`.

## 4. What is NOT changing

The resolver, event loop, step journal, signals, failure-policy, all repos, and the M3a dispatch
infra (allowlists, profile, render-prompt, sidecar, worktree, dispatch repo) are provider-neutral
and unchanged. This design touches only: (a) the new `src/agent/` boundary, (b) `src/config/agent-config.ts`,
(c) the removal of `src/dispatch/models.ts`, and (d) the M3b dispatch wiring built on the boundary.

## 5. Testing

- `AgentRunner` has a `FakeAgentRunner` → the whole dispatch path is tested offline (fake runner +
  real git + real DB); CI never invokes a real agent CLI.
- `resolveTier`, `AgentConfig` (zod), and `selectAgentRunner` are pure/unit-tested.
- Each provider adapter (Claude first) is exercised only by a manual smoke (gated, not CI), which
  also confirms the provider's exact CLI flags + output shape.

## 6. Migration / sequencing

- `src/dispatch/models.ts` (merged in M3a) is removed; its only consumer is the dispatch step (M3b,
  not yet built), so removal is clean.
- **M3b is rewritten** as "provider-agnostic real dispatch": its early tasks build the `src/agent/`
  boundary + `AgentConfig` + the Claude adapter (replacing the planned `ClaudeRunner` and retiring
  `models.ts`); the dispatch wiring, handlers, e2e, and smoke follow on top.
- Docs: this design doc + a `brainstorm.md §11` changelog entry + one-line pointer notes in
  `build-operations §4`, `minimal-loop §3`, `control-loop §4`. The frozen docs are not rewritten.
