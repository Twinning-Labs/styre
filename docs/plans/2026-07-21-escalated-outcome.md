# `escalated` Run Outcome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report an escalation (runner set the ticket `waiting` + inserted a `human_resume` signal) as a distinct `escalated` outcome — not `blocked` — consistently in the terminal summary, the machine `summary.outcome`, and Slack.

**Architecture:** `escalated` becomes a new member of the computed `RunOutcome` union, populated at the single place the run already distinguishes an escalation from a resolver dead-end (`driveToTerminal`'s pending-`human_resume` branch, which runs *before* the dead-end branch). No SQLite state-machine change, no telemetry schema bump. The escalation predicate is extracted once and reused. Design doc: `docs/brainstorms/2026-07-21-escalated-outcome-design.md`.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, zod, biome (lint/format), bun test.

## Global Constraints

- **User-facing sentences** use the em dash U+2014 and the straight apostrophe U+0027 (matching the sibling `outcomeSentence` strings). The `escalated` sentence is verbatim: `Escalated — a human needs to unblock this; re-run once it's resolved.`
- **Exit code** for `escalated` is `EXIT.TEMPFAIL` (75) — distinct from a dead-end's `1`, grouped with `parked` (the reserved slot in `errors.ts`).
- **No `SCHEMA_VERSION` bump.** `SummaryEvent.outcome` is an open `z.string()`; a new value is additive.
- **`escalated ⟺ pending `human_resume`** and **`blocked ⟺ resolver dead-end`** are mutually exclusive by branch order (`run-ticket.ts:109` precedes `:126`). Do not change *when* a run escalates — only how it is labelled. Escalation trigger sites (`failure-policy.ts`, `review-verdict.ts`, `arbiter-verdict.ts`, `checks-*-verdict.ts`) are OUT of scope and untouched.
- **The escalation predicate is defined once** (`hasPendingHumanResume`, Task 1) and its sole live consumer is `driveToTerminal`. The notifier's old inline copy is deleted (Task 4), not re-wired.
- **Resume mechanics (resolved):** an escalation is a *restart, not a resume* (fresh temp DB, re-ingest, no `human_resume` consumer, `--resume` needs a park dump escalations don't write). The sentence therefore says **re-run**, never `--resume`. See the design doc's resume-mechanics note.
- **Every task ends green:** run the named tests plus `bun run typecheck` and `bun run lint` — all must pass before the task is complete. (Auto-fix formatting with `bun run format` if lint flags style.)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/db/repos/signal.ts` | signal queries | **add** `hasPendingHumanResume` (Task 1) |
| `src/daemon/run-ticket.ts` | `RunOutcome` union; `driveToTerminal` decision; `formatRunSummary` | **union member** (Task 2), **flip decision + Reason line** (Task 3) |
| `src/cli/outcome.ts` | outcome → sentence / exit code | **add `escalated` cases** (Task 2) |
| `src/cli/park.ts` | `finishRunResult` terminal handler | **docstring only** (Task 2) |
| `src/daemon/notify.ts` | Slack decisions | **delete dead check, add `escalated` no-ping** (Task 4) |
| `src/telemetry/analytics/properties.ts` | analytics buckets | **comment only** (Task 5) |

Tests: `test/cli/outcome.test.ts`, `test/telemetry/emitter.test.ts` (Task 2); `test/daemon/run-summary.test.ts`, `test/daemon/run-ticket.test.ts`, `test/daemon/docs-revise-resolve.test.ts`, `test/dispatch/arbiter-e2e.test.ts` (Task 3); `test/daemon/notify-sweep.test.ts` (Task 4); `test/telemetry/analytics/properties.test.ts` (Task 5); a new `hasPendingHumanResume` test (Task 1).

---

## Task 1: `hasPendingHumanResume` predicate

**Files:**
- Modify: `src/db/repos/signal.ts` (add exported function after `listPending`, ~`:31`)
- Test: `test/db/signal-predicate.test.ts` (new)

**Interfaces:**
- Consumes: `listPending(db, ticketId): SignalRow[]` (existing, same file).
- Produces: `hasPendingHumanResume(db: Database, ticketId: number): boolean` — consumed by `driveToTerminal` in Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/db/signal-predicate.test.ts`:

```ts
import { expect, test } from "bun:test";
import { hasPendingHumanResume, insertPending } from "../../src/db/repos/signal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("hasPendingHumanResume: true iff a pending human_resume signal exists", () => {
  const { db, ticketId } = makeTestDb();
  expect(hasPendingHumanResume(db, ticketId)).toBe(false);

  // A different pending signal must not count.
  insertPending(db, { ticketId, signalType: "human_merge_approval" });
  expect(hasPendingHumanResume(db, ticketId)).toBe(false);

  insertPending(db, { ticketId, signalType: "human_resume", reason: "boom" });
  expect(hasPendingHumanResume(db, ticketId)).toBe(true);

  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/signal-predicate.test.ts`
Expected: FAIL — `hasPendingHumanResume` is not exported / not a function.

- [ ] **Step 3: Add the predicate**

In `src/db/repos/signal.ts`, immediately after `listPending` (ends ~`:31`), add:

```ts
/** True iff the ticket has a pending `human_resume` signal — i.e. the run escalated to a human
 *  rather than hitting a resolver dead-end. The single source of the escalation predicate; the
 *  runner's terminal decision reads it to report `escalated` vs `blocked`. */
export function hasPendingHumanResume(db: Database, ticketId: number): boolean {
  return listPending(db, ticketId).some((s) => s.signal_type === "human_resume");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db/signal-predicate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint`
Expected: clean.

```bash
git add src/db/repos/signal.ts test/db/signal-predicate.test.ts
git commit -m "feat(signal): add hasPendingHumanResume escalation predicate (ENG-353)"
```

---

## Task 2: `escalated` as a valid outcome — union member, sentence, exit code, telemetry passthrough

**Files:**
- Modify: `src/daemon/run-ticket.ts:19` (union) and its `outcome.ts` header dependency
- Modify: `src/cli/outcome.ts` (both switches + header comment)
- Modify: `src/cli/park.ts:40-65` (docstring + inline comment only)
- Modify: `src/cli/errors.ts:13` (tidy the reserved-slot comment)
- Test: `test/cli/outcome.test.ts` (extend), `test/telemetry/emitter.test.ts` (add an escalated summary case)

**Interfaces:**
- Consumes: `EXIT.TEMPFAIL` (`errors.ts`), the existing `RunOutcome` union.
- Produces: `RunOutcome` now includes `"escalated"`; `outcomeSentence("escalated")` and `exitCodeForOutcome("escalated")` are total. `driveToTerminal` still returns `"blocked"` for escalations after this task (flipped in Task 3) — build and all existing tests stay green.

- [ ] **Step 1: Write the failing tests**

Extend `test/cli/outcome.test.ts` — add to the "sentences" test:

```ts
  expect(outcomeSentence("escalated")).toBe(
    "Escalated — a human needs to unblock this; re-run once it's resolved.",
  );
```

and add a new exit-code test:

```ts
test("exit code: escalated is 75 (resumable), distinct from a dead-end's 1", () => {
  expect(exitCodeForOutcome("escalated")).toBe(75);
  expect(exitCodeForOutcome("escalated")).not.toBe(exitCodeForOutcome("blocked"));
});
```

Add an escalated summary case to `test/telemetry/emitter.test.ts` (reuses the file's `makeTestDb`, `appendEvent`, `createTelemetryEmitter`, and `sink` pattern):

```ts
test("emitSummary: an escalated outcome passes through to summary.outcome, with escalation reasons", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, { ticketId, kind: "escalated", reason: "step 'design:extract' failed" });
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));
  emitter.emitSummary(db, ticketId, {
    outcome: "escalated",
    iterations: 3,
    stage: "design",
    status: "waiting",
  });
  const summary = sink.find((e) => e.type === "summary");
  if (!summary || summary.type !== "summary") throw new Error("no summary emitted");
  expect(summary.outcome).toBe("escalated");
  expect(summary.escalation_count).toBe(1);
  expect(summary.escalation_reasons).toContain("step 'design:extract' failed");
  db.close();
});
```

> `test/telemetry/emitter.test.ts` already imports `appendEvent` and `makeTestDb` — no import change needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/cli/outcome.test.ts test/telemetry/emitter.test.ts`
Expected: RED at runtime. `bun test` strips types and runs (it does **not** typecheck), so the red is a runtime assertion failure, not a compile error: before Step 4, `outcomeSentence("escalated")` matches no `case` and — with no `default` — returns `undefined`, failing `.toBe(the sentence)`; `exitCodeForOutcome("escalated")` likewise returns `undefined`, failing `.toBe(75)`. (The type-level "switch not total" error surfaces separately under `bun run typecheck` once the union member is added in Step 3.)

- [ ] **Step 3: Add the union member**

In `src/daemon/run-ticket.ts:19`:

```ts
export type RunOutcome = "pr-ready" | "done" | "blocked" | "no-progress" | "parked" | "escalated";
```

- [ ] **Step 4: Handle it in both `outcome.ts` switches**

In `src/cli/outcome.ts`, replace the header comment (`:4-5`) and add the two cases:

```ts
/** The user-facing sentence for a terminal outcome (presentation layer, NOT a state rename).
 *  `escalated` is a distinct outcome from `blocked`: the run explicitly handed the ticket to a
 *  human (pending `human_resume`), rather than hitting a resolver dead-end (ENG-353). */
export function outcomeSentence(o: RunOutcome): string {
  switch (o) {
    case "pr-ready":
      return "Opened the PR — ready for your review. Waiting on CI + merge approval.";
    case "done":
      return "Merged and released.";
    case "parked":
      return "Paused — ran out of budget; resume anytime.";
    case "blocked":
      return "Stopped — no actionable work remains.";
    case "no-progress":
      return "Stopped — couldn't make progress.";
    case "escalated":
      return "Escalated — a human needs to unblock this; re-run once it's resolved.";
  }
}
```

```ts
export function exitCodeForOutcome(o: RunOutcome): number {
  switch (o) {
    case "pr-ready":
    case "done":
      return EXIT.OK;
    case "parked":
    case "escalated":
      return EXIT.TEMPFAIL;
    case "blocked":
    case "no-progress":
      return EXIT.OPERATIONAL;
  }
}
```

- [ ] **Step 5: Update the two docstrings/comments that enumerate outcomes**

In `src/cli/errors.ts:13`, the `TEMPFAIL` comment already mentions ENG-353 — leave it, or tidy to:
`TEMPFAIL: 75, // parked (out of budget) and escalated (handed to a human) — both resumable-later`.

In `src/cli/park.ts`, extend `finishRunResult`'s docstring (`:44-47`) and the inline comment (`:65`):

```ts
 * - parked: calls `dumpPark` (which closes db), sets `process.exitCode = 75`, returns.
 * - escalated: closes db, sets `process.exitCode = 75` (resumable-later like a park, but it writes
 *   no dump — it takes the plain `db.close()` path below).
 * - blocked | no-progress: closes db, sets `process.exitCode = 1` (via `exitCodeForOutcome`),
 *   returns — this is an operational stop, not a bug, so it must not throw a stack trace.
 * - otherwise (pr-ready | done): closes db, sets `process.exitCode = 0`, returns.
```

and the inline comment at the fall-through:

```ts
  process.exitCode = exitCodeForOutcome(out.outcome); // 0 pr-ready/done · 1 blocked/no-progress · 75 escalated
```

(No logic change in `park.ts` — an escalated run has `outcome !== "parked"` and no `park`, so it takes the `db.close()` + `exitCodeForOutcome` path, which now yields 75.)

- [ ] **Step 6: Run the tests + full suite to verify green**

Run: `bun test test/cli/outcome.test.ts test/telemetry/emitter.test.ts && bun run typecheck && bun run lint`
Expected: PASS / clean. Then a spot-check that nothing else broke from the union change:
Run: `bun test test/daemon/run-ticket.test.ts test/dispatch/arbiter-e2e.test.ts test/daemon/docs-revise-resolve.test.ts`
Expected: PASS — these still assert `"blocked"` and `driveToTerminal` still returns `"blocked"` (unchanged this task).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/run-ticket.ts src/cli/outcome.ts src/cli/park.ts src/cli/errors.ts \
        test/cli/outcome.test.ts test/telemetry/emitter.test.ts
git commit -m "feat(cli): add escalated to RunOutcome with sentence + exit 75 (ENG-353)"
```

---

## Task 3: flip the decision point + name the reason in the terminal summary

**Files:**
- Modify: `src/daemon/run-ticket.ts` — `driveToTerminal` decision (`:104-110`), `formatRunSummary` (`:204-217`)
- Test: `test/daemon/run-summary.test.ts` (rewrite `:53` and `:84`), and flip the three production-escalation assertions: `test/daemon/run-ticket.test.ts:174`, `test/daemon/docs-revise-resolve.test.ts:207`, `test/dispatch/arbiter-e2e.test.ts:1333`

**Interfaces:**
- Consumes: `hasPendingHumanResume` (Task 1); `RunOutcome` with `escalated` (Task 2); `EventLogRow.kind`/`.reason` (existing, imported in `run-ticket.ts`).
- Produces: `driveToTerminal` returns `{ outcome: "escalated" }` for an escalation; `formatRunSummary` renders the `escalated` sentence + a `Reason:` line and suppresses `Waiting on: human_resume`.

- [ ] **Step 1: Rewrite the terminal-string tests (red)**

In `test/daemon/run-summary.test.ts`, rewrite the two STYRE-7-shaped cases (`:53` and `:84`) to the new reality. Replace them with:

```ts
test("formatRunSummary: an escalation reports `escalated`, names the reason, hides internal vocab", () => {
  const { db, ticketId } = makeTestDb();
  insertPending(db, { ticketId, signalType: "human_resume" });
  appendEvent(db, { ticketId, kind: "escalated", reason: "step 'design:extract' failed" });

  const s = formatRunSummary(db, ticketId, {
    outcome: "escalated",
    iterations: 3,
    stage: "design",
    status: "waiting",
  });
  db.close();

  expect(s).toContain("Escalated — a human needs to unblock this; re-run once it's resolved.");
  expect(s).toContain("Reason: step 'design:extract' failed");
  // The blocked sentence and the raw internal signal name must NOT appear for an escalation.
  expect(s).not.toContain("Stopped — no actionable work remains.");
  expect(s).not.toContain("Waiting on: human_resume");
  // No internal detector vocabulary, no stack frames.
  expect(s).not.toContain("no-progress");
  expect(s).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
});

test("formatRunSummary: a resolver dead-end still reports `blocked` (distinct from an escalation)", () => {
  const { db, ticketId } = makeTestDb();
  // No pending human_resume, no escalated event → a genuine dead-end.
  const s = formatRunSummary(db, ticketId, {
    outcome: "blocked",
    iterations: 2,
    stage: "implement",
    status: "active",
  });
  db.close();

  expect(s).toContain("Stopped — no actionable work remains.");
  expect(s).not.toContain("Escalated");
});
```

> `test/daemon/run-summary.test.ts` already imports `appendEvent`, `insertPending`, `recordDelivered`, `makeTestDb`, and `formatRunSummary` — no new imports needed.

- [ ] **Step 2: Flip the three production-escalation assertions (red)**

Each already asserts `status: "waiting"` + a pending `human_resume` + (usually) an `escalated` event — only the outcome label changes.

- `test/daemon/run-ticket.test.ts:174`: `expect(r.outcome).toBe("blocked");` → `expect(r.outcome).toBe("escalated");`
- `test/daemon/docs-revise-resolve.test.ts:207`: `expect(result.outcome).toBe("blocked");` → `expect(result.outcome).toBe("escalated");` (and update the `:206` comment: `// Escalated, not silently wedged: 'escalated' (a human_resume pending signal), never 'no-progress'.`)
- `test/dispatch/arbiter-e2e.test.ts:1333`: `expect(r.outcome).toBe("blocked");` → `expect(r.outcome).toBe("escalated");` (and update the nearby comment referencing "blocked" to "escalated").

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/daemon/run-summary.test.ts test/daemon/run-ticket.test.ts test/daemon/docs-revise-resolve.test.ts test/dispatch/arbiter-e2e.test.ts`
Expected: FAIL — `driveToTerminal` still returns `"blocked"`, and `formatRunSummary` renders the blocked sentence with no `Reason:` line.

- [ ] **Step 4: Flip the decision point**

In `src/daemon/run-ticket.ts`, add the import and change the escalation branch. First extend the `signal.ts` import (`:7`):

```ts
import { getDeliveredPayload, hasPendingHumanResume, listPending } from "../db/repos/signal.ts";
```

Then replace the pending-`human_resume` branch (`:109-110`) — note `pending` is still computed at `:104` and used by the `human_merge_approval` check at `:111`, so leave that line; only the escalation test and its outcome change:

```ts
    if (hasPendingHumanResume(db, opts.ticketId))
      return await finish({ outcome: "escalated", iterations: i, ...last });
```

- [ ] **Step 5: Add the `Reason:` line + suppress `Waiting on:` in `formatRunSummary`**

In `src/daemon/run-ticket.ts`, `formatRunSummary` (`:204-217`), change the body so an escalation names its reason and doesn't print the raw pending signal:

```ts
export function formatRunSummary(db: Database, ticketId: number, result: RunResult): string {
  const events = listByTicket(db, ticketId);
  const pr = getDeliveredPayload(db, ticketId, "external_pr_result");
  const prUrl = typeof pr?.url === "string" ? pr.url : undefined;
  const pending = listPending(db, ticketId).map((s) => s.signal_type);
  const lines: string[] = [outcomeSentence(result.outcome)];
  if (prUrl) lines.push(`PR: ${prUrl}`);
  if (result.outcome === "escalated") {
    // Name WHY (the latest escalated event's reason); the pending `human_resume` signal name is
    // internal vocabulary and is intentionally not printed for an escalation.
    const reason = [...events].reverse().find((e) => e.kind === "escalated")?.reason;
    if (reason) lines.push(`Reason: ${reason}`);
  } else if (
    pending.length > 0 &&
    result.outcome !== "pr-ready" &&
    result.outcome !== "done"
  ) {
    lines.push(`Waiting on: ${pending.join(", ")}`);
  }
  lines.push(`Stage ${result.stage} · ${result.iterations} ticks · ${events.length} events`);
  for (const e of events) lines.push(`  #${e.seq} ${timelineLine(e)}`);
  return lines.join("\n");
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test test/daemon/run-summary.test.ts test/daemon/run-ticket.test.ts test/daemon/docs-revise-resolve.test.ts test/dispatch/arbiter-e2e.test.ts && bun run typecheck && bun run lint`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/run-ticket.ts test/daemon/run-summary.test.ts test/daemon/run-ticket.test.ts \
        test/daemon/docs-revise-resolve.test.ts test/dispatch/arbiter-e2e.test.ts
git commit -m "feat(run): report escalation as escalated with reason in the terminal summary (ENG-353)"
```

---

## Task 4: notifier — no double-notify, delete the dead predicate copy

**Files:**
- Modify: `src/daemon/notify.ts` — import (`:5`), `terminalDecision` (`:33-48`), `notifyTerminal` blocked branch (`:99-122`)
- Test: `test/daemon/notify-sweep.test.ts` (rewrite the `:59` case)
- Test: `test/daemon/run-ticket-notify.test.ts:15` — flip the now-stale comment (`blocked` → `escalated`); the assertions there (`no-progress`, `pr-ready`) are unaffected

**Interfaces:**
- Consumes: `outcome: string` (unchanged signature — `notifyTerminal(db, ticketId, outcome)`).
- Produces: an escalation (`outcome === "escalated"`) fires NO terminal ping; a dead-end (`outcome === "blocked"`) fires the dead-end ping unconditionally.

- [ ] **Step 1: Rewrite the notifier test (red)**

In `test/daemon/notify-sweep.test.ts`, replace the `:59` case ("blocked terminal: dead-end notifies, escalation-blocked does not") with the post-change contract:

```ts
test("terminal notify: dead-end blocked pings; an escalation (escalated) does not (already evented)", () => {
  // A resolver dead-end → the "Stopped — no actionable work remains." ping.
  const a = makeTestDb();
  createNotifier(cfg("escalations")).notifyTerminal(a.db, a.ticketId, "blocked");
  const aPayloads = payloads(a.db);
  a.db.close();
  expect(aPayloads).toEqual([{ event: "Stopped — no actionable work remains.", severity: "high" }]);

  // An escalation now arrives as `escalated` → NO terminal ping (the swept `escalated` event is
  // the notification). The pending human_resume no longer routes through the blocked branch.
  const b = makeTestDb();
  insertPending(b.db, { ticketId: b.ticketId, signalType: "human_resume", reason: "boom" });
  createNotifier(cfg("escalations")).notifyTerminal(b.db, b.ticketId, "escalated");
  const bCount = payloads(b.db).length;
  b.db.close();
  expect(bCount).toBe(0);
});
```

Also flip the stale comment in `test/daemon/run-ticket-notify.test.ts:15` — it reads "A pending human_resume would instead make it return `blocked`"; change `blocked` → `escalated` to match Task 3. (Comment only; that file's assertions are `no-progress`/`pr-ready` and are unaffected.)

- [ ] **Step 2: Run the test (it passes pre-change — this task is not red-first)**

Run: `bun test test/daemon/notify-sweep.test.ts`
Expected: the *rewritten* test PASSES even before the code change — `notifyTerminal(db,id,"blocked")` with no pending signal already pings, and `notifyTerminal(db,id,"escalated")` already yields 0 posts via `terminalDecision`'s `default → null`. The rewrite is nonetheless **required**: the OLD `:59` test asserted blocked-**with-pending-human_resume** → 0 pings, and that assertion breaks the moment Step 3 makes the blocked branch fire unconditionally. So this task swaps a soon-to-be-false assertion for the true post-change contract, then removes the now-dead code. Confirm the rewritten test passes here, then proceed.

- [ ] **Step 3: Delete the dead check + trim the import**

In `src/daemon/notify.ts`, change the import (`:5`) — `listPending` is no longer used in this file:

```ts
import { getDeliveredPayload } from "../db/repos/signal.ts";
```

Simplify `notifyTerminal`'s blocked branch (`:101-113`) to fire unconditionally:

```ts
    notifyTerminal(db, ticketId, outcome) {
      if (!enabled) return;
      if (outcome === "blocked") {
        // A resolver dead-end. (Escalations report `escalated`, not `blocked`, and are notified via
        // their swept `escalated` event — see terminalDecision.) Post the terminal dead-end ping.
        post(
          db,
          ticketId,
          `notify:${ticketId}:term:blocked`,
          buildMsg(db, ticketId, "Stopped — no actionable work remains.", "high"),
        );
        return;
      }
      const d = terminalDecision(outcome);
      if (!d) return;
      post(
        db,
        ticketId,
        `notify:${ticketId}:term:${outcome}`,
        buildMsg(db, ticketId, d.event, d.severity),
      );
    },
```

- [ ] **Step 4: Make `escalated` explicit in `terminalDecision` + fix its stale comment**

Replace `terminalDecision`'s header comment (`:33-36`) and add the `escalated` case (`:37-48`):

```ts
/** Map a terminal outcome → (severity, event) or null. `parked` and `escalated` are intentionally
 *  null: their notification already went out as a swept event. `blocked` (a resolver dead-end) is
 *  handled separately in `notifyTerminal` (an unconditional dead-end ping). */
function terminalDecision(outcome: string): { severity: NotifySeverity; event: string } | null {
  switch (outcome) {
    case "pr-ready":
      return { severity: "success", event: "PR ready to merge" };
    case "done":
      return { severity: "success", event: "released" };
    case "no-progress":
      return { severity: "high", event: "Stopped — couldn't make progress." };
    case "escalated":
      return null; // already notified via the swept `escalated` event; a terminal ping would double
    default:
      return null; // blocked (handled above), parked (swept)
  }
}
```

- [ ] **Step 5: Run the test + notifier suite to verify green**

Run: `bun test test/daemon/notify-sweep.test.ts test/daemon/notify-outbox.test.ts test/daemon/run-ticket-notify.test.ts && bun run typecheck && bun run lint`
Expected: PASS / clean. (`run-ticket-notify.test.ts` drives a real no-progress terminal; confirm it is unaffected. If it contained an escalation-as-blocked assertion, flip it to `escalated` the same way as Task 3.)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/notify.ts test/daemon/notify-sweep.test.ts
git commit -m "feat(notify): escalated fires no terminal ping; drop dead blocked predicate (ENG-353)"
```

---

## Task 5: analytics projector — reconcile the comment + fixtures

**Files:**
- Modify: `src/telemetry/analytics/properties.ts:65` (comment only)
- Test: `test/telemetry/analytics/properties.test.ts` (replace the impossible `:89` fixture; add an `escalated` `failureBucket` case)

**Interfaces:**
- Consumes: `failureBucket(outcome: string, escalationReasons: string[])` (existing).
- Produces: no behavior change — `escalated` (populated reasons) classifies by keyword; a dead-end `blocked` (empty reasons) → `"unknown"`. `runCompletedProperties` already passes `summary.outcome` raw, so PostHog receives `escalated`.

- [ ] **Step 1: Update the tests (red where behavior is asserted)**

In `test/telemetry/analytics/properties.test.ts`, extend the `failureBucket` test to pin the escalation classification and the dead-end fallback:

```ts
  // An escalation classifies by its reason keywords (reasons are populated).
  expect(failureBucket("escalated", ["blocking plan-defect found in review"])).toBe("plan-defect");
  expect(failureBucket("escalated", ["step 'design:extract' failed"])).toBe("unknown");
  // A resolver dead-end carries no escalation reasons → unknown.
  expect(failureBucket("blocked", [])).toBe("unknown");
```

Replace the now-impossible allow-list-guard fixture at `:89` (`{ outcome: "blocked", escalation_reasons: ["budget exhausted"] }`) with an escalated one, since a `blocked` outcome never carries escalation reasons after this change:

```ts
    runCompletedProperties(
      summary({ outcome: "escalated", escalation_reasons: ["budget exhausted"] }),
      5000,
      { complexityGrading: true, onPlanDefect: "redesign" },
    ),
```

- [ ] **Step 2: Run the tests to verify status**

Run: `bun test test/telemetry/analytics/properties.test.ts`
Expected: the new `failureBucket("escalated", …)` assertions PASS immediately (fall-through already classifies them); the allow-list fixture swap is a rename and also passes. This task is primarily locking behavior + fixing the fixture — if all assertions pass at Step 2, that confirms the no-logic-change claim.

- [ ] **Step 3: Fix the stale comment**

In `src/telemetry/analytics/properties.ts:65`, replace the `blocked`-only comment:

```ts
  // escalated (reasons populated) or a resolver dead-end blocked (no reasons → "unknown"):
  // classify by keyword against the joined reasons (the raw text never leaves here).
```

- [ ] **Step 4: Run the tests + typecheck/lint**

Run: `bun test test/telemetry/analytics/properties.test.ts && bun run typecheck && bun run lint`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/analytics/properties.ts test/telemetry/analytics/properties.test.ts
git commit -m "feat(analytics): classify escalated by reason; reconcile blocked fixtures (ENG-353)"
```

---

## Final verification (before the whole-branch review)

- [ ] Run the whole suite: `bun test && bun run typecheck && bun run lint` — all green.
- [ ] Acceptance walk-through against the ticket:
  - AC1 terminal reports `escalated` — Task 3 (`run-summary.test.ts`).
  - AC2 `summary.outcome` reads `escalated` — Task 2 (`emitter.test.ts`).
  - AC3 dead-end still `blocked`, distinguishable — Task 3 (dead-end case) + Task 4 (dead-end ping) + Task 5 (`unknown` bucket).
  - AC4 Slack: no `blocked` for an escalation — Task 4.
  - AC5 escalated message states resumability (re-run) + names reason — Task 3 (sentence + `Reason:`); resume-mechanics deviation recorded in the design doc.
  - AC6 decision recorded + predicate reused not duplicated — design doc + Task 1 (single predicate, notifier copy deleted in Task 4).
  - AC7 `summary.outcome` reconciled with `SCHEMA_VERSION` (additive, no bump) — Global Constraints + Task 2.
  - AC8 tests cover the split in terminal / Slack / `summary.outcome` — Tasks 2–5.
  - AC9 STYRE-7 transcript re-rendered reports `escalated` — Task 3's escalation `formatRunSummary` case is the STYRE-7 shape (`design:extract` reason).

## Self-Review (author, run before execution)

- **Spec coverage:** all six design units mapped to Tasks 1–5 (Unit 5 telemetry = no-code passthrough, covered by Task 2's test; Unit 7 analytics = Task 5). ✓
- **Placeholder scan:** none — every step has concrete code/commands. ✓
- **Type consistency:** `hasPendingHumanResume` signature identical in Task 1 (def), Task 3 (use); the `escalated` sentence string is byte-identical in the Global Constraints, Task 2 impl, Task 2 test, and Task 3 test. Exit code `75`/`EXIT.TEMPFAIL` consistent across Task 2 and the `park.ts` docstring. ✓
