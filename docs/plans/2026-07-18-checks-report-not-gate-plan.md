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
- **Adding a telemetry union member is additive — do NOT bump `SCHEMA_VERSION`** (a producer change; nothing in this repo consumes the stream). Caveat (design-sanctioned, no action here): `TelemetryEventSchema` is a zod `discriminatedUnion`, so a *consumer* validating against a pinned older union would reject an unknown `ci_handoff` rather than ignore it — "consumers ignore unknown types" is a convention of the §5.3 seam, not enforced by the schema.
- **Behavior change to state, not hide (D1):** after this change a repo whose CI is or goes **red** exits `pr-ready` / exit 0 — the run never loops back or escalates on CI. The `read:"failing"` value reaches only telemetry (and GitHub natively); the exit disposition is now fully decoupled from the CI verdict. This is intended per D1/§2 and MUST be covered by a test (Task 3) so it can't silently regress.
- **Out-of-band git hygiene (D4, not carried by this PR):** the design §4.3 also names abandoning the `feat/eng-337-checks-wait-budget` branch (local + origin) and the untracked `docs/brainstorms/2026-07-17-checks-quiescence-design.md` (which lives in `main`'s tree, not this worktree). These are **not** file edits in this plan and won't ride this PR; flagged here so the omission is explicit, not silent. The operator closes/deletes them separately.
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

Edit the **existing** test in `test/daemon/resolver.test.ts` — "merge: push → pr-ensure → wait checks → wait human → advance to released" (~460-478). It uses the file's real helpers `setTicketStage(db, ticketId, "merge")` and `await succeed(db, ticketId, <stepKey>)` (defined at ~line 14) — do NOT invent `seedAtMerge`/`markStepDone` (those don't exist in this file). Delete the three `external_checks` lines (~466-468): the `expect(...).toEqual({ kind: "wait", signalType: "external_checks" })` assertion **and** the `insertPending`/`markDelivered` that then satisfy it. The test must flow straight from pr-ensure to the human-merge wait. The relevant assertions become:

```ts
  await succeed(db, ticketId, "merge:push");
  await succeed(db, ticketId, "merge:pr-ensure");
  // (deleted the external_checks wait assertion + its insertPending/markDelivered)
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "wait", signalType: "human_merge_approval" });
```

Also rename the test (drop "wait checks") to e.g. "merge: push → pr-ensure → wait human → advance to released". If any other test in the file asserts the `external_checks` wait, delete it — that path is gone.

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

- [ ] **Step 4: Delete the now-dead "no-progress via external stall" test (Task 2's own collateral)**

Deleting the poller kills the premise of `test/daemon/run-ticket.test.ts`'s third test — "reports no-progress when nothing advances…" (~84-103), which drives `checksSystem:"external"` to stall on `external_checks`. That signal is never created now, so the ticket reaches pr-ready and the test can never see `no-progress`. Delete this test **in this task** so the commit stays green (do not defer it — a knowingly-red commit violates the Global Constraint "commit only on green"). Leave the other two run-ticket tests untouched here; Task 3 extends them.

Note (no action): `poll-checks.ts:42,50` were the only production callers of `deliverSignal` (`src/engine/signals.ts`). After this task `deliverSignal` is production-dead but still used by tests (e.g. `merge-complete-e2e.test.ts`), so it stays exported — no compile/lint break. This is expected: OSS no longer *delivers* a checks signal.

- [ ] **Step 5: Run typecheck + the daemon tests — all green**

Run: `bunx tsc --noEmit && bun test test/daemon/loop.test.ts test/daemon/run-ticket.test.ts`
Expected: typecheck PASS; both suites PASS (the dead test is gone).

- [ ] **Step 6: Commit**

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
    // The ONE deliberate push-style emit (the other members are derived from SoT rows by flushNew).
    // Justified: the handoff is an external network fact captured at the terminal, not a SoT row —
    // it feeds no control flow (CL-INV-6 safe) and writes nothing to the DB (CL-INV-7 safe), so the
    // derived-from-row pattern buys nothing and would cost a row-write + a derive fn. Best-effort,
    // lossy, dup-on-resume — squarely inside the §5.3 telemetry contract.
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

- [ ] **Step 8b: Commit the telemetry unit (commit 3a — independently reviewable)**

The event schema + emitter method are a self-contained unit with passing tests; commit them before the driver wiring so a bug in the read logic can't force a re-review of the schema.

```bash
git add src/telemetry/events.ts src/telemetry/emitter.ts test/telemetry/events.test.ts test/telemetry/emitter.test.ts
git commit -m "feat(telemetry): add the ci_handoff event + emitCiHandoff"
```

- [ ] **Step 9: Write the failing run-ticket handoff tests**

In `test/daemon/run-ticket.test.ts` add `import type { TelemetryEvent } from "../../src/telemetry/events.ts";` and a capturing sink. `seedAtMerge` and `ports()` already exist in THIS file (private helpers, ~37/50) — reuse them. Add four tests (the dead "no-progress via external stall" test was already removed in Task 2):

```ts
test("emits exactly one ci_handoff on the pr-ready path", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId, config: DEFAULT_RUNTIME_CONFIG, ports: ports(), profile, // checksSystem "none"
    emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("pr-ready");
  const handoffs = seen.filter((e) => e.type === "ci_handoff");
  expect(handoffs).toHaveLength(1);
  const h = handoffs[0];
  if (h.type === "ci_handoff") {
    expect(h.checks_system).toBe("none");
    expect(h.read).toBe("skipped"); // checksSystem none → skipped, no port touched
    expect(h.pr_url).toContain("/pr/"); // fakeForge emits https://fake/pr/N (NOT "pull")
    expect(h.pr_ref).not.toBeNull(); // external_pr_result delivered before pr-ready fires
  }
  db.close();
});

test("D1: a failing CI read still exits pr-ready (exit disposition decoupled from CI)", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const ghProfile = parseProfile({
    slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", checksSystem: "github",
  });
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId, config: DEFAULT_RUNTIME_CONFIG,
    ports: { issueTracker: fakeIssueTracker(), forge: fakeForge(), checks: fakeChecks("failing") },
    profile: ghProfile, emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("pr-ready"); // red CI never blocks or loops back
  const h = seen.find((e) => e.type === "ci_handoff");
  expect(h && h.type === "ci_handoff" && h.read).toBe("failing"); // reported, not gated
  db.close();
});

test("the ci_handoff read is fail-safe: a throwing checks port yields not-reported", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const ghProfile = parseProfile({
    slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", checksSystem: "github",
  });
  let calls = 0;
  const throwingChecks = { status: async () => { calls++; throw new Error("boom"); } };
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId, config: DEFAULT_RUNTIME_CONFIG,
    ports: { issueTracker: fakeIssueTracker(), forge: fakeForge(), checks: throwingChecks },
    profile: ghProfile, emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("pr-ready"); // read failure never blocks the terminal
  expect(calls).toBe(1); // the throwing port WAS reached (test isn't vacuous)
  const h = seen.find((e) => e.type === "ci_handoff");
  expect(h && h.type === "ci_handoff" && h.read).toBe("not-reported");
  db.close();
});

test("a non-merge terminal emits zero ci_handoffs", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  insertPending(db, { ticketId, signalType: "human_resume", reason: "stuck" });
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId, config: DEFAULT_RUNTIME_CONFIG, ports: ports(), profile,
    emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("blocked");
  expect(seen.filter((e) => e.type === "ci_handoff")).toHaveLength(0);
  db.close();
});
```

Keep the existing "drives to pr-ready" and "blocked when human_resume pending" tests, or fold them into the above (the last test supersedes the plain "blocked" one). Ensure `insertPending` and `fakeChecks` are imported (both already are in this file).

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

const CI_READ_TIMEOUT_MS = 8_000; // best-effort; never let the t+0 read block the terminal

/** Best-effort t+0 read of remote CI state. NEVER throws and NEVER blocks: any error, TIMEOUT,
 *  unsupported system, or missing sha → "not-reported"; checksSystem "none" → "skipped".
 *  The timeout is load-bearing: ChecksPort.status() (githubChecks) issues unbounded octokit
 *  paginate calls that HANG rather than throw on a slow/unreachable API — a bare try/catch would
 *  not save us, and a hang here would also block finish()'s outbox drain (the outbound PR/Linear
 *  projection), reintroducing the exact idle-burn this design deletes. */
async function readCiState(
  ports: ProjectorPorts,
  checksSystem: string,
  sha: string | null,
): Promise<CiRead> {
  if (checksSystem === "none") return "skipped";
  if (checksSystem !== "github" || !ports.checks || !sha) return "not-reported";
  const checks = ports.checks;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CiRead>((resolve) => {
    timer = setTimeout(() => resolve("not-reported"), CI_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([checks.status({ ref: sha }), timeout]);
  } catch {
    return "not-reported";
  } finally {
    clearTimeout(timer);
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

- [ ] **Step 13: Commit (commit 3b — driver wiring)**

```bash
git add src/daemon/run-ticket.ts test/daemon/run-ticket.test.ts
git commit -m "feat(run): emit the best-effort ci_handoff snapshot at PR-ready"
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
Expected: hits ONLY in `src/db/schema.sql` (and `docs/architecture/schema.sql`). If any `.ts` reads/writes them, STOP — the assumption is wrong; report it rather than deleting.

**WARNING — the bare `attempts` column is trickier.** The `signal` table's `attempts` (schema ~212) is also dead and to be deleted, but a bare `grep attempts` is noisy: `workflow_step.attempts` (schema ~482, read/written by `decrementAttempt`) and `projection_outbox.attempts` (heavily used by `projector.ts`/`projection-outbox.ts`) are **live and MUST NOT be touched**. Confirm `signal.attempts` is dead specifically: it appears in neither `signal.ts`'s `COLS` list (~17-19) nor any `.ts` query. Delete **only** the four-column block inside the `signal` `CREATE TABLE` (Step 2); never the `workflow_step`/`projection_outbox` columns.

- [ ] **Step 2: Delete the wait-budget columns in both schema files**

In `src/db/schema.sql`, remove the four wait-budget columns and their comment (lines ~211-215):

```sql
    -- Wait-budget fields (external_signal_budget).
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER,
    first_attempt_at TEXT,
    last_attempt_at TEXT,
```

(Confirm exact column list/defaults in the file before deleting; remove only the wait-budget block, leaving the rest of the `signal` table intact and the trailing comma on the preceding column correct.) Also clean up the now-stale `signal`-table comments: line ~207 (drop `external_checks` from the signal-type list), line ~208 (drop `'awaiting-checks'` from the `reason` list), and line ~202 (the "checks-system poll" mention). Apply the **identical** edits to `docs/architecture/schema.sql`.

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

> The design's §4.5 doc list was incomplete (three independent reviewers found stale gate-claims it missed). This task covers the **full** set so the authoritative docs are internally consistent — several are the canonical "read first" docs in CLAUDE.md, so a contradiction here is high-impact. Verify with the grep sweep in the final step.

**Files:**
- `docs/architecture/control-loop.md` — S8 rewrite (446-458); delete atlas rows P1/P2/P3 (657-660); §11 worked example (770-794); §7.3 signal-vocab table (560) + wait-budget prose (563-565); S9 OSS-boundary note (461-463) + guard (468); residual mentions (50, 85, 763).
- `docs/architecture/minimal-loop.md` — remove `POLL_INTERVAL`; fix the `next_step_key` pseudocode (~61) and the flow diagram (~206) that still route through `merge:await-checks`.
- `docs/architecture/execution-model.md` — the signal wording (~132) **and** the explicit OSS gate at ~166-169 ("waits for the project's checks system to go green… once checks pass, `styre run` exits").
- `docs/architecture/projector.md` — line 29 ("facts the runner *does* need (checks green? merged?) enter as delivered signals").
- `docs/architecture/glossary.md` — the `signal` entry example.
- `docs/architecture/README.md` — line 49 ("CI green … arrive only as signals").
- `docs/architecture/brainstorm.md` — append a §11 changelog entry; annotate A1.

**Interfaces:** none (docs). **Do not rewrite history** — for `brainstorm.md`, append/annotate only.

- [ ] **Step 1: control-loop.md — rewrite S8 (446-458)**

Replace the `S8 · merge:await-checks` section with a report-not-gate description: after the PR opens, `styre run` takes **one** best-effort t+0 read of CI state (bounded by an ~8s timeout), emits it as the `ci_handoff` telemetry event, and exits PR-ready — it does not wait for, re-poll, or loop back on CI. Note the read lives on the merge path to the PR-ready terminal, not as a dispatched step. State that CI-watch + reconcile is the commercial plane's outer loop (fenced, undesigned — like S9).

- [ ] **Step 2: control-loop.md — delete the atlas checks rows (657-660)**

Delete the "Checks (CI)" atlas rows **P1, P2, P3** at ~657-660 and the §8.4 escalate-list "P3" reference. Add one line noting they were removed when CI stopped gating the OSS run.

  **⚠️ WARNING — two different `P1/P2/P3` namespaces.** The §8.1 *first-principles invariants* **P1–P7** (~576-591: "P1 Recover-don't-halt", "P2 Ground-truth-triggers", "P3 Cost-and-time budget") and the cost-principle refs at ~256/584/669 are **load-bearing and MUST survive**. Delete only the **atlas rows** at 657-660 by their line anchor. Do **not** run a loose `grep P3` and delete matches — you will gut the invariants.

- [ ] **Step 3: control-loop.md — §11 worked example (770-794)**

Collapse steps 14–16: OSS `styre run` exits PR-ready right after the PR opens (step 13), emitting the `ci_handoff`. Remove the "checks green — OSS exits PR-ready here" step 14. Steps 15–16 (human merge, released projection) remain fenced as commercial-plane. Update the trailing prose ("The OSS `styre run` drives steps 1–14…").

- [ ] **Step 4: control-loop.md — §7.3 + S9 boundary + residuals**

- **§7.3 signal-vocabulary table (~560):** delete the `| external_checks | … |` row (that signal is never created again).
- **§7.3 prose (~563-565):** delete/replace the sentence "Budget fields (`attempts`, `max_attempts`, `first_attempt_at`) bound the wait; exhaustion → `human_resume`…" — it describes the columns Task 5 deletes.
- **S9 OSS-boundary note (~461-463):** it says OSS exits "once the PR exists with checks green (S7/S8)" — change to "once the PR exists (S7)"; CI is no longer part of the OSS exit.
- **S9 guard (~468):** "checks green (or none)" → drop the checks precondition.
- **Residual mentions:** reconcile line ~50 ("polling over webhooks in S8"), line ~85 (`poll_external_signals()` checks-system status — if inside fenced *plane* pseudocode, leave but confirm it's clearly plane-scoped), line ~763. Change only OSS-scoped claims; leave genuinely plane-fenced text.

- [ ] **Step 5: minimal-loop.md — pseudocode + diagram + POLL_INTERVAL**

- Remove the `POLL_INTERVAL = 60s` line/note (nothing polls).
- **`next_step_key` pseudocode (~61):** delete the `if not delivered('external_checks'): return 'merge:await-checks'` branch so merge flows push → pr-ensure → `merge:await-human`.
- **Flow diagram (~206):** remove the `→ merge:await-checks(poll)` node so it reads `… → merge:pr-ensure → merge:await-human`.

- [ ] **Step 6: execution-model.md + projector.md + glossary.md + README.md**

- `execution-model.md` (~132): reword so CI is a reported fact in OSS, not an awaited signal (keep "merged / human action" as signals). **Also (~166-169):** rewrite "waits for the project's checks system to go green. Once checks pass, `styre run` exits" → exits at PR-open; CI is snapshotted to telemetry, not awaited.
- `projector.md` (~29): "facts the runner *does* need (checks green? merged?) enter as delivered signals" → drop checks-green from the OSS list (merged/human action stay plane signals).
- `glossary.md`: adjust the `signal` entry so "checks green" is not an awaited OSS control signal (observed once and reported).
- `README.md` (~49): reword "CI green … arrive only as signals" to match.

- [ ] **Step 7: brainstorm.md — changelog + A1 annotation**

Append a dated §11 changelog entry summarizing report-not-gate (link this brainstorm + plan). Annotate the A1 row (~393) — its actual text is "…(required check = merge arbiter; PR #184 hermeticity is a prereq)" — to scope CI-as-arbiter to the commercial plane; in OSS, CI is reported, not gated. Append/annotate only; do not rewrite the entry.

- [ ] **Step 8: Sweep for residual stale claims, then commit**

Run: `grep -rniE "await-checks|external_checks|POLL_INTERVAL|checks (green|pass).*(exit|gate|wait)" docs/architecture/`
Expected: no live OSS-gating claims remain (only genuinely plane-fenced pseudocode, if any, and historical entries). Reconcile any straggler, then:

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
- §7 acceptance criteria → covered by tests in Tasks 1/3/4 (pr-ready-on-PR-opened; no external_checks signal; exactly-one ci_handoff on pr-ready + **zero** on a non-merge terminal; fail-safe read via throw **and** timeout → not-reported; `read:"failing"` still exits pr-ready [D1]; none≡skipped) and greps in Tasks 4/5/6 (poller gone; no live external_checks; no stale gate-claims in docs). The "timed-out → not-reported" AC is met by `CI_READ_TIMEOUT_MS` + `Promise.race` in `readCiState` (Task 3 Step 11).

**2. Placeholder scan:** The Task-4 Step-3 sweep and Task-5 Step-1 confirm are verification steps with exact grep commands and explicit expected end-states, not "handle edge cases" placeholders. No "TBD"/"TODO" remain.

**3. Type consistency:** `readCiState` returns `CiRead` (superset of `CheckVerdict "passing"|"failing"|"pending"`, so `ports.checks.status()`'s result is assignable). `emitCiHandoff`'s `read` param and the `CiHandoffEvent.read` zod enum share the same five values. `external_pr_result` payload is `{ ref: string, url: string }` (`projector.ts:149`), read via `getDeliveredPayload` and guarded with `typeof … === "string"`. `pr_ref`/`pr_url` are `string | null`.

**Known follow-through:** removing `profile` from `tick` (Task 2) forces the `merge-complete-e2e` tick-opts edit (Task 4 Step 1) — sequence Task 2 before Task 4. Task 2 deletes the now-dead "no-progress via external stall" run-ticket test as its own collateral (so every commit stays green); Task 3 then only *adds* run-ticket tests. Task 3 commits in two independently-reviewable halves (3a event+emitter, 3b read+wiring).

**Post-revision note:** this plan was revised after a 3-reviewer independent panel. Folded in: the read timeout (blocker), the two broken test snippets (`pr_url` `/pr/` and the real `resolver.test.ts` helpers), the green-commit ordering, the D1 `failing`-read + zero-handoff tests, the Task-5 `attempts`-column guard, and the substantially expanded Task 6 doc set (state-machine pseudocode, §7.3, S9 note, `projector.md`, with a guard against deleting the §8.1 invariants). The direct-emit design was endorsed and kept.
