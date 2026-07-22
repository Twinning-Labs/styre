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
**pre-emption**: the run-start probe throws *before* `resolveAgentRunner`/dispatch, so a missing-binary
case never reaches the provider `catch` at `claude.ts:152`. The catch's `cause: "transient"` classification
is left untouched.

Rejected alternative (Route B): sniff ENOENT in the provider catch and return a new non-retryable
`FailureCause`. `FailureCause` (`src/agent/runner.ts:3`) is a closed union of
`"session-limit" | "out-of-credits" | "transient"`; adding a value ripples through every `cause` switch
(`run-dispatch.ts`, park-vs-fail logic, `failure-policy.ts`) and re-opens a hot path the ticket did not ask
to touch. Route B's only marginal gain is defending an exotic race (the binary vanishing *between* the
run-start probe and a mid-run dispatch) — YAGNI. The existing test that pins spawn-failure = transient
(`test/agent/providers/claude.test.ts:99-109`) therefore stays green unchanged.

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
  deps?: { runVersion?: (command: string) => { ok: boolean; output: string }; env?: NodeJS.ProcessEnv },
): AgentCliPreflight;
```

Steps:

1. **Resolve the command** — `command = config.command ?? providerDefault(config.provider)`, the same rule
   the factories use in `src/agent/resolve.ts:9-14` (`claude` / `codex`).
2. **PATH check** — an inline `command -v` probe via `Bun.spawnSync(["sh", "-c", 'command -v "$1"', "sh",
   command])`, mirroring `probeCommandExists` (`discover-schema.ts:67-68`) but kept local so `preflight.ts`
   does not depend on the setup module. Not found → `{ ok: false, reason: "missing", command }`.
3. **Run `<command> --version`** — `Bun.spawnSync([command, "--version"], { timeout: ~5_000 })`, injectable
   via `deps.runVersion` for tests.
4. **Parse + compare** — extract the **first** `/(\d+)\.(\d+)(?:\.(\d+))?/` match anywhere in the output
   (claude prints `2.1.216 (Claude Code)` — version first; codex prints `codex-cli 0.144.6` — version
   second; the "first match anywhere" rule handles both). Compare numerically major→minor→patch against the
   provider floor. Below floor → `unsupported-version`. No match → `{ ok: true, version: null }` (fail-open).
5. **Unauth hint** — if `ok` and `requiredEnvFor(provider)` is set but absent from `env`, attach
   `unauthHint`. No extra spawn.

A small `provider → { label, minVersion }` table built from the adapter-exported constants (§3.2) supplies
the floor. Numeric comparison is hand-rolled (~10 lines over the three captured groups) — **no semver dep**
is added; none exists in the repo today and one CLI-version comparator does not justify it.

### 4.2 Wiring — `styre setup`

In `setupImpl` (`src/cli/setup.ts`), immediately after the existing env-key gate (:260-266) and before the
agent is ever invoked: run `preflightAgentCli`. On `!ok`, throw a `StyreError` at `EXIT.TOOLCHAIN_MISSING`
(69, `src/cli/errors.ts`) via `toolchainError(...)` (or a peer factory), with an actionable message naming
the binary and the required version. This closes the gap where setup checks the env key, then invokes the
agent, so a missing binary surfaces late as a transient failure.

### 4.3 Wiring — `styre run`

In `runImpl` (`src/cli/run.ts`), beside the existing `preflightToolchain` fail-fast (:177-181) — the
fresh-run-only window, after `--resume`/`--inspect` return (:158-166), before any DB/dispatch. Run
`preflightAgentCli`; on `!ok` throw `toolchainError(...)` → exit 69. Because this throws **before**
`resolveAgentRunner` (:202) and the first `runTicket` dispatch (:218), a missing/old CLI structurally
cannot reach the `cause:"transient"` → `applyFailurePolicy` → 3-attempt burn.

Unauth hint and the unparseable-version warning are emitted to stderr (via the existing output layer,
`src/cli/output.ts`) without failing the run.

### 4.4 Error-text shape

Three distinguishable messages (AC): **missing** ("`claude` is not installed or not on PATH — install it,
or set `agent.command` in your profile"); **out-of-range** ("`claude` 2.0.9 is below the supported minimum
2.1.200 — upgrade the CLI"); **unauth hint** appended when cheaply known. Formatted through the existing
`StyreError` → `renderError` path (`output.ts:4-18`): `styre <cmd>: <headline>` + indented detail +
recovery line.

## 5. Tests

Mirrors the repo's two established patterns.

- **Unit** — `test/agent/preflight.test.ts`. Fake `--version` scripts on disk à la `fakeCli`
  (`claude.test.ts:17-22`), or the injected `deps.runVersion` seam:
  - supported version → `{ ok: true }`
  - below floor → `{ ok: false, reason: "unsupported-version", found, required }`
  - unparseable output → `{ ok: true, version: null }` (fail-open) + warning surfaced
  - nonexistent command → `{ ok: false, reason: "missing" }` (no retry burn)
  - binary present + env key unset → `unauthHint` populated
  - codex `codex-cli 0.144.6` and claude `2.1.216 (Claude Code)` both parse (position-independent)
- **Integration — setup** — missing binary ⇒ `setup` rejects at exit 69, agent never invoked.
- **Integration — run** — mirror `test/cli/run-preflight.test.ts`: call unwrapped `runImpl`; missing/old
  binary ⇒ rejects before dispatch, **no park dump written, no retry burn**; assert `--resume`/`--inspect`
  bypass the probe (as they bypass `preflightToolchain`).
- **Regression** — existing `claude.test.ts:99-109` (spawn failure = transient) stays green; full
  `bun test` + `bun run lint` green.

## 6. Files touched

| file | change |
| -- | -- |
| `src/agent/preflight.ts` | **new** — `preflightAgentCli` + version parse/compare + provider floor table |
| `src/agent/providers/claude.ts` | export `CLAUDE_MIN_CLI_VERSION = "2.1.200"` (documented constant) |
| `src/agent/providers/codex.ts` | export `CODEX_MIN_CLI_VERSION = "0.140.0"` (documented constant) |
| `src/cli/setup.ts` | call probe after env-key gate; throw `StyreError` (69) on `!ok` |
| `src/cli/run.ts` | call probe beside `preflightToolchain`; throw `toolchainError` (69) on `!ok` |
| `src/cli/errors.ts` | (if needed) a peer factory for the message shape; reuse `EXIT.TOOLCHAIN_MISSING` |
| `test/agent/preflight.test.ts` | **new** — unit coverage |
| `test/cli/run-preflight.test.ts` (or peer) | run-start integration coverage |

No change to `FailureCause`, the provider `catch`, or the dispatch/retry path (§3.4).

## 7. Acceptance-criteria trace

| AC | satisfied by |
| -- | -- |
| Typed probe result `{ok}｜{missing}｜{unsupportedVersion,…}` (+unauth) | §4.1 `AgentCliPreflight` |
| `styre setup` fails with actionable message | §4.2 |
| `styre run` fails fast before first dispatch, no retry burn | §4.3 |
| Missing binary no longer a transient failure on dispatch path | §3.4 (pre-emption) |
| Version range declared per provider, single source of truth | §3.2 |
| Tests: supported / missing / old + existing dispatch green | §5 |
| `bun run lint` + `bun test` green | §5 |
