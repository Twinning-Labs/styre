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

- **DEC-CX-2 — `codex exec`, non-interactive, sandbox-enforced.** The adapter spawns
  `codex exec` with:
  - the prompt on **stdin** (`codex exec -` — reuses the existing stdin path; no argv-length limit,
    no shell-quoting surface);
  - `--model <id>` (tier→model from config, DEC-AG-3);
  - `--cd <cwd>` (explicit working dir, not just the spawn cwd);
  - `--sandbox <mode>` translated from the tool allowlist (DEC-CX-3);
  - `--ask-for-approval never` (a headless dispatch must NEVER block on an approval prompt);
  - `--json` (JSONL event stream) **and** `--output-last-message <tmpfile>` (the final assistant
    message, written verbatim — the source for `stdout`, DEC-CX-4);
  - `--skip-git-repo-check` (defensive; the worktree is a repo, but in-place / edge setups may not
    look like one to Codex).
  `danger-full-access` and the deprecated `--full-auto` are never used.

- **DEC-CX-3 — Translate `allowedTools` → sandbox in the adapter; the core interface is unchanged
  (chosen: adapter-translate).** `AgentRunInput.allowedTools: string[]` stays the neutral currency.
  The Codex adapter maps it:
  - allowlist ⊆ `{Read, Grep, Glob}` (no write/exec token) → `--sandbox read-only`;
  - allowlist contains any of `Write`, `Edit`, `Bash`/`Bash(…)` → `--sandbox workspace-write`
    (write surface = the worktree `cwd`).

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
  envelope's `result` field into `stdout`
  (keeping the usage parse), fixing the latent fenced-block escaping bug the fake-runner hid. Both
  providers now honor one contract, and every `extractSidecar` consumer
  (extract/review/complexity/discover/enrich) becomes provider-independent by construction.

- **DEC-CX-5 — Wire config-driven selection end-to-end (chosen: full config selection).** The four
  call sites stop hardcoding `DEFAULT_AGENT_CONFIG` + a single-entry map. Introduce one shared
  helper `resolveAgentRunner(agentConfig)` that (a) builds the **full built-in adapter map**
  `{ claude: () => claudeAgentRunner(cfg.command), codex: () => codexAgentRunner(cfg.command) }`
  and (b) calls `selectAgentRunner(agentConfig, map)`. `agentConfig` is loaded from workspace
  `config.json` under the existing precedence (ticket > workspace > profile > binary default);
  absent → `DEFAULT_AGENT_CONFIG` (Claude preset) as today. An unregistered `provider` remains the
  clear setup error `selectAgentRunner` already throws (a GOAL-INSTALL touchpoint). Result: "no
  claude present, codex configured" is a valid, tested configuration.

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
  but **no USD cost** → `costUsd: null`; the interface already tolerates null (`runner.ts:22`).

- **DEC-CX-8 — Named follow-ups (not silent deferrals).** (a) The neutral capability descriptor of
  DEC-CX-3. (b) Codex's native `--output-schema` could enforce the zod schema on the final message
  for sidecar steps (a reliability win over the fenced-block convention) — deferred; the fenced
  sidecar keeps working for both providers. (c) The doc/impl mismatch at `control-loop.md:147`
  ("Anthropic-SDK forced-schema tool calls") should be corrected to describe fenced-sidecar parsing;
  Codex's `--output-schema` is the closest realization of the doc's original intent.

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
            codex adapter: buildCodexArgs (allowedTools→--sandbox) → spawn `codex exec -`
                         → drain JSONL(stderr) for usage + read --output-last-message → stdout=final text
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
