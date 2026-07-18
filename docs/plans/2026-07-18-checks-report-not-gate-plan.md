# Checks report-not-gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OSS `styre run` treat remote CI as a *reported fact*, never a gate — it exits PR-ready on local ground truth (verify-green + review-clean + PR open), emits one best-effort CI snapshot to telemetry, and never waits, polls, or loops back on CI.

**Architecture:** Subtractive at the control layer plus one small emit. Delete the `external_checks` resolver park so the merge stage flows push → pr-ensure → `human_merge_approval` wait (which `driveToTerminal` already treats as PR-ready) with no CI park in between. Delete the per-tick checks poller entirely. Add one new `ci_handoff` telemetry event, emitted once on the PR-ready path from a best-effort read of the existing `ChecksPort`. Remove the dead wait-budget scaffolding and reconcile the design docs.

**Tech Stack:** TypeScript + Bun, `bun:sqlite`, zod (telemetry schema), `bun:test`.

## Global Constraints

- **Never commit to `main`; work on `feat/checks-report-not-gate`** (already the current branch). PR-only; the operator merges. (CLAUDE.md)
- **Follow the approved spec exactly:** `docs/brainstorms/2026-07-18-checks-report-not-gate-design.md`. The five decisions D1–D5 are the contract; do not re-open them.
- **The t+0 CI read is best-effort and must NEVER throw, block, or affect control flow or the exit disposition.** On any error / unsupported system / missing sha it yields `not-reported`; `checksSystem:"none"` yields `skipped`.
- **Nothing is posted to the PR.** The handoff is telemetry-only (D3).
- **Telemetry event fields are `snake_case`** to match the existing `EventEvent`/`SignalEvent`/`SummaryEvent` members (the brainstorm's illustrative JSON used camelCase — the code follows the repo convention).
- **Adding a telemetry union member is additive — do NOT bump `SCHEMA_VERSION`** (consumers ignore unknown `type`s).
- **Schema is self-bootstrapping from `schema.sql`** (`migrate.ts` embeds it as text; ephemeral per-run DBs) — column removals are edits to the `CREATE TABLE`, no ALTER/migration. **Edit BOTH copies** — `src/db/schema.sql` (authoritative, loaded) and `docs/architecture/schema.sql` (doc mirror).
- **Historical docs are append-only** — `docs/plans/*.md` and dated `docs/brainstorms/*.md` that mention `external_checks` are history; do NOT rewrite them. Only the live design docs (control-loop / minimal-loop / glossary / execution-model / README / `brainstorm.md` changelog) change.
- **Run after each task:** `bun test` (full suite), `bunx biome check`, `bunx tsc --noEmit` (or the repo's `bun run typecheck`). Commit only on green.

---

### Task 1: Remove the `external_checks` gate from the merge resolver

Deleting the park makes the resolver return the `human_merge_approval` wait one step sooner — which `driveToTerminal` already treats as PR-ready — so no terminal-condition change is needed.

**Files:**
- Modify: `src/daemon/resolver.ts:238-240` (delete the park block)
- Test: `test/daemon/resolver.test.ts:466-470` (assert the new merge sequence)
- Test: `test/daemon/advance.test.ts:127-130` (assert `advanceOneStep` no longer parks on external_checks)

**Interfaces:**
- Consumes: nothing new.
- Produces: the `merge` resolver now yields, in order: `merge:push` → `merge:pr-ensure` → `{ kind: "wait", signalType: "human_merge_approval" }` → `{ kind: "advance", from: "merge", to: "released" }`. No `external_checks` descriptor is ever produced.

- [ ] **Step 1: Update the resolver test to the new sequence (write the failing test)**

In `test/daemon/resolver.test.ts`, replace the assertion block at ~466-470 that expects `external_checks` then `human_merge_approval`. After push + pr-ensure are recorded done, the next descriptor must be the `human_merge_approval` wait:

```ts
test("merge resolver parks on human_merge_approval right after pr-ensure (no external_checks gate)", () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId); // stage=merge, one completed dispatch (see existing helper)
  markStepDone(db, ticketId, "merge:push");
  markStepDone(db, ticketId, "merge:pr-ensure");
  const d = nextStepKey(db, ticketId);
  expect(d).toEqual({ kind: "wait", signalType: "human_merge_approval" });
});
```

(Reuse the file's existing seed/mark helpers and `nextStepKey` import. If a test asserting the `external_checks` wait still exists, delete it — that path is gone.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/resolver.test.ts`
Expected: FAIL — the resolver still returns `{ kind: "wait", signalType: "external_checks" }` before `human_merge_approval`.

- [ ] **Step 3: Delete the park in the resolver**

In `src/daemon/resolver.ts`, delete these three lines (238-240):

```ts
      if (!hasDelivered(db, ticketId, "external_checks")) {
        return { kind: "wait", signalType: "external_checks" };
      }
```

The `merge` case now reads:

```ts
    case "merge": {
      if (!done(db, ticketId, "merge:push")) {
        return step("merge:push", "project", "merge:push", null);
      }
      if (!done(db, ticketId, "merge:pr-ensure")) {
        return step("merge:pr-ensure", "project", "merge:pr-ensure", null);
      }
      if (!hasDelivered(db, ticketId, "human_merge_approval")) {
        return { kind: "wait", signalType: "human_merge_approval" };
      }
      return { kind: "advance", from: "merge", to: "released" };
    }
```

If `hasDelivered` is now used only for `human_merge_approval`, keep the import (still used). If biome flags an unused import after other edits, remove it then.

- [ ] **Step 4: Fix the advance test**

In `test/daemon/advance.test.ts` (~127-130), the case that drives a merge ticket and expects `{ kind: "waiting", signalType: "external_checks" }` must now expect `human_merge_approval`:

```ts
expect(await advanceOneStep(db, ticketId, registry, {})).toEqual({
  kind: "waiting",
  signalType: "human_merge_approval",
});
```

(Ensure the test seeds push + pr-ensure as done first, matching the file's existing setup.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/daemon/resolver.test.ts test/daemon/advance.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/resolver.ts test/daemon/resolver.test.ts test/daemon/advance.test.ts
git commit -m "fix(merge): remove the external_checks gate from the merge resolver"
```

---

### Task 2: Delete the per-tick checks poller

With no `external_checks` signal ever created (Task 1), the poller's work-list is always empty — delete it and its wiring, and drop the now-unused `profile` param from `tick`.

**Files:**
- Delete: `src/daemon/poll-checks.ts`
- Delete: `test/daemon/poll-checks.test.ts`
- Modify: `src/daemon/loop.ts` (remove the `pollChecks` import + call; drop `profile` from `tick`'s opts type)
- Modify: `src/daemon/run-ticket.ts:58-62` (stop passing `profile` into `tick`)

**Interfaces:**
- Consumes: nothing.
- Produces: `tick(db, registry, opts?)` where `opts` no longer has a `profile` field: `{ maxConcurrent?, config?, ports? }`. `driveToTerminal` still receives `profile` on its own opts (Task 3 uses it), it just no longer forwards it to `tick`.

- [ ] **Step 1: Delete the poller module and its test**

```bash
git rm src/daemon/poll-checks.ts test/daemon/poll-checks.test.ts
```

- [ ] **Step 2: Remove the poller from the tick loop**

In `src/daemon/loop.ts`: delete the import line `import { pollChecks } from "./poll-checks.ts";` (line 5) and the block (lines 51-53):

```ts
  if (opts?.profile) {
    await pollChecks(db, opts.profile, opts.ports?.checks);
  }
```

Then drop `profile` from the `tick` opts type (it now has no reader):

```ts
export async function tick(
  db: Database,
  registry: StepRegistry,
  opts?: {
    maxConcurrent?: number;
    config?: RuntimeConfig;
    ports?: ProjectorPorts;
  },
): Promise<{ advanced: number; blocked: boolean; parked?: ParkInfo }> {
```

- [ ] **Step 3: Stop forwarding `profile` into `tick`**

In `src/daemon/run-ticket.ts`, the `tick` call (58-62) becomes:

```ts
    const r = await tick(db, registry, {
      config: opts.config,
      ports: opts.ports,
    });
```

Also update the stale comment on `driveToTerminal` (line 29-31) — remove "Passes `profile` so pollChecks delivers external_checks." and replace with: "Emits a best-effort `ci_handoff` telemetry snapshot on the PR-ready path (checks are reported, never gated)."

- [ ] **Step 4: Run typecheck + the daemon tests to verify nothing references the poller**

Run: `bunx tsc --noEmit && bun test test/daemon/loop.test.ts test/daemon/run-ticket.test.ts`
Expected: typecheck PASS; `loop.test.ts` PASS. `run-ticket.test.ts` may FAIL on its third "no-progress via external stall" test — that is expected and is fixed in Task 3 (that stall path no longer exists). If it fails only there, proceed; Task 3 rewrites it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(loop): delete the checks poller and its tick wiring"
```

---

### Task 3: Add the `ci_handoff` telemetry event and emit it at PR-ready

**Files:**
- Modify: `src/telemetry/events.ts` (add `CiHandoffEvent` to the union)
- Modify: `src/telemetry/emitter.ts` (add `emitCiHandoff` method)
- Modify: `src/daemon/run-ticket.ts` (best-effort read + emit on the PR-ready branch)
- Test: `test/telemetry/events.test.ts` (schema accepts/rejects)
- Test: `test/telemetry/emitter.test.ts` (emit shape)
- Test: `test/daemon/run-ticket.test.ts` (pr-ready emits exactly one handoff; fail-safe read; rewrite the dead no-progress test)

**Interfaces:**
- Consumes: `getDeliveredPayload(db, ticketId, "external_pr_result")` → `{ ref?, url? }` (`src/db/repos/signal.ts`); `getLatestForTicket(db, ticketId)?.branch_head_sha` (`src/db/repos/dispatch.ts`); `ChecksPort.status({ ref })` → `"passing"|"failing"|"pending"` (`src/integrations/checks.ts`).
- Produces: telemetry event `{ type: "ci_handoff", schema_version, ticket_id, ident, pr_ref, pr_url, branch_head_sha, checks_system, read, measured_at }` where `read ∈ {passing, failing, pending, not-reported, skipped}`. Emitter method `emitCiHandoff(db, ticketId, { prRef, prUrl, sha, checksSystem, read })`.

- [ ] **Step 1: Write the failing schema test**

Add to `test/telemetry/events.test.ts`:

```ts
test("TelemetryEventSchema accepts a ci_handoff event", () => {
  const ev = {
    schema_version: SCHEMA_VERSION,
    type: "ci_handoff",
    ticket_id: 1,
    ident: "STYRE-1",
    pr_ref: "42",
    pr_url: "https://github.com/o/r/pull/42",
    branch_head_sha: "abc123",
    checks_system: "github",
    read: "not-reported",
    measured_at: "2026-07-18T12:00:00Z",
  };
  expect(TelemetryEventSchema.safeParse(ev).success).toBe(true);
});

test("TelemetryEventSchema rejects a ci_handoff with an unknown read value", () => {
  const ev = {
    schema_version: SCHEMA_VERSION, type: "ci_handoff", ticket_id: 1, ident: "STYRE-1",
    pr_ref: null, pr_url: null, branch_head_sha: null, checks_system: "none",
    read: "green", measured_at: "2026-07-18T12:00:00Z",
  };
  expect(TelemetryEventSchema.safeParse(ev).success).toBe(false);
});
```

(Ensure `TelemetryEventSchema` and `SCHEMA_VERSION` are imported in the test.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/telemetry/events.test.ts`
Expected: FAIL — `ci_handoff` is not a member of the discriminated union.

- [ ] **Step 3: Add the `CiHandoffEvent` to the union**

In `src/telemetry/events.ts`, add the member and include it in the union:

```ts
/** A one-shot best-effort snapshot of remote CI state at PR-open, handed off to whoever owns the
 *  outer loop (the plane, or a human on GitHub). CI is reported, never gated (report-not-gate). */
const CiHandoffEvent = z.object({
  schema_version: version,
  type: z.literal("ci_handoff"),
  ticket_id: z.number(),
  ident: z.string(),
  pr_ref: z.string().nullable(),
  pr_url: z.string().nullable(),
  branch_head_sha: z.string().nullable(),
  checks_system: z.string(),
  read: z.enum(["passing", "failing", "pending", "not-reported", "skipped"]),
  measured_at: z.string(),
});

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  EventEvent,
  DispatchEvent,
  SignalEvent,
  SummaryEvent,
  CiHandoffEvent,
]);
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `bun test test/telemetry/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing emitter test**

Add to `test/telemetry/emitter.test.ts` (capturing sink pattern; match the file's existing helpers):

```ts
test("emitCiHandoff sinks a well-formed ci_handoff event", () => {
  const { db, ticketId } = makeTestDb(); // seed a ticket with an ident
  db.query("UPDATE ticket SET ident = 'STYRE-9' WHERE id = ?").run(ticketId);
  const seen: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => seen.push(e));
  emitter.emitCiHandoff(db, ticketId, {
    prRef: "7", prUrl: "https://x/pull/7", sha: "deadbeef",
    checksSystem: "github", read: "pending",
  });
  expect(seen).toHaveLength(1);
  const ev = seen[0];
  expect(ev.type).toBe("ci_handoff");
  if (ev.type === "ci_handoff") {
    expect(ev.ident).toBe("STYRE-9");
    expect(ev.pr_ref).toBe("7");
    expect(ev.branch_head_sha).toBe("deadbeef");
    expect(ev.checks_system).toBe("github");
    expect(ev.read).toBe("pending");
    expect(typeof ev.measured_at).toBe("string");
  }
  db.close();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: FAIL — `emitCiHandoff` does not exist.

- [ ] **Step 7: Implement `emitCiHandoff`**

In `src/telemetry/emitter.ts`, add the import `import { nowUtc } from "../util/time.ts";`, extend the returned object's type, and add the method:

```ts
export function createTelemetryEmitter(sink: TelemetrySink): {
  flushNew(db: Database, ticketId: number): void;
  emitSummary(db: Database, ticketId: number, result: RunResult): void;
  emitCiHandoff(
    db: Database,
    ticketId: number,
    h: {
      prRef: string | null;
      prUrl: string | null;
      sha: string | null;
      checksSystem: string;
      read: "passing" | "failing" | "pending" | "not-reported" | "skipped";
    },
  ): void;
} {
```

and inside the returned object (after `emitSummary`):

```ts
    emitCiHandoff(db, ticketId, h) {
      const ticket = getTicket(db, ticketId);
      sink({
        schema_version: SCHEMA_VERSION,
        type: "ci_handoff",
        ticket_id: ticketId,
        ident: ticket?.ident ?? "",
        pr_ref: h.prRef,
        pr_url: h.prUrl,
        branch_head_sha: h.sha,
        checks_system: h.checksSystem,
        read: h.read,
        measured_at: nowUtc(),
      });
    },
```

- [ ] **Step 8: Run the emitter test to verify it passes**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing run-ticket handoff test**

In `test/daemon/run-ticket.test.ts`: add imports for a capturing sink and rewrite the tests. First, extend the "drives to pr-ready" test to assert the handoff, and **replace** the third "no-progress via external stall" test (its premise — an `external_checks` stall — no longer exists):

```ts
test("emits a ci_handoff on the pr-ready path", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: ports(),        // fakeChecks("passing"), checksSystem "none" on `profile`
    profile,
    emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("pr-ready");
  const handoffs = seen.filter((e) => e.type === "ci_handoff");
  expect(handoffs).toHaveLength(1);
  const h = handoffs[0];
  if (h.type === "ci_handoff") {
    expect(h.checks_system).toBe("none");
    expect(h.read).toBe("skipped"); // checksSystem none → skipped
    expect(h.pr_url).toContain("pull"); // fakeForge PR url captured from external_pr_result
  }
  db.close();
});

test("the ci_handoff read is fail-safe: a throwing checks port yields not-reported", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const ghProfile = parseProfile({
    slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", checksSystem: "github",
  });
  const throwingChecks = { status: async () => { throw new Error("boom"); } };
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: { issueTracker: fakeIssueTracker(), forge: fakeForge(), checks: throwingChecks },
    profile: ghProfile,
    emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("pr-ready"); // read failure never blocks the terminal
  const h = seen.find((e) => e.type === "ci_handoff");
  expect(h && h.type === "ci_handoff" && h.read).toBe("not-reported");
  db.close();
});
```

Delete the old third test ("reports no-progress when nothing advances…") that relied on `checksSystem:"external"` stalling on external_checks. Keep the "blocked when human_resume pending" test unchanged. Add the needed imports: `TelemetryEvent` from `../../src/telemetry/events.ts`.

- [ ] **Step 10: Run it to verify it fails**

Run: `bun test test/daemon/run-ticket.test.ts`
Expected: FAIL — no `ci_handoff` is emitted yet.

- [ ] **Step 11: Emit the handoff on the PR-ready branch**

In `src/daemon/run-ticket.ts`, add imports:

```ts
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import { getDeliveredPayload, listPending } from "../db/repos/signal.ts";
```

(Merge `getDeliveredPayload` into the existing `listPending` import from `../db/repos/signal.ts`.) Add a fail-safe read helper above `driveToTerminal`:

```ts
type CiRead = "passing" | "failing" | "pending" | "not-reported" | "skipped";

/** Best-effort t+0 read of remote CI state. NEVER throws and NEVER blocks control flow: any error,
 *  unsupported system, or missing sha → "not-reported"; checksSystem "none" → "skipped". */
async function readCiState(
  ports: ProjectorPorts,
  checksSystem: string,
  sha: string | null,
): Promise<CiRead> {
  if (checksSystem === "none") return "skipped";
  if (checksSystem !== "github" || !ports.checks || !sha) return "not-reported";
  try {
    return await ports.checks.status({ ref: sha });
  } catch {
    return "not-reported";
  }
}
```

Then replace the PR-ready branch (currently 75-76):

```ts
    if (t.stage === "merge" && pending.some((s) => s.signal_type === "human_merge_approval")) {
      const pr = getDeliveredPayload(db, opts.ticketId, "external_pr_result");
      const sha = getLatestForTicket(db, opts.ticketId)?.branch_head_sha ?? null;
      const read = await readCiState(opts.ports, opts.profile.checksSystem, sha);
      emitter.emitCiHandoff(db, opts.ticketId, {
        prRef: typeof pr?.ref === "string" ? pr.ref : null,
        prUrl: typeof pr?.url === "string" ? pr.url : null,
        sha,
        checksSystem: opts.profile.checksSystem,
        read,
      });
      return await finish({ outcome: "pr-ready", iterations: i, ...last });
    }
```

- [ ] **Step 12: Run the run-ticket tests to verify they pass**

Run: `bun test test/daemon/run-ticket.test.ts`
Expected: PASS (pr-ready + one handoff; fail-safe read → not-reported).

- [ ] **Step 13: Commit**

```bash
git add src/telemetry/events.ts src/telemetry/emitter.ts src/daemon/run-ticket.ts \
        test/telemetry/events.test.ts test/telemetry/emitter.test.ts test/daemon/run-ticket.test.ts
git commit -m "feat(telemetry): emit a best-effort ci_handoff snapshot at PR-ready"
```

---

### Task 4: Reconcile the merge integration/e2e tests

These tests assert the old gated flow (park on `external_checks`, poller delivers). Rewrite them to the new flow: merge parks directly on `human_merge_approval`; no `external_checks` signal is ever created; `tick` opts no longer carry `profile`.

**Files:**
- Modify: `test/dispatch/merge-complete-e2e.test.ts`
- Modify: `test/dispatch/merge-e2e.test.ts`
- Modify (sweep): any remaining test asserting `external_checks` — verify `test/daemon/advance-projection.test.ts`, `test/daemon/projector-pr-result.test.ts`, `test/db/repos/ticket-ext.test.ts`, `test/engine/signals.test.ts`, `test/dispatch/projector-e2e.test.ts`.

**Interfaces:**
- Consumes: the Task 1–3 behavior. No new production interfaces.

- [ ] **Step 1: Rewrite `merge-complete-e2e.test.ts`**

Both tests drive to `human_merge_approval` and assert `hasDelivered(external_checks)`. Remove the `external_checks` assertions and the `profile` from the `tick` opts. Since `tick` no longer takes `profile`, `opts` becomes `{ ports }`. The "none" and "github" tests now differ only by profile-at-registry-build; both park directly on `human_merge_approval`:

```ts
  const ports = { issueTracker: fakeIssueTracker(), forge: fakeForge() };
  await driveUntil(
    db, reg, { ports },
    () => listPending(db, ticketId).some((s) => s.signal_type === "human_merge_approval"),
    "human_merge_approval pending",
  );
  // (deleted) expect(hasDelivered(db, ticketId, "external_checks")).toBe(true);
```

Delete the now-unused `hasDelivered` import if nothing else uses it. Keep the operator-approves-merge → released assertions unchanged. For the github test, the `checks` port is no longer needed to reach `human_merge_approval` (nothing polls it); you may drop it from `ports` or leave it — the flow ignores it.

- [ ] **Step 2: Rewrite `merge-e2e.test.ts`**

Read the file. The test at ~51-103 is titled "push + PR opened, ticket parks awaiting external_checks" and asserts a pending `external_checks` signal (~103). Change its intent to "push + PR opened, ticket parks awaiting human_merge_approval":

```ts
// after driving ticks until push + pr-ensure have run:
expect(listPending(db, ticketId).some((s) => s.signal_type === "human_merge_approval")).toBe(true);
expect(listPending(db, ticketId).some((s) => s.signal_type === "external_checks")).toBe(false);
```

The `tick(db, reg, { ports })` calls already omit `profile`, so no signature change is needed there.

- [ ] **Step 3: Sweep the remaining `external_checks` references in tests**

Run: `grep -rn "external_checks" test/`
For each hit: if it asserts the presence/delivery of an `external_checks` signal, update it to reflect that the signal is never created (or delete the assertion). Likely-incidental files (`advance-projection`, `projector-pr-result`, `ticket-ext`, `signals`, `projector-e2e`) may only mention it in a comment or an unrelated fixture — inspect each and change only what asserts the gated flow. Expected end state: `grep -rn "external_checks" src/` returns **nothing**; `grep -rn "external_checks" test/` returns nothing (or only a comment noting its removal).

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS (0 fail). If a test still references the poller or `external_checks` behavior, fix it here.

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "test(merge): reconcile e2e tests to the report-not-gate flow"
```

---

### Task 5: Remove the dead wait-budget scaffolding from the schema

**Files:**
- Modify: `src/db/schema.sql:210-215` (authoritative)
- Modify: `docs/architecture/schema.sql:210-215` (doc mirror — keep identical)

**Interfaces:** none (dead columns; no code reads/writes them).

- [ ] **Step 1: Confirm the columns are dead**

Run: `grep -rn "max_attempts\|first_attempt_at\|last_attempt_at" src/ test/`
Expected: hits ONLY in `src/db/schema.sql` (and possibly `docs/architecture/schema.sql`). If any `.ts` reads/writes them, STOP — the assumption is wrong; report it rather than deleting.

- [ ] **Step 2: Delete the wait-budget columns in both schema files**

In `src/db/schema.sql`, remove the four wait-budget columns and their comment (lines ~211-215):

```sql
    -- Wait-budget fields (external_signal_budget).
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER,
    first_attempt_at TEXT,
    last_attempt_at TEXT,
```

(Confirm exact column list/defaults in the file before deleting; remove only the wait-budget block, leaving the rest of the `signal` table intact and the trailing comma on the preceding column correct.) Also update the signal-type comment at line ~207 to drop `external_checks` from the enumerated list. Apply the **identical** edit to `docs/architecture/schema.sql`.

- [ ] **Step 3: Verify the schema still loads and invariants hold**

Run: `bun test test/db/`
Expected: PASS — the schema bootstraps clean; the signal-table invariant tests still pass. (If a test inserts into the removed columns, update it.)

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.sql docs/architecture/schema.sql test/db/
git commit -m "chore(schema): drop the dead external-signal wait-budget columns"
```

---

### Task 6: Update the design docs to report-not-gate

**Files:**
- Modify: `docs/architecture/control-loop.md` (S8 rewrite; delete atlas P1/P2/P3; §11 worked example; OSS boundary note)
- Modify: `docs/architecture/minimal-loop.md` (remove the `POLL_INTERVAL` note)
- Modify: `docs/architecture/glossary.md` (the "signal" example: checks are observed once & reported, not awaited)
- Modify: `docs/architecture/execution-model.md` and `docs/architecture/README.md` (reconcile "checks green arrive as signals" wording for OSS)
- Modify: `docs/architecture/brainstorm.md` (append a §11 changelog entry; correct A1's "CI green (required check = merge arbiter)" to scope it to the commercial plane)

**Interfaces:** none (docs).

- [ ] **Step 1: Rewrite control-loop.md S8**

Replace the `S8 · merge:await-checks` section (~446-458) with a report-not-gate description: after the PR is opened, `styre run` takes **one** best-effort read of CI state, emits it as the `ci_handoff` telemetry event, and exits PR-ready — it does not wait for, re-poll, or loop back on CI. Note the read lives on the merge path to the PR-ready terminal, not as a dispatched step. State that CI-watch + reconcile is the commercial plane's outer loop (fenced, undesigned — like S9).

- [ ] **Step 2: Delete the atlas checks rows**

In the §8 Loopback Atlas, delete the "Checks (CI)" rows **P1, P2, P3** (~657-660) and any prose that references them (e.g. §8.4's "P3" in the escalate list). Add one line noting these were removed when CI stopped gating the OSS run (report-not-gate, 2026-07-18).

- [ ] **Step 3: Update the §11 worked example**

Collapse steps 14–16: the OSS `styre run` exits PR-ready right after the PR is opened (step 13), emitting the `ci_handoff`. Remove the "checks green — OSS exits PR-ready here" step 14. Steps 15–16 (human merge, released projection) remain fenced as commercial-plane. Update the trailing prose ("The OSS `styre run` drives steps 1–14…") accordingly.

- [ ] **Step 4: minimal-loop.md + glossary.md + execution-model.md + README.md**

- `minimal-loop.md`: remove the `POLL_INTERVAL = 60s` line/note (nothing polls).
- `glossary.md`: adjust the `signal` entry so "checks green" is not listed as an awaited control signal in OSS (checks are observed once and reported).
- `execution-model.md` (~132) and `README.md` (~49, ~54): reword "checks green … arrive only as signals" so CI is a reported fact in OSS, not an awaited gate. Keep "merged / human action" as the plane's signals.

- [ ] **Step 5: brainstorm.md changelog + A1 correction**

Append a dated entry to the §11 changelog summarizing the report-not-gate decision (link the brainstorm + this plan). Correct the A1 row's "CI green (required check = merge arbiter = required check)" clause to scope CI-as-arbiter to the commercial plane; in OSS, CI is reported, not gated. **Do not rewrite existing history** — append/annotate only.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/
git commit -m "docs(control-loop): checks are reported, not gated (report-not-gate)"
```

---

## Self-Review

**1. Spec coverage** (brainstorm §4–§8 → tasks):
- §4.1 delete resolver park + PR-ready terminal → **Task 1** (terminal condition unchanged by design — deletion suffices; documented).
- §4.1 t+0 read → **Task 3** (`readCiState`).
- §4.2 `ci_handoff` telemetry event (best-effort, not journaled) → **Task 3**.
- §4.3 delete poller + loop call + wait-budget columns + `external_checks` type → **Tasks 2 & 5**.
- §4.3 atlas P1/P2/P3 → **Task 6**.
- §4.4 plane inherits (fenced) → **Task 6** (docs note; no code).
- §4.5 doc changes → **Task 6**.
- §7 acceptance criteria → covered by tests in Tasks 1/3/4 (pr-ready-on-PR-opened; no external_checks signal; one ci_handoff; fail-safe read; none≡skipped) and greps in Tasks 4/5 (poller gone; no live external_checks).

**2. Placeholder scan:** The Task-4 Step-3 sweep and Task-5 Step-1 confirm are verification steps with exact grep commands and explicit expected end-states, not "handle edge cases" placeholders. No "TBD"/"TODO" remain.

**3. Type consistency:** `readCiState` returns `CiRead` (superset of `CheckVerdict "passing"|"failing"|"pending"`, so `ports.checks.status()`'s result is assignable). `emitCiHandoff`'s `read` param and the `CiHandoffEvent.read` zod enum share the same five values. `external_pr_result` payload is `{ ref: string, url: string }` (`projector.ts:149`), read via `getDeliveredPayload` and guarded with `typeof … === "string"`. `pr_ref`/`pr_url` are `string | null`.

**Known follow-through:** removing `profile` from `tick` (Task 2) forces the `merge-complete-e2e` tick-opts edit (Task 4 Step 1) — sequence Task 2 before Task 4. Task 3 fixes the `run-ticket.test.ts` failure that Task 2 Step 4 flags.
