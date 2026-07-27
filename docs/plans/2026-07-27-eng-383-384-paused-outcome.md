# ENG-383 + ENG-384: pauseTicket + outcome collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the two step-less dead-ends (`blocked`, `no-progress`) into a resumable `paused` state via a step-independent `pauseTicket`, and collapse `RunOutcome` from six arms to `pr-ready | done | paused | abandoned` (+ an internal `reason`), with unified exit codes and re-keyed telemetry/notifications.

**Architecture:** Today `driveToTerminal` (`run-ticket.ts:95-137`) emits six outcomes; `blocked`/`no-progress` are step-less quiet quitters (no signal, ticket stays `active`) and `parked`/`escalated` are distinct. This plan adds `pauseTicket(db, ticketId, detail)` — mirroring `checks-gate-verdict.ts escalate()` (`waiting` + `human_resume` + event) minus the step — routes `blocked` (in `advance.ts`) and **both** `no-progress` cases through it (→ surface as `paused(needs_you)` via the existing `hasPendingHumanResume` check), and re-labels `parked`→`paused(budget)` / `escalated`→`paused(needs_you)`. Then the `RunOutcome` type, `outcome.ts` (sentences + exit codes), `park.ts finishRunResult`, `src/cli/run.ts`'s inline tail, `formatRunSummary`, `properties.ts failureBucket`, and `src/daemon/notify.ts` are updated to the new vocabulary, and the affected tests migrated. `abandoned` is a valid `ticket.status` (`schema.sql:105`) but a RESERVED outcome no code emits this ticket (explicit-only via ENG-386) — no schema change.

**Tech Stack:** Bun + TypeScript; `bun:sqlite`; biome (`bun run lint`); `tsc --noEmit` (`bun run typecheck`); `bun test`. No new dependencies, no schema migration.

## Global Constraints

- Every task ends `bun test` + `bun run lint` + `bun run typecheck` all green.
- No new runtime dependencies; no `schema.sql` change (`abandoned` status + `note`/`escalated` event kinds + the `signal` table with no step/dispatch column all already exist).
- Follow existing repo patterns: repo helpers are plain functions taking `db: Database`; a multi-write mutation wraps in `db.transaction(() => {...})()` (see `checks-gate-verdict.ts escalate`).
- **Out of scope (do NOT implement):** the unified `--resume` gate / resume `reason`-gating (ENG-385); `styre ls` and the explicit `styre clean` → `abandoned` route (ENG-386); the live-location/lock machinery (ENG-382, already merged). `pauseTicket` here is ONLY for the step-less dead-ends — do NOT refactor the five `failure-policy.ts` inline escalate blocks or `checks-gate-verdict.ts escalate()` to route through it (they also leave a `failed` step and carry distinct signatures; note the DRY opportunity as future work).
- **Reason vocabulary:** `PauseReason = "budget" | "needs_you" | "interrupted"`. Mapping: `parked → paused(budget)`; `escalated`, `blocked`, and `no-progress` (**both** iteration-cap **and** idle-stall) → `paused(needs_you)`; `pr-ready`/`done` unchanged. **`abandoned` is a RESERVED `RunOutcome` value that NO code path emits this ticket** — reachable only via the explicit `styre clean` route (ENG-386). (`interrupted` is likewise reserved — the ENG-385 resume/crash path.) This **reverses design §3.5.2's automatic honesty-abandon**: judging "nothing actionable" reliably needs the ENG-385 re-plan, so the auto-abandon is deferred and `abandoned` stays explicit-only this cycle (design doc §3.5 comment softened to match).

---

### Task 1: `pauseTicket` step-independent pause primitive

**Files:**
- Create: `src/daemon/pause-ticket.ts`
- Test: `test/daemon/pause-ticket.test.ts` (create)

**Interfaces:**
- Consumes: `setTicketStatus` (`src/db/repos/ticket.ts:82`), `insertPending` (`src/db/repos/signal.ts:40`), `appendEvent` (`src/db/repos/event-log.ts:52`), `makeTestDb` (`test/helpers/db.ts`).
- Produces: `pauseTicket(db: Database, ticketId: number, detail: string): void` — in one transaction sets the ticket `waiting`, raises a pending `human_resume` signal, and appends an `escalated` event carrying `detail`. Idempotent enough for tests; no return value.

- [ ] **Step 1: Write the failing test**

Create `test/daemon/pause-ticket.test.ts`:
```ts
import { expect, test } from "bun:test";
import { pauseTicket } from "../../src/daemon/pause-ticket.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { hasPendingHumanResume } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { makeTestDb } from "../helpers/db.ts";

test("pauseTicket sets waiting, raises human_resume, and records the honest detail", () => {
  const { db, ticketId } = makeTestDb();
  pauseTicket(db, ticketId, "no next move on this plan — edit and resume");
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  expect(hasPendingHumanResume(db, ticketId)).toBe(true);
  const ev = listEvents(db, ticketId).filter((e) => e.kind === "escalated").at(-1);
  expect(ev?.reason).toBe("no next move on this plan — edit and resume");
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/pause-ticket.test.ts`
Expected: FAIL — module `src/daemon/pause-ticket.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/daemon/pause-ticket.ts`:
```ts
import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { insertPending } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";

/** Pause a ticket that has NO failed/running step to re-arm — a resolver dead-end (`blocked`) or a
 *  driveToTerminal stall — into the same `waiting` + pending `human_resume` shape an escalation
 *  produces, so it becomes a legible, resumable `paused (needs_you)` checkpoint that drops out of
 *  `v_ready_tickets`. `detail` is the honest note (design §3.4): it must state what a resume
 *  requires. This mirrors `checks-gate-verdict.ts escalate()` MINUS the step/dispatch specifics; it
 *  is deliberately NOT wired into the step-bearing failure-policy escalate paths (they leave a
 *  `failed` step and carry distinct signatures — a future DRY opportunity, not this ticket). */
export function pauseTicket(db: Database, ticketId: number, detail: string): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertPending(db, { ticketId, signalType: "human_resume", reason: detail });
    appendEvent(db, { ticketId, kind: "escalated", reason: detail });
  })();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/daemon/pause-ticket.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gates + commit**

Run: `bun test && bun run lint && bun run typecheck`
```bash
git add src/daemon/pause-ticket.ts test/daemon/pause-ticket.test.ts
git commit -m "feat(daemon): step-independent pauseTicket primitive (ENG-383)"
```

---

### Task 2: Collapse the outcome model + route the dead-ends

This is the atomic outcome-model change: the `RunOutcome` type, every producer in `driveToTerminal`, the `blocked` route in `advance.ts`, the retired dead branches, `outcome.ts`, `park.ts finishRunResult`, `formatRunSummary`, and the migrated core tests — all in one green boundary (the type change is not splittable without a broken intermediate). Telemetry/notify re-key is Task 3 (it can lag because its tests unit-test with literal strings; see Task 3).

**Files:**
- Modify: `src/daemon/run-ticket.ts` (`RunOutcome`/`RunResult`; `driveToTerminal` detection `:95-137`; `formatRunSummary` `:209-227`)
- Modify: `src/daemon/advance.ts` (`blocked` branch `:87-89`)
- Modify: `src/daemon/loop.ts` (retire the `blocked` flag `:37,41,49`)
- Modify: `src/cli/outcome.ts` (`outcomeSentence`, `exitCodeForOutcome`)
- Modify: `src/cli/park.ts` (`finishRunResult` `:58-72`; the duplicated tail in `resumeRun` `:351-360`)
- Modify: `src/cli/run.ts` (**B1** — its own inline tail `if (out.outcome === "parked" && out.park)` ~`:315`)
- Test (migrate in this task — they break at Task 2's typecheck/test boundary, **S1**): `test/cli/outcome.test.ts` (rewrite), `test/daemon/run-ticket.test.ts` (`:68,98,128,156,174`), `test/daemon/run-summary.test.ts` (asserts `"parked"`/`"escalated"` + a "blocked distinct from escalation" test → now `paused(needs_you)`; rewrite), `test/telemetry/emitter.test.ts:109` (`RunResult` literal `outcome:"escalated"` → typecheck error), `test/cli/park.test.ts:43-51` (`finishRunResult` `outcome:"blocked"`), `test/cli/run-analytics.test.ts:16,48` (`outcome:"parked"` fixture + `props.outcome` assertion — the `failure_bucket` half is Task 3), `test/daemon/advance.test.ts` (**S3** — ADD a case, see Step 10), `test/daemon/loop.test.ts:53-63` (**S2**). The resolver still RETURNS `{kind:"blocked"}` (unchanged descriptor) → `resolver.test.ts` likely needs no change; verify. Dispatch-row `outcome:` / `FailureDecision` / `ReviewDecision` hits (park-inplace, arbiter, failure-policy, review-verdict) are OUT of scope — different enums.

**Interfaces:**
- Consumes: `pauseTicket` (Task 1).
- Produces:
  - `RunOutcome = "pr-ready" | "done" | "paused" | "abandoned"`; `PauseReason = "budget" | "needs_you" | "interrupted"`; `RunResult` gains `reason?: PauseReason`.
  - `exitCodeForOutcome(o: RunOutcome): number` — `pr-ready`/`done`→`OK(0)`, `paused`→`TEMPFAIL(75)`, `abandoned`→`OPERATIONAL(1)`.
  - `outcomeSentence(o, reason?)` — see Step 5.

- [ ] **Step 1: Rewrite `test/cli/outcome.test.ts` (RED)**

`test/cli/outcome.test.ts:5-27` currently asserts all six old outcomes. Replace with the new contract:
```ts
import { expect, test } from "bun:test";
import { EXIT } from "../../src/cli/errors.ts";
import { exitCodeForOutcome, outcomeSentence } from "../../src/cli/outcome.ts";

test("exitCodeForOutcome: paused→75, abandoned→1, done/pr-ready→0", () => {
  expect(exitCodeForOutcome("pr-ready")).toBe(EXIT.OK);
  expect(exitCodeForOutcome("done")).toBe(EXIT.OK);
  expect(exitCodeForOutcome("paused")).toBe(EXIT.TEMPFAIL);
  expect(exitCodeForOutcome("abandoned")).toBe(EXIT.OPERATIONAL);
});

test("outcomeSentence reflects the reason for a paused run", () => {
  expect(outcomeSentence("paused", "budget")).toMatch(/budget|resume/i);
  expect(outcomeSentence("paused", "needs_you")).toMatch(/you|resume/i);
  expect(outcomeSentence("abandoned")).toMatch(/rethink|abandon|couldn't/i);
  expect(outcomeSentence("done")).toMatch(/merged|released/i);
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test test/cli/outcome.test.ts`
Expected: FAIL — `exitCodeForOutcome("paused")` etc. hit the old six-arm switch (type error under `typecheck`, wrong values at runtime).

- [ ] **Step 3: `RunOutcome` + `PauseReason` + `RunResult` (`run-ticket.ts:20-27`)**
```ts
export type RunOutcome = "pr-ready" | "done" | "paused" | "abandoned";
export type PauseReason = "budget" | "needs_you" | "interrupted";
export interface RunResult {
  outcome: RunOutcome;
  reason?: PauseReason; // set iff outcome === "paused"
  iterations: number;
  stage: string;
  status: string;
  park?: ParkInfo;
}
```

- [ ] **Step 4: Rewrite `driveToTerminal` terminal detection (`run-ticket.ts:95-137`)**

Replace the six-outcome detection. **B2 — every terminal return keeps the `return await finish({...})` wrapper** (the current returns at `run-ticket.ts:108,109,111,123,127,131,136` all call `finish()`, which does emitSummary + notifyTerminal + drainOutbox — a bare `return {...}` would skip that). Spread `...last` (the last-ticket object built at `run-ticket.ts:94,104`) for `iterations`/`stage`/`status` — **N3** — do not hand-write those fields:
```ts
    if (r.parked) return await finish({ outcome: "paused", reason: "budget", park: r.parked, ...last });
    if (t.status === "done") return await finish({ outcome: "done", ...last });
    if (hasPendingHumanResume(db, ticketId)) return await finish({ outcome: "paused", reason: "needs_you", ...last });
    // ... merge-stage pr-ready branch UNCHANGED — still `return await finish({ outcome: "pr-ready", ... })` ...
    // (the old `if (r.blocked) return await finish({ outcome: "blocked" })` at :127 is DELETED — blocked
    //  routes through pauseTicket in advance.ts and is caught by the hasPendingHumanResume check above.)
    if (r.advanced === 0) {
      idle += 1;
      if (idle >= IDLE_CAP) {
        // idle-stall: repeated zero-advance with nothing pending. DECISION (this ticket, reversing
        // design §3.5.2): pause as needs_you — NOT auto-abandon — so the human can edit + resume.
        pauseTicket(db, ticketId, "stalled with no progress — edit the ticket and resume, or 'styre clean' to drop");
        return await finish({ outcome: "paused", reason: "needs_you", ...last });
      }
    } else {
      idle = 0;
    }
  }
  // iteration-cap: was advancing but ran out of the tick budget — genuinely resumable.
  pauseTicket(db, ticketId, `hit the ${DEFAULT_CAP}-tick iteration budget; resume to continue`);
  return await finish({ outcome: "paused", reason: "needs_you", ...last });
```
Add imports to `run-ticket.ts`: `pauseTicket` (`./pause-ticket.ts`). Keep `hasPendingHumanResume`. **No** `setTicketStatus`/`appendEvent` import is needed now (the idle-stall abandon branch is gone; `abandoned` is emitted by no path this ticket). Confirm `last` carries `iterations`/`stage`/`status` at the return sites (`:94,104`); if `iterations` isn't in `last`, add it explicitly (`iterations: i` / `iterations: cap`) alongside `...last`.

- [ ] **Step 5: `outcome.ts` — sentences keyed on reason + exit codes**
```ts
export function exitCodeForOutcome(o: RunOutcome): number {
  switch (o) {
    case "pr-ready":
    case "done":
      return EXIT.OK;
    case "paused":
      return EXIT.TEMPFAIL; // 75 — resumable, every reason
    case "abandoned":
      return EXIT.OPERATIONAL; // 1 — genuine terminal
  }
}

export function outcomeSentence(o: RunOutcome, reason?: PauseReason): string {
  switch (o) {
    case "pr-ready":
      return "Opened the PR — ready for your review. Waiting on CI + merge approval.";
    case "done":
      return "Merged and released.";
    case "abandoned":
      return "Stopped — couldn't make progress and there's nothing specific to fix; rethink the ticket and start fresh.";
    case "paused":
      switch (reason) {
        case "budget":
          return "Paused — out of budget; resume anytime.";
        case "interrupted":
          return "Paused — interrupted; resume to continue.";
        default: // needs_you
          return "Paused — needs you to unblock it, then resume.";
      }
  }
}
```
(Import `PauseReason` from `run-ticket.ts`; keep the `EXIT` import.)

- [ ] **Step 6: `advance.ts` — route `blocked` through `pauseTicket` (`:87-89`)**

Replace the blocked early-return:
```ts
    if (d.kind === "blocked") {
      pauseTicket(db, ticketId, `no next move on this plan (${d.reason}) — edit the plan/code, then resume`);
      return { kind: "paused-noprogress", reason: d.reason }; // NOT "advanced"; NOT the tick blocked flag
    }
```
Add a `paused-noprogress` arm to `AdvanceOutcome` (`advance.ts:36-44`) OR reuse an existing non-advancing, non-blocked kind — pick a kind `tick()` treats as "did not advance, not blocked" so the loop falls through to the next iteration where `hasPendingHumanResume` fires. Import `pauseTicket`. **Decision:** add a distinct `{ kind: "paused-noprogress"; reason: string }` arm so `tick()` can map it explicitly (Step 7).

- [ ] **Step 7: `loop.ts` — retire the `blocked` flag (`:22-50`)**

Remove `let blocked = false` (`:37`) and the `if (outcome.kind === "blocked") blocked = true` (`:41`); drop `blocked` from the returned `{ advanced, parked }` (`:49`) and from the `tick()` signature (`:30`). **S2 — add an explicit non-counting branch for the new kind** so it doesn't fall into the `else advanced++`:
```ts
    if (outcome.kind === "parked") { parked = outcome.park; }
    else if (outcome.kind === "paused-noprogress") { /* dead-end: not an advance, not parked — driveToTerminal's hasPendingHumanResume catches the pause next iteration */ }
    else { advanced++; }
```
So a `paused-noprogress` tick returns `{advanced: <n>, parked: undefined}` and driveToTerminal proceeds to the next iteration where `hasPendingHumanResume` fires. Update `run-ticket.ts`'s `tick` destructure to drop `blocked`. Update `test/daemon/loop.test.ts:53-63` (the "must NOT be counted as an advance" test) to the `paused-noprogress` kind and **drop its `summary.blocked` assertion** (the flag is retired).

- [ ] **Step 8: `park.ts finishRunResult` + `resumeRun` tail**

`finishRunResult` (`:58-72`): the `parked`→`dumpPark` branch keyed on `out.outcome === "parked" && out.park` becomes **`out.outcome === "paused" && out.reason === "budget" && out.park`** (**N1** — keep the `&& out.park` guard; only a `budget` pause carries `park`, so a `needs_you` pause takes the plain `db.close()` tail — dumping it is ENG-385's job). The exit-code line already delegates to `exitCodeForOutcome(out.outcome)` — now 75 paused / 1 abandoned / 0 done+pr-ready. Apply the identical change to the duplicated tail in `resumeRun` (`:351-360`).

**B1 — `src/cli/run.ts` (~:315) has its OWN inline tail.** It reads `if (out.outcome === "parked" && out.park) { ... }`. Change it to `if (out.outcome === "paused" && out.reason === "budget" && out.park) { ... }` (same N1 guard). Do NOT add resume-gating anywhere — ENG-385.

- [ ] **Step 9: `formatRunSummary` (`run-ticket.ts:209-227`)**

The branch on `result.outcome === "escalated"` becomes `result.outcome === "paused" && result.reason === "needs_you"` (still prints the latest `escalated`-event reason, which `pauseTicket` and the real escalate both append). The pr-ready/done "Waiting on" suppression is unchanged. Use `outcomeSentence(result.outcome, result.reason)`.

- [ ] **Step 10: Migrate the core outcome tests**

All of these break at THIS task's typecheck/test boundary (not Task 3) — migrate them here:
- `test/cli/outcome.test.ts` — done in Step 1.
- `test/daemon/run-ticket.test.ts` (`:68,98,128,156,174`) — `outcome: "escalated"` → `outcome: "paused"` + `reason: "needs_you"`; `"pr-ready"`/`"done"` unchanged; any `blocked`/`no-progress` driven outcome → `paused(needs_you)`.
- `test/daemon/run-summary.test.ts` — rewrite the `"parked"`/`"escalated"` assertions and the "blocked distinct from escalation" test (both now `paused(needs_you)` via `formatRunSummary`).
- `test/telemetry/emitter.test.ts:109` — the `RunResult` literal `outcome:"escalated"` is now a typecheck error → change to `outcome:"paused", reason:"needs_you"`.
- `test/cli/park.test.ts:43-51` — the `finishRunResult` test with `outcome:"blocked"` → `outcome:"paused", reason:"needs_you"` (asserts the non-dump/plain-close tail; a `budget` pause would dump).
- `test/cli/run-analytics.test.ts:16,48` — the `outcome:"parked"` fixture → `outcome:"paused", reason:"budget"`, and the `props.outcome` assertion → `"paused"`. (The `failure_bucket` half of this file is Task 3.)
- **S3 — `test/daemon/advance.test.ts`: ADD a new case** (there is no existing `blocked` assertion to rename). Drive the `blocked` descriptor through `advanceOneStep` and assert the `paused-noprogress` arm's side effects: ticket now `waiting` + a pending `human_resume` (i.e. `pauseTicket` fired), and the returned kind is `paused-noprogress`.
- **S2 — `test/daemon/loop.test.ts:53-63`**: update to the `paused-noprogress` kind; drop the `summary.blocked` assertion.
- `test/daemon/resolver.test.ts` — resolver still returns `{kind:"blocked"}` (unchanged descriptor); change ONLY if a case asserts a `RunOutcome`. Verify; likely no change.
- Run each focused file to green, then the full suite + lint + typecheck.

- [ ] **Step 11: Full gates + commit**

Run: `bun test && bun run lint && bun run typecheck`
Expected: PASS. (If a telemetry/notify test fails here because it drives a real run through the collapsed outcome, that means it belongs to Task 3's surface — pull the minimal fix forward or confirm it's a literal-string unit test that still passes.)
```bash
git add -A
git commit -m "feat(run): collapse RunOutcome to paused/abandoned + route blocked/no-progress via pauseTicket (ENG-383, ENG-384)"
```

---

### Task 3: Re-key telemetry + notifications on `reason`

**Files:**
- Modify: `src/telemetry/emitter.ts` (**S4** — `buildSummary` `:156-190` must include `reason` in its return)
- Modify: `src/telemetry/events.ts` (**S4** — `SummaryEvent` zod `:74-110` gains `reason` as an optional string)
- Modify: `src/telemetry/analytics/properties.ts` (`failureBucket` `:61-76`; `runCompletedProperties` `:112-132`)
- Modify: `src/daemon/notify.ts` (**B3** — `terminalDecision`/`notifyTerminal` `:36-121`; NOT `src/cli/notify.ts`, which is the `notify --test` command)
- Test: `test/telemetry/analytics/properties.test.ts`, any `src/daemon/notify.ts` test

**Interfaces:**
- Consumes: the new `RunOutcome`/`PauseReason` (Task 2).
- Produces: `failureBucket(outcome, reason, escalationReasons)`. **S4 — `reason` on the summary is mandatory:** add it to `buildSummary`'s return (`emitter.ts:156-190`) and the `SummaryEvent` schema (`events.ts:74-110`, optional string), then key the bucket on it. Without `reason`, a `budget` pause has empty `escalation_reasons` and loses its `parked-credits` bucket. (`success = outcome === "pr-ready"` stays correct.)

- [ ] **Step 1: Rewrite the `failureBucket` tests (RED)**

In `test/telemetry/analytics/properties.test.ts`, replace the old-string cases: a `paused` run with `reason:"budget"` → `"parked-credits"`; `paused`/`needs_you` → keyword-classified (or `"needs-you"`); `abandoned` → `"no-progress"` (or a new `"abandoned"` bucket — pick one and pin it); `pr-ready`/`done` → `null`.

- [ ] **Step 2: Run to verify FAIL**, then implement:

- [ ] **Step 3: `failureBucket` (`properties.ts:61-76`)** — re-key:
```ts
function failureBucket(outcome: string, reason: string | null | undefined, escalationReasons: string[]): string | null {
  if (outcome === "pr-ready" || outcome === "done") return null;
  if (outcome === "paused" && reason === "budget") return "parked-credits";
  if (outcome === "abandoned") return "no-progress";
  // paused(needs_you): keyword-classify the escalation reasons exactly as before (:66-75, unchanged).
  const joined = escalationReasons.join(" ").toLowerCase();
  // ... existing keyword ladder ...
}
```
Thread `summary.reason` into the `failureBucket(summary.outcome, summary.reason, summary.escalation_reasons)` call at `properties.ts:128`. `runCompletedProperties.success` (`:118`) stays `outcome === "pr-ready"`. Ensure `reason` is an `ALLOWED_KEYS` field if emitted (`:151-185`); add `reason` to the summary event schema (`events.ts:83` area) as an optional string if not present.

- [ ] **Step 4: `src/daemon/notify.ts` (`:36-121`)** (B3 — daemon, not cli) — `terminalDecision`/`notifyTerminal` branch on the old outcome strings; re-key on the new `outcome`. **N2 — don't over-thread `reason`**: `notifyTerminal(outcome)`'s existing signature is fine; just map the new values (a `paused` run notifies as the old escalation/park did per the operator's `notify` policy). `abandoned` is emitted by no path this ticket, so no `abandoned` branch is needed. Update any `src/daemon/notify.ts` test to match.

- [ ] **Step 5: Full gates + commit**

Run: `bun test && bun run lint && bun run typecheck`
```bash
git add -A
git commit -m "feat(telemetry): re-key failureBucket + notify on paused reason (ENG-384)"
```

---

## Self-Review

**Spec coverage:**
- `pauseTicket` step-independent primitive → Task 1. ✓
- Route `blocked` (advance) → Task 2 Step 6/7. ✓
- Route `no-progress` — BOTH iteration-cap AND idle-stall → paused(needs_you) via pauseTicket → Task 2 Step 4. ✓ (`abandoned` reserved/unemitted this ticket.)
- Retire dead `r.blocked` branch + tick `blocked` flag → Task 2 Steps 4,7 (+ S2 explicit `paused-noprogress` branch). ✓
- Honest-note (`detail`) on every pause → Task 1, Task 2 Step 4/6. ✓
- `RunOutcome` collapse + `reason` + exit codes → Task 2 Steps 3,5. ✓
- `park.ts finishRunResult` (dump on paused) → Task 2 Step 8. ✓
- Telemetry + notify re-key → Task 3. ✓
- Test migration → folded into the task whose code necessitates it (Task 2 core tests, Task 3 telemetry/notify tests). ✓

**Placeholder scan:** the `driveToTerminal` return in Step 4's iteration-cap and the `advance.ts` `AdvanceOutcome` arm reference "the current stage/status" and "an existing non-advancing kind" — the implementer must read the exact surrounding fields at implementation time; these are grounded in `run-ticket.ts:95-137` and `advance.ts:36-44` and are transcription-with-context, not TBDs. Every other code step carries full code.

**Type consistency:** `RunOutcome`/`PauseReason`/`RunResult.reason` used identically in Tasks 2–3; `outcomeSentence(o, reason?)` and `exitCodeForOutcome(o)` signatures consistent across `outcome.ts` and callers (`formatRunSummary`, `finishRunResult`).

## Residual open questions

- **idle-stall → `paused(needs_you)` — DECIDED (was the #1 open question).** The plan review adopted routing idle-stall to `paused(needs_you)` (like `blocked`) rather than design §3.5.2's auto-abandon: both dead-ends are "no next move," so pausing both is consistent, and a reliable "nothing actionable" judgment needs the ENG-385 re-plan. `abandoned` stays a reserved outcome, reachable only via the explicit `styre clean` route (ENG-386). Design doc §3.5 softened to match.
- **`AdvanceOutcome` new kind name** (`paused-noprogress`) vs reusing an existing non-advancing kind — implementer's discretion, but it must NOT be counted as advanced and must NOT set any blocked flag.
- **Summary event `reason` field** — confirm whether `reason` needs adding to the summary zod schema (`events.ts`) for the telemetry bucket, or whether the bucket can read it off `RunResult` before the summary is built.
