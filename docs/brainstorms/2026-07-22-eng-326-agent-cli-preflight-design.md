# ENG-326 — Agent-CLI preflight probe: fail fast when `claude`/`codex` is missing or too old

**Status:** design agreed (2026-07-22).
**Ticket:** ENG-326 · **Branch:** `rajatgoyal/eng-326-agent-cli-preflight-probe-fail-fast-with-version-guard-when`
**Related:** ENG-332 (`run: preflight the component toolchain before any spend`), ENG-331 (run resilience — dump + resume).

---

## 1. Problem

Styre never calls the Anthropic/OpenAI API directly. Every agent run shells out to the provider CLI —
`Bun.spawn([command, …])` in `src/agent/providers/claude.ts:106` and `codex.ts:155`, prompt on stdin.
That architecture is correct and stays (the CLI *is* the agentic harness; the `AgentRunner` +
CLI-adapter seam is what keeps the core provider-neutral). But it makes an installed, version-compatible
CLI a **hard runtime dependency**, and today that dependency fails **silently and misleadingly**:

- **No probe that the agent binary exists.** `probeCommandExists` (`src/setup/discover-schema.ts:55`)
  checks only the *repo's* build/test commands; the setup gate (`src/cli/setup.ts:260-266`) checks only
  the env key (`requiredEnvFor → ANTHROPIC_API_KEY` in `src/config/agent-config.ts:51`), never the binary.
- **A missing CLI is indistinguishable from a flaky dispatch.** If `claude` is not on `PATH`, `Bun.spawn`
  throws → caught at `claude.ts:152` → returned as `transportFailure(…, false)` with `cause: "transient"`
  (`claude.ts:90-103`). `transient` is the *retryable* signal, so the failure policy
  (`src/daemon/failure-policy.ts`, `DEFAULT_MAX_ATTEMPTS = 3` at :25, escalate at :70) re-dispatches it up
  to **3 times per step**, then escalates the ticket to `waiting` — never once telling the operator the CLI
  isn't installed.
- **The CLI flag surface is version-coupled and unguarded** — the adapters admit it twice
  (`claude.ts:8`, `codex.ts:22-28`: "Flag names are CLI-version-specific"). A CLI upgrade that renames a
  flag is an out-of-band breakage with no diagnostic.

**Net:** convert "burns 3 retries then dies cryptically" into "you're missing `claude` (or it's below the
supported version) — install/upgrade to ≥ vX."

## 2. Scope (from the ticket)

**IN** — a reusable preflight probe (binary on `PATH` + `--version` parses into a supported range); wired
into `styre setup` and `styre run` start with a distinct non-retry exit; a per-provider supported-version
constant as single source of truth; distinguish missing / unauthenticated (best-effort) / out-of-range.

**OUT** — reimplementing the loop against a provider SDK (rejected; the CLI dependency is inherent and
correct); auto-install/upgrade; the subscription-vs-API-key auth-mode question; deep auth validation.

## 3. Decisions

These four calls were made during brainstorming (2026-07-22) and shape the whole design.

### 3.1 Version guard: floor-only, **fail-open** on unparseable

The guard asserts a **minimum** version per provider — not a range. There is no ceiling. Rationale: a
ceiling would need bumping on every routine CLI release and reproduces the exact version-coupling
brittleness this ticket is reacting to. Behaviour:

| condition | result |
| -- | -- |
| binary missing | **hard fail** (exit 69) |
| `--version` parses, below floor | **hard fail** (exit 69) |
| `--version` parses, at/above floor | pass |
| newer than anything known | pass |
| `--version` output unparseable | **warn, proceed** (fail-open) |

Fail-open on unparse is deliberate: the binary *is* present, so the primary failure (missing CLI) is not
in play; blocking a working setup because a future `--version` format changed would re-introduce the
brittleness. The version floor is an advisory guard, not a gate of last resort.

### 3.2 Version floors: detected-installed, pinned per provider

Sourced from the CLIs actually installed on the maintainer's machine on 2026-07-22 (`claude 2.1.216`,
`codex-cli 0.144.6`), pinned just under each:

- `CLAUDE_MIN_CLI_VERSION = "2.1.200"`
- `CODEX_MIN_CLI_VERSION  = "0.140.0"` (codex is pre-1.0; minor is the significant component)

Declared as exported constants **at the provider adapters** (`claude.ts`, `codex.ts`) — the single source
of truth the probe references (AC: "Supported CLI version range is declared per provider and referenced by
the probe"). Bump these when a newer CLI floor is required.

Placement note: the ticket explicitly asks for these "documented **alongside the provider adapters**", and
the floor exists precisely *because* each adapter's flag surface is version-coupled — so co-locating the
floor with the flags it guards is the intended home. The alternative (beside `PROVIDER_REQUIRED_ENV` in
`agent-config.ts:46-49`, which already centralizes provider metadata) is also valid and would keep all
provider metadata in one module; we follow the ticket and keep it at the adapters, with `preflight.ts`
importing both constants. No import cycle either way.

### 3.3 Unauth signal: env-key inference only, **no extra spawn**

The "binary present but unauthenticated" distinction is derived from the already-known
`requiredEnvFor(provider)` key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) — which setup already reads — not
from any additional CLI invocation. If the binary is present and the required env key is unset, the result
carries an `unauthHint` (e.g. "`claude` is installed but `ANTHROPIC_API_KEY` is unset; it may not be
authenticated"). No auth round-trip, zero added cost. This is the ticket's "cheap best-effort" bar; deep
auth validation stays OUT.

### 3.4 AC #4 satisfied by **pre-emption only** (Route A), not by re-classifying the provider catch

AC #4 — "a missing binary is no longer classified as a transient transport failure on the dispatch path
**or is pre-empted by the run-start probe** so it can never reach that path" — offers two routes. We take
**pre-emption**: the probe throws *before* `resolveAgentRunner`/dispatch on **both** dispatch entry points
— the fresh-run path (`run.ts`) and the resume path (`resumeRun` in `park.ts`) — so a missing-binary case
never reaches the provider `catch` at `claude.ts:152`. The catch's `cause: "transient"` classification is
left untouched.

**Resume is a first-class dispatch flow and must be probed too** (independent-review finding, 2026-07-22).
`resumeRun` (`park.ts:187`) re-dispatches the agent via `resolveAgentRunner` (`park.ts:316`), and a resume
typically happens *later* — after a park, possibly on a different machine — which is precisely when the CLI
may have been uninstalled or downgraded since the original run. Skipping the probe there would leave the
ticket's exact defect intact behind `--resume`. So the probe runs inside `resumeRun` as well (§4.3). The
`--inspect` sub-path stays probe-free — it must remain exit-0 on a tool-less machine (same rule that keeps
`preflightToolchain` off `--inspect`).

The only genuine residual is the truly exotic intra-invocation race — the binary vanishing *between* a
probe and a later dispatch *within the same* `run`/`resume` process. That is YAGNI and left to the existing
transient path.

Rejected alternative (Route B): sniff ENOENT in the provider catch and return a new non-retryable
`FailureCause`. `FailureCause` (`src/agent/runner.ts:3`) is a closed union of
`"session-limit" | "out-of-credits" | "transient"`; adding a value ripples through every `cause` switch
(`run-dispatch.ts`, park-vs-fail logic, `failure-policy.ts`) and re-opens a hot path the ticket did not ask
to touch. Now that pre-emption covers both fresh and resume dispatch, Route B's only marginal gain is that
exotic intra-invocation race — not worth the enum ripple. The existing test that pins spawn-failure =
transient (`test/agent/providers/claude.test.ts:99-109`) therefore stays green unchanged.

## 4. Design

### 4.1 New module `src/agent/preflight.ts`

A standalone function — **not** a method on the hot `AgentRunner` interface (`runner.ts:39`), mirroring the
existing `preflightToolchain` standalone pattern (`src/cli/preflight.ts:63`).

```ts
export type AgentCliPreflight =
  | { ok: true;  version: string | null; unauthHint?: string }   // version:null ⇒ unparseable, fail-open
  | { ok: false; reason: "missing";             command: string }
  | { ok: false; reason: "unsupported-version"; command: string; found: string; required: string };

export function preflightAgentCli(
  config: AgentConfig,
  // Both the PATH check and the --version call are injected as ONE seam (a fake CLI stub or a
  // stubbed runner), so unit tests can drive the version/unparse branches without an on-PATH binary.
  deps?: { runCli?: (command: string, args: string[]) => { ok: boolean; output: string };
           env?: NodeJS.ProcessEnv },
): AgentCliPreflight;
```

Steps:

1. **Resolve the command** — `command = config.command ?? providerDefault(config.provider)`. The default
   itself lives in the factory *parameter defaults* (`claudeAgentRunner(command = "claude")` at
   `claude.ts:87`; `codexAgentRunner(command = "codex")` at `codex.ts:128`) — `resolveAgentRunner`
   (`resolve.ts:9-14`) passes `config.command` straight through (possibly `undefined`). `providerDefault`
   must replicate those factory defaults. In practice `DEFAULT_AGENT_CONFIG.command` is set, so this only
   bites a custom config that omits `command`.
2. **PATH check** — an inline `command -v` probe via `Bun.spawnSync(["sh", "-c", 'command -v "$1"', "sh",
   command])`, mirroring `probeCommandExists` (`discover-schema.ts:67-68`) but kept local so `preflight.ts`
   does not depend on the setup module. Not found → `{ ok: false, reason: "missing", command }`. (Runs
   through the injected `deps.runCli` so tests can force present/absent.)
3. **Run `<command> --version`** — `Bun.spawnSync([command, "--version"], { timeout: ~5_000 })`, via the
   same `deps.runCli` seam.
4. **Parse + compare** — extract the **last** `/(\d+)\.(\d+)(?:\.(\d+))?/` match in the output. Last-match
   (not first) avoids a false hard-fail when a line *leads* with an unrelated dotted number — a build date
   `2026.07.22`, a runtime version, a `1.2-compatible` note — which under first-match could parse below the
   floor and reject a healthy CLI. Both current CLIs still parse correctly: `2.1.216 (Claude Code)` →
   `2.1.216`; `codex-cli 0.144.6` → `0.144.6`. Compare numerically major→minor→patch against the provider
   floor. Below floor → `unsupported-version`. No match → `{ ok: true, version: null }` (fail-open).
5. **Unauth hint** — if `ok` and `requiredEnvFor(provider)` is set but absent from `env`, attach
   `unauthHint`. No extra spawn.

A small `provider → { label, minVersion }` table built from the adapter-exported constants (§3.2) supplies
the floor. Numeric comparison is hand-rolled (~10 lines over the three captured groups) — **no semver dep**
is added; none exists in the repo today and one CLI-version comparator does not justify it.

### 4.2 Error factory — dedicated `agentCliError`, not `toolchainError`

The probe needs its own `StyreError` factory (independent-review finding, 2026-07-22). `toolchainError`
(`errors.ts:53-60`) hard-codes headline *"cannot start — required commands are not runnable on this
machine"* + recovery *"Install the missing tool(s) and re-run."* — wrong for the **out-of-range** case,
where the binary *is* runnable and the fix is to *upgrade*, not install. (Reusing it would also collide
with `run-preflight.test.ts:66`'s `/cannot start/` assertion.)

Add `agentCliError(result: AgentCliPreflight & { ok: false })` at `EXIT.TOOLCHAIN_MISSING` (69), producing
distinct headline + recovery per reason:

- **missing** → headline "`claude` is not installed or not on PATH"; recovery "Install the `claude` CLI, or
  set `agent.command` in your profile, then re-run."
- **unsupported-version** → headline "`claude` 2.0.9 is below the supported minimum 2.1.200"; recovery
  "Upgrade the `claude` CLI to ≥ 2.1.200 and re-run."

Both exit 69 (already `EX_UNAVAILABLE`, "a required program is not available" — semantically apt, already
non-retry). Rendered through the existing `StyreError` → `renderError` path (`output.ts:4-18`):
`styre <cmd>: <headline>` + indented detail + recovery line.

### 4.3 Wiring — dispatch entry points (`styre run` fresh + resume)

**Fresh run** — in `runImpl` (`src/cli/run.ts`), beside the existing `preflightToolchain` fail-fast
(:177-181): the fresh-run-only window, after `--resume`/`--inspect` return (:158-166), before any
DB/dispatch. Compute `const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG` here — it must be
**hoisted** above the probe (it currently lives at `run.ts:192`, after the toolchain hook and after the
temp-DB `migrate`). `runtimeConfig` is already in scope from :125, so hoisting is trivial and keeps the
probe before any DB creation. Run `preflightAgentCli(agentConfig)`; on `!ok` throw `agentCliError(...)` →
exit 69. Because this throws **before** `resolveAgentRunner` (:202) and the first `runTicket` dispatch
(:218), a missing/old CLI structurally cannot reach the `cause:"transient"` → `applyFailurePolicy` →
3-attempt burn.

**Resume** — in `resumeRun` (`src/cli/park.ts:187`), after the `--inspect` early-return (~:237) and the
resume-refused HEAD check, and **before** the re-dispatch that calls `resolveAgentRunner` (:316). Same
probe on `runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG`, same `agentCliError` → exit 69. This closes the gap
where a resume on a machine that lost/downgraded the CLI would otherwise burn retries (§3.4). `--inspect`
stays probe-free (must remain exit-0 on a tool-less machine).

Unauth hint and the unparseable-version warning are emitted to stderr (via the existing output layer,
`src/cli/output.ts`) without failing the run.

### 4.4 `styre setup` wiring

In `setupImpl` (`src/cli/setup.ts`), immediately after the existing env-key gate (:260-266) and before the
agent is ever invoked (enrichment/discovery): run `preflightAgentCli(agentConfig)` — `agentConfig` is
already computed at `setup.ts:260`. On `!ok`, throw `agentCliError(...)` (exit 69). This closes the gap
where setup checks the env key, then invokes the agent, so a missing/old binary surfaces late as a
transient failure. (Note: the existing env-key gate throws a plain `Error` → `EXIT.INTERNAL`; the new probe
uses a `StyreError` for a clean exit-69 + actionable render.)

## 5. Tests

Mirrors the repo's two established patterns.

- **Unit** — `test/agent/preflight.test.ts`, driven through the single `deps.runCli` seam (so both the
  PATH-check and the `--version` branches are reachable without an on-PATH binary; an executable
  `#!/bin/sh` `fakeCli` stub à la `claude.test.ts:17-22` also works under `Bun.spawnSync`):
  - supported version → `{ ok: true }`
  - below floor → `{ ok: false, reason: "unsupported-version", found, required }`
  - unparseable output → `{ ok: true, version: null }` (fail-open) + warning surfaced
  - nonexistent command (PATH check fails) → `{ ok: false, reason: "missing" }` (no retry burn)
  - binary present + env key unset → `unauthHint` populated
  - codex `codex-cli 0.144.6` and claude `2.1.216 (Claude Code)` both parse via last-match; and a
    leading-dotted-number line (e.g. `2026.07.22 build … claude 2.1.216`) still parses `2.1.216`
- **Integration — setup** — missing binary ⇒ `setup` rejects at exit 69, agent never invoked.
- **Integration — run (fresh)** — mirror `test/cli/run-preflight.test.ts` (unwrapped `runImpl`): missing/old
  binary ⇒ rejects before dispatch, **no park dump written, no retry burn**; assert `--inspect` bypasses the
  probe.
- **Integration — resume** — the new coverage the review demands: a `resumeRun` (non-`--inspect`) against a
  missing/old CLI ⇒ rejects at exit 69 before re-dispatch (`park.ts:316`); `--inspect` stays exit-0 on a
  tool-less machine.
- **Regression** — existing `claude.test.ts:99-109` (spawn failure = transient) stays green; full
  `bun test` + `bun run lint` green.

## 6. Files touched

| file | change |
| -- | -- |
| `src/agent/preflight.ts` | **new** — `preflightAgentCli` + version parse/compare + provider floor table |
| `src/agent/providers/claude.ts` | export `CLAUDE_MIN_CLI_VERSION = "2.1.200"` (documented constant) |
| `src/agent/providers/codex.ts` | export `CODEX_MIN_CLI_VERSION = "0.140.0"` (documented constant) |
| `src/cli/errors.ts` | **new** `agentCliError` factory (distinct missing/out-of-range headlines, exit 69) |
| `src/cli/setup.ts` | call probe after env-key gate (:260-266); throw `agentCliError` on `!ok` |
| `src/cli/run.ts` | hoist `agentConfig` above the toolchain hook; call probe there; throw `agentCliError` on `!ok` |
| `src/cli/park.ts` | call probe in `resumeRun` after `--inspect` return, before re-dispatch (:316) |
| `test/agent/preflight.test.ts` | **new** — unit coverage |
| `test/cli/run-preflight.test.ts` (+ resume peer) | fresh-run and resume integration coverage |

No change to `FailureCause`, the provider `catch`, or the dispatch/retry path (§3.4).

## 7. Acceptance-criteria trace

| AC | satisfied by |
| -- | -- |
| Typed probe result `{ok}｜{missing}｜{unsupportedVersion,…}` (+unauth) | §4.1 `AgentCliPreflight` |
| `styre setup` fails with actionable message | §4.4 |
| `styre run` fails fast before first dispatch, no retry burn | §4.3 (fresh **and** resume) |
| Missing binary no longer a transient failure on dispatch path | §3.4 (pre-emption on both dispatch entry points) |
| Version range declared per provider, single source of truth | §3.2 |
| Tests: supported / missing / old + existing dispatch green | §5 |
| `bun run lint` + `bun test` green | §5 |
