# M6a — Projection Substrate + Issue-Tracker Port (Linear) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the one-way projector substrate — the transactional outbox drain that mirrors ticket state outward — behind a vendor-neutral `IssueTrackerPort`, with an official-SDK Linear adapter, so a ticket's stage progress reflects into the issue tracker with zero vendor lock-in.

**Architecture:** Stage transitions enqueue `projection_outbox` rows **in the same transaction** as the state change (event-driven, idempotency-keyed). A `drainOutbox` projector reads pending rows and dispatches each to a port method by **neutral role** (`target ∈ {issue_tracker, forge}`) — never a vendor name. The `IssueTrackerPort` (setState/setLabels/addComment) is selected from `RuntimeConfig.issueTracker` via a factory mirroring `selectAgentRunner`; the core depends only on the interface, vendor specifics + the official `@linear/sdk` live solely in the Linear adapter. The daemon holds creds (from env) and is the sole outward writer; agents have none.

**Tech Stack:** TypeScript + Bun + `bun:sqlite`; zod; `@linear/sdk` (official, new dep); the existing `selectAgentRunner` adapter pattern + `FakeAgentRunner`-style fake ports + the signals engine.

## Global Constraints

- **Never commit to `main`.** Work on branch `feat/m6a-projector-linear` (already created).
- **Zero vendor lock-in (operator directive).** The core imports only the port INTERFACE. Vendor specifics + official SDKs live solely in adapters, selected by config (mirror `selectAgentRunner`). A new vendor (JIRA) = a new adapter + a config value; no core or schema change. The outbox `target` is a **neutral role** (`issue_tracker`/`forge`), never a vendor name.
- **One config object.** Integration selection is fields on the EXISTING `RuntimeConfig` (`issueTracker`), NOT a new config type. Credentials come from **env** (the `ANTHROPIC_API_KEY` precedent), never config values. Constructed adapter INSTANCES are injected deps (like the `AgentRunner` instance), not config.
- **Enqueue in the SAME transaction as the state change** (CL-2 / projector §2). State and intent-to-project can never disagree.
- **Idempotent two ways** (projector §1): the outbox `idempotency_key` is globally UNIQUE by construction (re-enqueue = no-op insert), AND each adapter is declarative/probe-idempotent (set-to-desired; comments deduped by a `proj-key` tag).
- **No control-flow reads** (CL-INV-5): the projector only WRITES outward. Inbound facts arrive only as signals. Never read the issue tracker to decide anything.
- **A projection failure never blocks the loop** (projector §7): a transient error retries next drain; past `OUTBOX_RETRY_BUDGET` it escalates the ticket (parks on `human_resume`) — never a silent infinite retry, never a lost row.
- Run the full gate before claiming done: `bun test` · `bun run lint` · `bun run typecheck` · `bun run build`. Every task's gate includes `bun run lint`. The Linear adapter task additionally must `bun run build` clean (the new SDK dep bundles into the binary).
- **Schema change (operator-approved):** the `target` CHECK in BOTH `src/db/schema.sql` AND `docs/architecture/schema.sql` changes from `('linear','github')` to `('issue_tracker','forge')` on `projection_outbox` AND `projection_state`. This is the only schema change; the two files must stay byte-identical.

## Scope boundaries (deferred — note, don't build)
- **Forge port + GitHub adapter + merge stage + checks-system** → M6b.
- **`projection_state` snapshot / delta-suppression** → deferred (event-driven enqueue + unique keys + probe-idempotent adapters deliver the same goal). The table's `target` is still made neutral (Task 1) but M6a writes no rows to it.
- **`linear_id_cache` seeding + `setup` bootstrap** → deferred; the Linear adapter resolves names→ids live via the SDK.
- **Comment projections for escalations / review findings** (projector §3 `add_comment` rows) → deferred; M6a projects stage transitions (state + labels). The `add_comment` op + adapter method are still built (Task 2/3/5) so M6b/later can enqueue them.
- **The long-running `styre daemon` process** → later CLI milestone. M6a wires `drainOutbox` into the existing `tick` and tests it directly.

---

## File Structure

- **Modify** `src/db/schema.sql` + `docs/architecture/schema.sql` — neutral `target` CHECK (both tables, both files).
- **Create** `src/db/repos/projection-outbox.ts` — the outbox repo (enqueue idempotent, list pending, mark sent/failed, bump attempts).
- **Create** `src/integrations/issue-tracker.ts` — `IssueTrackerPort` interface + neutral `IssueState` type + `selectIssueTracker` factory.
- **Create** `src/integrations/adapters/fake-issue-tracker.ts` — an in-memory recording adapter for tests.
- **Create** `src/integrations/adapters/linear.ts` — the official-SDK Linear adapter.
- **Create** `src/daemon/projector.ts` — `drainOutbox` + the stage-transition enqueue helpers (`stageToState`, `enqueueStageProjection`).
- **Modify** `src/config/runtime-config.ts` — add `issueTracker` field.
- **Modify** `src/daemon/advance.ts` — enqueue stage-transition projection rows in the advance transaction.
- **Modify** `src/daemon/loop.ts` — `tick` drains the outbox (when ports supplied).
- **Tests:** `test/db/repos/projection-outbox.test.ts`, `test/integrations/issue-tracker.test.ts`, `test/daemon/projector.test.ts`, `test/daemon/advance-projection.test.ts`, `test/daemon/projector-e2e.test.ts`.

---

### Task 1: Neutral `target` schema + the `projection_outbox` repo

**Files:**
- Modify: `src/db/schema.sql`, `docs/architecture/schema.sql`
- Create: `src/db/repos/projection-outbox.ts`
- Test: `test/db/repos/projection-outbox.test.ts`

**Interfaces:**
- Consumes: the `projection_outbox` table.
- Produces:
  - `OutboxRow` (selected columns).
  - `OutboxTarget = "issue_tracker" | "forge"`.
  - `enqueue(db, p: { ticketId: number; target: OutboxTarget; op: string; payload?: unknown; idempotencyKey: string }): void` — INSERT that no-ops on a duplicate `idempotency_key` (re-enqueue is harmless).
  - `listPending(db): OutboxRow[]` — `status='pending'` ordered by `created_at, id`.
  - `markSent(db, id, responseRef?: string | null): void`; `bumpAttempt(db, id, error: string): void` (attempts+1, stays pending); `markFailed(db, id, error: string): void` (status='failed').

- [ ] **Step 1: Change the schema (both files, both tables)**

In BOTH `src/db/schema.sql` and `docs/architecture/schema.sql`, change the `target` CHECK on `projection_state` AND `projection_outbox`:

```sql
    target          TEXT NOT NULL CHECK (target IN ('issue_tracker','forge')),
```

Update the adjacent comments that say `'linear'/'github'` to the neutral roles. The two files must remain byte-identical.

- [ ] **Step 2: Write the failing test**

Create `test/db/repos/projection-outbox.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { bumpAttempt, enqueue, listPending, markFailed, markSent } from "../../../src/db/repos/projection-outbox.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("enqueue inserts a pending row; listPending returns it", () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", payload: { state: "in_progress" }, idempotencyKey: "k1" });
  const pending = listPending(db);
  db.close();
  expect(pending.length).toBe(1);
  expect(pending[0]?.target).toBe("issue_tracker");
  expect(pending[0]?.op).toBe("set_state");
  expect(JSON.parse(pending[0]?.payload_json ?? "{}").state).toBe("in_progress");
});

test("enqueue is idempotent on idempotency_key (re-enqueue is a no-op)", () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", idempotencyKey: "dup" });
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", idempotencyKey: "dup" });
  const pending = listPending(db);
  db.close();
  expect(pending.length).toBe(1);
});

test("markSent removes a row from pending; bumpAttempt keeps it pending; markFailed removes it", () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", idempotencyKey: "a" });
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", idempotencyKey: "b" });
  const [a, b] = listPending(db);
  markSent(db, a!.id, "resp-1");
  bumpAttempt(db, b!.id, "transient");
  const afterPending = listPending(db);
  markFailed(db, b!.id, "gave up");
  const finalPending = listPending(db);
  db.close();
  expect(afterPending.map((r) => r.id)).toEqual([b!.id]); // a sent (gone), b still pending
  expect(afterPending[0]?.attempts).toBe(1);
  expect(finalPending.length).toBe(0); // b now failed
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/db/repos/projection-outbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the repo**

Create `src/db/repos/projection-outbox.ts` (mirror the style of `src/db/repos/signal.ts` — `Row` interface, `COLS`, `nowUtc()`):

```typescript
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export type OutboxTarget = "issue_tracker" | "forge";

export interface OutboxRow {
  id: number;
  ticket_id: number;
  target: string;
  op: string;
  payload_json: string | null;
  idempotency_key: string;
  status: string;
  attempts: number;
  response_ref: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

const COLS =
  "id, ticket_id, target, op, payload_json, idempotency_key, status, attempts, response_ref, error, created_at, sent_at";

/** Enqueue a projection. No-ops on a duplicate idempotency_key (globally unique by construction →
 *  enqueue-twice is harmless), so callers can enqueue freely inside the state-change transaction. */
export function enqueue(
  db: Database,
  p: { ticketId: number; target: OutboxTarget; op: string; payload?: unknown; idempotencyKey: string },
): void {
  db.query(
    `INSERT OR IGNORE INTO projection_outbox
       (ticket_id, target, op, payload_json, idempotency_key, status, attempts, created_at)
     VALUES ($t, $target, $op, $payload, $key, 'pending', 0, $now)`,
  ).run({
    $t: p.ticketId,
    $target: p.target,
    $op: p.op,
    $payload: p.payload === undefined ? null : JSON.stringify(p.payload),
    $key: p.idempotencyKey,
    $now: nowUtc(),
  });
}

export function listPending(db: Database): OutboxRow[] {
  return db
    .query<OutboxRow, []>(
      `SELECT ${COLS} FROM projection_outbox WHERE status = 'pending' ORDER BY created_at, id`,
    )
    .all();
}

export function markSent(db: Database, id: number, responseRef?: string | null): void {
  db.query(
    `UPDATE projection_outbox SET status = 'sent', response_ref = $ref, sent_at = $now WHERE id = $id`,
  ).run({ $ref: responseRef ?? null, $now: nowUtc(), $id: id });
}

export function bumpAttempt(db: Database, id: number, error: string): void {
  db.query(
    `UPDATE projection_outbox SET attempts = attempts + 1, error = $err WHERE id = $id`,
  ).run({ $err: error, $id: id });
}

export function markFailed(db: Database, id: number, error: string): void {
  db.query(`UPDATE projection_outbox SET status = 'failed', error = $err WHERE id = $id`).run({
    $err: error,
    $id: id,
  });
}
```

- [ ] **Step 5: Run test + full suite**

Run: `bun test test/db/repos/projection-outbox.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS. The schema change is backward-compatible (no existing data; no code reads `target` yet). Confirm `git diff main -- src/db/schema.sql docs/architecture/schema.sql` shows ONLY the `target` CHECK lines changed, identically in both files.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql docs/architecture/schema.sql src/db/repos/projection-outbox.ts test/db/repos/projection-outbox.test.ts
git commit -m "feat(m6a): neutral outbox target (issue_tracker/forge) + projection_outbox repo"
```

---

### Task 2: `IssueTrackerPort` + neutral types + config selection + fake adapter

**Files:**
- Create: `src/integrations/issue-tracker.ts`
- Create: `src/integrations/adapters/fake-issue-tracker.ts`
- Modify: `src/config/runtime-config.ts`
- Test: `test/integrations/issue-tracker.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `IssueState = "in_progress" | "in_review" | "done" | "canceled" | "blocked"`.
  - `IssueTrackerPort`:
    - `setState(ref: string, state: IssueState): Promise<void>`
    - `setLabels(ref: string, change: { add: string[]; remove: string[] }): Promise<void>`
    - `addComment(ref: string, body: string, idempotencyKey: string): Promise<string | null>` (returns the created comment's id/ref, or null)
  - `IssueTrackerFactory = () => IssueTrackerPort`; `selectIssueTracker(config: { issueTracker: string }, adapters: Record<string, IssueTrackerFactory>): IssueTrackerPort` (mirrors `selectAgentRunner` — throws on unknown).
  - `fakeIssueTracker(): IssueTrackerPort & { calls: Array<{ method: string; args: unknown[] }> }` — records calls in `.calls`.
  - `RuntimeConfig` gains `issueTracker: string` (default `"linear"`).

- [ ] **Step 1: Write the failing tests**

Create `test/integrations/issue-tracker.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { selectIssueTracker } from "../../src/integrations/issue-tracker.ts";

test("selectIssueTracker returns the configured adapter", () => {
  const fake = fakeIssueTracker();
  const port = selectIssueTracker({ issueTracker: "linear" }, { linear: () => fake });
  expect(port).toBe(fake);
});

test("selectIssueTracker throws on an unregistered adapter", () => {
  expect(() => selectIssueTracker({ issueTracker: "jira" }, { linear: () => fakeIssueTracker() })).toThrow();
});

test("fakeIssueTracker records calls", async () => {
  const fake = fakeIssueTracker();
  await fake.setState("ENG-1", "in_progress");
  await fake.setLabels("ENG-1", { add: ["stage:implement"], remove: ["stage:design"] });
  const id = await fake.addComment("ENG-1", "hi", "k1");
  expect(fake.calls.map((c) => c.method)).toEqual(["setState", "setLabels", "addComment"]);
  expect(id).not.toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/integrations/issue-tracker.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the port + factory**

Create `src/integrations/issue-tracker.ts`:

```typescript
/** Vendor-neutral issue-tracker port (zero lock-in). The core depends only on this interface;
 *  Linear/JIRA/etc. are config-selected adapters that live behind it. Mirrors the AgentRunner
 *  pattern (src/agent/runner.ts + selectAgentRunner). */
export type IssueState = "in_progress" | "in_review" | "done" | "canceled" | "blocked";

export interface IssueTrackerPort {
  /** Set the issue's coarse state. The adapter maps the neutral state to its vendor vocabulary. */
  setState(ref: string, state: IssueState): Promise<void>;
  /** Apply a label delta, preserving labels outside the delta (label-safe; never clobbers). */
  setLabels(ref: string, change: { add: string[]; remove: string[] }): Promise<void>;
  /** Post a comment, deduped by idempotencyKey (the adapter probes existing comments). Returns
   *  the created comment's id/ref, or null if it already existed. */
  addComment(ref: string, body: string, idempotencyKey: string): Promise<string | null>;
}

export type IssueTrackerFactory = () => IssueTrackerPort;

export function selectIssueTracker(
  config: { issueTracker: string },
  adapters: Record<string, IssueTrackerFactory>,
): IssueTrackerPort {
  const factory = adapters[config.issueTracker];
  if (!factory) {
    throw new Error(`selectIssueTracker: no adapter registered for '${config.issueTracker}'`);
  }
  return factory();
}
```

Create `src/integrations/adapters/fake-issue-tracker.ts`:

```typescript
import type { IssueState, IssueTrackerPort } from "../issue-tracker.ts";

/** In-memory recording IssueTrackerPort for tests (the FakeAgentRunner analogue). */
export function fakeIssueTracker(): IssueTrackerPort & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async setState(ref: string, state: IssueState) {
      calls.push({ method: "setState", args: [ref, state] });
    },
    async setLabels(ref: string, change: { add: string[]; remove: string[] }) {
      calls.push({ method: "setLabels", args: [ref, change] });
    },
    async addComment(ref: string, body: string, idempotencyKey: string) {
      calls.push({ method: "addComment", args: [ref, body, idempotencyKey] });
      return `fake-comment-${calls.length}`;
    },
  };
}
```

- [ ] **Step 4: Add the config field**

In `src/config/runtime-config.ts`, add to `RuntimeConfigSchema`:

```typescript
  // M6a: which issue-tracker adapter projects ticket state outward. Vendor-neutral; creds via env.
  issueTracker: z.string().default("linear"),
```

- [ ] **Step 5: Run tests + full suite**

Run: `bun test test/integrations/issue-tracker.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS. Adding a defaulted field to `RuntimeConfig` doesn't break existing parses (`DEFAULT_RUNTIME_CONFIG` picks it up).

- [ ] **Step 6: Commit**

```bash
git add src/integrations/issue-tracker.ts src/integrations/adapters/fake-issue-tracker.ts src/config/runtime-config.ts test/integrations/issue-tracker.test.ts
git commit -m "feat(m6a): IssueTrackerPort + selectIssueTracker factory + fake adapter + config field"
```

---

### Task 3: The projector drain loop

**Files:**
- Create: `src/daemon/projector.ts`
- Test: `test/daemon/projector.test.ts`

**Interfaces:**
- Consumes: `listPending`, `markSent`, `bumpAttempt`, `markFailed` (outbox repo); `getTicket` (ticket repo, for `ident` → the issue ref); `IssueTrackerPort`; `insertPending as insertSignal` (signal repo) + `setTicketStatus` + `appendEvent` (the escalation pattern, mirror `failure-policy.ts`).
- Produces:
  - `OUTBOX_RETRY_BUDGET = 5` (exported const).
  - `ProjectorPorts = { issueTracker: IssueTrackerPort }`.
  - `drainOutbox(db, ports: ProjectorPorts, opts?: { retryBudget?: number }): Promise<{ sent: number; failed: number }>`.

- [ ] **Step 1: Write the failing tests**

Create `test/daemon/projector.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue, listPending } from "../../src/db/repos/projection-outbox.ts";
import { listPending as listSignals } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { makeTestDb } from "../helpers/db.ts";

test("drainOutbox applies a pending issue_tracker row via the port and marks it sent", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", payload: { state: "in_progress" }, idempotencyKey: "k1" });
  const fake = fakeIssueTracker();
  const out = await drainOutbox(db, { issueTracker: fake });
  const pending = listPending(db);
  db.close();
  expect(out.sent).toBe(1);
  expect(pending.length).toBe(0);
  expect(fake.calls[0]?.method).toBe("setState");
  expect(fake.calls[0]?.args[1]).toBe("in_progress"); // arg0 is the ticket ident (ref)
});

test("drainOutbox applies set_labels with the add/remove delta", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_labels", payload: { add: ["stage:implement"], remove: ["stage:design"] }, idempotencyKey: "k2" });
  const fake = fakeIssueTracker();
  await drainOutbox(db, { issueTracker: fake });
  db.close();
  expect(fake.calls[0]?.method).toBe("setLabels");
  expect(fake.calls[0]?.args[1]).toEqual({ add: ["stage:implement"], remove: ["stage:design"] });
});

test("a transient port error bumps attempts and keeps the row pending", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", payload: { state: "done" }, idempotencyKey: "k3" });
  const throwing = fakeIssueTracker();
  throwing.setState = async () => { throw new Error("network blip"); };
  await drainOutbox(db, { issueTracker: throwing });
  const pending = listPending(db);
  db.close();
  expect(pending.length).toBe(1);
  expect(pending[0]?.attempts).toBe(1);
});

test("a row past the retry budget is failed and the ticket is escalated", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "issue_tracker", op: "set_state", payload: { state: "done" }, idempotencyKey: "k4" });
  // pre-set attempts to budget-1 so the next failure crosses the budget
  db.query("UPDATE projection_outbox SET attempts = 4 WHERE idempotency_key = 'k4'").run();
  const throwing = fakeIssueTracker();
  throwing.setState = async () => { throw new Error("service down"); };
  const out = await drainOutbox(db, { issueTracker: throwing }, { retryBudget: 5 });
  const pending = listPending(db);
  const signals = listSignals(db, ticketId);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(out.failed).toBe(1);
  expect(pending.length).toBe(0); // row is now 'failed', not pending
  expect(signals.some((s) => s.signal_type === "human_resume")).toBe(true);
  expect(ticket?.status).toBe("waiting");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/daemon/projector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the drainer**

Create `src/daemon/projector.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import {
  type OutboxRow,
  bumpAttempt,
  listPending,
  markFailed,
  markSent,
} from "../db/repos/projection-outbox.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import type { IssueState, IssueTrackerPort } from "../integrations/issue-tracker.ts";

export const OUTBOX_RETRY_BUDGET = 5;

export interface ProjectorPorts {
  issueTracker: IssueTrackerPort;
}

/** Apply one outbox row to the configured port by NEUTRAL ROLE (never a vendor name). Returns the
 *  response ref (e.g. a comment id) or null. Throws on a transient external failure (the drainer
 *  retries/escalates). */
async function applyRow(db: Database, row: OutboxRow, ports: ProjectorPorts): Promise<string | null> {
  const ticket = getTicket(db, row.ticket_id);
  if (!ticket) {
    throw new Error(`projector: ticket ${row.ticket_id} not found`);
  }
  const ref = ticket.ident; // the issue ref the adapter resolves (e.g. "ENG-1")
  const payload = row.payload_json === null ? {} : (JSON.parse(row.payload_json) as Record<string, unknown>);

  if (row.target === "issue_tracker") {
    const it = ports.issueTracker;
    switch (row.op) {
      case "set_state":
        await it.setState(ref, payload.state as IssueState);
        return null;
      case "set_labels":
        await it.setLabels(ref, payload as { add: string[]; remove: string[] });
        return null;
      case "add_comment":
        return await it.addComment(ref, payload.body as string, row.idempotency_key);
      default:
        throw new Error(`projector: unknown issue_tracker op '${row.op}'`);
    }
  }
  // 'forge' is M6b — no forge rows are enqueued in M6a.
  throw new Error(`projector: no adapter for target '${row.target}' (forge is M6b)`);
}

/** Park the ticket and tell the operator the external service is down (projector §7, atlas X1).
 *  A projection failure never blocks the loop — the row is failed durably; control flow runs on. */
function escalateProjection(db: Database, ticketId: number, reason: string): void {
  db.transaction(() => {
    // setTicketStatus is set by insertSignal-adjacent escalation in failure-policy; do it explicitly.
    db.query("UPDATE ticket SET status = 'waiting', updated_at = $now WHERE id = $id").run({
      $now: new Date().toISOString().replace("T", " ").slice(0, 19),
      $id: ticketId,
    });
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, kind: "escalated", reason });
  })();
}

/** Drain pending outbox rows in FIFO order, applying each idempotently. A transient failure bumps
 *  attempts (retried next drain); past the budget the row is failed and the ticket escalated. */
export async function drainOutbox(
  db: Database,
  ports: ProjectorPorts,
  opts?: { retryBudget?: number },
): Promise<{ sent: number; failed: number }> {
  const budget = opts?.retryBudget ?? OUTBOX_RETRY_BUDGET;
  let sent = 0;
  let failed = 0;
  for (const row of listPending(db)) {
    try {
      const ref = await applyRow(db, row, ports);
      markSent(db, row.id, ref);
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (row.attempts + 1 >= budget) {
        markFailed(db, row.id, message);
        escalateProjection(db, row.ticket_id, `projection failing: ${message}`);
        failed += 1;
      } else {
        bumpAttempt(db, row.id, message);
      }
    }
  }
  return { sent, failed };
}
```

> Implementer note: prefer reusing the repo's timestamp helper. If `src/util/time.ts` exports `nowUtc()`, import it and use `nowUtc()` in `escalateProjection` instead of the inline `new Date()...` (Date is fine here — this is the daemon, not a workflow script; but match the codebase idiom). Also check how `failure-policy.ts` escalates and mirror it (it uses `setTicketStatus` from the ticket repo + `insertSignal` + `appendEvent`); use `setTicketStatus(db, ticketId, "waiting")` rather than an inline UPDATE if that's the established helper.

- [ ] **Step 4: Run tests + full suite**

Run: `bun test test/daemon/projector.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/projector.ts test/daemon/projector.test.ts
git commit -m "feat(m6a): drainOutbox projector (neutral-role dispatch, idempotent, retry+escalate)"
```

---

### Task 4: Enqueue stage-transition projections (same transaction)

**Files:**
- Modify: `src/daemon/projector.ts` (add `stageToState` + `enqueueStageProjection`)
- Modify: `src/daemon/advance.ts` (call the helper in the advance transaction)
- Test: `test/daemon/advance-projection.test.ts`

**Interfaces:**
- Consumes: `enqueue` (outbox repo); `TicketRow`.
- Produces:
  - `stageToState(stage: string): IssueState` — `design`/`implement`/`verify` → `in_progress`; `review`/`merge` → `in_review`; `released` → `done`.
  - `enqueueStageProjection(db, ticket: { id: number; ident: string }, from: string, to: string): void` — enqueues a `set_state` row (mapped) and a `set_labels` swap row, with deterministic keys. Idempotent (unique keys).
  - `advance.ts`: the `d.kind === "advance"` transaction also calls `enqueueStageProjection`.

- [ ] **Step 1: Write the failing test**

Create `test/daemon/advance-projection.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listPending } from "../../src/db/repos/projection-outbox.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { makeTestDb } from "../helpers/db.ts";

// A ticket parked at the design→implement boundary: design done, units verified is irrelevant —
// we drive the resolver to the advance and assert the projection rows it enqueues.
test("advancing a stage enqueues set_state + set_labels projection rows in the same tx", () => {
  const { db, ticketId } = makeTestDb();
  // Force the ticket to a state where the resolver's next action is advance design→implement:
  // (use the resolver's own routing — seed design:dispatch succeeded, a fast-track unit, track fast)
  // Simplest: call enqueueStageProjection directly to unit-test the helper, then assert rows.
  const ticket = getTicket(db, ticketId);
  // (covered more fully by the e2e in Task 6; here assert the helper's rows)
  db.close();
  expect(ticket).not.toBeNull();
});

import { enqueueStageProjection, stageToState } from "../../src/daemon/projector.ts";

test("stageToState maps stages to neutral issue states", () => {
  expect(stageToState("design")).toBe("in_progress");
  expect(stageToState("implement")).toBe("in_progress");
  expect(stageToState("verify")).toBe("in_progress");
  expect(stageToState("review")).toBe("in_review");
  expect(stageToState("merge")).toBe("in_review");
  expect(stageToState("released")).toBe("done");
});

test("enqueueStageProjection enqueues a mapped set_state and a label swap, idempotently", () => {
  const { db, ticketId } = makeTestDb();
  const t = getTicket(db, ticketId)!;
  enqueueStageProjection(db, t, "design", "implement");
  enqueueStageProjection(db, t, "design", "implement"); // re-run → no dup (unique keys)
  const rows = listPending(db);
  db.close();
  const ops = rows.map((r) => r.op).sort();
  expect(ops).toEqual(["set_labels", "set_state"]);
  const state = rows.find((r) => r.op === "set_state");
  const labels = rows.find((r) => r.op === "set_labels");
  expect(JSON.parse(state!.payload_json!).state).toBe("in_progress"); // implement → in_progress
  expect(JSON.parse(labels!.payload_json!)).toEqual({ add: ["stage:implement"], remove: ["stage:design"] });
});

test("advancing through advanceOneStep enqueues the projection (integration with the advance tx)", async () => {
  const { db, ticketId } = makeTestDb();
  // Drive a real advance: seed the resolver so the next action is an advance. Reuse the resolver
  // test helpers' approach — set stage='review' with review done so the resolver advances review→merge.
  const reg = new StepRegistry();
  reg.register("review", () => ({ findings: 0 }));
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  // mark the 'review' step succeeded so the resolver's verdict path is clean and it advances to merge
  // (the review verdict returns clean with no findings → advance review→merge)
  await advanceOneStep(db, ticketId, reg); // runs review (clean) → next call advances
  await advanceOneStep(db, ticketId, reg); // advance review→merge enqueues the projection
  const rows = listPending(db).filter((r) => r.op === "set_state");
  db.close();
  expect(rows.some((r) => JSON.parse(r.payload_json!).state === "in_review")).toBe(true); // merge → in_review
});
```

> Implementer note: the first stub test is a placeholder — replace it or delete it; the real coverage is the `stageToState`, `enqueueStageProjection`, and the `advanceOneStep` integration tests below it. For the `advanceOneStep` integration test, confirm against `src/daemon/resolver.ts` exactly what state makes the resolver return `{ kind: "advance", from: "review", to: "merge" }` (review stage + `review` step succeeded + clean verdict) and seed precisely that; if review's verdict needs a dispatch, simplify by asserting `enqueueStageProjection` directly (the helper test above) and driving one real advance whose pre-state you control. Keep it genuine — the projection must come from the real advance transaction, not be hand-inserted.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/daemon/advance-projection.test.ts`
Expected: FAIL — `stageToState`/`enqueueStageProjection` not exported.

- [ ] **Step 3: Add the enqueue helpers**

In `src/daemon/projector.ts`, add (import `enqueue` from the outbox repo):

```typescript
import { enqueue } from "../db/repos/projection-outbox.ts";

const STAGE_STATE: Record<string, IssueState> = {
  design: "in_progress",
  implement: "in_progress",
  verify: "in_progress",
  review: "in_review",
  merge: "in_review",
  released: "done",
};

export function stageToState(stage: string): IssueState {
  return STAGE_STATE[stage] ?? "in_progress";
}

/** Enqueue the issue-tracker projection for a stage transition (projector §3): a mapped set_state
 *  and a stage-label swap. Deterministic keys → re-enqueue is a no-op (idempotent). MUST be called
 *  inside the same transaction as the stage change (advance.ts). */
export function enqueueStageProjection(
  db: Database,
  ticket: { id: number; ident: string },
  from: string,
  to: string,
): void {
  enqueue(db, {
    ticketId: ticket.id,
    target: "issue_tracker",
    op: "set_state",
    payload: { state: stageToState(to) },
    idempotencyKey: `${ticket.ident}:set_state:${to}`,
  });
  enqueue(db, {
    ticketId: ticket.id,
    target: "issue_tracker",
    op: "set_labels",
    payload: { add: [`stage:${to}`], remove: [`stage:${from}`] },
    idempotencyKey: `${ticket.ident}:set_labels:${from}->${to}`,
  });
}
```

- [ ] **Step 4: Call it from the advance transaction**

In `src/daemon/advance.ts`, the `d.kind === "advance"` branch currently is:

```typescript
    if (d.kind === "advance") {
      db.transaction(() => {
        setTicketStage(db, ticketId, d.to);
        appendEvent(db, { ticketId, kind: "transition", fromStage: d.from, toStage: d.to });
      })();
      continue;
    }
```

Add the projection enqueue inside the same transaction (fetch the ticket for its ident; it's available — `getTicket` is imported in advance.ts):

```typescript
    if (d.kind === "advance") {
      const t = getTicket(db, ticketId);
      if (!t) {
        throw new Error(`advanceOneStep: ticket ${ticketId} not found`);
      }
      db.transaction(() => {
        setTicketStage(db, ticketId, d.to);
        appendEvent(db, { ticketId, kind: "transition", fromStage: d.from, toStage: d.to });
        enqueueStageProjection(db, t, d.from, d.to);
      })();
      continue;
    }
```

Add the import: `import { enqueueStageProjection } from "./projector.ts";`.

- [ ] **Step 5: Run tests + full suite**

Run: `bun test test/daemon/advance-projection.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS. The walking-skeleton e2e now enqueues outbox rows on each advance — it asserts stage/status (not outbox), so it stays green; the rows simply accumulate pending (no drainer wired in that test). Confirm walking-skeleton passes.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/projector.ts src/daemon/advance.ts test/daemon/advance-projection.test.ts
git commit -m "feat(m6a): enqueue stage-transition projections in the advance transaction"
```

---

### Task 5: The official-SDK Linear adapter

**Files:**
- Create: `src/integrations/adapters/linear.ts`
- Modify: `package.json` (add `@linear/sdk`)
- Test: build + typecheck (the core is covered by the fake port; the real adapter is build-verified + a smoke note)

**Interfaces:**
- Consumes: `IssueTrackerPort`, `IssueState` (the interface it implements).
- Produces: `linearIssueTracker(opts?: { apiKey?: string }): IssueTrackerPort` — backed by `@linear/sdk`, reading `LINEAR_API_KEY` from env when `apiKey` is omitted. The export to register in the adapters map as `{ linear: () => linearIssueTracker() }`.

- [ ] **Step 1: Add the dependency**

Run: `bun add @linear/sdk`
Confirm it lands in `package.json` `dependencies`.

- [ ] **Step 2: Implement the adapter**

Create `src/integrations/adapters/linear.ts` implementing `IssueTrackerPort` via `@linear/sdk`. Consult the `@linear/sdk` docs (use Context7 / the package's types) for exact method names; implement this BEHAVIOR:

- Construct `new LinearClient({ apiKey })` (apiKey from `opts.apiKey ?? process.env.LINEAR_API_KEY`; throw a clear error if absent — a setup/GOAL-INSTALL touchpoint).
- `setState(ref, state)`: resolve the issue by its identifier (`ref`, e.g. "ENG-1"); map the neutral `IssueState` to the Linear workflow-state NAME via a constant map (`in_progress→"In Progress"`, `in_review→"In Review"`, `done→"Done"`, `canceled→"Canceled"`, `blocked→"Blocked"`); resolve that name to the team's workflow-state id; `issueUpdate({ stateId })`. No-op if already there (declarative).
- `setLabels(ref, { add, remove })`: read the issue's current label ids; resolve `add`/`remove` label names to ids (skip a `remove` name that isn't present; for an `add` name that doesn't exist, skip it — label creation is deferred to setup); compute `current ∪ add \ remove`; `issueUpdate({ labelIds })`. **Label-safe**: preserve all labels outside the delta (never clobber).
- `addComment(ref, body, idempotencyKey)`: append a hidden tag `\n\n<!-- proj-key: ${idempotencyKey} -->` to the body; probe the issue's comments for that tag; if found, return null (already posted); else `commentCreate({ issueId, body })` and return the created comment id.

Map (module-level const):

```typescript
const LINEAR_STATE_NAME: Record<IssueState, string> = {
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
  blocked: "Blocked",
};
```

Keep all `@linear/sdk` imports confined to THIS file — the core never imports the SDK. Name→id resolution is live per call (the `linear_id_cache` optimization is deferred).

- [ ] **Step 3: Typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: clean. The `@linear/sdk` dep must bundle into the single binary (`dist/styre`). If the build fails to bundle the SDK, report it as BLOCKED with the error (do not work around by vendoring).

- [ ] **Step 4: Smoke note (no real API call in CI)**

Add a one-paragraph note to the adapter's top-of-file JSDoc: how to smoke-test it manually (`LINEAR_API_KEY=… ` + a tiny script calling `setState("ENG-N", "in_progress")` against a scratch issue). The core's behavior is covered by the fake port; this adapter is the thin vendor edge, verified by typecheck+build and an operator smoke run (the Claude-adapter precedent).

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/integrations/adapters/linear.ts
git commit -m "feat(m6a): official-SDK Linear adapter (IssueTrackerPort)"
```

---

### Task 6: Wire the drainer into the loop + end-to-end

**Files:**
- Modify: `src/daemon/loop.ts`
- Test: `test/daemon/projector-e2e.test.ts`

**Interfaces:**
- Consumes: `drainOutbox`, `ProjectorPorts`.
- Produces: `tick(db, registry, opts?: { maxConcurrent?: number; config?: RuntimeConfig; ports?: ProjectorPorts }): Promise<{ advanced: number }>` — after advancing tickets, if `opts.ports` is supplied, calls `await drainOutbox(db, opts.ports)`. (When `ports` is absent — e.g. the walking-skeleton — no drain happens; rows accumulate harmlessly.)

- [ ] **Step 1: Write the failing e2e**

Create `test/daemon/projector-e2e.test.ts`: drive a ticket through a stage advance with a real `tick`, supplying a fake issue-tracker port, and assert the fake port received the projection (enqueue → drain end-to-end).

```typescript
import { expect, test } from "bun:test";
import { tick } from "../../src/daemon/loop.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a stage advance projects to the issue tracker via the drainer in tick", async () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  const reg = new StepRegistry();
  reg.register("review", () => ({ findings: 0 }));
  const fake = fakeIssueTracker();
  // tick 1: run review (clean verdict). tick 2: advance review→merge (enqueues) + drain (applies).
  await tick(db, reg, { ports: { issueTracker: fake } });
  await tick(db, reg, { ports: { issueTracker: fake } });
  db.close();
  // The merge-entry projection (in_review) reached the fake port.
  expect(fake.calls.some((c) => c.method === "setState" && c.args[1] === "in_review")).toBe(true);
  expect(fake.calls.some((c) => c.method === "setLabels")).toBe(true);
});
```

> Implementer note: confirm the exact stage-state that makes the resolver advance `review→merge` (review step succeeded + clean review verdict). If the verdict requires a `latestDispatchForStep` row, simplify: seed the ticket so the resolver's next action is a stage advance you control (e.g. an advance into a stage), and assert the corresponding projection. The binding fact: a real `tick` advance enqueues, and the same `tick` drains it to the fake port. Don't hand-insert outbox rows.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/projector-e2e.test.ts`
Expected: FAIL — `tick` doesn't accept/forward `ports` yet.

- [ ] **Step 3: Wire the drainer into `tick`**

In `src/daemon/loop.ts`:

```typescript
import { type ProjectorPorts, drainOutbox } from "./projector.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
// …
export async function tick(
  db: Database,
  registry: StepRegistry,
  opts?: { maxConcurrent?: number; config?: RuntimeConfig; ports?: ProjectorPorts },
): Promise<{ advanced: number }> {
  const max = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const ids = readyTicketIds(db).slice(0, max);
  let advanced = 0;
  for (const id of ids) {
    await advanceOneStep(db, id, registry, { config: opts?.config });
    advanced++;
  }
  if (opts?.ports) {
    await drainOutbox(db, opts.ports);
  }
  return { advanced };
}
```

(If `tick` already forwards `config` to `advanceOneStep` from the M5b work, keep that; only the `ports` + drain are new.)

- [ ] **Step 4: Run test + full suite + build**

Run: `bun test test/daemon/projector-e2e.test.ts && bun test && bun run lint && bun run typecheck && bun run build`
Expected: PASS; build clean. Walking-skeleton (no `ports`) unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/loop.ts test/daemon/projector-e2e.test.ts
git commit -m "feat(m6a): drain the outbox each tick (ports injected); enqueue→drain e2e"
```

---

## Final Verification (before PR)

- [ ] Full gate fresh: `bun test && bun run lint && bun run typecheck && bun run build` — all pass; binary bundles `@linear/sdk`.
- [ ] Confirm the schema change is exactly the neutral-`target` CHECK in both files (`git diff main -- src/db/schema.sql docs/architecture/schema.sql`), byte-identical.
- [ ] Confirm zero-lock-in: the core (`projector.ts`, `advance.ts`, `loop.ts`, repos) imports only `IssueTrackerPort` — grep that `@linear/sdk` is imported ONLY in `src/integrations/adapters/linear.ts`.
- [ ] Whole-branch review on the most capable model; fix any Critical/Important.
- [ ] `finishing-a-development-branch`: push `feat/m6a-projector-linear`, open PR into `main`. **Do not merge** — the operator merges.
- [ ] Watch CI to green.

## Carries into M6b / later
- **Forge port + GitHub adapter** (official Octokit) + `RuntimeConfig.forge` field + the merge stage (`merge:push`/`merge:pr-ensure`, deliver `external_pr_result`) + the checks-system poll (`external_checks`) + `released:project`. The drainer's `forge` target branch + result-signal delivery land there.
- **The adapter wiring at the daemon entrypoint** — construct `selectIssueTracker(runtimeConfig, { linear: () => linearIssueTracker() })` + env creds and pass into `tick`. (No `styre daemon` process yet; M6a's tests inject ports directly.)
- **`projection_state` snapshot** (delta-suppression) + **`linear_id_cache`** + **`setup` bootstrap** (create `stage:*` labels, seed caches).
- **Comment projections** for escalations + review findings (the `add_comment` op + adapter method exist; enqueue sites are deferred).
- **`AgentConfig` → `RuntimeConfig` unification** (flagged by the operator; its own refactor step).

## Self-Review
- **Spec coverage:** neutral target + outbox repo (T1); port + factory + config + fake (T2); drainer with idempotent dispatch + retry/escalate (T3); same-tx stage-transition enqueue (T4); official-SDK Linear adapter (T5); drain-in-loop + e2e (T6). Covered. Deferred items explicitly scoped.
- **Invariants:** zero-lock-in (core imports only the interface; SDK confined to the adapter; neutral target; config-selected); same-tx enqueue (T4 inside the advance transaction); two-layer idempotency (unique key in T1 enqueue + declarative/probe adapter in T5); no control-flow reads (projector only writes; inbound stays signals); failure never blocks the loop (T3 retry/escalate, row durable); one config object (issueTracker on RuntimeConfig; creds via env; instances injected). Held.
- **Placeholder scan:** complete code in every step. Two implementer-notes (the advance-integration seeding in T4; the e2e seeding in T6) flag where to confirm exact resolver pre-state and to keep the test genuine (no hand-inserted rows) — and one explicitly-labeled stub test to replace. The Linear adapter (T5) specifies behavior + the exact state-name map and instructs consulting the SDK docs for method names (the vendor edge, build-verified).
- **Type consistency:** `OutboxTarget`/`target` neutral values match across T1 enqueue, T3 dispatch, T4 enqueue; `IssueState` + `IssueTrackerPort` method signatures (T2) match the drainer dispatch (T3), the enqueue payloads (T4), and the Linear adapter (T5); `ProjectorPorts` (T3) matches `tick` opts (T6); `enqueueStageProjection`/`stageToState` (T4) match their tests + the advance call.
