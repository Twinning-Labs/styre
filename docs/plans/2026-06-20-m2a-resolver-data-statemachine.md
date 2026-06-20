# M2a — Resolver Data Layer + Pure State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data layer the resolver reads/writes (work_unit, ground_truth_signal, event_log repos + ticket-repo extensions) and the **pure `nextStepKey` state machine** + step-handler registry — everything M2b's execution loop needs, unit-tested with no I/O.

**Architecture:** Continues M1's pattern — typed `bun:sqlite` repos hold all SQL; the resolver is a pure function over them. `nextStepKey(db, ticketId)` reads ticket/work_unit/journal/ground-truth/signal state and returns a **descriptor** (run-this-step / advance-stage / mark-unit-verified / wait-on-signal / blocked / done) WITHOUT mutating — M2b's `advance_one_step` will interpret descriptors and perform mutations. The step-handler registry maps a stable `handlerKey` to a handler function (M2b registers handlers; M2a defines the contract). This is **M2a** of the two-part M2 split (M2a = data + pure state machine, no execution; M2b = advance_one_step + failure-policy + loop() + walking-skeleton e2e). Source: minimal-loop.md §1, control-loop.md §2.3.

**Tech Stack:** Bun, `bun:sqlite`, `bun test`, Biome. No new dependencies.

## Global Constraints

- **Runtime is Bun**; SQLite via built-in `bun:sqlite`; `bun test`. No new deps (YAGNI).
- **Pure resolver (control-loop §2.3):** `nextStepKey` is a deterministic function of SQLite state. It **must not mutate** the DB — it only reads and returns a descriptor. All mutation (stage transitions, marking units verified, parking signals) is M2b's `advance_one_step`.
- **Stable step keys (CL-INV-1):** a `step_key` is a pure function of (ticket, work_unit, logical position) — e.g. `design:dispatch`, `implement:wu3:dispatch`, `verify:wu3:test`, `merge:push`. Never embed a timestamp/random/attempt.
- **Clean-break stage vocab (DS-2):** `ticket.stage ∈ {design, implement, verify, review, merge, released}`. Implement decomposes into per-`work_unit` dispatches; there is **no hardcoded `ui` stage**.
- **Timestamps stored UTC (DS-1)** via `nowUtc()`; never local time.
- **Build ON M0+M1, do not modify their behavior** beyond the additive ticket/signal extensions this plan specifies. Reuse: `nowUtc()` (`src/util/time.ts`); the `workflow-step` repo (`getByKey`, etc.); the `ticket`/`signal`/`project` repos; `makeTestDb()` (`test/helpers/db.ts`).
- **Conventions (match existing code exactly):** `.ts` import extensions; `verbatimModuleSyntax` → type-only imports use `import type`; import a repo module as a namespace (`import * as workUnits`) and reference its type via the namespace (`workUnits.WorkUnitRow`) to avoid a dual import; Biome import grouping external → `node:` → relative, alphabetical (run `bun run lint`, apply organizeImports); Biome `noNonNullAssertion` (use `if (!x) throw`, not `!`); double quotes; semicolons; 2-space indent; 100-col width; `noUnusedLocals`/`noUnusedParameters`.
- **Before committing each task:** `bun test && bun run lint && bun run typecheck` all clean (full suite — M0 + M1 + prior M2a tasks must stay green).
- **Dev workflow:** branch-only (`feat/m2-resolver-loop`); no commits to `main`; Conventional Commits; no auto-merge. TDD throughout; files small + single-responsibility.

---

### Task 1: `work_unit` repo

**Files:**
- Create: `src/db/repos/work-unit.ts`
- Test: `test/db/repos/work-unit.test.ts`

**Interfaces:**
- Consumes: `nowUtc()` (`src/util/time.ts`); `makeTestDb()` in tests.
- Produces (all on `src/db/repos/work-unit.ts`):
  - `interface WorkUnitRow { id: number; ticket_id: number; seq: number; kind: string; status: string; behavioral: number; files_to_touch: string | null; verify_check_types: string | null; depends_on: string | null; created_at: string; updated_at: string }`
  - `insertWorkUnit(db, p: { ticketId: number; seq: number; kind: string; status?: string; behavioral?: number; verifyCheckTypes?: number[] | string[] | null; dependsOn?: number[] | null }): WorkUnitRow`
  - `getById(db, id: number): WorkUnitRow | null`
  - `listByTicket(db, ticketId: number): WorkUnitRow[]` (ordered by `seq`)
  - `setStatus(db, id: number, status: string): void`
  - `parseDependsOn(row: WorkUnitRow): number[]`
  - `parseVerifyCheckTypes(row: WorkUnitRow): string[]`

- [ ] **Step 1: Write the failing test** — `test/db/repos/work-unit.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../../helpers/db.ts";
import * as workUnits from "../../../src/db/repos/work-unit.ts";

test("insertWorkUnit creates a pending unit with parsed json fields", () => {
  const { db, ticketId } = makeTestDb();
  const u = workUnits.insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    dependsOn: [],
  });
  db.close();
  expect(u.status).toBe("pending");
  expect(u.kind).toBe("backend");
  expect(workUnits.parseVerifyCheckTypes(u)).toEqual(["test"]);
  expect(workUnits.parseDependsOn(u)).toEqual([]);
});

test("listByTicket returns units ordered by seq", () => {
  const { db, ticketId } = makeTestDb();
  workUnits.insertWorkUnit(db, { ticketId, seq: 2, kind: "frontend" });
  workUnits.insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  const list = workUnits.listByTicket(db, ticketId);
  db.close();
  expect(list.map((u) => u.seq)).toEqual([1, 2]);
});

test("setStatus updates the unit status", () => {
  const { db, ticketId } = makeTestDb();
  const u = workUnits.insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  workUnits.setStatus(db, u.id, "verified");
  const after = workUnits.getById(db, u.id);
  db.close();
  expect(after?.status).toBe("verified");
});

test("parse helpers tolerate null json", () => {
  const { db, ticketId } = makeTestDb();
  const u = workUnits.insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  db.close();
  expect(workUnits.parseDependsOn(u)).toEqual([]);
  expect(workUnits.parseVerifyCheckTypes(u)).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/db/repos/work-unit.test.ts`
Expected: FAIL — `Cannot find module '../../../src/db/repos/work-unit.ts'`.

- [ ] **Step 3: Create `src/db/repos/work-unit.ts`**

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface WorkUnitRow {
  id: number;
  ticket_id: number;
  seq: number;
  kind: string;
  status: string;
  behavioral: number;
  files_to_touch: string | null;
  verify_check_types: string | null;
  depends_on: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, seq, kind, status, behavioral, files_to_touch, verify_check_types, depends_on, created_at, updated_at";

export function getById(db: Database, id: number): WorkUnitRow | null {
  return (
    db.query<WorkUnitRow, [number]>(`SELECT ${COLS} FROM work_unit WHERE id = ?`).get(id) ?? null
  );
}

export function listByTicket(db: Database, ticketId: number): WorkUnitRow[] {
  return db
    .query<WorkUnitRow, [number]>(`SELECT ${COLS} FROM work_unit WHERE ticket_id = ? ORDER BY seq`)
    .all(ticketId);
}

export function insertWorkUnit(
  db: Database,
  p: {
    ticketId: number;
    seq: number;
    kind: string;
    status?: string;
    behavioral?: number;
    verifyCheckTypes?: number[] | string[] | null;
    dependsOn?: number[] | null;
  },
): WorkUnitRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO work_unit
         (ticket_id, seq, kind, status, behavioral, verify_check_types, depends_on, created_at, updated_at)
       VALUES ($t, $seq, $kind, $status, $behavioral, $vct, $dep, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $seq: p.seq,
      $kind: p.kind,
      $status: p.status ?? "pending",
      $behavioral: p.behavioral ?? 1,
      $vct: p.verifyCheckTypes == null ? null : JSON.stringify(p.verifyCheckTypes),
      $dep: p.dependsOn == null ? null : JSON.stringify(p.dependsOn),
      $now: now,
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertWorkUnit: row missing after insert");
  }
  return created;
}

export function setStatus(db: Database, id: number, status: string): void {
  db.query("UPDATE work_unit SET status = $status, updated_at = $now WHERE id = $id").run({
    $status: status,
    $now: nowUtc(),
    $id: id,
  });
}

export function parseDependsOn(row: WorkUnitRow): number[] {
  return row.depends_on === null ? [] : (JSON.parse(row.depends_on) as number[]);
}

export function parseVerifyCheckTypes(row: WorkUnitRow): string[] {
  return row.verify_check_types === null ? [] : (JSON.parse(row.verify_check_types) as string[]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/db/repos/work-unit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/work-unit.ts test/db/repos/work-unit.test.ts
git commit -m "feat(m2a): work_unit repo (decomposition row data access)"
```

---

### Task 2: ticket-repo extensions + signal `hasDelivered`

**Files:**
- Modify: `src/db/repos/ticket.ts`
- Modify: `src/db/repos/signal.ts`
- Test: `test/db/repos/ticket-ext.test.ts`

**Interfaces:**
- Consumes: `nowUtc()`; `makeTestDb()`.
- Produces:
  - Extended `TicketRow` adds `track: string | null` and `needs_docs: number`.
  - `insertTicket` gains optional `track?: string` and `needsDocs?: number` params (existing params unchanged).
  - `setTicketStage(db, id: number, stage: string): void`
  - `setTicketTrack(db, id: number, track: string): void`
  - `setNeedsDocs(db, id: number, needsDocs: number): void`
  - `hasDelivered(db, ticketId: number, signalType: string): boolean` (`src/db/repos/signal.ts`) — true if a signal of that type is `delivered` or `consumed`.

- [ ] **Step 1: Write the failing test** — `test/db/repos/ticket-ext.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../../helpers/db.ts";
import {
  getTicket,
  insertTicket,
  setNeedsDocs,
  setTicketStage,
  setTicketTrack,
} from "../../../src/db/repos/ticket.ts";
import { hasDelivered, insertPending, markDelivered } from "../../../src/db/repos/signal.ts";

test("insertTicket accepts track and needsDocs; defaults are null/0", () => {
  const { db, projectId } = makeTestDb();
  const fastId = insertTicket(db, { projectId, ident: "ENG-2", track: "fast", needsDocs: 1 });
  const plainId = insertTicket(db, { projectId, ident: "ENG-3" });
  const fast = getTicket(db, fastId);
  const plain = getTicket(db, plainId);
  db.close();
  expect(fast?.track).toBe("fast");
  expect(fast?.needs_docs).toBe(1);
  expect(plain?.track).toBeNull();
  expect(plain?.needs_docs).toBe(0);
});

test("setTicketStage / setTicketTrack / setNeedsDocs update the row", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  setTicketTrack(db, ticketId, "full");
  setNeedsDocs(db, ticketId, 1);
  const t = getTicket(db, ticketId);
  db.close();
  expect(t?.stage).toBe("implement");
  expect(t?.track).toBe("full");
  expect(t?.needs_docs).toBe(1);
});

test("hasDelivered is false until a signal is delivered, then true", () => {
  const { db, ticketId } = makeTestDb();
  const sig = insertPending(db, { ticketId, signalType: "external_checks" });
  const before = hasDelivered(db, ticketId, "external_checks");
  markDelivered(db, sig.id);
  const after = hasDelivered(db, ticketId, "external_checks");
  db.close();
  expect(before).toBe(false);
  expect(after).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/db/repos/ticket-ext.test.ts`
Expected: FAIL — `setTicketStage`/`hasDelivered` not exported (and `track`/`needs_docs` not on `TicketRow`).

- [ ] **Step 3: Extend `src/db/repos/ticket.ts`**

Replace the `TicketRow` interface and `COLS` constant, extend `insertTicket`, and add three setters. The full file becomes:

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface TicketRow {
  id: number;
  project_id: number;
  ident: string;
  stage: string;
  status: string;
  track: string | null;
  needs_docs: number;
}

const COLS = "id, project_id, ident, stage, status, track, needs_docs";

export function insertTicket(
  db: Database,
  t: {
    projectId: number;
    ident: string;
    stage?: string;
    status?: string;
    track?: string;
    needsDocs?: number;
  },
): number {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ticket (project_id, ident, stage, status, track, needs_docs, created_at, updated_at)
       VALUES ($pid, $ident, $stage, $status, $track, $needsDocs, $now, $now)`,
    )
    .run({
      $pid: t.projectId,
      $ident: t.ident,
      $stage: t.stage ?? "design",
      $status: t.status ?? "active",
      $track: t.track ?? null,
      $needsDocs: t.needsDocs ?? 0,
      $now: now,
    });
  return Number(res.lastInsertRowid);
}

export function getTicket(db: Database, id: number): TicketRow | null {
  return db.query<TicketRow, [number]>(`SELECT ${COLS} FROM ticket WHERE id = ?`).get(id) ?? null;
}

export function setTicketStatus(db: Database, id: number, status: string): void {
  db.query("UPDATE ticket SET status = $status, updated_at = $now WHERE id = $id").run({
    $status: status,
    $now: nowUtc(),
    $id: id,
  });
}

export function setTicketStage(db: Database, id: number, stage: string): void {
  db.query("UPDATE ticket SET stage = $stage, updated_at = $now WHERE id = $id").run({
    $stage: stage,
    $now: nowUtc(),
    $id: id,
  });
}

export function setTicketTrack(db: Database, id: number, track: string): void {
  db.query("UPDATE ticket SET track = $track, updated_at = $now WHERE id = $id").run({
    $track: track,
    $now: nowUtc(),
    $id: id,
  });
}

export function setNeedsDocs(db: Database, id: number, needsDocs: number): void {
  db.query("UPDATE ticket SET needs_docs = $nd, updated_at = $now WHERE id = $id").run({
    $nd: needsDocs,
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 4: Add `hasDelivered` to `src/db/repos/signal.ts`**

Append this function (after the existing exports; keep `import type { Database }` and `nowUtc` imports as they are):

```ts
export function hasDelivered(db: Database, ticketId: number, signalType: string): boolean {
  const row = db
    .query<{ n: number }, [number, string]>(
      `SELECT COUNT(*) AS n FROM signal
       WHERE ticket_id = ? AND signal_type = ? AND status IN ('delivered','consumed')`,
    )
    .get(ticketId, signalType);
  return (row?.n ?? 0) > 0;
}
```

- [ ] **Step 5: Run the full suite to verify the extension didn't break M1**

Run: `bun test`
Expected: PASS — the new `ticket-ext.test.ts` passes AND all M1 ticket/signal tests still pass (the `TicketRow` widening is additive; `insertTicket`'s new params are optional).

- [ ] **Step 6: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/ticket.ts src/db/repos/signal.ts test/db/repos/ticket-ext.test.ts
git commit -m "feat(m2a): ticket repo track/needs_docs/stage setters + signal hasDelivered"
```

---

### Task 3: `ground_truth_signal` + `event_log` repos

**Files:**
- Create: `src/db/repos/ground-truth-signal.ts`
- Create: `src/db/repos/event-log.ts`
- Test: `test/db/repos/ground-truth-signal.test.ts`
- Test: `test/db/repos/event-log.test.ts`

**Interfaces:**
- Consumes: `nowUtc()`; `makeTestDb()`; `insertWorkUnit` (Task 1) in the ground-truth test.
- Produces:
  - `src/db/repos/ground-truth-signal.ts`: `interface GroundTruthSignalRow { id: number; ticket_id: number; work_unit_id: number | null; signal_type: string; result: string; detail_json: string | null; measured_at: string }`; `insertSignal(db, p: { ticketId: number; workUnitId?: number | null; signalType: string; result: string; detail?: unknown }): GroundTruthSignalRow`; `listByUnit(db, workUnitId: number): GroundTruthSignalRow[]`.
  - `src/db/repos/event-log.ts`: `interface EventLogRow { id: number; ticket_id: number; seq: number; kind: string; actor: string | null; from_stage: string | null; to_stage: string | null; loop: string | null; route_to: string | null; signature: string | null; reason: string | null; created_at: string }`; `nextSeq(db, ticketId: number): number`; `appendEvent(db, e: { ticketId: number; kind: string; actor?: string; fromStage?: string; toStage?: string; loop?: string; routeTo?: string; signature?: string; reason?: string }): EventLogRow`; `listByTicket(db, ticketId: number): EventLogRow[]`.

- [ ] **Step 1: Write the failing test** — `test/db/repos/ground-truth-signal.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../../helpers/db.ts";
import * as gts from "../../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../../src/db/repos/work-unit.ts";

test("insertSignal records a pass signal with detail; listByUnit returns it", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  gts.insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "pass",
    detail: { tests_passed: 3 },
  });
  const list = gts.listByUnit(db, unit.id);
  db.close();
  expect(list.length).toBe(1);
  expect(list[0]?.signal_type).toBe("test");
  expect(list[0]?.result).toBe("pass");
  expect(JSON.parse(list[0]?.detail_json ?? "null")).toEqual({ tests_passed: 3 });
});

test("listByUnit is empty for a unit with no signals", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  const list = gts.listByUnit(db, unit.id);
  db.close();
  expect(list).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/db/repos/ground-truth-signal.test.ts`
Expected: FAIL — `Cannot find module '../../../src/db/repos/ground-truth-signal.ts'`.

- [ ] **Step 3: Create `src/db/repos/ground-truth-signal.ts`**

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface GroundTruthSignalRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  signal_type: string;
  result: string;
  detail_json: string | null;
  measured_at: string;
}

const COLS = "id, ticket_id, work_unit_id, signal_type, result, detail_json, measured_at";

export function listByUnit(db: Database, workUnitId: number): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE work_unit_id = ? ORDER BY measured_at, id`,
    )
    .all(workUnitId);
}

export function insertSignal(
  db: Database,
  p: {
    ticketId: number;
    workUnitId?: number | null;
    signalType: string;
    result: string;
    detail?: unknown;
  },
): GroundTruthSignalRow {
  const res = db
    .query(
      `INSERT INTO ground_truth_signal (ticket_id, work_unit_id, signal_type, result, detail_json, measured_at)
       VALUES ($t, $wu, $type, $result, $detail, $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $type: p.signalType,
      $result: p.result,
      $detail: p.detail === undefined ? null : JSON.stringify(p.detail),
      $now: nowUtc(),
    });
  const created = db
    .query<GroundTruthSignalRow, [number]>(`SELECT ${COLS} FROM ground_truth_signal WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertSignal: row missing after insert");
  }
  return created;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/db/repos/ground-truth-signal.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test** — `test/db/repos/event-log.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../../helpers/db.ts";
import * as eventLog from "../../../src/db/repos/event-log.ts";

test("appendEvent assigns monotonic seq per ticket", () => {
  const { db, ticketId } = makeTestDb();
  const a = eventLog.appendEvent(db, { ticketId, kind: "transition", fromStage: "design", toStage: "implement" });
  const b = eventLog.appendEvent(db, { ticketId, kind: "transition", fromStage: "implement", toStage: "review" });
  db.close();
  expect(a.seq).toBe(1);
  expect(b.seq).toBe(2);
  expect(a.kind).toBe("transition");
  expect(a.from_stage).toBe("design");
  expect(a.to_stage).toBe("implement");
});

test("appendEvent records loopback fields; listByTicket returns in order", () => {
  const { db, ticketId } = makeTestDb();
  eventLog.appendEvent(db, { ticketId, kind: "transition", fromStage: "design", toStage: "implement" });
  eventLog.appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "implement",
    routeTo: "implement:wu1:dispatch",
    signature: "tests-red:[t1]",
  });
  const list = eventLog.listByTicket(db, ticketId);
  db.close();
  expect(list.length).toBe(2);
  expect(list[1]?.kind).toBe("loopback");
  expect(list[1]?.loop).toBe("implement");
  expect(list[1]?.signature).toBe("tests-red:[t1]");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/db/repos/event-log.test.ts`
Expected: FAIL — `Cannot find module '../../../src/db/repos/event-log.ts'`.

- [ ] **Step 7: Create `src/db/repos/event-log.ts`**

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface EventLogRow {
  id: number;
  ticket_id: number;
  seq: number;
  kind: string;
  actor: string | null;
  from_stage: string | null;
  to_stage: string | null;
  loop: string | null;
  route_to: string | null;
  signature: string | null;
  reason: string | null;
  created_at: string;
}

const COLS =
  "id, ticket_id, seq, kind, actor, from_stage, to_stage, loop, route_to, signature, reason, created_at";

export function nextSeq(db: Database, ticketId: number): number {
  const row = db
    .query<{ m: number | null }, [number]>("SELECT MAX(seq) AS m FROM event_log WHERE ticket_id = ?")
    .get(ticketId);
  return (row?.m ?? 0) + 1;
}

export function listByTicket(db: Database, ticketId: number): EventLogRow[] {
  return db
    .query<EventLogRow, [number]>(`SELECT ${COLS} FROM event_log WHERE ticket_id = ? ORDER BY seq`)
    .all(ticketId);
}

export function appendEvent(
  db: Database,
  e: {
    ticketId: number;
    kind: string;
    actor?: string;
    fromStage?: string;
    toStage?: string;
    loop?: string;
    routeTo?: string;
    signature?: string;
    reason?: string;
  },
): EventLogRow {
  const res = db
    .query(
      `INSERT INTO event_log
         (ticket_id, seq, kind, actor, from_stage, to_stage, loop, route_to, signature, reason, created_at)
       VALUES ($t, $seq, $kind, $actor, $from, $to, $loop, $route, $sig, $reason, $now)`,
    )
    .run({
      $t: e.ticketId,
      $seq: nextSeq(db, e.ticketId),
      $kind: e.kind,
      $actor: e.actor ?? "daemon",
      $from: e.fromStage ?? null,
      $to: e.toStage ?? null,
      $loop: e.loop ?? null,
      $route: e.routeTo ?? null,
      $sig: e.signature ?? null,
      $reason: e.reason ?? null,
      $now: nowUtc(),
    });
  const created = db
    .query<EventLogRow, [number]>(`SELECT ${COLS} FROM event_log WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("appendEvent: row missing after insert");
  }
  return created;
}
```

- [ ] **Step 8: Run both repo tests to verify they pass**

Run: `bun test test/db/repos/ground-truth-signal.test.ts test/db/repos/event-log.test.ts`
Expected: PASS (2 + 2 tests).

- [ ] **Step 9: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/db/repos/ground-truth-signal.ts src/db/repos/event-log.ts test/db/repos/ground-truth-signal.test.ts test/db/repos/event-log.test.ts
git commit -m "feat(m2a): ground_truth_signal + event_log repos"
```

---

### Task 4: step-handler registry + contract types

**Files:**
- Create: `src/daemon/step-registry.ts`
- Test: `test/daemon/step-registry.test.ts`

**Interfaces:**
- Consumes: `TicketRow` (`src/db/repos/ticket.ts`); `WorkflowStepRow` (`src/db/repos/workflow-step.ts`); `Database`.
- Produces (all on `src/daemon/step-registry.ts`):
  - `interface HandlerContext { db: Database; ticket: TicketRow; step: WorkflowStepRow; workUnitId: number | null }`
  - `type StepHandler = (ctx: HandlerContext) => unknown | Promise<unknown>`
  - `class StepRegistry { register(handlerKey: string, handler: StepHandler): void; resolve(handlerKey: string): StepHandler | undefined; has(handlerKey: string): boolean }`

Note: a `handlerKey` is the **stable handler identity** the resolver derives from a concrete `step_key` (e.g. `implement:wu3:dispatch` → handlerKey `implement:dispatch`). M2b registers handlers and wires this into `advance_one_step`; M2a only defines and tests the registry mechanics.

- [ ] **Step 1: Write the failing test** — `test/daemon/step-registry.test.ts`

```ts
import { expect, test } from "bun:test";
import { StepRegistry } from "../../src/daemon/step-registry.ts";

test("register then resolve returns the handler", () => {
  const reg = new StepRegistry();
  const handler = () => ({ ok: true });
  reg.register("design:dispatch", handler);
  expect(reg.has("design:dispatch")).toBe(true);
  expect(reg.resolve("design:dispatch")).toBe(handler);
});

test("resolve returns undefined for an unregistered key", () => {
  const reg = new StepRegistry();
  expect(reg.resolve("nope")).toBeUndefined();
  expect(reg.has("nope")).toBe(false);
});

test("register rejects a duplicate handlerKey", () => {
  const reg = new StepRegistry();
  reg.register("review", () => null);
  expect(() => reg.register("review", () => null)).toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/step-registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/daemon/step-registry.ts'`.

- [ ] **Step 3: Create `src/daemon/step-registry.ts`**

```ts
import type { Database } from "bun:sqlite";
import type { TicketRow } from "../db/repos/ticket.ts";
import type { WorkflowStepRow } from "../db/repos/workflow-step.ts";

/** Everything a step handler needs. Handlers do the work (dispatch/verify/project);
 *  in M2b's walking skeleton they are mocks. They return a result the journal records. */
export interface HandlerContext {
  db: Database;
  ticket: TicketRow;
  step: WorkflowStepRow;
  workUnitId: number | null;
}

export type StepHandler = (ctx: HandlerContext) => unknown | Promise<unknown>;

/** Maps a stable `handlerKey` (derived from a concrete step_key) to its handler.
 *  The resolver (M2b) computes the handlerKey and looks the handler up here. */
export class StepRegistry {
  private readonly handlers = new Map<string, StepHandler>();

  register(handlerKey: string, handler: StepHandler): void {
    if (this.handlers.has(handlerKey)) {
      throw new Error(`StepRegistry: handlerKey '${handlerKey}' already registered`);
    }
    this.handlers.set(handlerKey, handler);
  }

  resolve(handlerKey: string): StepHandler | undefined {
    return this.handlers.get(handlerKey);
  }

  has(handlerKey: string): boolean {
    return this.handlers.has(handlerKey);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/daemon/step-registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/step-registry.ts test/daemon/step-registry.test.ts
git commit -m "feat(m2a): step-handler registry + handler contract"
```

---

### Task 5: `nextStepKey` — the pure state machine

**Files:**
- Create: `src/daemon/resolver.ts`
- Test: `test/daemon/resolver.test.ts`

**Interfaces:**
- Consumes: `getTicket` (`ticket.ts`); `getByKey` (`workflow-step.ts`); `listByTicket`/`parseDependsOn`/`parseVerifyCheckTypes` (`work-unit.ts`); `listByUnit` (`ground-truth-signal.ts`); `hasDelivered` (`signal.ts`).
- Produces (all on `src/daemon/resolver.ts`):
  - `type StepDescriptor =`
    - `| { kind: "step"; stepKey: string; stepType: string; handlerKey: string; workUnitId: number | null }`
    - `| { kind: "advance"; from: string; to: string }`
    - `| { kind: "mark-verified"; workUnitId: number }`
    - `| { kind: "wait"; signalType: string }`
    - `| { kind: "blocked"; reason: string }`
    - `| { kind: "done" }`
  - `nextStepKey(db: Database, ticketId: number): StepDescriptor` — PURE (reads only).
  - `nextActionableUnit(db: Database, ticketId: number): WorkUnitRow | null` (exported for direct testing).
  - `nextUnrunCheck(db: Database, unit: WorkUnitRow): string | null` (exported for direct testing).

Behavior (minimal-loop §1, adapted for the M2 skeleton — rebase/`completeness_failed` are deferred to M3/M2b-failure-policy and are NOT in this pure machine):

- `design`: not done `design:dispatch` → step it; else no work_units → `design:extract`; else `track==='full'` and not done `design:review` → `design:review`; else `advance design→implement`.
- `implement`: `u = nextActionableUnit`; if `u`: `pending` → `implement:wu{seq}:dispatch`; `verifying` → `nextUnrunCheck` → `verify:wu{seq}:{check}` (or `mark-verified` if all checks have signals). If no actionable unit: `allUnitsVerified` → not done `verify:integration` → step it; `ticket.needs_docs` and not done `docs:revise` → step it; else `advance implement→review`. Otherwise `blocked`.
- `review`: not done `review` → step it; else `advance review→merge`.
- `merge`: not done `merge:push` → step it; not done `merge:pr-ensure` → step it; not `hasDelivered('external_checks')` → `wait`; not `hasDelivered('human_merge_approval')` → `wait`; else `advance merge→released`.
- `released`: not done `released:project` → step it; else `done`.

- [ ] **Step 1: Write the failing test** — `test/daemon/resolver.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../helpers/db.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { insertPending, markDelivered } from "../../src/db/repos/signal.ts";
import { setNeedsDocs, setTicketStage, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { nextStepKey } from "../../src/daemon/resolver.ts";

// helper: journal a step straight to succeeded (simulates a completed step for the resolver to read)
async function succeed(db: Parameters<typeof runStep>[0], ticketId: number, stepKey: string) {
  await runStep(db, { ticketId, stepKey, stepType: "dispatch", execute: () => ({ ok: true }) });
}

test("design: first asks for design:dispatch", () => {
  const { db, ticketId } = makeTestDb();
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "design:dispatch",
    stepType: "dispatch",
    handlerKey: "design:dispatch",
    workUnitId: null,
  });
});

test("design: after dispatch with no work units, asks for design:extract", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "design:dispatch");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("design:extract");
});

test("design fast-track: with units + track=fast, advances to implement", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "design:dispatch");
  setTicketTrack(db, ticketId, "fast");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "design", to: "implement" });
});

test("design full-track: with units + track=full, asks for design:review before advancing", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "design:dispatch");
  setTicketTrack(db, ticketId, "full");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("design:review");
});

test("implement: a pending unit asks for its dispatch step", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
    handlerKey: "implement:dispatch",
    workUnitId: expect.any(Number),
  });
});

test("implement: a verifying unit with an unrun check asks for the verify step", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verifying" });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "verify:wu1:test",
    stepType: "verify",
    handlerKey: "verify:check",
    workUnitId: u.id,
  });
});

test("implement: a verifying unit whose checks all have signals asks to mark-verified", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verifying" });
  insertSignal(db, { ticketId, workUnitId: u.id, signalType: "test", result: "pass" });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "mark-verified", workUnitId: u.id });
});

test("implement: all units verified + no docs → verify:integration then advance to review", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verified" });
  expect(u.status).toBe("verified");
  const beforeIntegration = nextStepKey(db, ticketId);
  expect(beforeIntegration.kind === "step" && beforeIntegration.handlerKey).toBe("verify:integration");
  await succeed(db, ticketId, "verify:integration");
  const afterIntegration = nextStepKey(db, ticketId);
  db.close();
  expect(afterIntegration).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("implement: needs_docs routes through docs:revise before advancing", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  setNeedsDocs(db, ticketId, 1);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"], status: "verified" });
  await succeed(db, ticketId, "verify:integration");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("docs:revise");
});

test("review: asks for review then advances to merge", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "review");
  const before = nextStepKey(db, ticketId);
  expect(before.kind === "step" && before.handlerKey).toBe("review");
  await succeed(db, ticketId, "review");
  const after = nextStepKey(db, ticketId);
  db.close();
  expect(after).toEqual({ kind: "advance", from: "review", to: "merge" });
});

test("merge: push → pr-ensure → wait checks → wait human → advance to released", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "merge");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("merge:push");
  await succeed(db, ticketId, "merge:push");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("merge:pr-ensure");
  await succeed(db, ticketId, "merge:pr-ensure");
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "wait", signalType: "external_checks" });
  const checks = insertPending(db, { ticketId, signalType: "external_checks" });
  markDelivered(db, checks.id);
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "wait", signalType: "human_merge_approval" });
  const human = insertPending(db, { ticketId, signalType: "human_merge_approval" });
  markDelivered(db, human.id);
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "merge", to: "released" });
});

test("released: runs released:project then reports done", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "released");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("released:project");
  await succeed(db, ticketId, "released:project");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "done" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/resolver.test.ts`
Expected: FAIL — `Cannot find module '../../src/daemon/resolver.ts'`.

- [ ] **Step 3: Create `src/daemon/resolver.ts`**

```ts
import type { Database } from "bun:sqlite";
import * as gts from "../db/repos/ground-truth-signal.ts";
import { hasDelivered } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import * as workUnits from "../db/repos/work-unit.ts";
import { getByKey } from "../db/repos/workflow-step.ts";

export type StepDescriptor =
  | { kind: "step"; stepKey: string; stepType: string; handlerKey: string; workUnitId: number | null }
  | { kind: "advance"; from: string; to: string }
  | { kind: "mark-verified"; workUnitId: number }
  | { kind: "wait"; signalType: string }
  | { kind: "blocked"; reason: string }
  | { kind: "done" };

function done(db: Database, ticketId: number, stepKey: string): boolean {
  return getByKey(db, ticketId, stepKey)?.status === "succeeded";
}

function step(
  stepKey: string,
  stepType: string,
  handlerKey: string,
  workUnitId: number | null,
): StepDescriptor {
  return { kind: "step", stepKey, stepType, handlerKey, workUnitId };
}

/** First unit (by seq) that still needs work (pending or verifying) and whose
 *  depends_on units are all verified. */
export function nextActionableUnit(
  db: Database,
  ticketId: number,
): workUnits.WorkUnitRow | null {
  const units = workUnits.listByTicket(db, ticketId);
  const verified = new Set(units.filter((u) => u.status === "verified").map((u) => u.seq));
  for (const u of units) {
    if (u.status !== "pending" && u.status !== "verifying") {
      continue;
    }
    if (workUnits.parseDependsOn(u).every((d) => verified.has(d))) {
      return u;
    }
  }
  return null;
}

/** First declared verify check-type for the unit that has no ground-truth signal yet. */
export function nextUnrunCheck(db: Database, unit: workUnits.WorkUnitRow): string | null {
  const run = new Set(gts.listByUnit(db, unit.id).map((s) => s.signal_type));
  for (const check of workUnits.parseVerifyCheckTypes(unit)) {
    if (!run.has(check)) {
      return check;
    }
  }
  return null;
}

function allUnitsVerified(db: Database, ticketId: number): boolean {
  const units = workUnits.listByTicket(db, ticketId);
  return units.length > 0 && units.every((u) => u.status === "verified");
}

/** Pure resolver (control-loop §2.3): maps current SQLite state to the next action.
 *  Does NOT mutate — M2b's advance_one_step interprets the descriptor. */
export function nextStepKey(db: Database, ticketId: number): StepDescriptor {
  const ticket = getTicket(db, ticketId);
  if (!ticket) {
    throw new Error(`nextStepKey: ticket ${ticketId} not found`);
  }

  switch (ticket.stage) {
    case "design": {
      if (!done(db, ticketId, "design:dispatch")) {
        return step("design:dispatch", "dispatch", "design:dispatch", null);
      }
      if (workUnits.listByTicket(db, ticketId).length === 0) {
        return step("design:extract", "dispatch", "design:extract", null);
      }
      if (ticket.track === "full" && !done(db, ticketId, "design:review")) {
        return step("design:review", "dispatch", "design:review", null);
      }
      return { kind: "advance", from: "design", to: "implement" };
    }

    case "implement": {
      const u = nextActionableUnit(db, ticketId);
      if (u) {
        if (u.status === "pending") {
          return step(`implement:wu${u.seq}:dispatch`, "dispatch", "implement:dispatch", u.id);
        }
        // verifying
        const check = nextUnrunCheck(db, u);
        if (check !== null) {
          return step(`verify:wu${u.seq}:${check}`, "verify", "verify:check", u.id);
        }
        return { kind: "mark-verified", workUnitId: u.id };
      }
      if (allUnitsVerified(db, ticketId)) {
        if (!done(db, ticketId, "verify:integration")) {
          return step("verify:integration", "verify", "verify:integration", null);
        }
        if (ticket.needs_docs === 1 && !done(db, ticketId, "docs:revise")) {
          return step("docs:revise", "dispatch", "docs:revise", null);
        }
        return { kind: "advance", from: "implement", to: "review" };
      }
      return { kind: "blocked", reason: "no actionable unit and not all units verified" };
    }

    case "review": {
      if (!done(db, ticketId, "review")) {
        return step("review", "dispatch", "review", null);
      }
      return { kind: "advance", from: "review", to: "merge" };
    }

    case "merge": {
      if (!done(db, ticketId, "merge:push")) {
        return step("merge:push", "project", "merge:push", null);
      }
      if (!done(db, ticketId, "merge:pr-ensure")) {
        return step("merge:pr-ensure", "project", "merge:pr-ensure", null);
      }
      if (!hasDelivered(db, ticketId, "external_checks")) {
        return { kind: "wait", signalType: "external_checks" };
      }
      if (!hasDelivered(db, ticketId, "human_merge_approval")) {
        return { kind: "wait", signalType: "human_merge_approval" };
      }
      return { kind: "advance", from: "merge", to: "released" };
    }

    case "released": {
      if (!done(db, ticketId, "released:project")) {
        return step("released:project", "project", "released:project", null);
      }
      return { kind: "done" };
    }

    default:
      throw new Error(`nextStepKey: unknown stage '${ticket.stage}'`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/daemon/resolver.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Run the FULL suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all M0 + M1 + M2a tests pass; Biome clean; `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/resolver.ts test/daemon/resolver.test.ts
git commit -m "feat(m2a): nextStepKey pure state machine (design→released routing)"
```

---

## M2a acceptance criteria

- [ ] New repos (`work_unit`, `ground_truth_signal`, `event_log`) + ticket extensions + `signal.hasDelivered` exist and are unit-tested against a real SQLite DB.
- [ ] `nextStepKey` deterministically routes a ticket through every stage (design → implement → verify → review → merge → released) and the terminal `done`, including fast vs full track, per-unit verify, `needs_docs`, and signal waits — all proven by `resolver.test.ts`.
- [ ] `nextStepKey` performs **no mutation** (pure read) — verified by construction (it calls only read functions) and by tests that call it repeatedly without state change.
- [ ] The step-handler registry registers/resolves handlers by `handlerKey`.
- [ ] `bun test` green; `bun run lint && bun run typecheck` clean.

## Out of scope (M2b and later)

- **`advance_one_step`** (interpreting descriptors: running steps via `runStep` + registered handlers, performing stage transitions with `event_log` + `setTicketStage`, marking units verified, parking on `wait` via `awaitSignal`) — **M2b**.
- **failure-policy / loopback atlas / budgets** (signatures, K_DISTINCT, retry/loopback/escalate; `completeness_failed`/D2) — **M2b**.
- **`loop()` event loop** (K=2, `v_ready_tickets` selection, spawn, drain/poll stubs) — **M2b**.
- **The walking-skeleton e2e + crash-resume** (mock handlers driving a fast-track ticket design→released) — **M2b**.
- **Rebase** (`branch_behind_origin`), real dispatch/verify/projector — M3/M4/M6.

## Done / handoff

When M2a is delivered, **pause to confirm M2a's *delivered* shape** with the operator (per their instruction) — that review of what actually landed informs the M2b plan. Only then draft/execute M2b (the resolver execution loop `advance_one_step`, failure-policy, `loop()`, and the walking-skeleton e2e).
