# ENG-353 — `escalated` as a distinct run outcome

**Date:** 2026-07-21
**Ticket:** ENG-353 — *outcome: report an escalation as `escalated`, not `blocked` — one label across terminal + telemetry*
**Status:** design approved; ready for implementation plan.

## Problem

When a run gives up and hands the ticket to a human — an **escalation**: the runner
sets `ticket.status = waiting`, inserts a `human_resume` signal, and appends an
`escalated` event — the reported terminal outcome is `blocked`, the *same* word used
for a resolver dead-end (the runner found no actionable work). A human and a telemetry
consumer both see `blocked` in the terminal summary and in `summary.outcome`, unable to
tell "a human needs to unblock me, and I left you a resume point" apart from "there is
nothing more to do here." These are different events with different operator responses.

Ground truth: `styre run STYRE-7` (2026-07-16) escalated to the needs-you inbox after
`design:extract` failed, yet reported `"outcome":"blocked","status":"waiting","escalation_count":1`.

## What the post-merge code already establishes

ENG-338/350 (merged, `e9feee2`) rewrote the output layer and left the `escalated` slot
deliberately reserved:

- `src/daemon/run-ticket.ts:19` — `RunOutcome = "pr-ready" | "done" | "blocked" | "no-progress" | "parked"` (no `escalated`).
- The run **already branches** on the escalation in `driveToTerminal`: the pending-`human_resume`
  check returns `blocked` (`run-ticket.ts:109`) *before* the resolver dead-end branch returns
  `blocked` (`:126`). The two conditions are already separated in code; they merely collapse
  onto the same string.
- `src/cli/outcome.ts` comment: *"escalated is intentionally absent — it is not a RunOutcome yet (ENG-353)."*
- `src/cli/errors.ts` reserves the exit code: `TEMPFAIL: 75 // ... and, ENG-353, escalated — resumable`.
- `src/telemetry/events.ts:68` — `SummaryEvent.outcome` is an open `z.string()`, and
  `SCHEMA_VERSION = 1` bumps only on a **breaking** change.
- `src/daemon/notify.ts` already emits an `escalated` **event** to Slack via the per-tick
  sweep (`eventDecision case "escalated"`), and `notifyTerminal` already suppresses the terminal
  `blocked` ping when a `human_resume` is pending — so Slack is already correct for escalations;
  only the *outcome label* is wrong.

## Decision: new union member (not derive-at-edge)

The ticket recommended *deriving* `escalated` at each reporting edge (keep `RunOutcome` as
`blocked`, re-check pending `human_resume` at the terminal string, Slack, and `summary.outcome`).
Having read the merged code, we chose the alternative — **add `escalated` to the `RunOutcome`
union** — for these reasons:

1. **`RunOutcome` is a computed report value, not persisted SoT state.** Adding a member does
   not touch the state machine: `ticket.status = waiting`, the `human_resume` signal, and the
   `escalated` event are unchanged either way. The ENG-338 principle ("user-facing vocabulary is
   a presentation layer derived from state, not a rename of the union") is honored — `escalated`
   is a genuine terminal-condition value at the same level as `blocked`/`parked`, not a UI word
   folded into the enum; `outcomeSentence` still maps it to a human sentence.
2. **The decision is made once, where the run already branches.** `driveToTerminal:109` already
   distinguishes the escalation from the dead-end. Returning `escalated` there makes
   `escalated ⟺ pending human_resume` and `blocked ⟺ dead-end` mutually exclusive by construction
   (`:109` runs before `:126`). Deriving at the edge would instead re-run the predicate at three
   separate edges — *more* duplication, contradicting the AC's "reuse the predicate, don't duplicate."
3. **The merged code reserved exactly this shape** — the `outcome.ts` comment and the exit-75
   reservation in `errors.ts` both cite ENG-353 as the union member that fills the slot.
4. **Exhaustive switches become a compiler-enforced checklist.** `outcomeSentence` and
   `exitCodeForOutcome` switch without a `default`, so adding the member makes TypeScript flag
   every edge that must handle it — a safety net, not a risk.

## Design

### Unit 1 — shared predicate (`src/db/repos/signal.ts`)

Extract the inline escalation check into one exported function:

```ts
/** True iff the ticket has an unresolved human_resume signal — i.e. the run escalated to a
 *  human rather than hitting a resolver dead-end. The single source of the escalation predicate. */
export function hasPendingHumanResume(db: Database, ticketId: number): boolean {
  return listPending(db, ticketId).some((s) => s.signal_type === "human_resume");
}
```

Live consumer: `driveToTerminal` (the decision point). `notify.ts`'s identical inline check is
**deleted** as dead code (see Unit 6), so the extraction replaces two inline copies with one named
predicate that has a single caller — naming the escalation concept once, and giving the predicate
test a target.

### Unit 2 — the union + decision point (`src/daemon/run-ticket.ts`)

- `RunOutcome` gains `escalated`:
  `"pr-ready" | "done" | "blocked" | "no-progress" | "parked" | "escalated"`.
- `driveToTerminal` — the pending-`human_resume` branch (`:109`) returns `outcome: "escalated"`
  instead of `"blocked"`, via `hasPendingHumanResume(db, ticketId)`. The dead-end branch (`:126`)
  is unchanged (`blocked`).

### Unit 3 — presentation switches (`src/cli/outcome.ts`)

- `outcomeSentence("escalated")` → `"Escalated — a human needs to unblock this; re-run once it's resolved."`
  (em dash U+2014, straight apostrophe U+0027, matching the sibling sentences). States it's runnable
  again after a human acts — see the resume-mechanics note below for why "re-run", not "resume".
- `exitCodeForOutcome("escalated")` → `EXIT.TEMPFAIL` (75). Distinct from a dead-end's `1` (AC),
  grouped with `parked` as "come back to this," matching the reserved slot.

**Resume-mechanics note (why the sentence says "re-run", not "resume") — RESOLVED.** Investigated
during planning: an escalation is a **restart, not a resume**. `styre run` uses an ephemeral
per-run temp DB (`run.ts:169-173`) and `runTicket` `insertTicket`s a fresh row every run, starting
at stage `design` — so a later `styre run <ident>` re-ingests from the tracker and redoes all prior
work; nothing carries over. `--resume` only targets a `parked` run (it needs a park dir, which an
escalation never writes — `park.ts:170-175` throws "no parked run"), and **nothing on any run path
consumes a `human_resume` signal** (`deliverSignal`/`consumeSignal` are dead code) — a pending
`human_resume` simply dies with its discarded temp DB. Consequence for the sentence: it must **not**
promise `--resume` or "continue." The honest framing is a *retry*: the operator fixes the blocker
out-of-band, then re-runs, which re-attempts from scratch and succeeds only if the blocker is gone.
Chosen sentence: **"Escalated — a human needs to unblock this; re-run once it's resolved."** This is
a deviation from a literal reading of AC "states the run can be resumed" — flagged to the maintainer;
resumability here means "runnable again after you act," not mid-run continuation.

### Unit 4 — name the reason (`src/daemon/run-ticket.ts` `formatRunSummary`)

For `escalated`, append a `Reason: <reason>` line drawn from the latest `escalated` event
(`kind === "escalated"`, `.reason`) — the escalation sites already attach this. Suppress the raw
`Waiting on: human_resume` line for `escalated` (the same suppression `pr-ready`/`done` get):
`human_resume` is internal signal vocabulary, and the escalation framing + `Reason` already convey
that a human is needed. Result: the escalated summary names *why* and states it can be resumed.

### Unit 5 — telemetry (`src/telemetry/emitter.ts`) — no change

`buildSummary` sets `outcome: result.outcome`, so `summary.outcome` becomes `"escalated"`
automatically. `SummaryEvent.outcome` is an open `z.string()` → additive, **no `SCHEMA_VERSION`
bump**. `escalation_count`/`escalation_reasons` already carry the reason for machine consumers.

### Unit 6 — no double-notify (`src/daemon/notify.ts`)

`notifyTerminal` is called only from `driveToTerminal.finish()` (`run-ticket.ts:88`) with
`result.outcome`. After Unit 2, an escalation's outcome is `"escalated"`, so it can **never** reach
`notifyTerminal` as `"blocked"`. Therefore:

- The blocked branch's inline `human_resume` check (`notify.ts:104-105`) is now **provably dead**
  (`blocked ⟹ dead-end ⟹ no pending human_resume`) and is **deleted**: the blocked branch fires the
  dead-end ping **unconditionally**.
- Add an explicit `escalated` case that **returns without a terminal ping** — the per-tick sweep
  already emitted an `escalated` event to Slack (`eventDecision case "escalated"`), so a terminal
  ping would double-notify. (`terminalDecision`'s `default → null` would already swallow `escalated`,
  but the explicit case documents the intent.)

Consequently the extracted `hasPendingHumanResume` predicate (Unit 1) has a **single live consumer**,
`driveToTerminal` — the notifier no longer needs the check at all. AC6's "reuse rather than
duplicate" is honored by *removing* the notifier's now-dead copy, not by wiring a second caller.

Net Slack behavior is unchanged and correct: escalation → `escalated` (from the swept event);
dead-end → `Stopped — no actionable work remains.`

### Unit 7 — analytics projector (`src/telemetry/analytics/properties.ts`) — comment + test only

`runCompletedProperties` passes `outcome: summary.outcome` through raw (`:119`), so PostHog receives
`escalated` distinctly — AC3 holds in analytics with **no code change**. `failureBucket(outcome,
reasons)` (`:61-75`) is typed `outcome: string` with a fall-through (it is **not** compiler-checked —
the exhaustiveness safety net does not cover it): `escalated` falls into the keyword-classification
block, which is correct (an escalation has populated `reasons`), while a genuine dead-end (empty
reasons → `"unknown"`) is unchanged. Two touch-ups, no logic change:
- the stale comment at `:65` (its guard now serves both `escalated` and `blocked`) is corrected;
- `test/telemetry/analytics/properties.test.ts:89` encodes the now-impossible
  `{ outcome: "blocked", escalation_reasons: [...] }` combination — replace it with an `escalated`
  fixture, and add a `failureBucket("escalated", [...])` case.

## Testing

Cover the escalation-vs-dead-end split at all three surfaces plus the contract values. **New/rewritten
assertions:**

- **Terminal string** (`test/daemon/run-summary.test.ts`): an escalation renders the `escalated`
  sentence + `Reason: <reason>` and does **not** render the `blocked` sentence nor the raw
  `Waiting on: human_resume`; a dead-end still renders the `blocked` sentence. Rewrite **both**
  STYRE-7-shaped cases that hardcode the now-impossible `blocked` + pending `human_resume` combo:
  `:53` ("names the pending signal", asserts `Waiting on: human_resume`) and `:84` ("STYRE-7
  acceptance") — both become `escalated` assertions consistent with the new suppression rule.
- **`summary.outcome`** (`test/telemetry/emitter.test.ts`): an escalation emits
  `outcome: "escalated"`; a dead-end emits `"blocked"`; both keep the correct `escalation_count`.
- **Slack** (`test/daemon/notify-sweep.test.ts`): an escalation still emits the `escalated` event
  and fires **no** terminal ping (no double-notify); a dead-end fires the dead-end ping.
- **Contract** (`test/cli/outcome.test.ts`): `outcomeSentence("escalated")` is the exact string;
  `exitCodeForOutcome("escalated") === 75`.
- **Predicate** (co-locate with an existing signal test): `hasPendingHumanResume` true with a
  pending `human_resume`, false otherwise.
- **Analytics** (`test/telemetry/analytics/properties.test.ts`): replace the impossible
  `:89` `{ outcome: "blocked", escalation_reasons: [...] }` fixture with an `escalated` one; add a
  `failureBucket("escalated", [...])` case.

**Existing production-escalation tests that assert `outcome === "blocked"` and MUST be flipped to
`"escalated"`** (each already asserts `status: "waiting"` + a pending `human_resume` + an `escalated`
event, so the label is the only change — these are real `driveToTerminal` escalations, not fixtures):
- `test/dispatch/arbiter-e2e.test.ts:1333` (Flow 8)
- `test/daemon/run-ticket.test.ts:174`
- `test/daemon/docs-revise-resolve.test.ts:207`

## Scope

**In:** the six units above and their tests. **Out** (unchanged): *when* a run escalates
(escalation sites in `failure-policy.ts`/`review-verdict.ts` are untouched — this only relabels the
existing escalation); the rest of the outcome vocabulary / PR URL / timeline (ENG-338, shipped);
the `null→0` telemetry fixes (ENG-339); run identity (ENG-349).

## Blast radius

Production:
- `src/daemon/run-ticket.ts` — union member + one decision line + `formatRunSummary` (`Reason:` line).
- `src/cli/outcome.ts` — 2 switch cases.
- `src/db/repos/signal.ts` — new exported `hasPendingHumanResume` predicate.
- `src/daemon/notify.ts` — delete the dead `human_resume` check (blocked branch fires
  unconditionally), add the `escalated` no-ping case.
- `src/telemetry/analytics/properties.ts` — corrected comment only (no logic change).
- `src/cli/park.ts` — extend `finishRunResult`'s docstring (`:44-47`) to list `escalated → 75`
  (behavior is already correct via the `park.ts:65` fall-through).

Tests: `run-summary.test.ts` (rewrite `:53`, `:84`), `emitter.test.ts`, `notify-sweep.test.ts`,
`outcome.test.ts`, a `hasPendingHumanResume` predicate test, `properties.test.ts` (rewrite `:89` +
add `escalated` bucket), and the three production-escalation tests above
(`arbiter-e2e.test.ts:1333`, `run-ticket.test.ts:174`, `docs-revise-resolve.test.ts:207`).

No state-machine change, no schema bump, no change to escalation triggers. Verified negatives:
outcome is decided **only** in `driveToTerminal` (no bypass constructs `blocked` for an escalation),
and exit-75 does **not** trigger park behavior (`finishRunResult` gates the park dump on
`outcome === "parked" && out.park`, not on the exit code).
