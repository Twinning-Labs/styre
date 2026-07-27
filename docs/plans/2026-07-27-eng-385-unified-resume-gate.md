# ENG-385: Unified resume gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `styre run --resume <ident>` a single recovery path that actually proceeds — a `needs_you` resume consumes the pending `human_resume` signal (instead of instant-re-pausing), everything else just continues — plus `--inspect` that names a `failed` step, a per-ticket lock so two resumes can't race the same checkpoint, and a `--fresh` that frees the branch via the liveness-gated reconcile before discarding.

**Architecture:** `resumeRun` (`park.ts:190-363`) today runs the same prep for every parked checkpoint and **never consumes** the pending `human_resume` signal (no `markConsumed` import), so an escalated/`needs_you` checkpoint re-trips `hasPendingHumanResume` (`run-ticket.ts:113`) on the first tick and pauses again. This plan consumes the pending `human_resume` on resume (the one gate that matters), keeps the existing HEAD-moved guard, and continues into the unchanged `reconcileWorktree → recover → driveToTerminal` path — where a `running` step is re-armed by `recover()`, a `failed` step by `runStep`'s `pending|failed` branch, and a no-step checkpoint by the resolver re-planning. Re-arm needs **no new code** (verified below) — only the signal consume. `budget`/`interrupted` resumes proceed identically to a plain resume (a still-out-of-budget run simply re-pauses — see the descoped reset-time gate). Additionally: `--inspect` resolves a `failed` step; `resumeRun` takes the per-ticket run lock (symmetry with the fresh path); `--fresh` reconciles before deleting.

**Tech Stack:** Bun + TypeScript; `bun:sqlite`; biome (`bun run lint`); `tsc --noEmit` (`bun run typecheck`); `bun test`. No new dependencies, no schema migration.

**Descoped (was in rev 1): the budget reset-time gate.** The independent review showed `resetAt` is NOT ISO-8601 — it is free text scraped from the CLI death message (`claude.ts:68` / `codex.ts:111` regexes → `"tomorrow"`, `"3pm"`, `"at 10pm (America/Chicago)"`). `new Date(resetAt)` → `NaN`, so a `now < resetAt` gate never fires and is untestable. This resolves design §12's open question in favour of **always-allow** (resume-and-re-pause): a budget resume proceeds; if still out of budget it simply parks again (a cheap re-pause). No reset-time refuse is implemented, and no reason classification is needed on the resume path.

## Global Constraints

- Every task ends `bun test` + `bun run lint` + `bun run typecheck` all green.
- No new runtime dependencies; no `schema.sql` change.
- **Attempt-counter: don't zero the re-armed failed step.** The per-STEP exhaustion cap (`DEFAULT_MAX_ATTEMPTS`, `failure-policy.ts:26`) is driven by `markRunning`'s `attempt = attempt + 1` (`workflow-step.ts:103`) each time a `pending|failed` step is re-executed — NOT by `markResumed` (which bumps the RUN row's `attempt`, unread by failure-policy). So "repeated resume-without-fix climbs to the cap and stops" holds for **non-provision** steps. `resetProvisionForResume` intentionally ZEROES the provision step's attempt on every worktree-mode resume (`provision.ts:251-256`), so a genuinely-broken **provision** is re-armed each resume by design (not capped) — leave that as-is. The rule for this ticket: add NO `resetAttempt` to the re-armed failed step.
- Reuse the `resumeParkedTicket` harness (`test/helpers/run-harness.ts:180-339`) and its seams (`buildRegistry`/`ports`/`preflight`; exit-map 75→paused, 65→refused).
- **Out of scope:** `styre ls` / `styre clean` and the `abandoned`-explicit route (ENG-386); the ENG-382 fresh-run refuse-guard/lock/whole-dir-delete machinery (reuse, don't duplicate).

---

### Task 1: Consume `human_resume` on resume (the needs_you gate)

**Files:**
- Modify: `src/cli/park.ts` (`resumeRun` — consume the pending `human_resume`; import)
- Test: `test/cli/park-resume-gate.test.ts` (create); extend `test/cli/park-resume-e2e.test.ts`; add `runNeedsYouTicket` to `test/helpers/run-harness.ts`

**Interfaces:**
- Consumes: `listPending`, `markConsumed` (`src/db/repos/signal.ts:25,69`), `hasPendingHumanResume` (`:36`).
- Produces: `resumeRun` consumes every pending `human_resume` signal for the ticket before `driveToTerminal`. **Decision (stated):** no reason classification on the resume path — the ONLY gate is "consume the pending `human_resume` if present; otherwise proceed." Budget/interrupted checkpoints have no such signal and fall straight through. (Any re-pause's outcome `reason` is set by `driveToTerminal`/`pauseTicket`, not here — a resume-time classifier would be dead code.)

- [ ] **Step 1: Write the failing test + the `runNeedsYouTicket` harness helper**

Add `runNeedsYouTicket()` to `test/helpers/run-harness.ts` — a concrete recipe to reach a `paused(needs_you)` checkpoint (a pending `human_resume`). Mirror `runParkedTicket`'s scaffolding (`gitRepoWithProject` for a real repo + DB at the `implement` stage with one pending `work_unit`; `XDG_STATE_HOME` → temp; the `finishRunResult` tail), but instead of a session-limit runner use a **`FakeAgentRunner` that deterministically FAILS the dispatch every call** so the step retries to `DEFAULT_MAX_ATTEMPTS` (3) and `applyFailurePolicy` escalates (inserting the pending `human_resume`):
```ts
// failing runner: a non-zero exit trips dispatch-failed → retry → escalate at the cap.
const failing = new FakeAgentRunner(() => ({
  completed: true, exitCode: 1, stdout: "{}", stderr: "boom",
  timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
}));
```
Drive `driveToTerminal` with `failing` until it returns `outcome:"paused"`, then run the same `finishRunResult(db, dbPath, PARK_SLUG, PARK_IDENT, result)` tail. Return the same `ParkedRunResult` shape (`dumpDir`, `ticketId`, …) as `runParkedTicket`. **Confirm the exact escalate trigger** (dispatch-failed vs postcondition-miss) against `failure-policy.ts:69-89` when writing — if a bare `exitCode:1` doesn't reach the escalate branch, use a failing postcondition instead; either way the end state is a pending `human_resume`. Assert in the helper that `hasPendingHumanResume(db, ticketId)` is true before returning.

Then `test/cli/park-resume-gate.test.ts`:
```ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { hasPendingHumanResume } from "../../src/db/repos/signal.ts";
import { cleanupParkedRun, resumeParkedTicket, runNeedsYouTicket } from "../helpers/run-harness.ts";

test("resuming a needs_you checkpoint consumes the human_resume signal (does not instant-re-pause)", async () => {
  const parked = await runNeedsYouTicket();
  const before = openDb(join(parked.dumpDir, "run.db"));
  expect(hasPendingHumanResume(before, parked.ticketId)).toBe(true);
  before.close();

  const resumed = await resumeParkedTicket(parked); // resume-phase fake SUCCEEDS the step
  const after = openDb(join(parked.dumpDir, "run.db"));
  expect(hasPendingHumanResume(after, parked.ticketId)).toBe(false); // consumed
  after.close();
  expect(resumed.ran).toBeGreaterThan(0); // actually dispatched — did not no-op re-pause
  cleanupParkedRun(parked);
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test test/cli/park-resume-gate.test.ts`
Expected: FAIL — `hasPendingHumanResume` still `true` after resume (never consumed today) and/or `ran === 0` (re-pauses on the pending signal without dispatching).

- [ ] **Step 3: Consume the signal in `resumeRun`**

Add the import at the top of `park.ts` (not imported today):
```ts
import { listPending, markConsumed } from "../db/repos/signal.ts";
```
In `resumeRun`, immediately AFTER the HEAD-moved refuse (`park.ts:247-254`) and agent-CLI preflight (`park.ts:261-268`), and BEFORE `setTicketStatus(db, ticketId, "active")` (`park.ts:314`):
```ts
    // Consume any pending human_resume BEFORE driveToTerminal — else hasPendingHumanResume
    // (run-ticket.ts:113) fires on the first tick and instantly re-pauses. Budget/interrupted
    // checkpoints have no such signal and fall through untouched. (No reset-time gate — resetAt is
    // free text, see the plan header; a still-out-of-budget run simply re-pauses.)
    for (const s of listPending(db, ticketId).filter((s) => s.signal_type === "human_resume")) {
      markConsumed(db, s.id);
    }
```
Do NOT touch `markResumed` (attempt++ stays); do NOT `resetAttempt` any step.

- [ ] **Step 4: Run to verify GREEN + the needs_you e2e**

Run: `bun test test/cli/park-resume-gate.test.ts test/cli/park-resume-e2e.test.ts`
Expected: PASS — signal consumed, `ran > 0`, and the `failed` step re-executed by `runStep`'s `pending|failed` branch (no new re-arm code — the resolver picks the non-`succeeded` step and `driveToTerminal` dispatches it). Extend `park-resume-e2e.test.ts` with the ticket's end-to-end AC: a failure parks `needs_you`; on resume (fake now succeeds) the run **proceeds past the failed step** to `pr-ready`.

- [ ] **Step 5: Budget-resume test (proceeds normally)**

Add to `park-resume-gate.test.ts`: a budget checkpoint (`runParkedTicket`) resumes and proceeds (`resumeParkedTicket` → not `"refused"`; it dispatches / reaches a terminal), confirming budget has no gate. (No budget-refuse test — the reset-time gate is descoped.)

- [ ] **Step 6: Full gates + commit**

Run: `bun test && bun run lint && bun run typecheck`
```bash
git add src/cli/park.ts test/cli/park-resume-gate.test.ts test/cli/park-resume-e2e.test.ts test/helpers/run-harness.ts
git commit -m "feat(resume): consume human_resume on resume so a needs_you checkpoint proceeds (ENG-385)"
```

---

### Task 2: `--inspect` resolves a `failed` step

**Files:**
- Modify: `src/cli/park.ts` (`parkedStep` resolution `:233`)
- Test: `test/cli/park.test.ts` (extend)

**Interfaces:**
- Consumes: `listByStatus` (`src/db/repos/workflow-step.ts`).
- Produces: `parkedStep` resolves a `running` step first, else a `failed` step, so `--inspect` names the real target (and the carryover `resumeContext` at `park.ts:315-327` reads the right `step_key`).

- [ ] **Step 1: Write the failing test**

In `test/cli/park.test.ts`, add: a checkpoint whose only stepped work is a `failed` step → `resumeRun(..., { inspect: true })` prints `would re-dispatch step: <the failed step_key>`, NOT `(none)`. Capture `process.stderr`.

- [ ] **Step 2: Run to verify FAIL** — prints `(none)` today (`parkedStep` reads only `running`).

- [ ] **Step 3: Implement** — change `park.ts:233`:
```ts
    const parkedStep =
      listByStatus(db, "running").find((s) => s.ticket_id === ticketId) ??
      listByStatus(db, "failed").find((s) => s.ticket_id === ticketId) ??
      null;
```
(`running` first — an in-flight step is the live target; else the `failed` escalation target.)

- [ ] **Step 4: Run GREEN + full gates + commit**
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
- Consumes: `acquireRunLock`, `releaseRunLock` (`src/cli/run-lock.ts`, ENG-382).
- Produces: `resumeRun` holds the per-ticket lock (`dir` = the checkpoint dir) for the life of the resume; a second concurrent `--resume` of the same ticket refuses (exit 65).

**Decision (recommended, flagged for the human):** the fresh path takes the lock (`run.ts:253`); `resumeRun` does NOT today (`park.ts:299-301` flags concurrent `--resume` as ENG-385 scope). Two concurrent `--resume` of one ticket open the same live-location `run.db` → corruption. **Recommend acquiring it** for symmetry. Alternative: defer (documented gap). If deferred, drop this task.

- [ ] **Step 1: Write the failing test**

Extend `park-resume-gate.test.ts`: pre-seed a live foreign lock in the checkpoint dir (`writeFileSync(join(dir, "run.lock"), String(process.ppid))`), then `resumeParkedTicket` → `"refused"` (exit 65) and it does not dispatch.

- [ ] **Step 2: Run to verify FAIL** — resume ignores the lock today.

- [ ] **Step 3: Implement**

Import `acquireRunLock, releaseRunLock` from `./run-lock.ts`. In `resumeRun`, after the checkpoint-exists check (`park.ts:202-207`) and BEFORE `migrate(dbPath)` (`park.ts:210`), acquire the lock; wrap the remainder of the body in `try { … } finally { releaseRunLock(lock); }`. On a held lock, **mirror the HEAD-moved refuse mechanism** — `process.stderr.write(...)` + `process.exitCode = 65` + `return` — NOT a thrown `usageError` (that's exit 64 and never sets `process.exitCode`). The lock is taken before `migrate`/`openDb`, so on a held lock there is **no db to close**:
```ts
    const lock = acquireRunLock(dir);
    if (lock === null) {
      process.stderr.write(
        `resume refused: another 'styre run ${args.resume}' is already in progress (${dir}/run.lock).\n` +
          `  Wait for it to finish, or remove the stale lock if that process is gone.\n`,
      );
      process.exitCode = 65; // EXIT.RESUME_REFUSED — no db opened yet, nothing to close
      return;
    }
    try {
      migrate(dbPath);
      // ... existing resumeRun body (openDb → … → driveToTerminal → re-park tail) ...
    } finally {
      releaseRunLock(lock);
    }
```
The inner early-returns (inspect exit 0; HEAD-moved refuse exit 65) now sit inside the `try`, so the `finally` releases the lock on every path. `acquireRunLock` is O_EXCL + stale-reclaim (a crashed prior resume's lock is reclaimed).

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
- Consumes: `reconcileWorktree` (`src/dispatch/worktree.ts:181`, 5-arg with `checkpointDir`), `branchNameFor` (`src/agent/branch.ts`), `branchPrefixFor` (`src/integrations/ticket-source.ts:27`).
- Produces: `--fresh` frees the branch via the liveness-gated reconcile before the whole-dir delete + fresh run.

**Why this is a real fix, not an edge case (review reframe):** a **gracefully parked run** is the COMMON post-park state — it leaves a **non-prunable, styre-owned** worktree (its dir still exists) and a **released** lock. ENG-382's `--fresh` `rmSync`s the checkpoint then relies on `ensureWorktree`'s prunable-only retry — which **REFUSES** a non-prunable holder. So `styre run <ident> --fresh` on a normally-parked ticket aborts at `ensureWorktree` today. ENG-385 adds one `reconcileWorktree(..., checkpointDir)` in the `--fresh` block: with the owner's lock released (or absent), the liveness gate frees the styre-owned holder. This is the ONLY `--fresh` addition; do NOT duplicate ENG-382's delete/lock logic.

- [ ] **Step 1: Write the failing test**

Extend `run-live-location.test.ts`: a ticket with a **non-prunable styre-owned** leftover worktree holding its branch and **no live lock**; `styre run <ident> --fresh` succeeds (frees the leftover, starts fresh) instead of aborting at `ensureWorktree`.

- [ ] **Step 2: Run to verify FAIL** — `--fresh` aborts in `ensureWorktree` (prunable-only refuse) on the non-prunable leftover.

- [ ] **Step 3: Implement**

In the `--fresh` block (`run.ts:233-242`), after the existing lock check and BEFORE `rmSync(checkpointDir, …)`, free the branch via the liveness gate. `IngestedTicket` has NO `branch_name`/`branch_prefix`, so build the `branchNameFor` arg explicitly (import `branchPrefixFor` from `../integrations/ticket-source.ts`); `reconcileWorktree`'s `newWorktreePath` arg is used ONLY for the `=== repoPath` in-place check, so pass a plain non-repo path (no throwaway `mkdtempSync`):
```ts
      const freshBranch = branchNameFor({ ident: ingested.ident, branch_name: null, branch_prefix: branchPrefixFor(ingested.typeLabel) });
      // Free a styre-owned holder (the common post-park leftover) via the liveness gate before the
      // whole-dir delete — ensureWorktree's later prunable-only retry would refuse a non-prunable one.
      reconcileWorktree(profile.targetRepo, freshBranch, undefined, join(checkpointDir, "wt"), checkpointDir);
      rmSync(checkpointDir, { recursive: true, force: true });
```
(`ingested`, `checkpointDir`, `profile.targetRepo` are already in scope in the ENG-382 fresh path. `join(checkpointDir, "wt")` is a non-repo sentinel for the in-place check. Confirm the exact `IngestedTicket` field names + `branchNameFor`'s param type against `ticket-source.ts`/`branch.ts` when writing.)

- [ ] **Step 4: Run GREEN + full gates + commit**
```bash
git add src/cli/run.ts test/cli/run-live-location.test.ts
git commit -m "feat(resume): --fresh reconciles the worktree (frees the common styre-owned leftover) before discarding (ENG-385)"
```

---

## Self-Review

**Spec coverage (ENG-385 ticket + design §3.3/§7):**
- Consume the pending `human_resume` on resume (needs_you) → Task 1. ✓
- budget/interrupted resume proceeds (no reset-time gate — descoped, resolves §12 as always-allow) → Task 1 (fall-through) + Step 5 test. ✓
- re-arm-or-replan → verified automatic (recover→running; runStep pending|failed→failed; resolver→no-step); Task 1 tests it, no new code. ✓
- don't zero the attempt counter → Global Constraint (markRunning drives the cap; provision intentionally re-armed) + no `resetAttempt`. ✓
- `--inspect` from `failed` → Task 2. ✓
- `--fresh` reconcile → Task 4 (the common post-park case). ✓
- per-ticket lock on resume → Task 3 (flagged decision; refuse mirrors HEAD-moved: stderr + exitCode 65 + return). ✓
- needs_you e2e (STYRE-1 shape) → Task 1 Step 4. ✓

**Placeholder scan:** grounded "confirm at implementation" notes: the escalate trigger for `runNeedsYouTicket` (Task 1 Step 1, against `failure-policy.ts:69-89`) and the `IngestedTicket` field names for `branchNameFor` (Task 4 Step 3) — each cites its source, transcription-with-context, not TBDs. No `resumeReason`/`latestParkedResetAt` remain (removed with the descoped budget gate). `runNeedsYouTicket`'s body is a concrete recipe (failing `FakeAgentRunner` + `gitRepoWithProject` + `finishRunResult` tail).

**Type consistency:** the consume uses `listPending`/`markConsumed` (`signal.ts`) with real signatures; `acquireRunLock`/`releaseRunLock` (Task 3) and `reconcileWorktree` 5-arg + `branchNameFor({ident,branch_name,branch_prefix})` + `branchPrefixFor` (Task 4) match their real signatures.

## Residual open questions

- **Task 3 (per-ticket lock on resume): the one real decision.** Recommended for symmetry (prevents two `--resume` racing one live `run.db`); resume is lower-contention, so the human may prefer to defer until there's evidence of the race. **Flagged.** If deferred, drop Task 3.
- **`interrupted` reason** has no automated fixture (a true interrupted checkpoint needs a mid-flight kill / crashed live-location run); the consume-if-pending gate handles it correctly (no `human_resume` → falls through). Noted as manual validation.
