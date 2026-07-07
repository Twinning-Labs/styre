# Codex Provider Adapter — Design

> Add OpenAI's `codex` CLI as a second agent provider behind the existing `AgentRunner`
> boundary. This is the first real exercise of the provider-agnostic seam
> (`docs/brainstorms/2026-06-21-provider-agnostic-agent-design.md`, DEC-AG-1..5). It proves the
> claim "another AI agent drops in with zero core changes" — and, where that claim was aspirational
> rather than wired, closes the gap. Status: **proposed** 2026-07-07.

---

## 1. Why

The provider-agnostic design (DEC-AG-1..5) declared the core must not assume Claude and that a
second provider is "a sibling file under `providers/` + config, zero core changes." Codex is the
test of that claim. Digging in shows the seam itself is sound — `AgentRunner`, abstract tiers,
`selectAgentRunner`, the `AGENTS.md` instruction file, and the fenced-sidecar structured-output
convention are all genuinely provider-neutral — but three things the design *assumed* were wired
turn out to be dead or Claude-shaped:

1. **Provider selection is designed but never wired.** All four entrypoints hardcode
   `selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() })`
   (`cli/run.ts:111`, `cli/park.ts:272`, `cli/setup.ts:225`, `scripts/smoke-agent.ts:19`).
   `config.provider` is never read from workspace config. "No `claude` on this host" is *not*
   currently a valid configuration, contradicting DEC-AG-1.
2. **The `stdout` contract is undefined**, and the Claude adapter quietly violates the one the
   consumers assume. `extractSidecar` (`dispatch/sidecar.ts:16`) regexes a literal fenced block out
   of `result.stdout`, but the Claude adapter returns the raw `--output-format json` **envelope**,
   in which the fence's newlines are JSON-escaped — the `FakeAgentRunner` masks this because it
   returns plain text. Codex forces the contract to be stated.
3. **Two capability touchpoints are Claude-key-shaped:** the `ANTHROPIC_API_KEY is required` setup
   gate (`cli/setup.ts:222`) and the `verifyEnv` denylist that strips only `ANTHROPIC_API_KEY`
   (`agent/agent-env.ts:8`). Under Codex the first wrongly rejects a valid host and the second
   leaves the agent's API key readable by agent-authored verify code (an F4 capability-isolation
   hole).

This design adds the Codex adapter **and** closes these three gaps, because Codex cannot run
without them. Claude remains the bundled binary default; Codex is an opt-in preset.

## 2. Decisions

- **DEC-CX-1 — Codex is a sibling adapter, not a fork of the core.** New
  `src/agent/providers/codex.ts` implements `AgentRunner`, mirroring `claude.ts`: a pure
  `buildCodexArgs`, a JSONL usage/final-message parser, and a `classifyCodexFailure` that is the
  *only* place that knows Codex's error markers. The core imports it only through the adapter map.

- **DEC-CX-2 — `codex exec`, non-interactive, sandbox-enforced.** Argv shape is ground-truth from a
  real `codex` self-review (2026-07-07): **`--ask-for-approval` and `--search` are GLOBAL flags that
  MUST precede the `exec` subcommand** — the installed CLI rejects `codex exec --ask-for-approval …`.
  So the adapter emits:
  - **global (before `exec`):** `--ask-for-approval never` (a headless dispatch must NEVER block on
    approval); `--search` **only** when the allowlist carries WebSearch/WebFetch (enables the native
    web-search tool — `network_access` alone does not);
  - **subcommand + flags:** `exec`, then `--json` (JSONL usage stream) + `-o <tmpfile>`
    (`--output-last-message`, the final message — source for `stdout`, DEC-CX-4); `--model <id>`
    (tier→model, DEC-AG-3); `--cd <cwd>`; `--sandbox <mode>` (DEC-CX-3); `--skip-git-repo-check`;
    **`--ephemeral`** (no Codex session persistence — Styre's SQLite journal + transcript dump are the
    durable record; avoids `.codex` churn); **`--ignore-user-config` + `--ignore-rules`** (Styre owns
    the run contract — local Codex config/execpolicy must not alter runner behavior; target-repo
    `AGENTS.md` handling stays a separate deliberate choice); trailing `-` (prompt on stdin).
  `danger-full-access` and the deprecated `--full-auto` are never used.

- **DEC-CX-3 — Translate `allowedTools` → sandbox in the adapter; the core interface is unchanged
  (chosen: adapter-translate).** `AgentRunInput.allowedTools: string[]` stays the neutral currency.
  The Codex adapter maps it:
  - allowlist ⊆ `{Read, Grep, Glob}` (no write/exec token) → `--sandbox read-only`;
  - allowlist contains any of `Write`, `Edit`, `Bash`/`Bash(…)` → `--sandbox workspace-write`
    (write surface = the worktree `cwd`).

  **Network parity (from independent review + Codex self-review).** Codex's `workspace-write` sandbox
  disables network by **default**, but `design:dispatch`'s allowlist carries `WebSearch`/`WebFetch`
  (`tool-allowlists.ts:10`) — a design agent is meant to browse. Restoring web takes **two** flags,
  not one: the global `--search` enables the native web-search tool, **and**
  `-c sandbox_workspace_write.network_access=true` restores raw network (the config override alone
  does not turn on the search tool). Both are emitted only when the allowlist contains
  `WebSearch`/`WebFetch`; otherwise network + search stay off (implement/docs get no web, matching
  Claude, whose allowlists omit the web tools). This keeps capability parity for the one dispatch
  that needs the web, instead of silently losing it.

  **Accepted fidelity loss (explicit, operator-signed-off 2026-07-07):** Claude scopes Bash to
  specific runners (`Bash(pytest:*)`) and *drops Bash entirely* when a unit resolves no runners
  (`tool-allowlists.ts:37`). Codex `workspace-write` cannot express per-command scoping — an
  `implement` dispatch under Codex may run any command inside the sandbox. This is a **coarser
  command boundary but a stronger filesystem boundary** (OS-level Seatbelt/Bubblewrap confine
  writes to the workspace regardless of what the agent runs). The real defense for the broad
  command/secret surface was always environment isolation (Docker), per the M-A residual-risks — the
  Bash allowlist was defense-in-depth, not the primary control. We accept the trade for the minimal
  port and record enriching the interface to a neutral `{readOnly, writeScope, runners[]}`
  capability descriptor as a **named, non-silent follow-up** (DEC-CX-8), not a drop.

- **DEC-CX-4 — Pin the `stdout` contract; retrofit the Claude adapter (chosen: pin + retrofit
  both).** Define: **`AgentRunResult.stdout` is the agent's final assistant message as
  human-readable text (unescaped, real newlines). Token/cost accounting lives only in the typed
  fields, never in `stdout`.** This is exactly what `extractSidecar` already assumes. The Codex
  adapter satisfies it cleanly: with `--json` the JSONL event stream (carrying the `turn.completed`
  usage event) is parsed for token accounting, and `AgentRunResult.stdout` is set to the contents of
  the `--output-last-message` file (the final assistant message, verbatim) — so the accounting
  stream and the message text never intermix. The Claude adapter is **retrofitted** to extract the
  envelope's `result` field into `stdout` (the usage parse keeps reading the **raw** envelope, not
  the unwrapped text), fixing the latent fenced-block escaping bug the fake-runner hid. Retrofit
  caution: if `result` is absent/non-string (e.g. an error envelope), fall back to the raw stdout —
  never emit the literal string `"undefined"`. Both providers now honor one contract, and every
  `extractSidecar` consumer (extract/review/complexity/discover/enrich) becomes provider-independent
  by construction.

- **DEC-CX-5 — Wire config-driven selection through the config file that exists today (chosen: full
  config selection, scoped to the current loader).** The four call sites stop hardcoding
  `DEFAULT_AGENT_CONFIG` + a single-entry map. Introduce one shared helper
  `resolveAgentRunner(agentConfig)` that (a) builds the **full built-in adapter map**
  `{ claude: () => claudeAgentRunner(cfg.command), codex: () => codexAgentRunner(cfg.command) }`
  and (b) calls `selectAgentRunner(agentConfig, map)`. **Scope correction (from independent
  review):** the ticket > workspace > profile > default *precedence merge* does **not** exist yet —
  `runtime-config.ts:3-7` explicitly defers that loader to the startup-entrypoint milestone, and
  `agentConfig` is currently a field of neither `RuntimeConfigSchema` nor the profile (it lives only
  as `DEFAULT_AGENT_CONFIG`). So DEC-CX-5 wires selection through the **single-file loader that
  exists today**: add an optional `agent: AgentConfigSchema` field to the runtime `config.json`
  (parsed by the same `--config` path `run.ts:64-67` already uses); present → use it, absent →
  `DEFAULT_AGENT_CONFIG` (Claude preset). This makes "no claude present, codex configured" a valid,
  tested configuration **now**, without inventing the precedence engine. Folding `agentConfig` into
  the full ticket>workspace>profile precedence merge is deferred to that milestone as a named
  follow-up (DEC-CX-8d), not silently assumed here. An unregistered `provider` remains the clear
  setup error `selectAgentRunner` already throws (a GOAL-INSTALL touchpoint).

- **DEC-CX-6 — Provider-parametric capability gates.** The setup credential gate stops naming
  Anthropic: it requires the *configured provider's* key (`ANTHROPIC_API_KEY` for `claude`,
  `OPENAI_API_KEY` for `codex`) — a small per-provider `requiredEnv` on the adapter/preset, checked
  against `process.env`. **Security:** `VERIFY_ENV_DENYLIST` strips the **union** of all known
  provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, plus Codex's `CODEX_API_KEY` /
  `CODEX_ACCESS_TOKEN`), so agent-authored verify code cannot read whichever key is present — the F4
  invariant now holds for every provider, not just Claude. `agentEnv` continues to pass provider
  keys through (the agent CLI needs them to authenticate); it already strips only Linear/GitHub, so
  `OPENAI_API_KEY` flows to the Codex CLI unchanged.

- **DEC-CX-7 — Codex preset; Claude stays the binary default.** Add a Codex preset to config
  (`{ provider: "codex", command: "codex", models: { deep, standard, cheap } }`). The concrete
  model ids are **operator-set config, not core constants** (DEC-AG-3) — the binary ships the Claude
  preset as `DEFAULT_AGENT_CONFIG` and documents the Codex preset as a drop-in. Codex reports token
  usage (`turn.completed.usage`: `input_tokens`/`output_tokens`/`cached_input_tokens`→`cacheRead`)
  but **no USD cost** → `costUsd: null`; the interface already tolerates null (`runner.ts:20`), the
  per-dispatch `cost_usd` is nullable (`events.ts:45`), and the summary `sum()` coerces null→0
  (`emitter.ts:82`) — so a null Codex cost breaks no telemetry.

- **DEC-CX-8 — Named follow-ups (not silent deferrals).** (a) The neutral capability descriptor of
  DEC-CX-3. (b) Codex's native `--output-schema` could enforce the zod schema on the final message
  for sidecar steps (a reliability win over the fenced-block convention) — deferred; the fenced
  sidecar keeps working for both providers. (c) The doc/impl mismatch at `control-loop.md:147`
  ("Anthropic-SDK forced-schema tool calls") should be corrected to describe fenced-sidecar parsing;
  Codex's `--output-schema` is the closest realization of the doc's original intent. (d) Fold
  `agentConfig` into the full ticket > workspace > profile > default precedence merge once the
  startup-entrypoint milestone builds that loader (`runtime-config.ts:3-7`); DEC-CX-5 ships
  single-file loading until then.

- **DEC-CX-9 — Repo hygiene: ignore local agent/worktree artifacts.** `.gitignore` gains
  `.claude/worktrees/` (transient in-repo worktrees), `.codex/` (Codex's local session/config dir,
  the analogue of `.claude/`), and `AGENTS.md`. Rationale: running either agent against the Styre
  repo itself drops local state that must never be committed. **Note on `AGENTS.md`:** Styre reads a
  *target* repo's committed root `AGENTS.md` as authoritative onboarding (`setup/agents-md.ts`);
  ignoring it here only means Styre's *own* repo does not track one — dev instructions stay in
  `CLAUDE.md`. No tracked file is untouched (none exists today), so this is purely preventive.

## 3. Architecture

```
src/agent/
  runner.ts                 # UNCHANGED interface; DEC-CX-4 stdout contract documented on it
  tiers.ts                  # UNCHANGED — deep|standard|cheap
  registry.ts               # UNCHANGED — selectAgentRunner(config, adapters)
  resolve.ts                # NEW — resolveAgentRunner(agentConfig): builds the full built-in map + selects (DEC-CX-5)
  agent-env.ts              # CHANGED — verifyEnv strips the union of provider keys (DEC-CX-6)
  providers/
    claude.ts               # CHANGED — stdout = envelope.result (DEC-CX-4 retrofit); + requiredEnv
    codex.ts                # NEW — the Codex adapter (DEC-CX-1/2/3); + requiredEnv
src/config/
  agent-config.ts           # CHANGED — add CODEX_PRESET; DEFAULT_AGENT_CONFIG unchanged (Claude)
src/cli/{run,park,setup}.ts # CHANGED — call resolveAgentRunner(loadedAgentConfig); drop hardcoded map
scripts/smoke-agent.ts      # CHANGED — same; add a codex smoke path
.gitignore                  # CHANGED — .claude/worktrees/, .codex/, AGENTS.md (DEC-CX-9)
```

**Data flow (unchanged shape; provider swapped behind the boundary):**

```
handler → runAgentDispatch → renderPrompt → ensureWorktree
        → runner.run({ prompt, model, allowedTools, cwd, timeoutMs })     ← resolveAgentRunner picked codex
            codex adapter: buildCodexArgs (allowedTools→--sandbox[+network]) → spawn `codex exec -`
                         → parse JSONL(stdout) for usage + read --output-last-message file → stdout field = final text
        → commitWorktree → completeDispatch → postcondition
        → (sidecar steps) extractSidecar(result.stdout, schema)           ← now provider-independent
```

The core control loop (resolver, event loop, step journal, signals, failure-policy, projector,
repos, tool-allowlists, profile, render-prompt, worktree, dispatch repo) is **untouched**. Only the
agent boundary, its two capability touchpoints, and the four wiring sites change.

## 4. Failure classification (the park/loop contract)

`classifyCodexFailure(stderr, stdout, exitCode)` maps Codex outcomes to the neutral
`FailureCause = session-limit | out-of-credits | transient` (`runner.ts:3`) that the core already
routes on — the core never sees a Codex string:

- **`session-limit`** — Codex rate-limit / usage-limit exhaustion (429-class, `turn.failed` /
  `error` events carrying rate/usage-limit text; capture any human reset hint into `resetAt`). Same
  park behavior as Claude: `run-dispatch.ts` records `parked`, throws `ParkSignal`, exit 75.
- **`out-of-credits`** — Codex billing/quota-exhausted / insufficient-balance text.
- **`transient`** — everything else (network, auth misconfig, unknown non-zero exit, timeout). A
  timeout still carries no marker → transient (unchanged), and the SIGKILL-on-timeout hard progress
  bound is copied verbatim from `claude.ts` (it is already provider-neutral).

The exact marker strings are pinned by the Codex adapter's unit tests + a gated manual smoke, never
in core logic — identical containment to `claude.ts:classifyFailure` and its
`classify-failure.test.ts`.

## 5. Error handling & edge cases

- **Missing `codex` binary / wrong provider** → `selectAgentRunner` throws the existing clear setup
  error (GOAL-INSTALL). No silent fallback to Claude.
- **Missing `OPENAI_API_KEY`** (codex selected) → the provider-parametric setup gate (DEC-CX-6)
  fails fast with a provider-named message.
- **Interactive approval attempt** → prevented by `--ask-for-approval never`; if Codex ever blocks
  anyway, the timeout SIGKILL bound resolves it as `transient` (re-dispatch), never a hang.
- **`--output-last-message` tmpfile** written under the run's temp dir, read once, unlinked; if it's
  absent/empty (Codex crashed before a final message) → treat as transport failure (`completed:
  false`, `transient`), never a false empty verdict — consistent with §3a "absent payload is a
  transport failure, not a no."
- **JSONL parse resilience** — usage parsing is best-effort/forensic (like `parseClaudeJson`): a
  malformed/absent `turn.completed` yields null token fields, never throws; it must not gate
  completion (completion is decided by exit code + a non-empty final message).

## 6. Testing

Mirrors DEC-AG §5 (CI never invokes a real agent CLI):

- **`codex.test.ts`** — pure `buildCodexArgs` (asserts `exec`, `--sandbox` translation for read-only
  vs write allowlists, `--ask-for-approval never`, `--model`, `--cd`), and the JSONL/final-message
  parser against captured fixtures.
- **`classify-codex-failure.test.ts`** — the marker→cause table (session-limit / out-of-credits /
  transient), sibling to the Claude one.
- **`resolve.test.ts`** — `resolveAgentRunner` selects claude vs codex by config; unknown provider
  throws; "no claude present" config resolves codex.
- **`agent-env.test.ts`** — `verifyEnv` strips the union of provider keys; `agentEnv` passes
  `OPENAI_API_KEY` through and still strips Linear/GitHub.
- **stdout-contract regression** — `extractSidecar` succeeds against a Claude-envelope fixture
  *after* the retrofit (would fail before), proving DEC-CX-4.
- **FakeAgentRunner** continues to cover the whole dispatch path offline, now honoring the pinned
  stdout contract.
- **Manual gated smoke** (`scripts/smoke-agent.ts`, `--provider codex`) — the only place a real
  `codex exec` runs; confirms the exact flags, JSONL shape, and final-message capture, exactly as
  Task 7 did for Claude.

## 7. What is explicitly NOT changing

The substrate invariants (single-writer SoT, one-way projector, exactly-once journal, ground-truth
verdicts, loop-not-halt, CL-COMMIT, CL-PROFILE, §3a) are provider-neutral and untouched — Codex is
selected behind the same boundary and produces the same worktree commits the runner persists. The
tool-allowlist *table* is unchanged (only its translation to a provider flag differs, and that lives
in the adapter). Prompts and `AGENTS.md` injection are already vendor-neutral; Codex reads
`AGENTS.md` natively, so no instruction-file change is needed.

## 8. Migration / sequencing

1. Document the `stdout` contract on `AgentRunResult` + retrofit `claude.ts` (DEC-CX-4) — smallest,
   unblocks provider-independence and fixes a latent bug; guard with the stdout-contract regression.
2. `verifyEnv` union + provider-parametric setup gate (DEC-CX-6) — security-relevant, isolated.
3. `resolve.ts` + rewire the four call sites to config-driven selection (DEC-CX-5), Claude still
   default → behavior-preserving refactor, fully covered by existing tests.
4. `codex.ts` + `classifyCodexFailure` + Codex preset (DEC-CX-1/2/3/7) — the new provider.
5. `.gitignore` hygiene (DEC-CX-9) — trivial, land with any step.
6. Tests (§6) alongside each step; manual codex smoke last.
7. Docs: this doc; a `docs/architecture/brainstorm.md §11` changelog pointer (append-only, never
   rewrite history); correct `control-loop.md:147` (DEC-CX-8c). The frozen substrate docs are not
   rewritten.

Steps 1–3 are worth doing on their own merits (they pay down the "designed-but-unwired" debt and fix
a latent bug); step 4 is the provider itself. Per repo workflow: a `feat/` branch, PR into `main`,
operator merges — no auto-merge.

## 9. Independent review (2026-07-07)

A fresh, code-grounded adversarial review verified every `file:line` claim and attacked each
decision. Outcome: the three headline claims (unwired provider selection, the latent sidecar/envelope
bug, the two Claude-key-shaped capability touchpoints) and DEC-CX-4/6/7 all **confirmed against the
code**. Two corrections were folded back in:

- **DEC-CX-5 rescoped (was HIGH):** the ticket>workspace>profile precedence loader does not exist
  (`runtime-config.ts:3-7` defers it; `agentConfig` is not yet a config field). Now ships single-file
  loading via the existing `--config` path; full precedence → DEC-CX-8d.
- **DEC-CX-3 network parity (was MEDIUM):** Codex `workspace-write` disables network by default,
  which would silently strip web access from `design:dispatch`; the adapter now restores it via
  `-c sandbox_workspace_write.network_access=true` when the allowlist carries `WebSearch`/`WebFetch`.

Plus low-severity fixes: data-flow diagram stream label (JSONL is on stdout, not stderr), a retrofit
fallback for an absent `envelope.result`, and telemetry-null-cost confirmation. No un-inventoried
Claude assumptions were found in `src/`.

**Codex self-review (2026-07-07).** The real `codex` CLI reviewed both docs and caught one **blocking
command-primitive bug**: `--ask-for-approval` (and `--search`) are **global** flags — `codex exec
--ask-for-approval never …` is rejected; the working form is `codex --ask-for-approval never exec …`.
Folded into DEC-CX-2 (argv is now global-flags-before-`exec`). Also adopted as improvements:
`--search` is required (not just `network_access`) to enable the web-search tool (DEC-CX-3);
`--ephemeral` + `--ignore-user-config` + `--ignore-rules` so Styre owns the run contract; temp-**dir**
cleanup (not just the message file); preserve the real `exitCode` on a clean-exit-but-empty dispatch;
and a tightened quota regex so "insufficient permissions" is not misclassified as out-of-credits. All
are localized to `codex.ts` and reflected in the plan's Task 3 tests.
