# ENG-385: Unified resume gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `styre run --resume <ident>` a single reason-gated recovery path — `budget` waits for its reset time, `needs_you` consumes the `human_resume` signal so the run actually proceeds (instead of instant-re-pausing), `interrupted` just continues — plus `--inspect` that names a `failed` step, a per-ticket lock so two resumes can't race the same checkpoint, and a `--fresh` that frees the branch via the liveness-gated reconcile before discarding.

**Architecture:** `resumeRun` (`park.ts:190-363`) today runs the same prep for every parked checkpoint and **never consumes** the pending `human_resume` signal (no `markConsumed` import), so an escalated/`needs_you` checkpoint re-trips `hasPendingHumanResume` (`run-ticket.ts:113`) on the first tick and pauses again. This plan derives the pause `reason` from checkpoint state (pending `human_resume` ⇒ `needs_you`; latest `parked` event ⇒ `budget`; else `interrupted`), gates on it (consume the signal for `needs_you`; refuse-until-`resetAt` for `budget`; nothing for `interrupted`), keeps the existing HEAD-moved guard, then continues into the unchanged `reconcileWorktree → recover → driveToTerminal` path — where a `running` step is re-armed by `recover()`, a `failed` step by `runStep`'s `pending|failed` branch, and a no-step checkpoint by the resolver re-planning. Re-arm needs **no new code** (verified below) — only the signal consume + reason gate. Additionally: `--inspect` resolves a `failed` step; `resumeRun` takes the per-ticket run lock (symmetry with the fresh path); `--fresh` reconciles before deleting.

**Tech Stack:** Bun + TypeScript; `bun:sqlite`; biome (`bun run lint`); `tsc --noEmit` (`bun run typecheck`); `bun test`. No new dependencies, no schema migration.

## Global Constraints

- Every task ends `bun test` + `bun run lint` + `bun run typecheck` all green.
- No new runtime dependencies; no `schema.sql` change.
- **Do NOT zero the attempt counter on resume.** `markResumed` (`src/db/repos/run.ts:50-52`) already does `attempt = attempt + 1`; the re-armed `failed` step must NOT be `resetAttempt`'d (only `resetProvisionForResume`'s existing worktree-mode provision reset stays). So repeated resume-without-fix still climbs to `DEFAULT_MAX_ATTEMPTS` (`failure-policy.ts:26`) and stops.
- Reuse the `resumeParkedTicket` harness (`test/helpers/run-harness.ts:180-339`) and its seams (`buildRegistry`/`ports`/`preflight`; exit-map 75→paused, 65→refused).
- **Out of scope:** `styre ls` / `styre clean` (ENG-386); the `abandoned`-explicit route (ENG-386); the ENG-382 fresh-run refuse-guard/lock/delete machinery (reuse, don't duplicate).
- **Reason vocabulary** is the merged `PauseReason = "budget" | "needs_you" | "interrupted"` (`run-ticket.ts`). Resume DERIVES it from state (no stored reason on the checkpoint).

---

### Task 1: Reason-gated resume (consume `human_resume` for needs_you; budget reset-time gate)

**Files:**
- Modify: `src/cli/park.ts` (`resumeRun` — add reason derivation + the gate; imports)
- Test: `test/cli/park-resume-gate.test.ts` (create); extend `test/cli/park-resume-e2e.test.ts`

**Interfaces:**
- Consumes: `hasPendingHumanResume`, `listPending`, `markConsumed` (`src/db/repos/signal.ts:36,25,69`); `listByTicket` (`src/db/repos/event-log.ts:36`); `nowUtc` (`src/util/time.ts`).
- Produces: a private `resumeReason(db, ticketId): "budget" | "needs_you" | "interrupted"` and a private `latestParkedResetAt(db, ticketId): string | null` in `park.ts`; the gate wired into `resumeRun` after the HEAD-moved/preflight guards and before `setTicketStatus(active)` (`park.ts:314`).

- [ ] **Step 1: Write the failing test — needs_you resume consumes the signal and proceeds**

Create `test/cli/park-resume-gate.test.ts`. Use the harness that already parks a `needs_you` checkpoint (a resolver escalation leaves a pending `human_resume`). If `runParkedTicket` only parks on budget, add a `needs_you` variant (a `FakeAgentRunner` that fails a step to the escalate cap); the harness already exposes `buildRegistry`, so drive it to an escalation.
```ts
import { expect, test } from "bun:test";
import { hasPendingHumanResume } from "../../src/db/repos/signal.ts";
import { openDb } from "../../src/db/client.ts";
import { join } from "node:path";
import { runNeedsYouTicket, resumeParkedTicket, cleanupParkedRun } from "../helpers/run-harness.ts";

test("resuming a needs_you checkpoint consumes the human_resume signal (does not instant-re-pause)", async () => {
  const parked = await runNeedsYouTicket();            // ticket paused(needs_you): pending human_resume
  const dbBefore = openDb(join(parked.dumpDir, "run.db"));
  expect(hasPendingHumanResume(dbBefore, parked.ticketId)).toBe(true);
  dbBefore.close();

  const resumed = await resumeParkedTicket(parked);    // fake runner now SUCCEEDS the step
  // The signal is consumed → driveToTerminal does not immediately re-pause on hasPendingHumanResume.
  const dbAfter = openDb(join(parked.dumpDir, "run.db"));
  expect(hasPendingHumanResume(dbAfter, parked.ticketId)).toBe(false);
  dbAfter.close();
  expect(resumed.ran).toBeGreaterThan(0);              // it actually dispatched, didn't no-op re-pause
  cleanupParkedRun(parked);
});
```
(If a `runNeedsYouTicket` helper doesn't exist, add it to `run-harness.ts` mirroring `runParkedTicket` but driving a `FakeAgentRunner` that returns a failing exit until the escalate cap — reuse `gitRepoWithProject`, `XDG_STATE_HOME` override, and the existing park→finishRunResult tail. Its body is specified by that pattern.)

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test test/cli/park-resume-gate.test.ts`
Expected: FAIL — `hasPendingHumanResume` is still `true` after resume (the signal is never consumed today), and/or `ran === 0` because the run re-paused on the pending signal without dispatching.

- [ ] **Step 3: Add reason derivation + gate helpers to `park.ts`**

Add imports at the top of `park.ts` (none of these are imported today):
```ts
import { hasPendingHumanResume, listPending, markConsumed } from "../db/repos/signal.ts";
```
(`listByTicket` from `../db/repos/event-log.ts` and `nowUtc` from `../util/time.ts` are already imported — verify; add if absent.)

Add these module-private helpers near `headBaseline` (`park.ts:175`):
```ts
/** The pause reason of a checkpoint, derived from state (no reason is stored on disk):
 *  a pending `human_resume` signal ⇒ needs_you (escalation / pauseTicket); else a `parked` event
 *  (budget/session-limit park); else interrupted (crash / live-location, no handler ran). */
function resumeReason(db: Database, ticketId: number): "budget" | "needs_you" | "interrupted" {
  if (hasPendingHumanResume(db, ticketId)) return "needs_you";
  const parked = listByTicket(db, ticketId).filter((e) => e.kind === "parked").at(-1);
  return parked !== undefined ? "budget" : "interrupted";
}

/** `resetAt` (ISO-8601 UTC) from the latest `parked` event's payload, or null. Budget parks record
 *  `payload_json = { cause, resetAt, dispatchId }` (advance.ts:180). */
function latestParkedResetAt(db: Database, ticketId: number): string | null {
  const parked = listByTicket(db, ticketId).filter((e) => e.kind === "parked").at(-1);
  if (parked?.payload_json == null) return null;
  try {
    return (JSON.parse(parked.payload_json) as { resetAt?: string | null }).resetAt ?? null;
  } catch {
    return null;
  }
}
```
(If `EventRow` doesn't expose `payload_json`, read the field name the row actually carries — grep `event_log` columns in `schema.sql`; the payload column is `payload_json`.)

- [ ] **Step 4: Wire the gate into `resumeRun`**

In `resumeRun`, immediately AFTER the HEAD-moved refuse (`park.ts:247-254`) and the agent-CLI preflight (`park.ts:261-268`), and BEFORE `setTicketStatus(db, ticketId, "active")` (`park.ts:314`), insert:
```ts
    const reason = resumeReason(db, ticketId);

    // budget: refuse until the reset time has passed (informative; exit 65, mirrors HEAD-moved refuse).
    if (reason === "budget") {
      const resetAt = latestParkedResetAt(db, ticketId);
      if (resetAt !== null && new Date(nowUtc()).getTime() < new Date(resetAt).getTime()) {
        process.stderr.write(
          `resume refused: paused for budget; resets ${resetAt}.\n` +
            `  Re-run after that time, or 'styre run ${ticket.ident} --fresh' to start over.\n`,
        );
        db.close();
        process.exitCode = 65; // EXIT.RESUME_REFUSED
        return;
      }
    }

    // needs_you: consume the pending human_resume signal(s) BEFORE driveToTerminal — otherwise
    // hasPendingHumanResume (run-ticket.ts:113) fires on the first tick and instantly re-pauses.
    if (reason === "needs_you") {
      for (const s of listPending(db, ticketId).filter((s) => s.signal_type === "human_resume")) {
        markConsumed(db, s.id);
      }
    }
    // interrupted: no gate.
```
Do NOT touch `markResumed` (attempt++ stays) and do NOT `resetAttempt` any step.

- [ ] **Step 5: Run to verify GREEN + the needs_you e2e**

Run: `bun test test/cli/park-resume-gate.test.ts test/cli/park-resume-e2e.test.ts`
Expected: PASS — the signal is consumed, `ran > 0`, and the failed step is re-executed by `runStep`'s `pending|failed` branch (no new re-arm code needed — the resolver picks the non-`succeeded` step and `driveToTerminal` dispatches it). Also add to `park-resume-e2e.test.ts` the ticket's end-to-end AC: a provision-style failure parks `needs_you`; on resume (fake now succeeds) the run **proceeds past the failed step** to `pr-ready`.

- [ ] **Step 6: Budget-gate tests**

Add to `park-resume-gate.test.ts`: (a) a budget checkpoint whose `parked` event `resetAt` is in the future → `resumeParkedTicket` returns `"refused"` (exit 65) and the stderr names the reset time; (b) `resetAt` in the past (or a pre-upgrade dump with no `parked` payload) → resumes normally. Use the harness's exit-code map (65→"refused").

- [ ] **Step 7: Full gates + commit**

Run: `bun test && bun run lint && bun run typecheck`
```bash
git add src/cli/park.ts test/cli/park-resume-gate.test.ts test/cli/park-resume-e2e.test.ts test/helpers/run-harness.ts
git commit -m "feat(resume): reason-gated resume — consume human_resume for needs_you, budget reset-time gate (ENG-385)"
```

---

### Task 2: `--inspect` resolves a `failed` step

**Files:**
- Modify: `src/cli/park.ts` (`parkedStep` resolution `:233`; the `--inspect` print `:239-245`)
- Test: `test/cli/park.test.ts` (extend)

**Interfaces:**
- Consumes: `listByStatus` (`src/db/repos/workflow-step.ts`).
- Produces: `parkedStep` resolves a `running` step first, else a `failed` step, so `--inspect` names the real target.

- [ ] **Step 1: Write the failing test**

In `test/cli/park.test.ts`, add: a checkpoint whose only stepped work is a `failed` step (a needs_you escalation) → `resumeRun(..., { inspect: true })` prints `would re-dispatch step: <the failed step_key>`, NOT `(none)`. Capture `process.stderr`.

- [ ] **Step 2: Run to verify FAIL** — prints `(none)` today (`parkedStep` only reads `running`).

- [ ] **Step 3: Implement**

Change `park.ts:233`:
```ts
    const parkedStep =
      listByStatus(db, "running").find((s) => s.ticket_id === ticketId) ??
      listByStatus(db, "failed").find((s) => s.ticket_id === ticketId) ??
      null;
```
(`running` takes precedence — an in-flight step is the live target; a `failed` step is the escalation target. The `--inspect` print and the carryover `resumeContext` at `park.ts:315-327` both read `parkedStep.step_key` and now resolve correctly.)

- [ ] **Step 4: Run GREEN**, then full gates + commit
```bash
git add src/cli/park.ts test/cli/park.test.ts
git commit -m "feat(resume): --inspect names a failed step, not (none) (ENG-385)"
```

---

### Task 3: Per-ticket run lock on resume  ⚠️ DECISION — confirm in review

**Files:**
- Modify: `src/cli/park.ts` (`resumeRun` — acquire the lock, release in `finally`)
- Test: `test/cli/park-resume-gate.test.ts` (extend)

**Interfaces:**
- Consumes: `acquireRunLock`, `releaseRunLock`, `runLockStatus` (`src/cli/run-lock.ts`, from ENG-382).
- Produces: `resumeRun` holds the per-ticket lock (`dir` = the checkpoint dir) for the life of the resume; a second concurrent `--resume` of the same ticket refuses.

**Decision (recommended, flagged for the human):** the fresh path takes the lock (`run.ts:253`); `resumeRun` does NOT today (`park.ts:299-301` flags concurrent `--resume` as ENG-385 scope). Two concurrent `--resume` of one ticket open the same live-location `run.db` → corruption. **Recommend acquiring it** for symmetry. Alternative: defer (documented as a known gap). This task implements the acquire; if the human prefers to defer, drop this task.

- [ ] **Step 1: Write the failing test**

Extend `park-resume-gate.test.ts`: pre-seed a live foreign `run.lock` (`writeFileSync(join(dir,"run.lock"), String(process.ppid))`) in the checkpoint dir, then `resumeParkedTicket` → refuses (exit 65 / a "in progress" `usageError`) and does not open/dispatch.

- [ ] **Step 2: Run to verify FAIL** — resume ignores the lock today.

- [ ] **Step 3: Implement**

In `resumeRun`, after the checkpoint-exists check (`park.ts:202-207`) and before `migrate(dbPath)`, acquire the lock; wrap the remainder of the function body in `try { … } finally { if (lock) releaseRunLock(lock); }`:
```ts
    const lock = acquireRunLock(dir);
    if (lock === null) {
      throw usageError(
        `another 'styre run ${args.resume}' is already in progress (${dir}/run.lock)`,
        "Wait for it to finish, or remove the stale lock if that process is gone.",
      );
    }
    try {
      // ... existing resumeRun body (migrate → … → driveToTerminal → re-park tail) ...
    } finally {
      releaseRunLock(lock);
    }
```
Note: the early-returns inside (inspect exit 0, budget/HEAD refuse exit 65) now sit inside the `try`, so the `finally` releases the lock on every path. `acquireRunLock` is O_EXCL + stale-reclaim (a crashed prior resume's lock is reclaimed).

- [ ] **Step 4: Run GREEN + full gates + commit**
```bash
git add src/cli/park.ts test/cli/park-resume-gate.test.ts
git commit -m "feat(resume): take the per-ticket run lock on resume (ENG-385)"
```

---

### Task 4: `--fresh` reconciles the worktree before discarding

**Files:**
- Modify: `src/cli/run.ts` (the `--fresh` block `:233-242`)
- Test: `test/cli/run-live-location.test.ts` (extend)

**Interfaces:**
- Consumes: `reconcileWorktree` (`src/dispatch/worktree.ts:181`, 5-arg with `checkpointDir`), `branchNameFor` (`src/agent/branch.ts`).
- Produces: `--fresh` frees the branch via the liveness-gated reconcile (handles a styre-owned **dead-owner non-prunable** leftover, which ENG-382's later `ensureWorktree` prune-retry would REFUSE) before the whole-dir delete + fresh run.

**Note vs ENG-382:** ENG-382's `--fresh` already checks the lock and `rmSync`s the whole checkpoint dir, relying on `ensureWorktree`'s prunable-only retry to free the branch. Gap: a dead-owner leftover whose dir still exists (not prunable) is refused by that retry. ENG-385 adds one `reconcileWorktree(..., checkpointDir)` call in the `--fresh` block so the dead-owner case is freed. This is the ONLY `--fresh` addition; do NOT duplicate ENG-382's delete/lock logic.

- [ ] **Step 1: Write the failing test**

Extend `run-live-location.test.ts`: a ticket with a **non-prunable styre-owned** leftover worktree holding its branch and a **dead** run-lock; `styre run <ident> --fresh` succeeds (frees the leftover, starts fresh) rather than aborting at the later `ensureWorktree` refuse.

- [ ] **Step 2: Run to verify FAIL** — `--fresh` currently refuses (or aborts in `ensureWorktree`) on a dead-owner non-prunable leftover.

- [ ] **Step 3: Implement**

In the `--fresh` block (`run.ts:233-242`), after the lock check and BEFORE `rmSync(checkpointDir, …)`, free the branch via the liveness-gated reconcile (the branch + target are known here from the resolved ident):
```ts
      // Free the branch via the liveness gate (frees a styre-owned dead-owner leftover the later
      // ensureWorktree prunable-only retry would refuse) before discarding the checkpoint.
      reconcileWorktree(profile.targetRepo, branchNameFor(ingested), undefined, join(mkdtempSync(join(tmpdir(), "styre-wt-")), ingested.ident), checkpointDir);
      rmSync(checkpointDir, { recursive: true, force: true });
```
(Use the `ingested`/`checkpointDir`/`profile.targetRepo` already in scope in the fresh path from ENG-382; `branchNameFor` may need importing. If the branch/target aren't in scope at `:233`, compute them from `ingested` as the surrounding fresh path does.)

- [ ] **Step 4: Run GREEN + full gates + commit**
```bash
git add src/cli/run.ts test/cli/run-live-location.test.ts
git commit -m "feat(resume): --fresh reconciles the worktree (frees dead-owner leftover) before discarding (ENG-385)"
```

---

## Self-Review

**Spec coverage (ENG-385 ticket + design §3.3/§7):**
- reason-gated resume (budget/needs_you/interrupted) → Task 1. ✓
- `markConsumed` the pending `human_resume` for needs_you → Task 1 Step 4. ✓
- budget reset-time refuse → Task 1 Step 4/6. ✓
- re-arm-or-replan → verified automatic (recover for running, runStep pending|failed for failed, resolver for no-step); Task 1 tests it, no new code. ✓
- don't zero the attempt counter → Global Constraint + Task 1 (no `resetAttempt`). ✓
- `--inspect` from `failed` → Task 2. ✓
- `--fresh` → Task 4 (the reconcile addition atop ENG-382). ✓
- per-ticket lock on resume → Task 3 (flagged decision). ✓
- STYRE-1 / needs_you e2e → Task 1 Step 5. ✓

**Placeholder scan:** two grounded "read the exact field/scope at implementation time" notes (the `EventRow.payload_json` field name in Task 1 Step 3; the branch/target scope in Task 4 Step 3) — both cite the source and are transcription-with-context, not TBDs. The `runNeedsYouTicket` harness helper (Task 1 Step 1) is specified by the `runParkedTicket` pattern it mirrors.

**Type consistency:** `resumeReason`/`latestParkedResetAt` local to `park.ts`; the gate uses `signal.ts`/`event-log.ts`/`time.ts` helpers with their real signatures; `acquireRunLock`/`releaseRunLock` (Task 3) and `reconcileWorktree` 5-arg (Task 4) match their ENG-382 signatures.

## Residual open questions

- **Task 3 (per-ticket lock on resume): the one real decision.** Recommended (symmetry with the fresh path; prevents two `--resume` racing one live `run.db`). But `resumeRun` runs later/on another machine and is lower-contention than a fresh run; if the human prefers to keep resume lock-free until there's evidence of the race, drop Task 3 and note it. **Flagged for the human/reviewer.**
- **Task 4 (`--fresh` reconcile) — is it worth it?** The gap it closes (dead-owner **non-prunable** leftover) is an edge case (the owning process died AND its worktree dir was not reaped). If deemed too narrow, `--fresh` could stay ENG-382-only and Task 4 dropped. Flagged.
- **`interrupted` reason** is derived (no pending signal + no `parked` event) but, in the current model, `driveToTerminal` only ever emits `budget`/`needs_you` pauses — a true `interrupted` checkpoint arises only from a crash/live-location run with no graceful pause. The gate treats it as "no gate, proceed," which is correct; there is no dedicated test fixture for a crash (would require killing a run mid-flight) — noted as manual validation.
