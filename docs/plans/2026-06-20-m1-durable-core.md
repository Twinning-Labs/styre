# M1 — Durable Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the durable-execution primitives — the typed SoT data layer, the step journal (replay + write-ahead intent), durable signals, idempotency keys, and crash recovery — so any step is exactly-once-effective and resumable after a crash.

**Architecture:** Pure functions over a `bun:sqlite` `Database` handle (no daemon yet — that's M2). `db/repos/*` are thin typed data-access modules (the only SQL). `engine/step-journal.ts` implements the step contract (control-loop §3): a succeeded step replays its recorded result without re-running; an effectful step journals `running` + an idempotency key *before* the effect. `engine/signals.ts` is the durable-wait primitive (§7). `daemon/recover.ts` reconciles steps a crash left `running` (§6.1). No real dispatch/projector/external effects yet — those are M3/M6; M1 proves the mechanics with in-DB keyed effects.

**Tech Stack:** Bun, `bun:sqlite`, `bun test`, Biome. No new dependencies.

## Global Constraints

- **Runtime is Bun**; SQLite via built-in `bun:sqlite`; `bun test`. No new deps (YAGNI).
- **Only the daemon writes the SoT (B2 / CL-INV-7).** In M1 there is no daemon; the engine/repo functions ARE that single write path and take an explicit `db` handle. Tests act as the caller. Workers never write — not applicable yet.
- **Timestamps stored UTC, ISO-8601 `…Z` (DS-1 / CL-INV-8)** via `src/util/time.ts`; never store local time. (No display surface in M1.)
- **Stable step keys (CL-INV-1):** `step_key` is a pure function of (ticket, work_unit, logical position) — never embed a timestamp/random/attempt. (The journal enforces one row per `(ticket_id, step_key)`.)
- **Replay returns the recorded result (control-loop §6.2):** a `succeeded` step is never re-executed; `runStep` returns its `result_json`.
- **Effectful steps use write-ahead intent (control-loop §3):** mark `running` + `idempotency_key` + `pid` in one tx *before* the effect; mark `succeeded` + `result_json` after.
- **Idempotency keys are globally unique BY CONSTRUCTION (control-loop §3):** built by prefixing a caller-supplied id (the future `dispatch_id`); the schema's UNIQUE indexes are the dedup mechanism.
- **Crash mid-step resumes (control-loop §6.1):** a `running` row is the complete record that "an effect may be half-done"; `recover()` kills the journaled orphan pid and resets reattemptable steps to `pending`.
- **Dev workflow:** branch-only (`feat/m1-durable-core`); no commits to `main`; Conventional Commits; no auto-merge. TDD throughout; files small + single-responsibility.
- **Build on M0, do not modify it:** `openDb(path): Database` (`src/db/client.ts`) and `migrate(path): MigrateResult` (`src/db/migrate.ts`) exist and are stable. Reuse them.

---

### Task 1: Test DB helper, UTC time util, and project/ticket repos

**Files:**
- Create: `src/util/time.ts`
- Create: `src/db/repos/project.ts`
- Create: `src/db/repos/ticket.ts`
- Create: `test/helpers/db.ts`
- Test: `test/db/repos/fixtures.test.ts`

**Interfaces:**
- Consumes (from M0): `migrate(path)` and `openDb(path)`.
- Produces:
  - `nowUtc(): string` — ISO-8601 UTC timestamp.
  - `insertProject(db, { slug: string; targetRepo: string; defaultBranch?: string }): number` (returns project id); `getProject(db, id): ProjectRow | null`; `interface ProjectRow { id: number; slug: string; target_repo: string; default_branch: string }`.
  - `insertTicket(db, { projectId: number; ident: string; stage?: string; status?: string }): number` (returns ticket id); `getTicket(db, id): TicketRow | null`; `setTicketStatus(db, id: number, status: string): void`; `interface TicketRow { id: number; project_id: number; ident: string; stage: string; status: string }`.
  - `makeTestDb(): { db: Database; projectId: number; ticketId: number }` (`test/helpers/db.ts`) — migrates a tmp DB, opens it, seeds one project + one ticket.

- [ ] **Step 1: Write the failing test** — `test/db/repos/fixtures.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../../helpers/db.ts";
import { getProject } from "../../../src/db/repos/project.ts";
import { getTicket, setTicketStatus } from "../../../src/db/repos/ticket.ts";

test("makeTestDb seeds a project and ticket", () => {
  const { db, projectId, ticketId } = makeTestDb();
  const project = getProject(db, projectId);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(project?.slug).toBe("test-project");
  expect(ticket?.project_id).toBe(projectId);
  expect(ticket?.stage).toBe("design");
  expect(ticket?.status).toBe("active");
});

test("setTicketStatus updates the ticket disposition", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStatus(db, ticketId, "waiting");
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.status).toBe("waiting");
});

test("nowUtc returns a Zulu ISO-8601 timestamp", async () => {
  const { nowUtc } = await import("../../../src/util/time.ts");
  expect(nowUtc()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/db/repos/fixtures.test.ts`
Expected: FAIL — `Cannot find module '../../helpers/db.ts'` (helper + repos not created yet).

- [ ] **Step 3: Create `src/util/time.ts`**

```ts
/** ISO-8601 UTC timestamp ('…Z'). Storage is always UTC (DS-1 / CL-INV-8);
 *  conversion to the operator's local tz happens only at the render edge. */
export function nowUtc(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 4: Create `src/db/repos/project.ts`**

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface ProjectRow {
  id: number;
  slug: string;
  target_repo: string;
  default_branch: string;
}

const COLS = "id, slug, target_repo, default_branch";

export function insertProject(
  db: Database,
  p: { slug: string; targetRepo: string; defaultBranch?: string },
): number {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO project (slug, target_repo, default_branch, created_at, updated_at)
       VALUES ($slug, $repo, $branch, $now, $now)`,
    )
    .run({ $slug: p.slug, $repo: p.targetRepo, $branch: p.defaultBranch ?? "main", $now: now });
  return Number(res.lastInsertRowid);
}

export function getProject(db: Database, id: number): ProjectRow | null {
  return db.query<ProjectRow, [number]>(`SELECT ${COLS} FROM project WHERE id = ?`).get(id) ?? null;
}
```

- [ ] **Step 5: Create `src/db/repos/ticket.ts`**

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface TicketRow {
  id: number;
  project_id: number;
  ident: string;
  stage: string;
  status: string;
}

const COLS = "id, project_id, ident, stage, status";

export function insertTicket(
  db: Database,
  t: { projectId: number; ident: string; stage?: string; status?: string },
): number {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ticket (project_id, ident, stage, status, created_at, updated_at)
       VALUES ($pid, $ident, $stage, $status, $now, $now)`,
    )
    .run({
      $pid: t.projectId,
      $ident: t.ident,
      $stage: t.stage ?? "design",
      $status: t.status ?? "active",
      $now: now,
    });
  return Number(res.lastInsertRowid);
}

export function getTicket(db: Database, id: number): TicketRow | null {
  return db.query<TicketRow, [number]>(`SELECT ${COLS} FROM ticket WHERE id = ?`).get(id) ?? null;
}

export function setTicketStatus(db: Database, id: number, status: string): void {
  db.query(`UPDATE ticket SET status = $status, updated_at = $now WHERE id = $id`).run({
    $status: status,
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 6: Create `test/helpers/db.ts`**

```ts
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";

/** Migrate a fresh tmp DB, open it, and seed one project + one ticket.
 *  The caller is responsible for db.close(). */
export function makeTestDb(): { db: Database; projectId: number; ticketId: number } {
  const path = join(mkdtempSync(join(tmpdir(), "styre-m1-")), "styre.db");
  migrate(path);
  const db = openDb(path);
  const projectId = insertProject(db, { slug: "test-project", targetRepo: "/tmp/repo" });
  const ticketId = insertTicket(db, { projectId, ident: "ENG-1" });
  return { db, projectId, ticketId };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test test/db/repos/fixtures.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: Biome clean; `tsc --noEmit` exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/util/time.ts src/db/repos/project.ts src/db/repos/ticket.ts test/helpers/db.ts test/db/repos/fixtures.test.ts
git commit -m "feat(m1): UTC time util, project/ticket repos, and test DB helper"
```

---

### Task 2: `workflow_step` repo

**Files:**
- Create: `src/db/repos/workflow-step.ts`
- Test: `test/db/repos/workflow-step.test.ts`

**Interfaces:**
- Consumes: `nowUtc` (Task 1); `makeTestDb` (Task 1) in tests.
- Produces (all on `src/db/repos/workflow-step.ts`):
  - `interface WorkflowStepRow` with fields: `id, ticket_id, work_unit_id, seq, step_key, step_type, status, attempt, idempotency_key, input_json, result_json, error_json, pid, await_signal_id, started_at, ended_at, created_at, updated_at` (numbers for id/ticket_id/seq/attempt; `number | null` for work_unit_id/pid/await_signal_id; `string | null` for the json/timestamp nullable fields; `string` for step_key/step_type/status/created_at/updated_at).
  - `nextSeq(db, ticketId: number): number`
  - `insertPending(db, p: { ticketId: number; workUnitId?: number | null; stepKey: string; stepType: string; input?: unknown }): WorkflowStepRow`
  - `getByKey(db, ticketId: number, stepKey: string): WorkflowStepRow | null`
  - `getById(db, id: number): WorkflowStepRow | null`
  - `markRunning(db, id: number, opts: { idempotencyKey?: string | null; pid?: number | null }): void`
  - `markSucceeded(db, id: number, result: unknown): void`
  - `markFailed(db, id: number, error: unknown): void`
  - `resetToPending(db, id: number): void`
  - `listByStatus(db, status: string): WorkflowStepRow[]`

- [ ] **Step 1: Write the failing test** — `test/db/repos/workflow-step.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../../helpers/db.ts";
import * as steps from "../../../src/db/repos/workflow-step.ts";

test("insertPending creates a pending step with seq 1 and attempt 0", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.close();
  expect(step.status).toBe("pending");
  expect(step.seq).toBe(1);
  expect(step.attempt).toBe(0);
  expect(step.idempotency_key).toBeNull();
});

test("nextSeq increments per ticket", () => {
  const { db, ticketId } = makeTestDb();
  steps.insertPending(db, { ticketId, stepKey: "a", stepType: "dispatch" });
  steps.insertPending(db, { ticketId, stepKey: "b", stepType: "dispatch" });
  const seq = steps.nextSeq(db, ticketId);
  db.close();
  expect(seq).toBe(3);
});

test("getByKey returns the step; unknown key returns null", () => {
  const { db, ticketId } = makeTestDb();
  steps.insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  const found = steps.getByKey(db, ticketId, "design:dispatch");
  const missing = steps.getByKey(db, ticketId, "nope");
  db.close();
  expect(found?.step_key).toBe("design:dispatch");
  expect(missing).toBeNull();
});

test("markRunning sets running, bumps attempt, records key + pid", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "merge:push", stepType: "project" });
  steps.markRunning(db, step.id, { idempotencyKey: "ENG-1-d1-push", pid: 4242 });
  const after = steps.getById(db, step.id);
  db.close();
  expect(after?.status).toBe("running");
  expect(after?.attempt).toBe(1);
  expect(after?.idempotency_key).toBe("ENG-1-d1-push");
  expect(after?.pid).toBe(4242);
});

test("markSucceeded records a JSON result", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "design:extract", stepType: "dispatch" });
  steps.markSucceeded(db, step.id, { units: 2 });
  const after = steps.getById(db, step.id);
  db.close();
  expect(after?.status).toBe("succeeded");
  expect(JSON.parse(after?.result_json ?? "null")).toEqual({ units: 2 });
});

test("markFailed records a serialized error; resetToPending clears running state", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "x", stepType: "dispatch" });
  steps.markRunning(db, step.id, { pid: 99 });
  steps.markFailed(db, step.id, new Error("boom"));
  const failed = steps.getById(db, step.id);
  steps.resetToPending(db, step.id);
  const reset = steps.getById(db, step.id);
  db.close();
  expect(failed?.status).toBe("failed");
  expect(JSON.parse(failed?.error_json ?? "{}").message).toBe("boom");
  expect(reset?.status).toBe("pending");
  expect(reset?.pid).toBeNull();
});

test("listByStatus filters by status", () => {
  const { db, ticketId } = makeTestDb();
  const a = steps.insertPending(db, { ticketId, stepKey: "a", stepType: "dispatch" });
  steps.insertPending(db, { ticketId, stepKey: "b", stepType: "dispatch" });
  steps.markRunning(db, a.id, { pid: 1 });
  const running = steps.listByStatus(db, "running");
  db.close();
  expect(running.length).toBe(1);
  expect(running[0]?.step_key).toBe("a");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/db/repos/workflow-step.test.ts`
Expected: FAIL — `Cannot find module '../../../src/db/repos/workflow-step.ts'`.

- [ ] **Step 3: Create `src/db/repos/workflow-step.ts`**

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface WorkflowStepRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  seq: number;
  step_key: string;
  step_type: string;
  status: string;
  attempt: number;
  idempotency_key: string | null;
  input_json: string | null;
  result_json: string | null;
  error_json: string | null;
  pid: number | null;
  await_signal_id: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, work_unit_id, seq, step_key, step_type, status, attempt, idempotency_key, " +
  "input_json, result_json, error_json, pid, await_signal_id, started_at, ended_at, created_at, updated_at";

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return JSON.stringify({ name: error.name, message: error.message });
  }
  return JSON.stringify({ name: "Error", message: String(error) });
}

export function nextSeq(db: Database, ticketId: number): number {
  const row = db
    .query<{ m: number | null }, [number]>(
      "SELECT MAX(seq) AS m FROM workflow_step WHERE ticket_id = ?",
    )
    .get(ticketId);
  return (row?.m ?? 0) + 1;
}

export function getById(db: Database, id: number): WorkflowStepRow | null {
  return (
    db.query<WorkflowStepRow, [number]>(`SELECT ${COLS} FROM workflow_step WHERE id = ?`).get(id) ??
    null
  );
}

export function getByKey(db: Database, ticketId: number, stepKey: string): WorkflowStepRow | null {
  return (
    db
      .query<WorkflowStepRow, [number, string]>(
        `SELECT ${COLS} FROM workflow_step WHERE ticket_id = ? AND step_key = ?`,
      )
      .get(ticketId, stepKey) ?? null
  );
}

export function insertPending(
  db: Database,
  p: { ticketId: number; workUnitId?: number | null; stepKey: string; stepType: string; input?: unknown },
): WorkflowStepRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO workflow_step
         (ticket_id, work_unit_id, seq, step_key, step_type, status, attempt, input_json, created_at, updated_at)
       VALUES ($t, $wu, $seq, $k, $ty, 'pending', 0, $in, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $seq: nextSeq(db, p.ticketId),
      $k: p.stepKey,
      $ty: p.stepType,
      $in: p.input === undefined ? null : JSON.stringify(p.input),
      $now: now,
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertPending: row missing after insert");
  }
  return created;
}

export function markRunning(
  db: Database,
  id: number,
  opts: { idempotencyKey?: string | null; pid?: number | null },
): void {
  const now = nowUtc();
  db.query(
    `UPDATE workflow_step
       SET status = 'running', attempt = attempt + 1, idempotency_key = $key, pid = $pid,
           started_at = $now, updated_at = $now
     WHERE id = $id`,
  ).run({ $key: opts.idempotencyKey ?? null, $pid: opts.pid ?? null, $now: now, $id: id });
}

export function markSucceeded(db: Database, id: number, result: unknown): void {
  const now = nowUtc();
  db.query(
    `UPDATE workflow_step
       SET status = 'succeeded', result_json = $r, ended_at = $now, updated_at = $now
     WHERE id = $id`,
  ).run({ $r: JSON.stringify(result === undefined ? null : result), $now: now, $id: id });
}

export function markFailed(db: Database, id: number, error: unknown): void {
  const now = nowUtc();
  db.query(
    `UPDATE workflow_step
       SET status = 'failed', error_json = $e, ended_at = $now, updated_at = $now
     WHERE id = $id`,
  ).run({ $e: serializeError(error), $now: now, $id: id });
}

export function resetToPending(db: Database, id: number): void {
  db.query(
    `UPDATE workflow_step SET status = 'pending', pid = NULL, updated_at = $now WHERE id = $id`,
  ).run({ $now: nowUtc(), $id: id });
}

export function listByStatus(db: Database, status: string): WorkflowStepRow[] {
  return db
    .query<WorkflowStepRow, [string]>(
      `SELECT ${COLS} FROM workflow_step WHERE status = ? ORDER BY ticket_id, seq`,
    )
    .all(status);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/db/repos/workflow-step.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/workflow-step.ts test/db/repos/workflow-step.test.ts
git commit -m "feat(m1): workflow_step repo (journal row data access)"
```

---

### Task 3: Idempotency keys + the step journal (the crux)

**Files:**
- Create: `src/engine/idempotency.ts`
- Create: `src/engine/step-journal.ts`
- Test: `test/engine/idempotency.test.ts`
- Test: `test/engine/step-journal.test.ts`

**Interfaces:**
- Consumes: the whole `workflow-step` repo (Task 2); `makeTestDb` (Task 1).
- Produces:
  - `idempotencyKey(prefix: string, suffix: string): string` (`src/engine/idempotency.ts`) — returns `` `${prefix}-${suffix}` ``; throws if either is empty.
  - `class StepInFlightError extends Error` (`src/engine/step-journal.ts`).
  - `interface RunStepParams { ticketId: number; workUnitId?: number | null; stepKey: string; stepType: string; input?: unknown; effectful?: boolean; idempotencyKey?: string | null; execute: (step: WorkflowStepRow) => unknown | Promise<unknown> }`
  - `interface RunStepResult { step: WorkflowStepRow; result: unknown; replayed: boolean }`
  - `runStep(db, params: RunStepParams): Promise<RunStepResult>` — the durable executor.

- [ ] **Step 1: Write the failing test** — `test/engine/idempotency.test.ts`

```ts
import { expect, test } from "bun:test";
import { idempotencyKey } from "../../src/engine/idempotency.ts";

test("idempotencyKey composes prefix and suffix", () => {
  expect(idempotencyKey("ENG-1-d0003", "push")).toBe("ENG-1-d0003-push");
});

test("idempotencyKey rejects empty parts", () => {
  expect(() => idempotencyKey("", "push")).toThrow();
  expect(() => idempotencyKey("ENG-1", "")).toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/engine/idempotency.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/idempotency.ts'`.

- [ ] **Step 3: Create `src/engine/idempotency.ts`**

```ts
/** Build a globally-unique-by-construction idempotency key (control-loop §3).
 *  `prefix` is the caller's unique id (the future dispatch_id / ticket ident);
 *  `suffix` names the effect (e.g. "push", "pr_create"). The schema's UNIQUE
 *  indexes on idempotency_key are the actual dedup mechanism. */
export function idempotencyKey(prefix: string, suffix: string): string {
  if (!prefix) {
    throw new Error("idempotencyKey: prefix required");
  }
  if (!suffix) {
    throw new Error("idempotencyKey: suffix required");
  }
  return `${prefix}-${suffix}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/engine/idempotency.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test** — `test/engine/step-journal.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../helpers/db.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { idempotencyKey } from "../../src/engine/idempotency.ts";
import { StepInFlightError, runStep } from "../../src/engine/step-journal.ts";

test("a pure step runs once, journals succeeded, and replays its recorded result", async () => {
  const { db, ticketId } = makeTestDb();
  let calls = 0;
  const params = {
    ticketId,
    stepKey: "design:extract",
    stepType: "dispatch",
    execute: () => {
      calls++;
      return { units: 2 };
    },
  };

  const first = await runStep(db, params);
  expect(first.replayed).toBe(false);
  expect(first.result).toEqual({ units: 2 });
  expect(first.step.status).toBe("succeeded");

  // Replay: the resolver re-asks for the same step_key → recorded result, no re-run.
  const second = await runStep(db, params);
  db.close();
  expect(second.replayed).toBe(true);
  expect(second.result).toEqual({ units: 2 });
  expect(calls).toBe(1); // executed exactly once
});

test("an effectful step journals running + idempotency key before the effect", async () => {
  const { db, ticketId } = makeTestDb();
  let observedStatusDuringEffect = "";
  const key = idempotencyKey("ENG-1-d1", "push");
  const result = await runStep(db, {
    ticketId,
    stepKey: "merge:push",
    stepType: "project",
    effectful: true,
    idempotencyKey: key,
    execute: (step) => {
      // The journal must have recorded intent (running + key) BEFORE we run.
      observedStatusDuringEffect = step.status;
      return { sha: "abc" };
    },
  });
  const persisted = steps.getByKey(db, ticketId, "merge:push");
  db.close();
  expect(observedStatusDuringEffect).toBe("running");
  expect(result.step.idempotency_key).toBe(key);
  expect(persisted?.status).toBe("succeeded");
});

test("a failing step is journaled failed and the error rethrown", async () => {
  const { db, ticketId } = makeTestDb();
  const run = runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => {
      throw new Error("agent died");
    },
  });
  await expect(run).rejects.toThrow("agent died");
  const persisted = steps.getByKey(db, ticketId, "design:dispatch");
  db.close();
  expect(persisted?.status).toBe("failed");
  expect(JSON.parse(persisted?.error_json ?? "{}").message).toBe("agent died");
});

test("runStep refuses a step another runner left running", async () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "merge:push", stepType: "project" });
  steps.markRunning(db, step.id, { pid: 1 });
  const run = runStep(db, {
    ticketId,
    stepKey: "merge:push",
    stepType: "project",
    execute: () => ({}),
  });
  await expect(run).rejects.toBeInstanceOf(StepInFlightError);
  db.close();
});

test("a keyed effect is exactly-once-effective across a crash + recovery re-run", async () => {
  const { db, ticketId } = makeTestDb();
  const key = idempotencyKey("ENG-1-d1", "push");
  // The "external effect" is a keyed outbox insert that dedups on idempotency_key.
  const effect = (): { applied: true } => {
    db.query(
      `INSERT INTO projection_outbox (ticket_id, target, op, idempotency_key, status, created_at)
       VALUES ($t, 'github', 'push', $key, 'pending', $now)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run({ $t: ticketId, $key: key, $now: new Date().toISOString() });
    return { applied: true };
  };

  // First attempt completes the effect, then we simulate a crash AFTER the effect
  // but treat the step as interrupted by forcing it back to 'running'.
  await runStep(db, {
    ticketId,
    stepKey: "merge:push",
    stepType: "project",
    effectful: true,
    idempotencyKey: key,
    execute: effect,
  });
  const stepRow = steps.getByKey(db, ticketId, "merge:push");
  steps.markRunning(db, stepRow!.id, { idempotencyKey: key, pid: 1 }); // pretend it crashed mid-step

  // Recovery resets it to pending; the resolver re-runs the same keyed effect.
  steps.resetToPending(db, stepRow!.id);
  await runStep(db, {
    ticketId,
    stepKey: "merge:push",
    stepType: "project",
    effectful: true,
    idempotencyKey: key,
    execute: effect,
  });

  const count = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM projection_outbox WHERE idempotency_key = ?",
    )
    .get(key);
  db.close();
  expect(count?.n).toBe(1); // at-least-once-attempted, exactly-once-effective
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/engine/step-journal.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/step-journal.ts'`.

- [ ] **Step 7: Create `src/engine/step-journal.ts`**

```ts
import type { Database } from "bun:sqlite";
import * as steps from "../db/repos/workflow-step.ts";

/** Thrown when a step is found 'running' — an in-flight or crash-interrupted run
 *  that recover() (control-loop §6.1) owns, not a fresh execution. */
export class StepInFlightError extends Error {
  constructor(stepKey: string) {
    super(`step '${stepKey}' is running; recovery owns it`);
    this.name = "StepInFlightError";
  }
}

export interface RunStepParams {
  ticketId: number;
  workUnitId?: number | null;
  stepKey: string;
  stepType: string;
  input?: unknown;
  /** Effectful steps journal 'running' + idempotency key BEFORE the effect (control-loop §3). */
  effectful?: boolean;
  idempotencyKey?: string | null;
  execute: (step: steps.WorkflowStepRow) => unknown | Promise<unknown>;
}

export interface RunStepResult {
  step: steps.WorkflowStepRow;
  result: unknown;
  replayed: boolean;
}

/** The durable step executor (control-loop §3 / §6.2).
 *  - succeeded → return recorded result, never re-run (replay)
 *  - running   → throw StepInFlightError (recover owns it)
 *  - pending/failed → execute with write-ahead intent (effectful), journal the outcome */
export async function runStep(db: Database, params: RunStepParams): Promise<RunStepResult> {
  const existing = steps.getByKey(db, params.ticketId, params.stepKey);
  const step =
    existing ??
    steps.insertPending(db, {
      ticketId: params.ticketId,
      workUnitId: params.workUnitId ?? null,
      stepKey: params.stepKey,
      stepType: params.stepType,
      input: params.input,
    });

  if (step.status === "succeeded") {
    return {
      step,
      result: step.result_json === null ? null : JSON.parse(step.result_json),
      replayed: true,
    };
  }
  if (step.status === "running") {
    throw new StepInFlightError(params.stepKey);
  }

  // pending | failed → (re)execute
  if (params.effectful) {
    steps.markRunning(db, step.id, { idempotencyKey: params.idempotencyKey ?? null, pid: process.pid });
  }

  const current = steps.getById(db, step.id);
  if (!current) {
    throw new Error(`runStep: step ${step.id} vanished`);
  }

  try {
    const result = await params.execute(current);
    steps.markSucceeded(db, step.id, result);
    const finished = steps.getById(db, step.id);
    if (!finished) {
      throw new Error(`runStep: step ${step.id} vanished after success`);
    }
    return { step: finished, result, replayed: false };
  } catch (err) {
    steps.markFailed(db, step.id, err);
    throw err;
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test test/engine/step-journal.test.ts test/engine/idempotency.test.ts`
Expected: PASS (5 + 2 tests).

- [ ] **Step 9: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/engine/idempotency.ts src/engine/step-journal.ts test/engine/idempotency.test.ts test/engine/step-journal.test.ts
git commit -m "feat(m1): step journal — replay, write-ahead intent, exactly-once effects"
```

---

### Task 4: Durable signals (the wait primitive)

**Files:**
- Create: `src/db/repos/signal.ts`
- Create: `src/engine/signals.ts`
- Test: `test/engine/signals.test.ts`

**Interfaces:**
- Consumes: `nowUtc` (Task 1); `setTicketStatus`/`getTicket` (Task 1); `makeTestDb`.
- Produces:
  - `src/db/repos/signal.ts`: `interface SignalRow { id: number; ticket_id: number; signal_type: string; status: string; reason: string | null; payload_json: string | null; idempotency_key: string | null; requested_at: string; delivered_at: string | null; consumed_at: string | null }`; `insertPending(db, p: { ticketId: number; signalType: string; reason?: string; idempotencyKey?: string | null }): SignalRow`; `getById(db, id): SignalRow | null`; `listPending(db, ticketId): SignalRow[]`; `markDelivered(db, id, payload?: unknown): void`; `markConsumed(db, id): void`.
  - `src/engine/signals.ts`: `awaitSignal(db, p: { ticketId: number; signalType: string; reason?: string; idempotencyKey?: string | null }): SignalRow` (parks: pending signal + ticket→`waiting`, idempotent); `deliverSignal(db, signalId: number, payload?: unknown): SignalRow` (delivered + ticket→`active`); `consumeSignal(db, signalId: number): SignalRow`.

- [ ] **Step 1: Write the failing test** — `test/engine/signals.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../helpers/db.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { awaitSignal, consumeSignal, deliverSignal } from "../../src/engine/signals.ts";

test("awaitSignal parks the ticket on a pending signal", () => {
  const { db, ticketId } = makeTestDb();
  const sig = awaitSignal(db, { ticketId, signalType: "human_merge_approval", reason: "awaiting merge" });
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(sig.status).toBe("pending");
  expect(sig.signal_type).toBe("human_merge_approval");
  expect(ticket?.status).toBe("waiting");
});

test("awaitSignal is idempotent for the same signal type (no duplicate park)", () => {
  const { db, ticketId } = makeTestDb();
  const a = awaitSignal(db, { ticketId, signalType: "external_checks" });
  const b = awaitSignal(db, { ticketId, signalType: "external_checks" });
  db.close();
  expect(b.id).toBe(a.id);
});

test("deliverSignal marks delivered, stores payload, and un-parks the ticket", () => {
  const { db, ticketId } = makeTestDb();
  const sig = awaitSignal(db, { ticketId, signalType: "external_pr_result" });
  const delivered = deliverSignal(db, sig.id, { pr: 42 });
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(delivered.status).toBe("delivered");
  expect(JSON.parse(delivered.payload_json ?? "null")).toEqual({ pr: 42 });
  expect(ticket?.status).toBe("active");
});

test("consumeSignal marks the signal consumed", () => {
  const { db, ticketId } = makeTestDb();
  const sig = awaitSignal(db, { ticketId, signalType: "human_resume" });
  deliverSignal(db, sig.id);
  const consumed = consumeSignal(db, sig.id);
  db.close();
  expect(consumed.status).toBe("consumed");
  expect(consumed.consumed_at).not.toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/engine/signals.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/signals.ts'`.

- [ ] **Step 3: Create `src/db/repos/signal.ts`**

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface SignalRow {
  id: number;
  ticket_id: number;
  signal_type: string;
  status: string;
  reason: string | null;
  payload_json: string | null;
  idempotency_key: string | null;
  requested_at: string;
  delivered_at: string | null;
  consumed_at: string | null;
}

const COLS =
  "id, ticket_id, signal_type, status, reason, payload_json, idempotency_key, " +
  "requested_at, delivered_at, consumed_at";

export function getById(db: Database, id: number): SignalRow | null {
  return db.query<SignalRow, [number]>(`SELECT ${COLS} FROM signal WHERE id = ?`).get(id) ?? null;
}

export function listPending(db: Database, ticketId: number): SignalRow[] {
  return db
    .query<SignalRow, [number]>(
      `SELECT ${COLS} FROM signal WHERE ticket_id = ? AND status = 'pending' ORDER BY id`,
    )
    .all(ticketId);
}

export function insertPending(
  db: Database,
  p: { ticketId: number; signalType: string; reason?: string; idempotencyKey?: string | null },
): SignalRow {
  const res = db
    .query(
      `INSERT INTO signal (ticket_id, signal_type, status, reason, idempotency_key, requested_at)
       VALUES ($t, $ty, 'pending', $reason, $key, $now)`,
    )
    .run({
      $t: p.ticketId,
      $ty: p.signalType,
      $reason: p.reason ?? null,
      $key: p.idempotencyKey ?? null,
      $now: nowUtc(),
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("signal insertPending: row missing after insert");
  }
  return created;
}

export function markDelivered(db: Database, id: number, payload?: unknown): void {
  db.query(
    `UPDATE signal SET status = 'delivered', payload_json = $p, delivered_at = $now WHERE id = $id`,
  ).run({ $p: payload === undefined ? null : JSON.stringify(payload), $now: nowUtc(), $id: id });
}

export function markConsumed(db: Database, id: number): void {
  db.query(`UPDATE signal SET status = 'consumed', consumed_at = $now WHERE id = $id`).run({
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 4: Create `src/engine/signals.ts`**

```ts
import type { Database } from "bun:sqlite";
import * as signals from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";

/** Park a ticket on a durable signal (control-loop §7): insert a pending signal and
 *  set ticket.status='waiting' so it leaves the ready set (no busy-wait). Idempotent:
 *  reuses an existing pending signal of the same type. */
export function awaitSignal(
  db: Database,
  p: { ticketId: number; signalType: string; reason?: string; idempotencyKey?: string | null },
): signals.SignalRow {
  const tx = db.transaction(() => {
    const existing = signals
      .listPending(db, p.ticketId)
      .find((s) => s.signal_type === p.signalType);
    const signal = existing ?? signals.insertPending(db, p);
    setTicketStatus(db, p.ticketId, "waiting");
    return signal;
  });
  return tx();
}

/** Deliver a signal out-of-band (control-loop §7.3): mark delivered + un-park the ticket. */
export function deliverSignal(db: Database, signalId: number, payload?: unknown): signals.SignalRow {
  const tx = db.transaction(() => {
    signals.markDelivered(db, signalId, payload);
    const sig = signals.getById(db, signalId);
    if (!sig) {
      throw new Error(`deliverSignal: signal ${signalId} not found`);
    }
    setTicketStatus(db, sig.ticket_id, "active");
    return sig;
  });
  return tx();
}

/** Consume a delivered signal — the parked await step then succeeds. */
export function consumeSignal(db: Database, signalId: number): signals.SignalRow {
  signals.markConsumed(db, signalId);
  const sig = signals.getById(db, signalId);
  if (!sig) {
    throw new Error(`consumeSignal: signal ${signalId} not found`);
  }
  return sig;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/engine/signals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/signal.ts src/engine/signals.ts test/engine/signals.test.ts
git commit -m "feat(m1): durable signals — park/deliver/consume wait primitive"
```

---

### Task 5: Crash recovery — `recover()`

**Files:**
- Create: `src/daemon/recover.ts`
- Test: `test/daemon/recover.test.ts`

**Interfaces:**
- Consumes: `listByStatus`, `resetToPending`, `getById` (Task 2); `makeTestDb`, `insertPending`/`markRunning` in tests.
- Produces:
  - `interface RecoverDeps { isAlive: (pid: number) => boolean; kill: (pid: number) => void }`
  - `interface RecoverResult { reset: number; killed: number }`
  - `recover(db, deps: RecoverDeps): RecoverResult` — reconcile crash-interrupted `running` steps.
  - `realRecoverDeps(): RecoverDeps` — production deps using `process.kill` (pid liveness via signal 0).

- [ ] **Step 1: Write the failing test** — `test/daemon/recover.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../helpers/db.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { recover } from "../../src/daemon/recover.ts";

function fixedDeps(alive: Set<number>) {
  const killed: number[] = [];
  return {
    deps: { isAlive: (pid: number) => alive.has(pid), kill: (pid: number) => void killed.push(pid) },
    killed,
  };
}

test("recover resets a running step to pending and kills its live orphan pid", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  steps.markRunning(db, step.id, { pid: 5000 });
  const { deps, killed } = fixedDeps(new Set([5000]));

  const result = recover(db, deps);
  const after = steps.getById(db, step.id);
  db.close();

  expect(result.reset).toBe(1);
  expect(result.killed).toBe(1);
  expect(killed).toEqual([5000]);
  expect(after?.status).toBe("pending");
  expect(after?.pid).toBeNull();
});

test("recover resets a running step whose pid is already dead without killing", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "x", stepType: "dispatch" });
  steps.markRunning(db, step.id, { pid: 9999 });
  const { deps, killed } = fixedDeps(new Set()); // 9999 not alive

  const result = recover(db, deps);
  const after = steps.getById(db, step.id);
  db.close();

  expect(result.reset).toBe(1);
  expect(result.killed).toBe(0);
  expect(killed).toEqual([]);
  expect(after?.status).toBe("pending");
});

test("recover leaves succeeded and pending steps untouched", () => {
  const { db, ticketId } = makeTestDb();
  const done = steps.insertPending(db, { ticketId, stepKey: "done", stepType: "dispatch" });
  steps.markSucceeded(db, done.id, { ok: true });
  steps.insertPending(db, { ticketId, stepKey: "todo", stepType: "dispatch" });
  const { deps } = fixedDeps(new Set());

  const result = recover(db, deps);
  const doneAfter = steps.getById(db, done.id);
  db.close();

  expect(result.reset).toBe(0);
  expect(doneAfter?.status).toBe("succeeded");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/recover.test.ts`
Expected: FAIL — `Cannot find module '../../src/daemon/recover.ts'`.

- [ ] **Step 3: Create `src/daemon/recover.ts`**

```ts
import type { Database } from "bun:sqlite";
import * as steps from "../db/repos/workflow-step.ts";

export interface RecoverDeps {
  /** True if a process with this pid is currently alive. */
  isAlive: (pid: number) => boolean;
  /** Force-kill the process (a journaled orphan from before the crash). */
  kill: (pid: number) => void;
}

export interface RecoverResult {
  reset: number;
  killed: number;
}

/** Crash recovery (control-loop §6.1). A step left 'running' is the complete record
 *  that a crash interrupted it. Kill any journaled orphan still alive (the ENG-131
 *  lesson), then reset the step to 'pending' so the resolver re-picks it. A dispatch
 *  retry is a fresh attempt (§6.3); exactly-once for external effects is provided by
 *  keyed/probed effects (§3 / §5), added with the adapters in M6 — so resetting to
 *  pending is the correct, complete behavior for the substrate at M1. */
export function recover(db: Database, deps: RecoverDeps): RecoverResult {
  const running = steps.listByStatus(db, "running");
  let killed = 0;
  for (const step of running) {
    if (step.pid !== null && deps.isAlive(step.pid)) {
      deps.kill(step.pid);
      killed++;
    }
    steps.resetToPending(db, step.id);
  }
  return { reset: running.length, killed };
}

/** Production deps: liveness via signal 0 (throws if the pid is gone), SIGKILL to kill. */
export function realRecoverDeps(): RecoverDeps {
  return {
    isAlive: (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid: number) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone — nothing to kill
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/daemon/recover.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all M0 + M1 tests pass; Biome clean; `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/recover.ts test/daemon/recover.test.ts
git commit -m "feat(m1): recover() — reconcile crash-interrupted running steps"
```

---

## M1 acceptance criteria

Discharges control-loop §6 (the §9.4 #2 acceptance) at the journal layer:

- [ ] **Replay returns the recorded result** — a `succeeded` step re-asked by `runStep` returns its `result_json` and does not re-execute (`step-journal.test.ts`).
- [ ] **External effects carry idempotency keys** — `idempotencyKey()` builds globally-unique keys; an effectful step journals the key as write-ahead intent; a keyed effect is exactly-once-effective across a crash + re-run (`step-journal.test.ts`).
- [ ] **Crash mid-step resumes** — `recover()` kills the journaled orphan pid and resets `running` steps to `pending` (`recover.test.ts`).
- [ ] `bun test` green; `bun run lint && bun run typecheck` clean.

## Out of scope (deferred to later milestones)

- **The resolver + event loop** (`next_step_key`, `advance_one_step`, `loop()`, K-concurrency) — **M2**. M1 provides the primitives the resolver will call.
- **Real dispatch** (`claude -p`, worktrees, render-prompt, sidecar) — **M3**.
- **Real external effects + the probe path in recover** (outbox drain, Linear/GitHub adapters, `pr_create` probes, reconstructing `succeeded` from a probe) — **M6**. M1 demonstrates exactly-once with in-DB keyed inserts only.
- **Failure policy / loopback atlas** (`apply_failure_policy`, resets, budgets) — **M2**. M1's `runStep` records a `failed` step and rethrows; routing is the resolver's job.

## Done / handoff

When M1 merges, the next plan is **M2 — Resolver + event loop** (the walking skeleton): `next_step_key`, `advance_one_step`, the `loop()`, and the failure-policy/atlas shape, driving one fast-track ticket `design → released` with mocked step handlers — built on this durable core.
