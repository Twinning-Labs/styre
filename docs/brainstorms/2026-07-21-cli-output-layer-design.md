# CLI output layer + run outcome content — design

Status: **approved 2026-07-21**, ready for planning.
Tickets: **ENG-350** (the substrate — shared output layer + error boundary + exit-code scheme), **ENG-338** (run-specific content — outcome sentences, PR URL, timeline, success framing).
Origin: the 2026-07-20 output audit (see the ENG-338 / ENG-339 addenda and the STYRE-7 correction).

## Problem

Two defects, one root cause. The CLI has **no output layer**: ~35 print sites hand-roll their own prefix, punctuation, and recovery text, and **125 `throw new Error` sites** funnel through citty's `runMain`, which prints every uncaught error *twice* (full object + stack trace, then the message again) and exits `1`. So config errors, git failures, internal invariant bugs, and ordinary operational outcomes are indistinguishable — all look like a crash, all exit `1`. `styre run`'s own summary compounds it: it never prints the PR URL (even on success), reports outcomes in the internal `RunOutcome` vocabulary (`no-progress`, bare `status=waiting`), and renders operational stops as thrown stack traces.

The binary is the CI/cloud/fleet primitive, so its **terminal text and exit codes are its API**. Today that API is inconsistent per-command and, for the throw sites, is just a raw stack dump.

## Goals

Consistency, specificity, clarity, and recovery across everything the CLI prints — and a differentiated, documented exit-code space. Concretely: one formatter, one error boundary, operational outcomes that read as outcomes (not crashes), the PR URL on every outcome that has one, and messages that name the file/command/ticket involved and state the next step.

## Non-goals

- The `escalated` outcome value → **ENG-353**. This design builds the vocabulary layer with `escalated`'s slot and agreed sentence, but does **not** wire the `blocked`→`escalated` derivation. Until ENG-353 lands, an escalation reads as the `blocked` sentence.
- Telemetry / NDJSON changes → **ENG-339 / ENG-349**.
- The wait-budget / idle-pacing behaviour → ENG-337 (cancelled) — out of scope regardless.
- Changing *when* a run reaches any outcome. This is purely how outcomes are labelled and rendered.

## Decisions (locked with the operator, 2026-07-21)

### Exit-code scheme — sysexits, fine-grained

Every distinct condition a script cares about gets its own code, aligned with the BSD `sysexits.h` conventions already in use (65/69/75). Shared across all four subcommands.

| Code | Name | Condition |
|------|------|-----------|
| `0` | — | success: `pr-ready`, `done` |
| `1` | operational stop | `blocked` / `no-progress` — ran fine, reached a dead-end a human should look at |
| `64` | `EX_USAGE` | CLI usage error — missing `--ticket`, `notify` without `--test` (replaces the ad-hoc `2`) |
| `65` | `EX_DATAERR` | resume refused — branch HEAD moved *(keep)* |
| `69` | `EX_UNAVAILABLE` | required toolchain program missing *(keep — ENG-332)* |
| `70` | `EX_SOFTWARE` | internal bug / unexpected crash (was: `1` catch-all) |
| `75` | `EX_TEMPFAIL` | parked, or (ENG-353) escalated — needs a human, resumable *(keep + extend)* |
| `78` | `EX_CONFIG` | bad config/profile — invalid value, unknown adapter, unresolved profile |

Notes:
- `2` (notify usage) is **retired** into `64`.
- `1` changes meaning from "any thrown error" to "operational stop (blocked/no-progress)". The old `1` catch-all becomes `70`.
- `75` covers `parked` today; ENG-353 extends it to `escalated`. Both are "needs a human, resumable."

### Outcome words — sentence-style

The user-facing vocabulary is a **presentation layer derived from `RunOutcome`, not a rename of the state machine** (per ENG-338). Each outcome renders as a full sentence, followed by the PR URL and any pending-signal detail.

| `RunOutcome` | Sentence | Framing | Exit |
|--------------|----------|---------|------|
| `pr-ready` | "Opened the PR — ready for your review. Waiting on CI + merge approval." | success | 0 |
| `done` | "Merged and released." | success | 0 |
| `parked` | "Paused — ran out of budget; resume anytime." | attention | 75 |
| `escalated` *(ENG-353)* | "Escalated to you — needs a decision before it can continue." | attention | 75 |
| `blocked` | "Stopped — no actionable work remains." | attention | 1 |
| `no-progress` | "Stopped — couldn't make progress." | attention | 1 |

The `pr-ready` sentence must never surface a bare `status=waiting` — "waiting on CI + merge approval" *is* the success framing.

## Architecture

Two new modules under `src/cli/`, edits to `index.ts` and the four subcommands, and a rewrite of the run summary + `finishRunResult`. Each unit is independently testable against its rendered strings.

### 1. `src/cli/errors.ts` — the error taxonomy

A `StyreError` base carrying the operator-facing shape and its exit code:

```
class StyreError extends Error {
  code: number;         // process exit code
  headline: string;     // the one-line what-went-wrong
  detail?: string;      // optional indented body (e.g. the offending field list)
  recovery?: string;    // optional "do this next" line
}
```

Factories bake in the code and the house wording:
- `UsageError(cmd, headline, recovery?)` → `64`
- `ConfigError({ cmd, file, field?, detail, recovery })` → `78`
- `ResumeRefusedError(...)` → `65` (moves the existing `park.ts:198` message here)
- `ToolchainError(missing)` → `69` (wraps the existing `formatMissingTools`)

Operational outcomes (`blocked`/`no-progress`) are **not** `StyreError`s — they are returned from the run, not thrown (see §5). Anything reaching the boundary that is **not** a `StyreError` is treated as an internal bug → `70`.

### 2. `src/cli/output.ts` — the one formatter

The single place operator text is shaped. House style: a `styre <cmd>: ` prefix, the headline, an optional indented `detail` block, and an optional `recovery` line. Members:
- `note(cmd, msg)` — an informational line (startup confirmations, `setup` progress).
- `renderError(e: StyreError)` — formats headline + detail + recovery.
- `renderInternal(cmd, err)` — the "internal error — please report" banner for non-`StyreError` throws, with the underlying `err.message` as a single detail line (full stack only when `DEBUG`/`--debug` is set).

All output goes to **stderr** (see stream rule). No site constructs its own prefix.

### 3. `src/cli/guard.ts` (or a `guard` export from `output.ts`) — the error boundary

```
async function guard(cmd: string, body: () => Promise<void>): Promise<void>
```

Runs `body`; on throw, renders once via `output.ts`, sets `process.exitCode` from the error's `code` (or `70` for a non-`StyreError`), and **returns without rethrowing** — so citty's `runMain` never sees the throw and never prints its double stack trace. Each subcommand's `run(ctx)` becomes `run: (ctx) => guard("<cmd>", () => impl(ctx))`. This is the "before citty" interception, implemented without patching citty internals. A body that sets `process.exitCode` itself (e.g. park → `75`) and returns normally is left untouched.

**Verified against `citty/dist/index.mjs` (independent review, 2026-07-21):** `runMain` awaits `cmd.run` (index.mjs:316,445); its double-print + `process.exit(1)` live *only* in the `catch` (index.mjs:447-457); the sole `process.exit(0)` is the `--help` branch (index.mjs:437). A guard that catches-and-returns never enters the catch, and a `process.exitCode` we set survives to Node's natural exit. The mechanism holds.

**Two implementation requirements this imposes:**
- **Export the unwrapped `impl` for each subcommand.** Tests invoke the command body directly and must still be able to assert on throws / structured returns (see Testing) — `guard` swallows throws, so the wrapped `run` is not directly assertable. Each subcommand exports both `run` (wrapped) and its `impl` (unwrapped).
- **Caveat — citty-level required-arg errors bypass the guard.** citty throws its own `CLIError` inside `parseArgs`, *before* `cmd.run` (index.mjs:250/280). Harmless today (no `run`/`notify`/`setup` arg is `required: true`; the missing-`--ticket` case is an in-body `throw` at `run.ts:133`). Note in the code so nobody later marks an arg `required` and silently reopens the double-print.

### 4. Migrations onto the substrate (ENG-350)

- **Zod parse sites** — wrap the `.parse()` at `config/discover.ts:52,57` and `dispatch/profile.ts:144` in a helper that catches `ZodError` and throws `ConfigError` naming the file, the offending field path(s), and a fix. Kills the raw-ZodError-no-filename dump. (`discover.ts:39`'s JSON-syntax path already does this well — match its shape.)
- **Adapter-value validation** — after config discovery, validate `issueTracker` / `forge` / `agent.provider` against the valid adapter keys and throw `ConfigError` (file + valid values) on a miss, so a typo fails early and uniformly instead of surfacing later as `selectIssueTracker: no adapter registered for 'liner'`.
  - **Prerequisite (review 2026-07-21): no enumerable registry exists today.** `selectIssueTracker`/`selectForge`/`selectAgentRunner`/`selectNotifier` take `adapters` as a *parameter* and the valid keys are inline object literals at the wiring sites (`daemon/ports.ts:31-47` → issueTracker `{linear, jira}`, forge `{github}`, notifier `{slack}`; `agent/resolve.ts:10-13` → provider `{claude, codex}`). So this task first **exports a keys-only list** next to each wiring map (e.g. `ISSUE_TRACKER_ADAPTER_KEYS`) and validates against it. Special case: `notifier` legitimately allows `"none"` (handled in `notifier.ts:40`, not an adapter key) — the valid-values list is the adapter keys **plus `none`**, not `Object.keys(adapters)`.
- **`setup/enrich.ts`** — thread the agent CLI's real `result.stderr` into the enrichment-failure message (currently discarded; only `exit N` / `timed out` survive) and route it through `ConfigError`/`UsageError` as appropriate rather than the bare `enrichRuntimeContext:` prefix.
- **The ~20 internal-invariant throws** (`advanceOneStep:`, `nextStepKey:`, `insertX: row missing after insert`, …) — **left as-is**. The boundary reframes every non-`StyreError` under the `70` "please report" banner, so their messages become useful debug detail without per-site rewording. (Decided: no churn; the boundary is the reframing.)

### 5. Run content (ENG-338)

- **`formatRunSummary` rewrite** (`daemon/run-ticket.ts:176-187`):
  - Line 1: the approved outcome **sentence** (success framing for `pr-ready`/`done`).
  - **PR URL on every outcome that has one** — read `external_pr_result` via `getDeliveredPayload` (DB-only, no network; mirrors `notify.ts`). Finding #1.
  - When ended waiting, **name the pending signal** via `listPending` (e.g. "waiting on `human_merge_approval`"). Finding #3.
  - **Timeline**: a loopback line conveys `loop` → `route_to` + a short signature (and the findings count for a redesign), not the bare word `loopback`. Finding #8.
- **`finishRunResult` stops throwing** (`cli/park.ts:60-62`) for `blocked`/`no-progress`: it returns a structured result; the command renders the summary and sets exit `1`. A single `exitCodeFor(outcome)` helper maps outcome → code per the table above; `parked` keeps `75`, resume-refused keeps `65`. No throw, no stack, no double-print (findings #4/#5).
  - **Two sites, not one (review 2026-07-21).** The resume path does **not** call `finishRunResult`; it duplicates the tail inline — `db.close()` at `park.ts:295`, `throw` at `park.ts:296-298`. Both the shared `finishRunResult` *and* this inline resume tail must be de-thrown.
  - **Preserve side effects.** `finishRunResult`'s blocked/no-progress branch closes the db (`park.ts:59`) before throwing — the de-thrown version keeps `db.close()`; likewise the inline resume tail. `dumpPark` (parked) is unaffected.
  - **Keep the parked `exitCode = 75` inside `finishRunResult`.** `test/helpers/run-harness.ts:128` calls `finishRunResult` and reads `process.exitCode` back (consumed by `park-resume-e2e.test.ts` expecting `75`) — moving the exit-code set out of `finishRunResult` breaks the harness. `exitCodeFor` computes the value; `finishRunResult` still applies it.
- **Telemetry reconciliation (review 2026-07-21).** `run.ts:204-210` currently wraps the run in `try/catch → analytics.cliError(...) → rethrow`, and it reads `process.exitCode` *before* any code is set (so it would log `1` for every failure). Fold this into `guard`: emit the analytics error event from the guard, *after* it has set the real `process.exitCode`, so the reported code is accurate (78/70/…). Operational stops (`blocked`/`no-progress`) are no longer thrown, so they stop emitting `cliError` — correct (they are outcomes, not errors); if a signal is wanted, emit a distinct non-error analytics event, decided in planning.
- **Slack wording** (`daemon/notify.ts:37-48`) aligned to the new vocabulary; `"gave up (no progress)"` removed. `terminalDecision` gains sentences consistent with the terminal.
- **Stale comment.** Update the exit-code doc comment at `run.ts:27-28` (still says "2 notifier-config") to the new scheme.

### 6. Stream rule

**All human/diagnostic output → stderr, everywhere.** stdout is reserved for machine payloads (NDJSON in `run`; nothing else today). This moves `setup`'s `console.log` lines to stderr — a uniform, pipe-safe rule, safe pre-cutover (no stdout consumers exist). A future machine-readable `setup` output is a `--porcelain`/`--json` flag, not stdout prose.

## Data flow

```
subcommand run(ctx)
  └─ guard(cmd, impl)
       ├─ impl succeeds → (may set process.exitCode, e.g. parked=75) → return
       └─ impl throws
            ├─ StyreError  → output.renderError → exitCode = e.code
            └─ other       → output.renderInternal (bug, please report) → exitCode = 70

run success path (impl):
  driveToTerminal → RunResult
    └─ formatRunSummary(outcome sentence + PR URL + pending signal + timeline) → stderr
    └─ finishRunResult → exitCodeFor(outcome)   // no throw for blocked/no-progress
```

## Testing

TDD — failing tests first, over the **rendered strings and exit codes** (the tickets require this):
- `output.ts` / `errors.ts`: each factory renders the right headline/detail/recovery; `guard` maps `StyreError`→code and non-`StyreError`→70 with no double-print.
- `ConfigError` wrap: a malformed `config.json` / `profile.json` produces a message naming the file + field, not a ZodError; an unknown adapter names the file + valid values.
- `formatRunSummary`: `pr-ready` reads as success and includes the PR URL; a waiting end names the pending signal; a loopback timeline line carries route/signature; `blocked`/`no-progress` render without a stack trace and exit `1`.
- Slack: no `blocked`/`gave up` wording; sentences match the terminal.
- The STYRE-1 (ENG-338) and STYRE-7 transcripts, re-rendered, tell an operator the true story (PR open + link, or the real stop reason).

**Existing tests the refactor touches (review 2026-07-21):**
- `test/cli/run-preflight.test.ts` invokes `runCommand.run()` directly and asserts `.rejects.toThrow("no parked run")` (lines 78, 85). The guard swallows throws, so these must be rewritten against the **unwrapped `impl`** (assert the throw there) or against `process.exitCode` on the wrapped command.
- `test/helpers/run-harness.ts:128` + `test/cli/park-resume-e2e.test.ts` read `exitCode === 75` back from `finishRunResult` — preserved by keeping the exit-code set inside `finishRunResult` (see §5). No change needed if that constraint holds.
- No existing test asserts the blocked/no-progress throw (grep of the CLI tests for `"ended"`/`"no-progress"` is empty), so de-throwing those is low-risk.
- `test/cli.test.ts` captures **stdout** only for `--version` (`index.ts:15`) — unaffected by the stderr move.

## Build order & delivery

One worktree (`feat/eng-338-350-cli-output`, already created). Build **ENG-350 substrate first** (errors → output → guard → migrations), then **ENG-338 content** on top (it needs the substrate to test). Two commits (350, then 338), **one draft PR** closing both — 338 isn't independently testable without 350. No auto-merge; the operator merges.

## Open items

- Exact `recovery` wording per error site — settled during implementation against the templates already in-repo (`preflight.ts:83`, `park.ts:198`, `discover.ts:28`).
- Whether `guard` lives in `output.ts` or its own file — a mechanical call made during planning.
- Whether operational stops (`blocked`/`no-progress`) emit a non-error analytics event now that they no longer throw `cliError` (§5 telemetry note) — decide in planning.
- Cosmetic: `setup`'s interactive `globalThis.prompt()` writes its prompt to stdout independently of the `console.log`→stderr move (`setup.ts:139,162`). Left as-is unless it proves noisy; not a break.

## Independent review

Reviewed against the codebase on 2026-07-21 (fresh agent, read-only). Verdict: **no design-breaking blockers** — the `guard`/citty mechanism, exit-code mechanics, `formatRunSummary` data access, and the stderr move all check out against the code. The review's SHOULD-FIX findings (no enumerable adapter registry; two tests that break; the duplicated resume tail + preserved side effects; the `cliError` telemetry interaction) are folded into §3, §4, §5 and Testing above.
