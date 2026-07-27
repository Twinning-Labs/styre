# ENG-383 + ENG-384: pauseTicket + outcome collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the two step-less dead-ends (`blocked`, `no-progress`) into a resumable `paused` state via a step-independent `pauseTicket`, and collapse `RunOutcome` from six arms to `pr-ready | done | paused | abandoned` (+ an internal `reason`), with unified exit codes and re-keyed telemetry/notifications.

**Architecture:** Today `driveToTerminal` (`run-ticket.ts:95-137`) emits six outcomes; `blocked`/`no-progress` are step-less quiet quitters (no signal, ticket stays `active`) and `parked`/`escalated` are distinct. This plan adds `pauseTicket(db, ticketId, detail)` — mirroring `checks-gate-verdict.ts escalate()` (`waiting` + `human_resume` + event) minus the step — routes `blocked` (in `advance.ts`) and `no-progress` iteration-cap through it (→ surface as `paused` via the existing `hasPendingHumanResume` check), routes the idle-stall through an honesty-abandon (→ `abandoned`), and re-labels `parked`→`paused(budget)` / `escalated`→`paused(needs_you)`. Then the `RunOutcome` type, `outcome.ts` (sentences + exit codes), `park.ts finishRunResult`, `formatRunSummary`, `properties.ts failureBucket`, and `notify.ts` are updated to the new vocabulary, and the affected tests migrated. `abandoned` is already a valid `ticket.status` (`schema.sql:105`) — no schema change.

**Tech Stack:** Bun + TypeScript; `bun:sqlite`; biome (`bun run lint`); `tsc --noEmit` (`bun run typecheck`); `bun test`. No new dependencies, no schema migration.

## Global Constraints

- Every task ends `bun test` + `bun run lint` + `bun run typecheck` all green.
- No new runtime dependencies; no `schema.sql` change (`abandoned` status + `note`/`escalated` event kinds + the `signal` table with no step/dispatch column all already exist).
- Follow existing repo patterns: repo helpers are plain functions taking `db: Database`; a multi-write mutation wraps in `db.transaction(() => {...})()` (see `checks-gate-verdict.ts escalate`).
- **Out of scope (do NOT implement):** the unified `--resume` gate / resume `reason`-gating (ENG-385); `styre ls` and the explicit `styre clean` → `abandoned` route (ENG-386); the live-location/lock machinery (ENG-382, already merged). `pauseTicket` here is ONLY for the step-less dead-ends — do NOT refactor the five `failure-policy.ts` inline escalate blocks or `checks-gate-verdict.ts escalate()` to route through it (they also leave a `failed` step and carry distinct signatures; note the DRY opportunity as future work).
- **Reason vocabulary:** `PauseReason = "budget" | "needs_you" | "interrupted"`. Mapping from the old outcomes: `parked → paused(budget)`; `escalated`, `blocked`, `no-progress`(iteration-cap) → `paused(needs_you)`; `no-progress`(idle-stall) → `abandoned`; `pr-ready`/`done` unchanged. (`interrupted` is produced only by the ENG-385 resume/crash path — reserve the value, don't emit it here.)

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
- Test: `test/cli/outcome.test.ts` (rewrite), `test/daemon/run-ticket.test.ts`, `test/daemon/advance.test.ts`, `test/daemon/loop.test.ts`, `test/daemon/resolver.test.ts` (only where they assert a `RunOutcome`; the resolver still RETURNS `{kind:"blocked"}` — that descriptor is unchanged, so resolver.test.ts likely needs no change; verify).

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

Replace the six-outcome detection with:
```ts
    if (r.parked) return { outcome: "paused", reason: "budget", iterations: i, stage: t.stage, status: t.status, park: r.parked };
    if (t.status === "done") return { outcome: "done", iterations: i, stage: t.stage, status: t.status };
    if (hasPendingHumanResume(db, ticketId)) return { outcome: "paused", reason: "needs_you", iterations: i, stage: t.stage, status: t.status };
    // ... merge-stage pr-ready branch UNCHANGED (run-ticket.ts:112-124) ...
    // (the old `if (r.blocked) return "blocked"` at :127 is DELETED — blocked now routes through
    //  pauseTicket in advance.ts and is caught by the hasPendingHumanResume check above.)
    if (r.advanced === 0) {
      idle += 1;
      if (idle >= IDLE_CAP) {
        // idle-stall: repeated zero-advance with nothing pending and no dead-end signal raised —
        // an opaque stall with nothing actionable to hand the human (design §3.5.2 honesty-abandon).
        setTicketStatus(db, ticketId, "abandoned");
        appendEvent(db, { ticketId, kind: "note", reason: "abandoned: stalled with no progress and nothing actionable — edit the ticket and start fresh, or drop it" });
        return { outcome: "abandoned", iterations: i, stage: t.stage, status: t.status };
      }
    } else {
      idle = 0;
    }
  }
  // iteration-cap: was making progress but ran out of the tick budget — genuinely resumable.
  pauseTicket(db, ticketId, `hit the ${DEFAULT_CAP}-tick iteration budget; resume to continue`);
  return { outcome: "paused", reason: "needs_you", iterations: cap, stage: /* current */, status: /* current */ };
```
Add imports to `run-ticket.ts`: `setTicketStatus` (`../db/repos/ticket.ts`), `appendEvent` (`../db/repos/event-log.ts`), `pauseTicket` (`./pause-ticket.ts`). Keep `hasPendingHumanResume` import. Match the exact `RunResult` field set the surrounding code already returns (stage/status from the last `getTicket`).

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

Remove `let blocked = false` (`:37`) and the `if (outcome.kind === "blocked") blocked = true` (`:41`); drop `blocked` from the returned `{ advanced, parked }` (`:49`) and from the `tick()` signature (`:30`). A `paused-noprogress` outcome (Step 6) is neither advanced nor parked → the loop returns `{advanced: <n>, parked: undefined}` and driveToTerminal proceeds to the next iteration, where `hasPendingHumanResume` catches the pause. Update `run-ticket.ts`'s `tick` destructure to drop `blocked` (the `r.blocked` read at `:127` is already deleted in Step 4).

- [ ] **Step 8: `park.ts finishRunResult` + `resumeRun` tail**

`finishRunResult` (`:58-72`): the `parked`→`dumpPark` branch keyed on `out.outcome === "parked"` must become `out.outcome === "paused"` (dump on a pause; note `reason` is on `out.reason`). The exit code line already delegates to `exitCodeForOutcome(out.outcome)` — now returns 75 for paused, 1 for abandoned, 0 for done/pr-ready. Apply the identical change to the duplicated tail in `resumeRun` (`:351-360`). (Do NOT add resume-gating — ENG-385.)

- [ ] **Step 9: `formatRunSummary` (`run-ticket.ts:209-227`)**

The branch on `result.outcome === "escalated"` becomes `result.outcome === "paused" && result.reason === "needs_you"` (still prints the latest `escalated`-event reason, which `pauseTicket` and the real escalate both append). The pr-ready/done "Waiting on" suppression is unchanged. Use `outcomeSentence(result.outcome, result.reason)`.

- [ ] **Step 10: Migrate the core outcome tests**

- `test/cli/outcome.test.ts` — done in Step 1.
- `test/daemon/run-ticket.test.ts` (`:68,98,128,156,174`) — any assertion of `outcome: "escalated"` becomes `outcome: "paused"` + `reason: "needs_you"`; `"pr-ready"`/`"done"` unchanged. If a test drove a `blocked`/`no-progress` outcome, update to `paused`/`abandoned` per the mapping.
- `test/daemon/advance.test.ts` (1 hit), `test/daemon/loop.test.ts` (1 hit) — update the `blocked` assertions to the new `paused-noprogress` kind / dropped flag.
- `test/daemon/resolver.test.ts` — the resolver still returns `{kind:"blocked"}` (unchanged); update ONLY if a case asserts a `RunOutcome`. Verify; likely no change.
- Run each focused file to green, then the full suite.

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
- Modify: `src/telemetry/analytics/properties.ts` (`failureBucket` `:61-76`; `runCompletedProperties` `:112-132`)
- Modify: `src/cli/notify.ts` (`terminalDecision`/`notifyTerminal` `:36-121`)
- Test: `test/telemetry/analytics/properties.test.ts`, any `notify` test

**Interfaces:**
- Consumes: the new `RunOutcome`/`PauseReason` (Task 2). The summary carries `outcome` + `reason` (thread `reason` into the summary event if not already — check `emitter.ts:165`/`events.ts:83`; add `reason` to the summary shape if the bucket needs it).
- Produces: `failureBucket` keyed on `(outcome, reason, escalationReasons)`.

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

- [ ] **Step 4: `notify.ts` (`:36-121`)** — `terminalDecision`/`notifyTerminal` branch on the old outcome strings; re-key on the new `outcome`+`reason` (a `paused` run notifies as the old escalation/park would per the operator's `notify` policy; `abandoned` notifies like the old `no-progress`). Update any notify test to match.

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
- Route `no-progress` iteration-cap → paused(needs_you); idle-stall → abandoned → Task 2 Step 4. ✓ (see open question)
- Retire dead `r.blocked` branch + tick `blocked` flag → Task 2 Steps 4,7. ✓
- Honest-note (`detail`) on every pause + the abandoned note → Task 1, Task 2 Step 4/6. ✓
- `RunOutcome` collapse + `reason` + exit codes → Task 2 Steps 3,5. ✓
- `park.ts finishRunResult` (dump on paused) → Task 2 Step 8. ✓
- Telemetry + notify re-key → Task 3. ✓
- Test migration → folded into the task whose code necessitates it (Task 2 core tests, Task 3 telemetry/notify tests). ✓

**Placeholder scan:** the `driveToTerminal` return in Step 4's iteration-cap and the `advance.ts` `AdvanceOutcome` arm reference "the current stage/status" and "an existing non-advancing kind" — the implementer must read the exact surrounding fields at implementation time; these are grounded in `run-ticket.ts:95-137` and `advance.ts:36-44` and are transcription-with-context, not TBDs. Every other code step carries full code.

**Type consistency:** `RunOutcome`/`PauseReason`/`RunResult.reason` used identically in Tasks 2–3; `outcomeSentence(o, reason?)` and `exitCodeForOutcome(o)` signatures consistent across `outcome.ts` and callers (`formatRunSummary`, `finishRunResult`).

## Residual open questions

- **idle-stall → `abandoned` (the #1 call to scrutinize).** Per design §3.5.2 an opaque idle-stall auto-abandons, while `blocked` (also "no next move") → `paused(needs_you)`. The distinction: `blocked` is a clean resolver dead-end a human can re-plan by editing; an idle-stall is repeated zero-advance with nothing actionable. But once `blocked` routes through `pauseTicket` (raising `human_resume`, caught immediately by `hasPendingHumanResume`), the idle-stall path may rarely fire in practice. **Alternative to weigh in review:** route idle-stall → `paused(needs_you)` too (with a "stalled — edit and resume, or `styre clean` to drop" note) and keep `abandoned` reachable ONLY via the explicit `styre clean` route (ENG-386), i.e. no automatic abandon in this ticket. That is more consistent (both dead-ends → paused) and defers the one automatic terminal until the model has soaked. Flagging for the independent plan review + human to choose; the plan implements the design-literal (idle-stall → abandoned) unless overridden.
- **`AdvanceOutcome` new kind name** (`paused-noprogress`) vs reusing an existing non-advancing kind — implementer's discretion, but it must NOT be counted as advanced and must NOT set any blocked flag.
- **Summary event `reason` field** — confirm whether `reason` needs adding to the summary zod schema (`events.ts`) for the telemetry bucket, or whether the bucket can read it off `RunResult` before the summary is built.
