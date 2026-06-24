# Design — Classify transport-failure cause (ENG-164)

**Date:** 2026-06-24
**Status:** Design approved; ready for planning
**Ticket:** ENG-164 (legacy harness) — *Session-limit dispatch deaths misclassify as progress-md-entry-missing / dispatch-failed halts*
**Scope:** OSS core (`styre run`), provider-agnostic agent boundary

---

## 1. Problem

A dispatch (`claude -p`, or any provider adapter) can die mid-run for three causes that demand
**three different responses**:

- **session-limit** — the subscription/usage quota is exhausted; the process dies with a marker
  like `You've hit your session limit · resets 11:10pm`. Resolves on a **clock** (the reset time).
- **out-of-credits** — billing/credit exhaustion; retrying never helps. Resolves on a **human**
  action (top up).
- **crash / timeout / transient** — a genuine transient failure. Retrying is correct.

Styre today collapses all of these. `claudeAgentRunner` (`src/agent/providers/claude.ts`) captures
`stderr`/`exitCode` but never reads them; `runAgentDispatch` (`src/dispatch/run-dispatch.ts:80`)
throws a single generic `transport failure` for any `!completed || timedOut`, which flows to
`applyFailurePolicy` and is treated like any step error: increment `attempt`, escalate after
`maxAttempts = 3`.

Consequences (the ENG-164 evidence): a quota pause burns three retries fast and then **false-escalates
to a human**, and the failure taxonomy the retrospective learns from is corrupted (legacy
`brainstorm.md:36`: `dispatch-failed: 56`, all exit 20, session-limit / out_of_credits / crash
conflated — the single biggest failure bucket; 23 escalated to operator halts). This both **burns
runs** and breaks the **loop-not-halt** promise — a quota pause masquerades as "the agent is broken."

The design already anticipated the fix (`brainstorm.md:130`): *"Known signature → deterministic
match (e.g. `out_of_credits` in stderr) → known action, no LLM."* This is that row.

## 2. Goals / Non-goals

**Goals**
- Deterministically classify a dispatch death into a provider-neutral cause.
- Route each cause to the correct response: **session-limit / out-of-credits → resumable park**;
  **transient → bounded in-process retry** (today's behavior, preserved).
- Make a quota/billing pause **resumable from the exact paused state**, including best-effort agent
  context carryover.
- Emit honest telemetry so a pause is countable as itself, never as a fake failure.

**Non-goals**
- Auto-pausing the orchestrator, quota-aware scheduling, staggering resumes (was out of scope even
  in ENG-164; belongs to the commercial plane).
- Deciding *when* to resume (clock wait / credit top-up) — the caller/plane owns that. The core only
  produces a resumable dump and a documented exit code.
- Mid-agent-turn resume. Resume is **step-granularity** (the existing journal model): completed steps
  never re-run; the interrupted step re-runs fresh.

## 3. Decisions (locked during brainstorming)

| # | Decision |
|---|----------|
| D1 | **Park, don't sleep.** session-limit/out-of-credits → park + durable dump + honest exit; there is a *next run* that resumes. No in-process sleeping in the core. |
| D2 | **Resume model = step-granularity via persisted SoT + agent context carryover.** The dump captures the SoT + branch + the interrupted dispatch's partial transcript; resume rehydrates and re-dispatches only the interrupted step, injecting the transcript as an *advisory* hint. |
| D3 | **out-of-credits uses the same resumable-park path** as session-limit, parameterized by trigger (clock vs human). |
| D4 | **crash/timeout/unknown → bounded in-process retry** (unchanged), attempt consumed, escalate after `maxAttempts`. |
| D5 | **Resume trigger = `styre run --resume <ticket\|path>`.** One verb, one flag; OSS is self-sufficient, the plane automates the same flag. |
| D6 | **HEAD guard on resume**, with two escape hatches: `--accept-head` and `--inspect`. (`--keep-transcript` combo and a `--restart` helper were considered and dropped — YAGNI; a plain `styre run` with no `--resume` is the always-available fresh start.) |
| D7 | **Classification lives in the provider adapter**, surfaced to the core as a provider-neutral `cause` enum on `AgentRunResult`. The core never matches provider strings (keeps the generic `AgentRunner` boundary intact). |

## 4. Routing table

| Cause | Detection (in adapter) | Response | Attempt counter |
|---|---|---|---|
| `session-limit` | quota marker + reset time on a **clean non-zero exit** | resumable park; reason names reset time; trigger = clock | **not** consumed |
| `out-of-credits` | billing/credit marker | resumable park; reason = "top up to resume"; trigger = human | **not** consumed |
| `transient` | timeout, signal-kill, exit≠0 with no known marker, spawn error | bounded in-process retry → escalate after `maxAttempts` | consumed |

Key behavioral guarantee: **park causes never touch the attempt counter or `applyFailurePolicy`.**
A run may park → resume → park → resume indefinitely on quota without ever exhausting `maxAttempts`.

## 5. Design

### 5.1 Provider-neutral classification boundary

In `src/agent/runner.ts`, extend the boundary:

```ts
export type FailureCause = "session-limit" | "out-of-credits" | "transient";

export interface AgentRunResult {
  // ...existing fields...
  cause?: FailureCause;     // defaults to "transient" when absent
  resetAt?: string | null;  // UTC ISO; set only for session-limit when parsed
}
```

Only `src/agent/providers/claude.ts` knows the marker strings. A session-limit death is a **clean
non-zero exit** (legacy exit 20), so on the `outcome === "exited"` path the adapter already drains
`stdout`/`stderr` and *has* both the marker and any partial transcript. The adapter matches:
`/hit your session limit|session limit.*resets/i` → `session-limit` (+ parse `resetAt`); a
credit/billing marker → `out-of-credits`; everything else (timeout, signal kill, unmatched exit,
spawn error) → `transient`. A provider that never sets `cause` defaults safely to `transient`.

This is the **closed** taxonomy — three causes, no open-ended set.

### 5.2 Park-and-dump

In `runAgentDispatch` (`run-dispatch.ts`), route on `result.cause`:

- `transient` → throw the transport-failure `Error` exactly as today → `applyFailurePolicy` →
  bounded retry. **Unchanged.**
- `session-limit` / `out-of-credits` → throw a distinct **`ParkSignal`** (a typed sentinel, *not* a
  generic `Error`) carrying `{ cause, resetAt, dispatchId, transcript }`.

`ParkSignal` propagates **like the existing `StepInFlightError`** — `advanceOneStep` already has the
seam (`advance.ts:120`: "Not a handler failure … Propagate."). So `runStep` does **not** `markFailed`
it; the step stays `running` and **no attempt is consumed.** The park bubbles up through `tick` →
`driveToTerminal`, which catches `ParkSignal`, sets `ticket.status = "waiting"` with a `reason`
(`"session-limit; resets <resetAt>"` or `"out-of-credits; top up to resume"`), and returns a new
`RunOutcome = "parked"`.

A parked run's SoT — with the interrupted step left `running` — is **byte-identical to a crashed
run**, so resume needs no new replay logic: `recover()` already handles exactly this shape (it resets
a `running` step to `pending` so the resolver re-picks it).

**The dump** (three durable things) lives at:

```
~/.local/state/styre/<project-stub>/<ticket-ident>/
```

where `<project-stub>` is the profile `slug` (the identity used at `insertProject`).

1. **`run.db`** — the SQLite SoT, moved/copied out of the temp dir (it is already a file). Carries
   every completed step + the `running` interrupted one.
2. **`transcript.json`** — the dying dispatch's captured `stdout` (best-effort partial), for context
   carryover.
3. The **branch** — already durable in the target repo's git; the temp worktree is disposable and
   rebuilt from the branch on resume.

The CLI then emits park telemetry and exits **`75` (EX_TEMPFAIL)**. The stderr summary names the real
cause + reset time + the exact `styre run --resume …` command to continue.

### 5.3 Resume — `styre run --resume`

Add `--resume` to the `run` command (`src/cli/run.ts`); the ticket positional becomes optional and
`--resume <ticket-ident|path>` resolves the dump dir.

1. **Rehydrate** — point `openDb` at the dumped `run.db` (instead of a fresh temp DB); run `migrate`
   (idempotent); **skip the Linear ingest** — the ticket already exists in the SoT. A `resumeTicket`
   path loads the existing `ticketId` and flips `status` back to `active` (vs. `runTicket`'s
   `fetchTicket` + `insertTicket`).
2. **`recover()`** — runs as it already does at startup; resets the interrupted `running` step to
   `pending`; the resolver re-picks it. Completed steps return journaled results (exactly-once intact).
3. **Worktree rebuild** — `ensureWorktree` recreates the disposable worktree from the durable branch
   HEAD; committed work is intact.
4. **Transcript carryover** — the re-dispatch of the interrupted step injects `transcript.json` as an
   **advisory continuity block**, fenced with a ground-truth guard:
   > *"A previous attempt was interrupted (quota/billing pause). Below is its partial output, for
   > context only — it may be incomplete or stale. The repository and journal are the source of truth;
   > verify the current state before redoing or relying on anything it claims to have done."*

   This is additive prompt text on resume only; it never feeds a verdict or self-score, so
   **ground-truth-over-self-report holds**. A clean (non-resume) run has no transcript and no block.
5. On terminal success the dump dir is cleaned up (or replaced if it parks again).

### 5.4 HEAD guard + escape hatches

On resume, compare the current branch HEAD sha to the last recorded `dispatch.branch_head_sha`.

- **Match** → resume normally (§5.3).
- **Mismatch** (force-push / rebase / a manual operator commit) → **refuse by default**, printing the
  diff context (recorded sha, current sha, "N commits ahead" vs "diverged/rebased", parked cause,
  which step would re-run) and pointing at the two flags below. Exit **`65` (EX_DATAERR)**.

Escape hatches:

- **`--accept-head`** — resume against current HEAD. Keep **all** completed journal steps;
  re-dispatch the interrupted step **cold** (no transcript carryover — the operator changed the base,
  so the transcript is stale and untrustworthy); update the SoT's expected sha. This is the
  "I pushed a fix, keep my progress" path — distinct from a fresh run, which discards completed work.
- **`--inspect`** — read-only diagnostic: print recorded vs current sha, commits-ahead/diverged,
  parked cause, and which step would re-dispatch; change nothing; exit **`0`**.

### 5.5 Telemetry, event-log & exit codes (the honest-signal half of ENG-164)

- **Dispatch row.** A parked dispatch records `outcome: "parked"` (extend the `dispatch.outcome`
  CHECK if one exists), **never** `dispatch-failed`. This alone lets the retrospective count
  session-limit/credit pauses separately from genuine failures.
- **Event-log timeline.** A park appends
  `event_log(kind='parked', reason=<cause; trigger>, dispatch_id, payload_json={cause, resetAt})`.
  A resume appends `event_log(kind='resumed', reason=…)`. Adding `parked` to the `kind` CHECK is a
  **schema change touching both `schema.sql` copies** (`src/db/` authoritative + `docs/architecture/`
  doc) — see [[styre-dual-schema-files]]. `resumed` already exists in the enum.
- **NDJSON telemetry stream.** `kind` is already a free string in the `event` telemetry type, so
  `parked`/`resumed` flow through with no `SCHEMA_VERSION` bump. Add the optional `payload_json` field
  to the telemetry `EventEvent` (additive → non-breaking) so the plane reads `cause`/`resetAt`
  structurally.
- **Exit codes** (part of the CLI seam — documented):

  | Situation | Exit |
  |---|---|
  | park (session-limit / out-of-credits) | `75` EX_TEMPFAIL |
  | resume HEAD-guard refusal | `65` EX_DATAERR |
  | `--inspect` diagnostic | `0` |
  | done / pr-ready | `0` |
  | blocked / no-progress | non-zero (existing throw) |

### 5.6 Testing strategy

All deterministic, no live `claude`:

1. **Adapter classification (unit).** Feed representative stderr+exit fixtures: the real
   `You've hit your session limit · resets 11:10pm` line → `cause:"session-limit"` + parsed `resetAt`;
   a credit/billing marker → `out-of-credits`; exit≠0 with unknown stderr, timeout, and spawn-error →
   `transient`.
2. **Routing (unit, via the existing `fake-runner`).** Extend `FakeRunner` to return each `cause`.
   Assert: `transient` → `markFailed` + attempt++ → retry, and 3× → escalate (regression guard);
   `session-limit`/`out-of-credits` → `ParkSignal` propagates, step stays `running`, **attempt not
   incremented**, ticket `status=waiting`, `outcome="parked"`, dispatch `outcome="parked"`, `parked`
   event appended.
3. **Park→resume round-trip (integration).** Drive to a session-limit park; assert the dump dir has
   `run.db` + `transcript.json`. Then `--resume`: completed steps not re-run (exactly-once), the
   interrupted step re-dispatches with the carryover block + ground-truth guard present, the run
   continues. **Park-loop:** park→resume→park→resume never exhausts `maxAttempts`.
4. **HEAD guard (integration).** Move branch HEAD after park: plain `--resume` refuses with exit `65`
   + diff; `--inspect` prints the diagnostic and exits `0` unchanged; `--accept-head` resumes against
   new HEAD, keeps completed steps, re-dispatches the interrupted step **without** carryover, updates
   the expected sha.

## 6. Invariants preserved

- **Provider-agnostic core** — marker strings live only in the Claude adapter; the core routes on a
  neutral enum. A second provider defaults to `transient`.
- **Daemon-persists / single-writer** — the daemon still computes and persists; park is a state
  change in the same SoT, no second writer.
- **Durable journal = exactly-once + crash-resume** — park reuses the `running`+`recover()` shape;
  completed steps never re-run.
- **Ground truth over self-report** — transcript carryover is an advisory prompt hint, never a verdict
  or score; the repo/journal remain the source of truth.
- **Loop-not-halt** — a quota/billing pause is an absorb-and-resume, not a halt-to-human; only genuine
  transient crash-loops still escalate after `maxAttempts`.

## 7. OSS / commercial-plane boundary

The core produces the dump + telemetry and exposes `styre run --resume` (OSS is self-sufficient for a
manual resume). Deciding *when* to resume — waiting out a reset clock, detecting a credit top-up,
quota-aware scheduling — is **plane** work and is explicitly **not** built into the core. See
[[styre-oss-commercial-boundary]].

## 8. Touch list (for planning)

- `src/agent/runner.ts` — `FailureCause`, `cause`/`resetAt` on `AgentRunResult`.
- `src/agent/providers/claude.ts` — marker classification → neutral cause.
- `src/agent/fake-runner.ts` — emit each cause for tests.
- `src/dispatch/run-dispatch.ts` — route cause; `ParkSignal`.
- new `ParkSignal` + park/dump module (state-dir paths, SoT move, `transcript.json`).
- `src/daemon/advance.ts` / `src/engine/step-journal.ts` — propagate `ParkSignal` past `markFailed`.
- `src/daemon/run-ticket.ts` — `RunOutcome="parked"`; catch `ParkSignal` in `driveToTerminal`;
  `resumeTicket`.
- `src/cli/run.ts` — `--resume` / `--accept-head` / `--inspect`; exit codes; rehydrate path.
- `src/daemon/recover.ts` — confirmed reused as-is (no change expected).
- `src/db/schema.sql` (**both copies**) — `event_log.kind` += `parked`; `dispatch.outcome` += `parked`
  if CHECK-constrained.
- `src/telemetry/events.ts` — optional `payload_json` on `EventEvent`.
- HEAD-guard helper (compare current branch HEAD to recorded `dispatch.branch_head_sha`).

## 9. Open items / risks

- **Marker robustness** — provider CLI wording can change. Mitigation: the markers live in one adapter
  method with unit fixtures; an unmatched death degrades safely to `transient` (retry), never a wrong
  park.
- **Partial transcript quality** — a session-limit death may emit truncated/!valid JSON. We store raw
  `stdout` regardless; the ground-truth guard covers gaps. Carryover is best-effort by design.
- **State-dir hygiene** — stale dumps if a ticket is abandoned out-of-band. Cleanup on terminal
  success is in scope; a broader GC policy is not (plane concern).
