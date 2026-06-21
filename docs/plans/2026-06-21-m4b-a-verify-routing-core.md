# M4b-a — Verify-Failure Routing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make verify failures route correctly and make re-verification trustworthy — every check result is stamped with the commit it judged, checks re-run when the code changes (never reused on stale results, never deleted), failures route by kind, repeated no-progress escalates, a whole-project failure spawns a fix unit, and a retry after a bounce-back uses the stronger model tier.

**Architecture:** The fix for stale re-verification is a **content stamp, not a deletion**: each check result records the commit fingerprint (branch-head SHA) it ran against, and the resolver decides "has this check passed for the *current* code?" by looking for a passing result *at the current commit*. A new coding attempt produces a new commit, so its checks have no results yet and re-run automatically; old results stay forever as history. Re-execution of previously-passed checks is handled by re-opening the unit's verify steps on a bounce-back. The resolver stays a pure function of the database (it reads the current commit from the recorded coding-attempt, never from git). Failure routing gains kind-discrimination (a check that couldn't run vs. one that genuinely failed), signature-based escalation (the same failure twice → stop and ask a human), a whole-project-failure path that adds a reconcile unit, and tier escalation on retry.

**Tech Stack:** Bun (1.3.5), `bun:sqlite`, `bun test`, Biome.

## Global Constraints

- **Never delete or overwrite check-result history.** Every check result is permanent and tagged with the commit it judged. The self-learning layer (post-cutover) reads this trail.
- **Re-verification is content-keyed.** "Has this check passed?" means "is there a passing result *at the current commit*?" — never "is there any result?". A new commit ⇒ checks re-run.
- **Load-bearing invariant (state it, rely on it):** a coding attempt that changes nothing never reaches verification — the daemon rejects an empty-diff coding attempt at the coding step. So "reaching verification" guarantees a new commit. The verify layer must not depend on git; it reads the current commit from the recorded coding attempt.
- **Ground truth gates the step** (move 5): verify still throws on a non-pass result; the daemon computes routing from recorded state, never from agent self-report.
- **Verify stays daemon-run, read-only, no agent, no commit** (move 4 / B2). Only the daemon writes the database.
- **The resolver stays pure** (control-loop §2.3): a function of SQLite state only — no git reads, no mutation. `advance` interprets descriptors and mutates.
- **Provider-agnostic intact:** no `src/agent/*` change except the already-wired `DispatchSpec.loopback`/`resolveTier` path (consumed, not redefined).
- **Timestamps stored UTC** via `nowUtc()`.
- **Bun conventions:** `.ts` import extensions; `import type` for type-only imports; double quotes; semicolons; 2-space / 100-col; no non-null assertions; `noUnusedLocals`/`noUnusedParameters`; Biome `organizeImports` (run `bun run lint`; apply `./node_modules/.bin/biome check --write .` if flagged).
- **Full gate before each commit:** `bun test && bun run lint && bun run typecheck` all clean (the existing suite stays green).
- **Conventional Commits.** Branch `feat/m4b-verify-routing` only — never `main`, no push, no PR (the operator opens/merges).

## Explicitly DEFERRED to M4b-b (do NOT build here)

- The behavioral-test-in-diff gate (a behavioral unit's test check requiring a test file in the coding diff).
- The `scope_diff` advisory check.
- Both need new git-diff/changed-files inspection + a profile test-file pattern — that whole substrate is M4b-b.

## Vocabulary (plain ↔ code, for the implementer)

- "commit fingerprint" / "current commit" = the branch-head SHA recorded on a coding attempt's `dispatch` row (`branch_head_sha`).
- "coding attempt" = a `dispatch` row (per-unit implement dispatch).
- "check result" = a `ground_truth_signal` row.
- "whole-project check" = `verify:integration`; "per-chunk check" = `verify:check` for a `work_unit`.
- "bounce-back" = a verify loopback (unit reset to `pending`, re-implemented).
- "fix unit" / "reconcile unit" = a `work_unit` with `kind = "reconcile"`.

## File Structure

- **Modify `docs/architecture/schema.sql`** + **`src/db/repos/ground-truth-signal.ts`** — add `branch_head_sha` to the result row; record it; query passing results at a given SHA.
- **Modify `src/db/repos/dispatch.ts`** — add `getLatestByWorkUnit` and `getLatestForTicket` (the current commit for a unit / for the branch).
- **Modify `src/dispatch/handlers.ts`** — stamp each verify result with the current commit; fix the spawn-failure result class; (Task 6) set the loopback tier flag when re-implementing.
- **Modify `src/daemon/resolver.ts`** — make `nextUnrunCheck` and the integration gate content-keyed (passing result at the current commit).
- **Modify `src/daemon/failure-policy.ts`** — re-open all of a unit's verify steps on a bounce-back; discriminate could-not-run (retry) vs. genuinely-failed (loopback); escalate on a repeated failure signature; whole-project failure → reconcile unit.
- **Tests** alongside each.

---

### Task 1: record the commit fingerprint on each check result + "current commit" lookups

**Files:**
- Modify: `docs/architecture/schema.sql` (the `ground_truth_signal` table)
- Modify: `src/db/repos/ground-truth-signal.ts`
- Modify: `src/db/repos/dispatch.ts`
- Test: `test/db/repos/ground-truth-signal.test.ts`, `test/db/repos/dispatch.test.ts`

**Interfaces:**
- Consumes: existing `insertSignal`/`listByUnit`/`GroundTruthSignalRow`; `DispatchRow`/`listByTicket`.
- Produces:
  - `GroundTruthSignalRow` gains `branch_head_sha: string | null`.
  - `insertSignal(db, p)` gains optional `p.branchHeadSha?: string`.
  - `passingShasFor(db, args: { ticketId: number; workUnitId: number | null; signalType: string }): string[]` — the SHAs at which this check has a PASS result (for the resolver's content-keyed decision).
  - `getLatestByWorkUnit(db, workUnitId: number): DispatchRow | null` — the unit's most recent coding attempt (max `seq`).
  - `getLatestForTicket(db, ticketId: number): DispatchRow | null` — the ticket's most recent coding attempt with a non-null `branch_head_sha` (the current branch commit).

- [ ] **Step 1: Write the failing test** — append to `test/db/repos/ground-truth-signal.test.ts`

```ts
test("records branch_head_sha and reports the SHAs a check passed at", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "fail", branchHeadSha: "aaa" });
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "pass", branchHeadSha: "bbb" });
  const passed = passingShasFor(db, { ticketId, workUnitId: unit.id, signalType: "test" });
  db.close();
  expect(passed).toEqual(["bbb"]); // only the passing SHA, history of the fail kept
});
```

And a new `test/db/repos/dispatch.test.ts`:

```ts
import { expect, test } from "bun:test";
import { completeDispatch, getLatestByWorkUnit, getLatestForTicket, insertDispatch, nextSeq } from "../../../src/db/repos/dispatch.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("getLatestByWorkUnit / getLatestForTicket return the most recent coding attempt", () => {
  const { db, ticketId } = makeTestDb();
  const d1 = insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: nextSeq(db, ticketId), workUnitId: 7 });
  completeDispatch(db, d1.id, { outcome: "clean-success", branchHeadSha: "sha1" });
  const d2 = insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: nextSeq(db, ticketId), workUnitId: 7 });
  completeDispatch(db, d2.id, { outcome: "clean-success", branchHeadSha: "sha2" });
  const latestUnit = getLatestByWorkUnit(db, 7);
  const latestTicket = getLatestForTicket(db, ticketId);
  db.close();
  expect(latestUnit?.branch_head_sha).toBe("sha2");
  expect(latestTicket?.branch_head_sha).toBe("sha2");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/db/repos/ground-truth-signal.test.ts test/db/repos/dispatch.test.ts`
Expected: FAIL — `passingShasFor`/`getLatestByWorkUnit`/`getLatestForTicket` undefined; `branch_head_sha` missing.

- [ ] **Step 3: Add the column** — in `docs/architecture/schema.sql`, inside `CREATE TABLE ground_truth_signal`, add this line immediately after the `command TEXT,` line:

```sql
    branch_head_sha TEXT,                               -- the commit fingerprint this check ran against (M4b-a)
```

- [ ] **Step 4: Wire `ground-truth-signal.ts`**

Add `branch_head_sha: string | null;` to `GroundTruthSignalRow` (after `command`). Add `branch_head_sha` to `COLS` (after `command`). Add `branchHeadSha` to `insertSignal`'s param + INSERT column list + `$sha: p.branchHeadSha ?? null` binding (insert the column in the same position in both the column list and VALUES). Append:

```ts
export function passingShasFor(
  db: Database,
  args: { ticketId: number; workUnitId: number | null; signalType: string },
): string[] {
  const rows = db
    .query<{ branch_head_sha: string | null }, [number, number | null, string]>(
      `SELECT branch_head_sha FROM ground_truth_signal
       WHERE ticket_id = ? AND work_unit_id IS ? AND signal_type = ? AND result = 'pass'
         AND branch_head_sha IS NOT NULL`,
    )
    .all(args.ticketId, args.workUnitId, args.signalType);
  return rows.map((r) => r.branch_head_sha).filter((s): s is string => s !== null);
}
```

> Note: `work_unit_id IS ?` matches NULL correctly when `workUnitId` is null (integration), unlike `=`.

- [ ] **Step 5: Wire `dispatch.ts`** — append:

```ts
export function getLatestByWorkUnit(db: Database, workUnitId: number): DispatchRow | null {
  return (
    db
      .query<DispatchRow, [number]>(
        `SELECT ${COLS} FROM dispatch WHERE work_unit_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(workUnitId) ?? null
  );
}

export function getLatestForTicket(db: Database, ticketId: number): DispatchRow | null {
  return (
    db
      .query<DispatchRow, [number]>(
        `SELECT ${COLS} FROM dispatch WHERE ticket_id = ? AND branch_head_sha IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      )
      .get(ticketId) ?? null
  );
}
```

- [ ] **Step 6: Run the tests + full suite**

Run: `bun test test/db/repos/ground-truth-signal.test.ts test/db/repos/dispatch.test.ts && bun test`
Expected: PASS; full suite green (the new column is additive/nullable; existing callers omit it).

- [ ] **Step 7: Lint + typecheck + commit**

Run: `bun run lint && bun run typecheck`
```bash
git add docs/architecture/schema.sql src/db/repos/ground-truth-signal.ts src/db/repos/dispatch.ts test/db/repos/ground-truth-signal.test.ts test/db/repos/dispatch.test.ts
git commit -m "feat(m4b-a): stamp check results with the verified commit + current-commit lookups"
```

---

### Task 2: verify handlers stamp the verified commit + fix the could-not-run result class

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/verify-handlers.test.ts`

**Interfaces:**
- Consumes: `getLatestByWorkUnit`, `getLatestForTicket` (Task 1); `insertSignal` with `branchHeadSha` (Task 1); existing `worktreeFor`, `runCommand`, `VERIFY_TIMEOUT_MS`.
- Produces: both verify handlers record `branchHeadSha` on their signal; the result mapping treats a could-not-spawn outcome as `"error"`.

**Behavior:** the commit a per-chunk check judges = the unit's latest coding attempt's `branch_head_sha`; for the whole-project check = the ticket's latest coding attempt's `branch_head_sha`. Record it on the signal. Result class: `exitCode === 0` → `"pass"`; **`timedOut || exitCode === null`** → `"error"` (timeout or could-not-spawn = infrastructure, not a test failure); otherwise `"fail"`. Apply the same mapping in both handlers.

- [ ] **Step 1: Write the failing test** — append to `test/dispatch/verify-handlers.test.ts`

```ts
test("verify:check stamps the verified commit on the signal", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { test: "true" });
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);
  // record a coding attempt with a known commit for the unit
  const d = insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: nextSeq(db, ticketId), workUnitId: unit.id });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "deadbeef" });

  await advanceOneStep(db, ticketId, registry);
  const sig = listByUnit(db, unit.id)[0];
  db.close();
  expect(sig?.result).toBe("pass");
  expect(sig?.branch_head_sha).toBe("deadbeef");
});
```

(Add imports for `insertDispatch`, `nextSeq`, `completeDispatch` from `../../src/db/repos/dispatch.ts`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/verify-handlers.test.ts`
Expected: FAIL — `sig.branch_head_sha` is null (handler doesn't stamp it yet).

- [ ] **Step 3: Edit `src/dispatch/handlers.ts`**

Add imports: `getLatestByWorkUnit`, `getLatestForTicket` from `../db/repos/dispatch.ts`.

In `verify:check`, before `insertSignal`, resolve the commit and use the corrected mapping:

```ts
const latest = getLatestByWorkUnit(ctx.db, ctx.workUnitId);
const branchHeadSha = latest?.branch_head_sha ?? null;
const result = run.exitCode === 0 ? "pass" : run.timedOut || run.exitCode === null ? "error" : "fail";
insertSignal(ctx.db, {
  ticketId: ctx.ticket.id,
  workUnitId: ctx.workUnitId,
  signalType: checkType,
  result,
  command,
  branchHeadSha: branchHeadSha ?? undefined,
  detail: { exitCode: run.exitCode, timedOut: run.timedOut, stderr: run.stderr.slice(0, 2000) },
});
```

In `verify:integration`, resolve the branch commit and apply the same mapping fix:

```ts
const branchHeadSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha ?? undefined;
```
…and in the loop, compute `result` with `run.timedOut || run.exitCode === null ? "error" : "fail"` for the non-zero case, and pass `branchHeadSha` to the integration `insertSignal`.

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/dispatch/verify-handlers.test.ts && bun test`
Expected: PASS; full suite green.

- [ ] **Step 5: Lint + typecheck + commit**

Run: `bun run lint && bun run typecheck`
```bash
git add src/dispatch/handlers.ts test/dispatch/verify-handlers.test.ts
git commit -m "feat(m4b-a): verify handlers stamp the verified commit; could-not-run maps to error"
```

---

### Task 3: content-keyed re-verification in the resolver

**Files:**
- Modify: `src/daemon/resolver.ts`
- Test: `test/daemon/resolver.test.ts`

**Interfaces:**
- Consumes: `passingShasFor` (Task 1); `getLatestByWorkUnit`, `getLatestForTicket` (Task 1).
- Produces: `nextUnrunCheck` becomes content-keyed (a check is satisfied only by a PASS result at the unit's current commit); a unit is marked verified only when every check has a PASS at the current commit; the integration gate runs the whole-project check unless a PASS integration result exists at the current branch commit.

**Behavior:** the resolver stays pure — it reads "the current commit" from the latest coding attempt (database), never from git. If there is no coding attempt yet (no commit), treat every check as unrun (it will run once the unit has been coded).

- [ ] **Step 1: Write the failing test** — append to `test/daemon/resolver.test.ts`

```ts
test("nextUnrunCheck: a check that passed at an OLD commit is unrun at the new commit", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  setStatus(db, unit.id, "verifying");
  // latest coding attempt is at commit "new"
  const d = insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: nextSeq(db, ticketId), workUnitId: unit.id });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "new" });
  // a stale PASS from a previous commit
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "pass", branchHeadSha: "old" });
  const u = getById(db, unit.id);
  if (!u) throw new Error("no unit");
  const check = nextUnrunCheck(db, u);
  db.close();
  expect(check).toBe("test"); // stale pass does NOT satisfy the current commit
});

test("nextUnrunCheck: a PASS at the current commit satisfies the check", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  setStatus(db, unit.id, "verifying");
  const d = insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: nextSeq(db, ticketId), workUnitId: unit.id });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "cur" });
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "pass", branchHeadSha: "cur" });
  const u = getById(db, unit.id);
  if (!u) throw new Error("no unit");
  const check = nextUnrunCheck(db, u);
  db.close();
  expect(check).toBeNull(); // satisfied → resolver will mark-verified
});
```

(Import `insertDispatch`, `nextSeq`, `completeDispatch`, `insertSignal`, `getById`, `setStatus` as needed; avoid the `!` shown in the comment — use the `if (!u) throw` form.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/daemon/resolver.test.ts`
Expected: FAIL — current `nextUnrunCheck` treats any signal (any commit) as "run", so the stale-pass test returns `null` instead of `"test"`.

- [ ] **Step 3: Edit `src/daemon/resolver.ts`**

Add imports: `getLatestByWorkUnit`, `getLatestForTicket` from `../db/repos/dispatch.ts`. (`gts` is already imported.)

Add a pure helper and rewrite `nextUnrunCheck`:

```ts
/** The commit a unit's verification is currently judged against = the unit's latest coding
 *  attempt's branch head. Null if it hasn't been coded yet. */
function currentShaForUnit(db: Database, workUnitId: number): string | null {
  return getLatestByWorkUnit(db, workUnitId)?.branch_head_sha ?? null;
}

/** First declared check-type for the unit that has NOT passed at the unit's current commit.
 *  A pass recorded against an older commit does not count (content-keyed re-verification). */
export function nextUnrunCheck(db: Database, unit: workUnits.WorkUnitRow): string | null {
  const sha = currentShaForUnit(db, unit.id);
  for (const check of workUnits.parseVerifyCheckTypes(unit)) {
    const passedShas = gts.passingShasFor(db, {
      ticketId: unit.ticket_id,
      workUnitId: unit.id,
      signalType: check,
    });
    const satisfied = sha !== null && passedShas.includes(sha);
    if (!satisfied) {
      return check;
    }
  }
  return null;
}
```

Replace the integration gate. In the `implement` case, change:

```ts
if (!done(db, ticketId, "verify:integration")) {
  return step("verify:integration", "verify", "verify:integration", null);
}
```
to a content-keyed gate:

```ts
const branchSha = getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
const integrationPassedShas = gts.passingShasFor(db, {
  ticketId,
  workUnitId: null,
  signalType: "integration",
});
if (branchSha === null || !integrationPassedShas.includes(branchSha)) {
  return step("verify:integration", "verify", "verify:integration", null);
}
```

- [ ] **Step 4: Run the tests + full suite**

Run: `bun test test/daemon/resolver.test.ts && bun test`
Expected: the two new tests PASS. Existing resolver/e2e tests may now expect updated behavior — if any fails because it relied on the old "any signal = run" semantics WITHOUT recording a coding attempt + matching SHA, update that test to record a coding attempt with a `branch_head_sha` and stamp its signals with the same SHA (the realistic shape). Do NOT loosen an assertion to pass; make the test reflect the real content-keyed flow. If a failure looks like a genuine resolver bug, STOP and report.

- [ ] **Step 5: Lint + typecheck + commit**

Run: `bun run lint && bun run typecheck`
```bash
git add src/daemon/resolver.ts test/daemon/resolver.test.ts
git commit -m "feat(m4b-a): content-keyed re-verification (pass-at-current-commit)"
```

---

### Task 4: re-open all of a unit's checks on a bounce-back + route by failure kind + escalate on repeated failure

**Files:**
- Modify: `src/daemon/failure-policy.ts`
- Test: `test/daemon/failure-policy.test.ts`

**Interfaces:**
- Consumes: existing `applyFailurePolicy`, `failureSignature`, `appendEvent`, `resetToPending`, `setUnitStatus`; `listByTicket` (event-log) for signature history; the failed step row (`error_json`, `step_key`, `step_type`, `work_unit_id`).
- Produces: on a per-chunk verify bounce-back, ALL of that unit's verify steps reset to `pending` (so previously-passed checks re-run at the new commit); a verify failure whose recorded result was `error` (could-not-run / infrastructure) is a **retry**, not a bounce-back; the same failure signature occurring twice in a row escalates immediately (no-progress).

**Behavior detail:**
- "All of a unit's verify steps" = `workflow_step` rows with `work_unit_id = unit` and `step_type = "verify"`. Add `listVerifyStepsForUnit(db, ticketId, workUnitId)` to `workflow-step.ts` (returns rows) and reset each to pending.
- Discriminate could-not-run vs. failed using the failed step's most recent check result: if the latest `ground_truth_signal` for this step's check (by `measured_at`) is `error` → infrastructure → `retry` (re-run the check, no re-code); if `fail` → re-code (`loopback`).
- No-progress escalation: read the last two `loopback` events for the ticket; if the new signature equals the previous one (same check failing the same way back-to-back) → escalate instead of looping. This is the backstop for the trivial-change-that-doesn't-fix case.

- [ ] **Step 1: Write the failing tests** — append to `test/daemon/failure-policy.test.ts`

```ts
test("verify bounce-back re-opens ALL of the unit's verify steps", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["build", "test"] });
  const buildStep = insertPending(db, { ticketId, workUnitId: unit.id, stepKey: "verify:wu1:build", stepType: "verify" });
  markRunning(db, buildStep.id, {}); markSucceeded(db, buildStep.id, { ok: true }); // build already passed
  const testStep = insertPending(db, { ticketId, workUnitId: unit.id, stepKey: "verify:wu1:test", stepType: "verify" });
  markRunning(db, testStep.id, {}); markFailed(db, testStep.id, new Error("tests red"));
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "fail" });

  const failed = getById(db, testStep.id);
  if (!failed) throw new Error("no step");
  const r = applyFailurePolicy(db, ticketId, failed);
  const buildAfter = getById(db, buildStep.id);
  db.close();
  expect(r.decision).toBe("loopback");
  expect(buildAfter?.status).toBe("pending"); // the previously-passed check was re-opened too
});

test("a could-not-run verify failure retries instead of bouncing back", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const step = insertPending(db, { ticketId, workUnitId: unit.id, stepKey: "verify:wu1:test", stepType: "verify" });
  markRunning(db, step.id, {}); markFailed(db, step.id, new Error("spawn error"));
  insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "error" });
  const s = getById(db, step.id);
  if (!s) throw new Error("no step");
  const r = applyFailurePolicy(db, ticketId, s);
  db.close();
  expect(r.decision).toBe("retry"); // infrastructure error, not a code failure
});
```

(Import `insertSignal` from ground-truth-signal; `markSucceeded`/`markFailed`/`markRunning`/`getById`/`insertPending` from workflow-step.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/daemon/failure-policy.test.ts`
Expected: FAIL — currently only the failed step resets (build stays succeeded), and an `error`-class verify failure still loops back.

- [ ] **Step 3: Add `listVerifyStepsForUnit` to `src/db/repos/workflow-step.ts`**

```ts
export function listVerifyStepsForUnit(db: Database, ticketId: number, workUnitId: number): WorkflowStepRow[] {
  return db
    .query<WorkflowStepRow, [number, number]>(
      `SELECT ${COLS} FROM workflow_step WHERE ticket_id = ? AND work_unit_id = ? AND step_type = 'verify'`,
    )
    .all(ticketId, workUnitId);
}
```

- [ ] **Step 4: Rewrite the verify branch of `applyFailurePolicy`** in `src/daemon/failure-policy.ts`

Add imports: `listVerifyStepsForUnit` from `../db/repos/workflow-step.ts`; `listByUnit` from `../db/repos/ground-truth-signal.ts`; `listByTicket as listEvents` from `../db/repos/event-log.ts`.

Add helpers and replace the `step.step_type === "verify" && step.work_unit_id !== null` block:

```ts
/** The kind of the most recent recorded result for this verify step's check.
 *  'error' = could-not-run (infrastructure), 'fail' = genuine failure, null = none. */
function latestVerifyResult(db: Database, step: WorkflowStepRow): string | null {
  if (step.work_unit_id === null) {
    return null;
  }
  const check = step.step_key.split(":").pop() ?? "";
  const rows = listByUnit(db, step.work_unit_id).filter((s) => s.signal_type === check);
  return rows.length === 0 ? null : (rows[rows.length - 1]?.result ?? null);
}

/** True when the same failure signature was the immediately-previous loopback for this ticket
 *  (no progress between attempts → escalate). */
function isRepeatedFailure(db: Database, ticketId: number, signature: string): boolean {
  const loopbacks = listEvents(db, ticketId).filter((e) => e.kind === "loopback");
  const prev = loopbacks[loopbacks.length - 1];
  return prev?.signature === signature;
}
```

Replace the verify-loopback block with:

```ts
if (step.step_type === "verify" && step.work_unit_id !== null) {
  const workUnitId = step.work_unit_id;
  const signature = failureSignature(step);

  // Could-not-run (infrastructure) → retry the check, don't re-code.
  if (latestVerifyResult(db, step) === "error") {
    resetToPending(db, step.id);
    return { decision: "retry" };
  }

  // No progress since the last identical failure → escalate now.
  if (isRepeatedFailure(db, ticketId, signature)) {
    db.transaction(() => {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, {
        ticketId,
        signalType: "human_resume",
        reason: `no progress: '${step.step_key}' failed identically twice`,
      });
      appendEvent(db, { ticketId, kind: "escalated", reason: "no progress", signature });
    })();
    return { decision: "escalated" };
  }

  // Genuine failure → bounce the unit back to coding; re-open ALL its checks so the
  // previously-passed ones re-run against the new commit.
  db.transaction(() => {
    setUnitStatus(db, workUnitId, "pending");
    for (const s of listVerifyStepsForUnit(db, ticketId, workUnitId)) {
      resetToPending(db, s.id);
    }
    appendEvent(db, { ticketId, kind: "loopback", loop: "implement", routeTo: step.step_key, signature });
  })();
  return { decision: "loopback" };
}
```

(`insertSignal` here is the signal-repo `insertPending as insertSignal` already imported at the top of failure-policy.ts.)

- [ ] **Step 5: Run the tests + full suite**

Run: `bun test test/daemon/failure-policy.test.ts && bun test`
Expected: PASS; full suite green. If an existing failure-policy test asserted the old "reset only the failed step" behavior, update it to the new shape (all unit verify steps reset). Do not loosen assertions.

- [ ] **Step 6: Lint + typecheck + commit**

Run: `bun run lint && bun run typecheck`
```bash
git add src/daemon/failure-policy.ts src/db/repos/workflow-step.ts test/daemon/failure-policy.test.ts
git commit -m "feat(m4b-a): re-open all unit checks on bounce-back; route by kind; escalate repeats"
```

---

### Task 5: whole-project failure spawns a fix unit (reconcile)

**Files:**
- Modify: `src/daemon/failure-policy.ts`
- Test: `test/daemon/failure-policy.test.ts`

**Interfaces:**
- Consumes: `insertWorkUnit` (`work-unit.ts`); `listByTicket` (`work-unit.ts`) for the next `seq`; `resetToPending`; `appendEvent`.
- Produces: when the failed step is the whole-project check (`step_type = "verify"`, `work_unit_id === null`), add a `kind = "reconcile"` work-unit (depending on all existing units, so it runs last), reset the integration step to pending, and return `loopback`.

**Behavior:** the reconcile unit gets `seq = max(seq)+1`, `kind = "reconcile"`, `behavioral = 0`, and `verify_check_types = []` (the whole-project check is the gate; the reconcile unit itself just needs to build/commit). It depends on every existing unit's `seq` so the resolver schedules it after them.

- [ ] **Step 1: Write the failing test** — append to `test/daemon/failure-policy.test.ts`

```ts
test("whole-project failure spawns a reconcile unit and re-opens integration", () => {
  const { db, ticketId } = makeTestDb();
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verified" });
  const intStep = insertPending(db, { ticketId, stepKey: "verify:integration", stepType: "verify" });
  markRunning(db, intStep.id, {}); markFailed(db, intStep.id, new Error("integration red"));
  const s = getById(db, intStep.id);
  if (!s) throw new Error("no step");
  const r = applyFailurePolicy(db, ticketId, s);
  const units = listByTicket(db, ticketId);
  const reconcile = units.find((u) => u.kind === "reconcile");
  const intAfter = getById(db, intStep.id);
  db.close();
  expect(r.decision).toBe("loopback");
  expect(reconcile).toBeDefined();
  expect(reconcile?.status).toBe("pending");
  expect(intAfter?.status).toBe("pending");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/failure-policy.test.ts`
Expected: FAIL — integration failure currently falls to plain `retry`; no reconcile unit is created.

- [ ] **Step 3: Edit `src/daemon/failure-policy.ts`**

Add imports: `insertWorkUnit`, `listByTicket as listUnits` from `../db/repos/work-unit.ts`.

Add this block BEFORE the final `resetToPending(db, step.id); return { decision: "retry" };` (and after the per-unit verify block):

```ts
// Whole-project (integration) failure → ticket-scoped reconcile: add a fix unit that runs
// after all others, then re-open the integration check.
if (step.step_type === "verify" && step.work_unit_id === null) {
  db.transaction(() => {
    const units = listUnits(db, ticketId);
    const nextSeqNum = Math.max(0, ...units.map((u) => u.seq)) + 1;
    insertWorkUnit(db, {
      ticketId,
      seq: nextSeqNum,
      kind: "reconcile",
      behavioral: 0,
      verifyCheckTypes: [],
      dependsOn: units.map((u) => u.seq),
    });
    resetToPending(db, step.id);
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "integration",
      routeTo: step.step_key,
      signature: failureSignature(step),
    });
  })();
  return { decision: "loopback" };
}
```

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/daemon/failure-policy.test.ts && bun test`
Expected: PASS; full suite green.

- [ ] **Step 5: Lint + typecheck + commit**

Run: `bun run lint && bun run typecheck`
```bash
git add src/daemon/failure-policy.ts test/daemon/failure-policy.test.ts
git commit -m "feat(m4b-a): integration failure spawns a reconcile work-unit (N1)"
```

---

### Task 6: a retry after a bounce-back uses the stronger model tier

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/handlers.test.ts`

**Interfaces:**
- Consumes: existing `implement:dispatch` handler; `DispatchSpec.loopback` (already consumed by `runAgentDispatch`/`resolveTier`); `listByTicket` (event-log) to detect a prior bounce-back for the unit.
- Produces: the `implement:dispatch` handler sets `loopback: true` in its `DispatchSpec` when this unit has been bounced back before (so the model escalates standard → deep).

**Behavior:** "has this unit been bounced back?" = there is a `loopback` event whose `route_to` names this unit's verify step (`verify:wu{seq}:`). Add `isUnitLoopback(db, ticketId, unitSeq)`.

- [ ] **Step 1: Write the failing test** — append to `test/dispatch/handlers.test.ts`

```ts
test("implement:dispatch escalates to the deep tier after a bounce-back", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  // simulate a prior bounce-back of this unit
  appendEvent(db, { ticketId, kind: "loopback", loop: "implement", routeTo: "verify:wu1:test", signature: "x" });
  const runner = new FakeAgentRunner((input) => { writeFileSync(join(input.cwd, "f.ts"), "export const y=2;\n"); return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }; });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "true" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-lbwt-")),
  });

  await advanceOneStep(db, ticketId, registry);
  const model = listByTicket(db, ticketId)[0]?.model;
  db.close();
  expect(model).toBe("claude-opus-4-8"); // deep tier (escalated), not the standard sonnet
});
```

(Imports for this test: `appendEvent` from `../../src/db/repos/event-log.ts`; `listByTicket` from `../../src/db/repos/dispatch.ts`; `buildDispatchRegistry` from `../../src/dispatch/handlers.ts`; `DEFAULT_AGENT_CONFIG`, `parseProfile`, `FakeAgentRunner`, `insertWorkUnit`, `makeTestDb`, `mkdtempSync`, `tmpdir`, `join`, `writeFileSync` as in the other handler tests; reuse the file's existing `gitRepo` helper.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/handlers.test.ts`
Expected: FAIL — model is `claude-sonnet-4-6` (standard); loopback flag never set.

- [ ] **Step 3: Edit `src/dispatch/handlers.ts`**

Add import: `listByTicket as listEvents` from `../db/repos/event-log.ts`.

Add a helper near `worktreeFor`:

```ts
/** Has this unit been bounced back to coding before? (a loopback event targeting its checks) */
function isUnitLoopback(ctx: HandlerContext, unitSeq: number): boolean {
  const prefix = `verify:wu${unitSeq}:`;
  return listEvents(ctx.db, ctx.ticket.id).some(
    (e) => e.kind === "loopback" && (e.route_to?.startsWith(prefix) ?? false),
  );
}
```

In the `implement:dispatch` handler, set the flag on the `DispatchSpec`:

```ts
loopback: isUnitLoopback(ctx, unit.seq),
```

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/dispatch/handlers.test.ts && bun test`
Expected: PASS; full suite green.

- [ ] **Step 5: Lint + typecheck + commit**

Run: `bun run lint && bun run typecheck`
```bash
git add src/dispatch/handlers.ts test/dispatch/handlers.test.ts
git commit -m "feat(m4b-a): escalate to deep tier when re-implementing after a bounce-back"
```

---

### Task 7: end-to-end — fail → re-code → re-verify (history kept), and integration → reconcile

**Files:**
- Create: `test/dispatch/verify-routing-e2e.test.ts`

**Interfaces:**
- Consumes: `buildDispatchRegistry`, `advanceOneStep`, `FakeAgentRunner`, repos. No new production code — if the e2e surfaces a real bug, STOP and report it (don't patch the test around it).

**Behavior:** prove the loop converges and keeps history. A unit whose test check fails on the first coding attempt, then passes after a second coding attempt, ends `verified`, AND both the failing and passing results remain on record (stamped with different commits). Drive it with a `FakeAgentRunner` whose first run writes code that fails the profile test command and whose second run writes code that passes.

- [ ] **Step 1: Write the e2e** — `test/dispatch/verify-routing-e2e.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByUnit } from "../../src/db/repos/ground-truth-signal.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-vr-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

test("a unit that fails then passes ends verified, with both results on record", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });

  // The profile test command checks for a marker file the agent writes only on its 2nd attempt.
  let attempt = 0;
  const runner = new FakeAgentRunner((input) => {
    attempt += 1;
    writeFileSync(join(input.cwd, `change-${attempt}.ts`), `export const v = ${attempt};\n`);
    if (attempt >= 2) writeFileSync(join(input.cwd, "PASS"), "ok");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "test -f PASS" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vrwt-")),
  });

  for (let i = 0; i < 12; i++) {
    if (getUnit(db, unit.id)?.status === "verified") break;
    await advanceOneStep(db, ticketId, registry);
  }
  const results = listByUnit(db, unit.id);
  const finalUnit = getUnit(db, unit.id);
  db.close();
  expect(finalUnit?.status).toBe("verified");
  expect(results.some((r) => r.result === "fail")).toBe(true); // the first attempt's failure is kept
  expect(results.some((r) => r.result === "pass")).toBe(true); // the second attempt's pass
  expect(new Set(results.map((r) => r.branch_head_sha)).size).toBeGreaterThan(1); // distinct commits
});
```

- [ ] **Step 2: Run the e2e**

Run: `bun test test/dispatch/verify-routing-e2e.test.ts`
Expected: PASS. If it loops without converging or a handler throws unexpectedly, STOP and report which module is at fault — do not loosen the assertion.

- [ ] **Step 3: Run the FULL gate**

Run: `bun test && bun run lint && bun run typecheck && bun run build && ./dist/styre --version`
Expected: full suite green, Biome clean, `tsc --noEmit` exit 0, binary builds and prints its version.

- [ ] **Step 4: Commit**

```bash
git add test/dispatch/verify-routing-e2e.test.ts
git commit -m "test(m4b-a): e2e fail→re-code→re-verify converges and keeps history"
```

---

## M4b-a acceptance criteria

- [ ] Every check result records the commit it judged; re-verification is content-keyed (a pass only counts at the current commit); nothing is deleted.
- [ ] A previously-passed check re-runs after the unit is bounced back (all the unit's checks re-open).
- [ ] A could-not-run verify failure retries; a genuine failure bounces back to coding; the same failure twice in a row escalates to a human.
- [ ] A spawn failure is recorded as `error` (not `fail`).
- [ ] A whole-project failure spawns a reconcile unit and re-opens the whole-project check.
- [ ] Re-implementing a unit after a bounce-back uses the deep model tier.
- [ ] e2e: fail → re-code → re-verify converges to `verified` with both results on record at distinct commits.
- [ ] `bun test` green; lint + typecheck clean; binary builds. No `src/agent/*` change beyond consuming the existing loopback flag.

## Out of scope (M4b-b and later)

- Behavioral-test-in-diff gate · `scope_diff` advisory · the git changed-files + profile test-pattern substrate → **M4b-b**.
- Cross-stage re-run of the whole-project check after a review-stage bounce-back (needs the review loop) → **M5**.
- Distinct-count budgets / B2 / B3 spend ceilings beyond the consecutive-identical escalation → later.
