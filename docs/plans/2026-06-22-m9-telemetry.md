# M9 — Telemetry stdout export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `styre run` emits a structured NDJSON telemetry stream to stdout (event_log + dispatch + ground-truth-signal rows as they're journaled, plus a final per-ticket summary), the OSS↔commercial-plane contract.

**Architecture:** A reusable, injectable telemetry sink (default = NDJSON to stdout; a no-op in libraries; a capturing array in tests). A versioned zod event schema (discriminated union mirroring the DB rows in snake_case + a `schema_version`) is the contract. A stateful emitter streams **per-tick incrementally** — after each `tick`, the new event_log/dispatch/signal rows are emitted (dedup by natural key), so telemetry survives a mid-run crash; a `summary` event is emitted on exit. Cost telemetry comes from the `dispatch` table (already persisted) — `metric_event` is deferred. The human-readable run summary moves to **stderr** so stdout carries only machine NDJSON.

**Tech Stack:** TypeScript + Bun, zod. Commands: `bun test`, `bun run lint`, `bun run typecheck`, `bun run build`.

## Global Constraints

- **The telemetry event schema is a versioned public API (open-core seam).** Every emitted object carries `schema_version: 1` and a `type` discriminator. Fields mirror the DB rows in **snake_case** (the stream mirrors the SQL rows). Define it with zod (the `RuntimeConfigSchema` pattern); `TelemetryEvent` = `z.infer`.
- **NDJSON to stdout is the wire form** (build-ops §5.3, DECIDED): one JSON object per line, `\n`-terminated. The human-readable summary goes to **stderr**. stdout carries only telemetry.
- **Per-tick incremental emit:** after each `tick`, emit the newly-journaled rows; emit a final `summary` on exit. Idempotent — each row is emitted once, deduped by its natural key (event_log: `(ticket_id, seq)` via a monotonic last-seq; dispatch: `dispatch_id`; signal: `id`).
- **Injectable sink, default no-op in libraries.** `driveToTerminal`/`runTicket` take an optional `emit?: TelemetrySink` defaulting to a **no-op** — only `styre run` wires the real `stdoutSink`. Libraries must never write to stdout unless told (tests stay quiet / inject a capturing sink).
- **Cost from `dispatch`, not `metric_event`.** The summary's `cost_usd`/`tokens_in`/`tokens_out` are summed from the `dispatch` rows (already persisted by `completeDispatch`). Do NOT add a `metric_event` writer this milestone.
- **UTC timestamps, machine-consumed.** Emit the stored UTC strings verbatim (DS-1: no local-tz rendering — that's a human-edge concern; telemetry is machine-read).
- **No schema change.** This milestone reads existing tables and emits; it adds one repo *query* (`ground-truth-signal.listByTicket`) but no DDL. Verify `git diff main -- src/db/schema.sql docs/architecture/schema.sql` is empty.
- **No behavior change to the loop.** Telemetry is observational — `driveToTerminal`'s outcome logic, the resolver, and the dispatch path are untouched; emission is additive.

---

## File Structure

**New files:**
- `src/telemetry/events.ts` — the zod event schema (discriminated union: `event` | `dispatch` | `signal` | `summary`) + `SCHEMA_VERSION` + the `TelemetryEvent` type.
- `src/telemetry/emit.ts` — `TelemetrySink` type + `stdoutSink` (NDJSON to stdout) + `noopSink`.
- `src/telemetry/emitter.ts` — row→event mappers, `buildSummary`, and `createTelemetryEmitter(sink)` (stateful: `flushNew` dedup + `emitSummary`).
- Tests: `test/telemetry/events.test.ts`, `test/telemetry/emitter.test.ts`.

**Modified files:**
- `src/db/repos/ground-truth-signal.ts` — add `listByTicket(db, ticketId)`.
- `src/daemon/run-ticket.ts` — `driveToTerminal` + `runTicket` gain `emit?: TelemetrySink`; per-tick `flushNew`; `summary` on exit.
- `src/cli/run.ts` — pass `emit: stdoutSink`; human summary → `console.error` (stderr).
- `test/cli/run-e2e.test.ts` — assert the emitted telemetry stream (capturing sink).

---

### Task 1: Telemetry event schema + sinks

**Files:**
- Create: `src/telemetry/events.ts`, `src/telemetry/emit.ts`
- Test: `test/telemetry/events.test.ts`

**Interfaces:**
- Produces:
  - `SCHEMA_VERSION = 1` (const).
  - `TelemetryEventSchema` (zod discriminated union on `type`) + `type TelemetryEvent = z.infer<...>`. Variants: `event`, `dispatch`, `signal`, `summary` — each with `schema_version: 1`.
  - `type TelemetrySink = (event: TelemetryEvent) => void`; `stdoutSink: TelemetrySink` (writes `JSON.stringify(e)+"\n"` to `process.stdout`); `noopSink: TelemetrySink`.

- [ ] **Step 1: Write the failing test**

`test/telemetry/events.test.ts`:
```ts
import { expect, test } from "bun:test";
import { SCHEMA_VERSION, TelemetryEventSchema } from "../../src/telemetry/events.ts";
import { noopSink, stdoutSink } from "../../src/telemetry/emit.ts";

test("SCHEMA_VERSION is 1", () => {
  expect(SCHEMA_VERSION).toBe(1);
});

test("a summary event round-trips through the schema", () => {
  const ev = {
    schema_version: 1 as const,
    type: "summary" as const,
    ticket_id: 1,
    ident: "ENG-1",
    outcome: "pr-ready",
    stage: "merge",
    status: "waiting",
    ticks: 7,
    cost_usd: 0.42,
    tokens_in: 100,
    tokens_out: 50,
    dispatch_count: 2,
    dispatch_outcomes: { "clean-success": 2 },
    cycle_count: 1,
    escalation_count: 0,
    escalation_reasons: [],
  };
  const parsed = TelemetryEventSchema.parse(ev);
  expect(parsed.type).toBe("summary");
});

test("an event row variant round-trips (nullable fields allowed)", () => {
  const ev = {
    schema_version: 1 as const,
    type: "event" as const,
    ticket_id: 1,
    seq: 3,
    kind: "transition",
    actor: "daemon",
    from_stage: "design",
    to_stage: "implement",
    loop: null,
    route_to: null,
    signature: null,
    reason: null,
    created_at: "2026-06-22T00:00:00Z",
  };
  expect(TelemetryEventSchema.parse(ev).type).toBe("event");
});

test("the schema rejects an unknown type and a wrong version", () => {
  expect(() => TelemetryEventSchema.parse({ schema_version: 1, type: "nope" })).toThrow();
  expect(() =>
    TelemetryEventSchema.parse({ schema_version: 2, type: "summary" }),
  ).toThrow();
});

test("stdoutSink writes one JSON line; noopSink writes nothing", () => {
  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // @ts-expect-error test stub
  process.stdout.write = (s: string) => {
    written.push(s);
    return true;
  };
  try {
    stdoutSink({
      schema_version: 1,
      type: "summary",
      ticket_id: 1,
      ident: "ENG-1",
      outcome: "done",
      stage: "released",
      status: "done",
      ticks: 1,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      dispatch_count: 0,
      dispatch_outcomes: {},
      cycle_count: 0,
      escalation_count: 0,
      escalation_reasons: [],
    });
    noopSink({ schema_version: 1, type: "summary" } as never);
  } finally {
    process.stdout.write = orig;
  }
  expect(written.length).toBe(1);
  expect(written[0].endsWith("\n")).toBe(true);
  expect(JSON.parse(written[0]).ident).toBe("ENG-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/telemetry/events.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Write `src/telemetry/events.ts`**

```ts
import { z } from "zod";

/** The telemetry event-stream schema version (open-core seam — bump on a breaking change). */
export const SCHEMA_VERSION = 1;
const version = z.literal(SCHEMA_VERSION);

/** An event_log row (per-ticket timeline: transition / loopback / escalated / resumed / note). */
const EventEvent = z.object({
  schema_version: version,
  type: z.literal("event"),
  ticket_id: z.number(),
  seq: z.number(),
  kind: z.string(),
  actor: z.string().nullable(),
  from_stage: z.string().nullable(),
  to_stage: z.string().nullable(),
  loop: z.string().nullable(),
  route_to: z.string().nullable(),
  signature: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

/** A completed dispatch row (per-attempt cost/outcome/model/duration). */
const DispatchEvent = z.object({
  schema_version: version,
  type: z.literal("dispatch"),
  dispatch_id: z.string(),
  ticket_id: z.number(),
  work_unit_id: z.number().nullable(),
  seq: z.number(),
  stage: z.string().nullable(),
  kind: z.string().nullable(),
  model: z.string().nullable(),
  outcome: z.string().nullable(),
  branch_head_sha: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  duration_ms: z.number().nullable(),
  tokens_in: z.number().nullable(),
  tokens_out: z.number().nullable(),
  cost_usd: z.number().nullable(),
});

/** A ground-truth signal row (verify result: build/test/lint pass|fail|error). */
const SignalEvent = z.object({
  schema_version: version,
  type: z.literal("signal"),
  id: z.number(),
  ticket_id: z.number(),
  work_unit_id: z.number().nullable(),
  signal_type: z.string(),
  result: z.string(),
  command: z.string().nullable(),
  branch_head_sha: z.string().nullable(),
  measured_at: z.string(),
});

/** The per-ticket summary emitted on exit. The plane aggregates these into the §5.3 dashboard
 *  rates (autonomous-fix ratio, first-time CI pass rate) across runs. */
const SummaryEvent = z.object({
  schema_version: version,
  type: z.literal("summary"),
  ticket_id: z.number(),
  ident: z.string(),
  outcome: z.string(),
  stage: z.string(),
  status: z.string(),
  ticks: z.number(),
  cost_usd: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  dispatch_count: z.number(),
  dispatch_outcomes: z.record(z.string(), z.number()),
  cycle_count: z.number(),
  escalation_count: z.number(),
  escalation_reasons: z.array(z.string()),
});

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  EventEvent,
  DispatchEvent,
  SignalEvent,
  SummaryEvent,
]);

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
```

- [ ] **Step 4: Write `src/telemetry/emit.ts`**

```ts
import type { TelemetryEvent } from "./events.ts";

/** A telemetry sink. The OSS contract is NDJSON to stdout (stdoutSink); libraries default to
 *  noopSink (never write to stdout unless told); tests inject a capturing sink. */
export type TelemetrySink = (event: TelemetryEvent) => void;

/** The OSS↔plane wire form: one JSON object per line on stdout. */
export const stdoutSink: TelemetrySink = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

/** The library default — emit nothing. */
export const noopSink: TelemetrySink = () => {};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/telemetry/events.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add src/telemetry/events.ts src/telemetry/emit.ts test/telemetry/events.test.ts
git commit -m "feat(m9): telemetry event schema (versioned union) + stdout/noop sinks"
```

---

### Task 2: Row→event mappers, summary, and the stateful emitter

**Files:**
- Modify: `src/db/repos/ground-truth-signal.ts` (add `listByTicket`)
- Create: `src/telemetry/emitter.ts`
- Test: `test/telemetry/emitter.test.ts`

**Interfaces:**
- Consumes: `TelemetryEvent`/`SCHEMA_VERSION` (Task 1); `listByTicket` from event-log + dispatch + ground-truth-signal repos; `getTicket`; `RunResult` (`src/daemon/run-ticket.ts`).
- Produces:
  - `ground-truth-signal.listByTicket(db, ticketId): GroundTruthSignalRow[]` (ordered by measured_at, id).
  - `buildSummary(db, ticketId, result: RunResult): TelemetryEvent` (the `summary` event).
  - `createTelemetryEmitter(sink: TelemetrySink): { flushNew(db, ticketId): void; emitSummary(db, ticketId, result): void }` — `flushNew` emits only rows not seen before (event_log by monotonic seq, dispatch by `dispatch_id` once `ended_at` is set, signal by `id`); `emitSummary` emits the summary.

**Context:** Cost/tokens come from the `dispatch` rows (`completeDispatch` already persisted them). `cycle_count` = count of `event_log` rows with `kind === "loopback"`; `escalation_reasons` = the `reason` of `kind === "escalated"` rows. Only completed dispatches (`ended_at != null`) are emitted (a pending dispatch has no outcome/cost yet).

- [ ] **Step 1: Add `listByTicket` to `src/db/repos/ground-truth-signal.ts`**

After `listByUnit`:
```ts
export function listByTicket(db: Database, ticketId: number): GroundTruthSignalRow[] {
  return db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal WHERE ticket_id = ? ORDER BY measured_at, id`,
    )
    .all(ticketId);
}
```

- [ ] **Step 2: Write the failing test**

`test/telemetry/emitter.test.ts`:
```ts
import { expect, test } from "bun:test";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { createTelemetryEmitter } from "../../src/telemetry/emitter.ts";
import type { TelemetryEvent } from "../../src/telemetry/events.ts";
import { makeTestDb } from "../helpers/db.ts";

test("flushNew emits each row once (dedup) across calls; summary sums cost + counts cycles", () => {
  const { db, ticketId } = makeTestDb();
  const sink: TelemetryEvent[] = [];
  const emitter = createTelemetryEmitter((e) => sink.push(e));

  // First batch: a transition event + a completed dispatch with cost.
  appendEvent(db, { ticketId, kind: "transition", fromStage: "design", toStage: "implement" });
  const d1 = insertDispatch(db, { ticketId, dispatchId: "D1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d1.id, { outcome: "clean-success", branchHeadSha: "s1", costUsd: 0.25, tokensIn: 100, tokensOut: 40 });
  emitter.flushNew(db, ticketId);

  const firstCount = sink.length;
  expect(sink.some((e) => e.type === "event" && e.kind === "transition")).toBe(true);
  expect(sink.some((e) => e.type === "dispatch" && e.dispatch_id === "D1")).toBe(true);

  // Re-flush with no new rows → nothing added (dedup).
  emitter.flushNew(db, ticketId);
  expect(sink.length).toBe(firstCount);

  // Second batch: a loopback event + a ground-truth signal.
  appendEvent(db, { ticketId, kind: "loopback", reason: "verify failed" });
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  insertSignal(db, { ticketId, workUnitId: unit.id ?? unit, signalType: "test", result: "fail" });
  emitter.flushNew(db, ticketId);
  expect(sink.some((e) => e.type === "event" && e.kind === "loopback")).toBe(true);
  expect(sink.some((e) => e.type === "signal" && e.result === "fail")).toBe(true);

  // Summary: cost summed from dispatch; cycle_count from loopback events.
  emitter.emitSummary(db, ticketId, { outcome: "pr-ready", iterations: 5, stage: "merge", status: "waiting" });
  const summary = sink.find((e) => e.type === "summary");
  if (!summary || summary.type !== "summary") throw new Error("no summary emitted");
  expect(summary.cost_usd).toBeCloseTo(0.25);
  expect(summary.tokens_in).toBe(100);
  expect(summary.dispatch_count).toBe(1);
  expect(summary.cycle_count).toBe(1);
  expect(summary.outcome).toBe("pr-ready");
  db.close();
});
```
(NOTE: `insertWorkUnit`'s return shape — if it returns a row use `.id`, if it returns the id number use it directly. Check `src/db/repos/work-unit.ts` and use the correct form; the `unit.id ?? unit` above is a placeholder — replace with the actual accessor.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: FAIL — `src/telemetry/emitter.ts` does not exist.

- [ ] **Step 4: Write `src/telemetry/emitter.ts`**

```ts
import type { Database } from "bun:sqlite";
import { listByTicket as listDispatches } from "../db/repos/dispatch.ts";
import type { DispatchRow } from "../db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";
import type { EventLogRow } from "../db/repos/event-log.ts";
import { listByTicket as listSignals } from "../db/repos/ground-truth-signal.ts";
import type { GroundTruthSignalRow } from "../db/repos/ground-truth-signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import type { RunResult } from "../daemon/run-ticket.ts";
import { SCHEMA_VERSION, type TelemetryEvent } from "./events.ts";
import type { TelemetrySink } from "./emit.ts";

function toEvent(r: EventLogRow): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "event",
    ticket_id: r.ticket_id,
    seq: r.seq,
    kind: r.kind,
    actor: r.actor,
    from_stage: r.from_stage,
    to_stage: r.to_stage,
    loop: r.loop,
    route_to: r.route_to,
    signature: r.signature,
    reason: r.reason,
    created_at: r.created_at,
  };
}

function toDispatch(r: DispatchRow): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "dispatch",
    dispatch_id: r.dispatch_id,
    ticket_id: r.ticket_id,
    work_unit_id: r.work_unit_id,
    seq: r.seq,
    stage: r.stage,
    kind: r.kind,
    model: r.model,
    outcome: r.outcome,
    branch_head_sha: r.branch_head_sha,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_ms: r.duration_ms,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    cost_usd: r.cost_usd,
  };
}

function toSignal(r: GroundTruthSignalRow): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "signal",
    id: r.id,
    ticket_id: r.ticket_id,
    work_unit_id: r.work_unit_id,
    signal_type: r.signal_type,
    result: r.result,
    command: r.command,
    branch_head_sha: r.branch_head_sha,
    measured_at: r.measured_at,
  };
}

/** Compute the per-ticket summary from the durable SoT (cost from the dispatch rows). */
export function buildSummary(db: Database, ticketId: number, result: RunResult): TelemetryEvent {
  const ticket = getTicket(db, ticketId);
  const events = listEvents(db, ticketId);
  const dispatches = listDispatches(db, ticketId);
  const sum = (ns: Array<number | null>) => ns.reduce((a: number, n) => a + (n ?? 0), 0);
  const dispatch_outcomes: Record<string, number> = {};
  for (const d of dispatches) {
    if (d.outcome) dispatch_outcomes[d.outcome] = (dispatch_outcomes[d.outcome] ?? 0) + 1;
  }
  const escalations = events.filter((e) => e.kind === "escalated");
  return {
    schema_version: SCHEMA_VERSION,
    type: "summary",
    ticket_id: ticketId,
    ident: ticket?.ident ?? "",
    outcome: result.outcome,
    stage: result.stage,
    status: result.status,
    ticks: result.iterations,
    cost_usd: sum(dispatches.map((d) => d.cost_usd)),
    tokens_in: sum(dispatches.map((d) => d.tokens_in)),
    tokens_out: sum(dispatches.map((d) => d.tokens_out)),
    dispatch_count: dispatches.length,
    dispatch_outcomes,
    cycle_count: events.filter((e) => e.kind === "loopback").length,
    escalation_count: escalations.length,
    escalation_reasons: escalations
      .map((e) => e.reason)
      .filter((r): r is string => r !== null),
  };
}

/** A stateful per-run emitter: flushNew streams rows journaled since the last call (dedup by
 *  natural key); emitSummary emits the terminal summary. */
export function createTelemetryEmitter(sink: TelemetrySink): {
  flushNew(db: Database, ticketId: number): void;
  emitSummary(db: Database, ticketId: number, result: RunResult): void;
} {
  let lastEventSeq = 0;
  const seenDispatch = new Set<string>();
  const seenSignal = new Set<number>();
  return {
    flushNew(db, ticketId) {
      for (const r of listEvents(db, ticketId)) {
        if (r.seq > lastEventSeq) {
          sink(toEvent(r));
          lastEventSeq = r.seq;
        }
      }
      for (const d of listDispatches(db, ticketId)) {
        if (d.ended_at !== null && !seenDispatch.has(d.dispatch_id)) {
          sink(toDispatch(d));
          seenDispatch.add(d.dispatch_id);
        }
      }
      for (const s of listSignals(db, ticketId)) {
        if (!seenSignal.has(s.id)) {
          sink(toSignal(s));
          seenSignal.add(s.id);
        }
      }
    },
    emitSummary(db, ticketId, result) {
      sink(buildSummary(db, ticketId, result));
    },
  };
}
```
(If importing `RunResult` from `run-ticket.ts` creates an import cycle once Task 3 imports the emitter into `run-ticket.ts`, move the `RunOutcome`/`RunResult` types into a tiny `src/daemon/run-result.ts` and import from there in both — note this in your report if you hit it. A type-only import usually does not cycle at runtime; prefer `import type`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: PASS. Fix the `insertWorkUnit` accessor in the test to match the repo's actual return.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add src/db/repos/ground-truth-signal.ts src/telemetry/emitter.ts test/telemetry/emitter.test.ts
git commit -m "feat(m9): telemetry emitter (row mappers + dedup flushNew + summary) + signal listByTicket"
```

---

### Task 3: Wire telemetry into the run path (stdout/stderr split)

**Files:**
- Modify: `src/daemon/run-ticket.ts` (`driveToTerminal` + `runTicket` gain `emit?`; per-tick flush + summary)
- Modify: `src/cli/run.ts` (pass `stdoutSink`; human summary → stderr)
- Test: `test/cli/run-e2e.test.ts` (assert the emitted stream)

**Interfaces:**
- Consumes: `createTelemetryEmitter` (Task 2); `TelemetrySink`/`noopSink`/`stdoutSink` (Task 1).
- Produces: `driveToTerminal` and `runTicket` accept `emit?: TelemetrySink` (default `noopSink`); `styre run` emits NDJSON to stdout and prints the human summary to stderr.

**Context:** `driveToTerminal` (run-ticket.ts:27-66) has multiple terminal `return`s. Add a `finish(result)` helper that flushes + emits the summary, and route every `return` through it. Per-tick: call `emitter.flushNew` right after `tick`. The default `emit` is `noopSink`, so existing callers (run-ticket.test, merge-complete-e2e — which pass no `emit`) stay silent and unchanged.

- [ ] **Step 1: Write the failing test (assert the emitted stream)**

Add to `test/cli/run-e2e.test.ts` a test that injects a capturing sink:
```ts
test("runTicket emits a telemetry stream (events + summary) to the sink", async () => {
  const { db } = makeTestDb({ seedTicket: false });
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", commands: {}, checksSystem: "none" });
  const ports = {
    issueTracker: fakeIssueTracker({
      ticket: { ident: "ENG-9", title: "T", description: "B", typeLabel: "Feature", linearIssueUuid: "u", url: null },
    }),
    forge: fakeForge(),
    checks: fakeChecks("passing"),
  };
  const events: import("../../src/telemetry/events.ts").TelemetryEvent[] = [];
  const out = await runTicket({
    db,
    profile,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ports,
    registry: skeletonRegistry(),
    ticketRef: "ENG-9",
    emit: (e) => events.push(e),
  });
  expect(out.outcome).toBe("pr-ready");
  // The stream carries at least one transition event and exactly one terminal summary.
  expect(events.some((e) => e.type === "event")).toBe(true);
  const summaries = events.filter((e) => e.type === "summary");
  expect(summaries.length).toBe(1);
  if (summaries[0].type !== "summary") throw new Error("unreachable");
  expect(summaries[0].outcome).toBe("pr-ready");
  expect(summaries[0].ident).toBe("ENG-9");
  db.close();
});
```
(Match the existing file's imports — `makeTestDb`, `parseProfile`, fakes, `skeletonRegistry`, `runTicket`, `DEFAULT_RUNTIME_CONFIG` are already imported there; use the same `makeTestDb({ seedTicket: false })` form the file already uses, adapting if needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/run-e2e.test.ts`
Expected: FAIL — `runTicket` has no `emit` param; no summary emitted.

- [ ] **Step 3: Thread `emit` through `driveToTerminal` (`src/daemon/run-ticket.ts`)**

Add imports:
```ts
import { createTelemetryEmitter } from "../telemetry/emitter.ts";
import { noopSink, type TelemetrySink } from "../telemetry/emit.ts";
```
Add `emit?: TelemetrySink` to `driveToTerminal`'s `opts`, and route returns through a `finish` helper:
```ts
export async function driveToTerminal(
  db: Database,
  registry: StepRegistry,
  opts: {
    ticketId: number;
    config: RuntimeConfig;
    ports: ProjectorPorts;
    profile: { checksSystem: string };
    cap?: number;
    emit?: TelemetrySink;
  },
): Promise<RunResult> {
  const cap = opts.cap ?? DEFAULT_CAP;
  const emitter = createTelemetryEmitter(opts.emit ?? noopSink);
  const finish = (result: RunResult): RunResult => {
    emitter.flushNew(db, opts.ticketId);
    emitter.emitSummary(db, opts.ticketId, result);
    return result;
  };
  let idle = 0;
  let last = { stage: "", status: "" };
  for (let i = 1; i <= cap; i++) {
    const r = await tick(db, registry, { config: opts.config, ports: opts.ports, profile: opts.profile });
    emitter.flushNew(db, opts.ticketId);
    const t = getTicket(db, opts.ticketId);
    if (!t) throw new Error(`driveToTerminal: ticket ${opts.ticketId} not found`);
    last = { stage: t.stage, status: t.status };
    const pending = listPending(db, opts.ticketId);

    if (t.status === "done") return finish({ outcome: "done", iterations: i, ...last });
    if (pending.some((s) => s.signal_type === "human_resume"))
      return finish({ outcome: "blocked", iterations: i, ...last });
    if (t.stage === "merge" && pending.some((s) => s.signal_type === "human_merge_approval"))
      return finish({ outcome: "pr-ready", iterations: i, ...last });

    if (r.advanced === 0) {
      idle += 1;
      if (idle >= IDLE_CAP) return finish({ outcome: "no-progress", iterations: i, ...last });
    } else {
      idle = 0;
    }
  }
  return finish({ outcome: "no-progress", iterations: cap, ...last });
}
```

- [ ] **Step 4: Thread `emit` through `runTicket`**

Add `emit?: TelemetrySink` to `runTicket`'s `deps`, and pass it to `driveToTerminal`:
```ts
export async function runTicket(deps: {
  db: Database;
  profile: Profile;
  runtimeConfig: RuntimeConfig;
  ports: ProjectorPorts;
  registry: StepRegistry;
  ticketRef: string;
  emit?: TelemetrySink;
}): Promise<RunResult & { ticketId: number; summary: string }> {
  // ... ingest unchanged ...
  const result = await driveToTerminal(deps.db, deps.registry, {
    ticketId,
    config: deps.runtimeConfig,
    ports: deps.ports,
    profile: deps.profile,
    emit: deps.emit,
  });
  return { ...result, ticketId, summary: formatRunSummary(deps.db, ticketId, result) };
}
```

- [ ] **Step 5: Wire `styre run` (`src/cli/run.ts`) — telemetry → stdout, human → stderr**

Add the import:
```ts
import { stdoutSink } from "../telemetry/emit.ts";
```
Pass the sink and move the human summary to stderr (replace lines 49-57):
```ts
    const out = await runTicket({
      db,
      profile,
      runtimeConfig,
      ports,
      registry,
      ticketRef: args.ticket,
      emit: stdoutSink,
    });
    console.error(out.summary); // human summary → stderr; stdout carries only NDJSON telemetry
    db.close();
    if (out.outcome === "blocked" || out.outcome === "no-progress") {
      throw new Error(`run: ticket ${args.ticket} ended ${out.outcome}`);
    }
```

- [ ] **Step 6: Run the new e2e + the no-regression run tests**

Run: `bun test test/cli/run-e2e.test.ts test/daemon/run-ticket.test.ts test/dispatch/merge-complete-e2e.test.ts`
Expected: PASS. The existing run-ticket/merge-complete tests pass `no emit` → `noopSink` → silent, behavior unchanged. The new test asserts the captured stream.

- [ ] **Step 7: Full gate + typecheck + build, commit**

Run: `bun test 2>&1 | tail -3 && bun run lint && bun run typecheck && bun run build`
Expected: all green; binary builds.

```bash
git add src/daemon/run-ticket.ts src/cli/run.ts test/cli/run-e2e.test.ts
git commit -m "feat(m9): emit telemetry per-tick to stdout (human summary → stderr)"
```

---

## Final Verification (run after all tasks)

```bash
bun test           # all green (prior suite + new telemetry tests)
bun run lint && bun run typecheck && bun run build
git diff main -- src/db/schema.sql docs/architecture/schema.sql   # EMPTY (no schema change)
# Manual: a real run prints NDJSON on stdout, the human summary on stderr:
#   bun run src/index.ts run ENG-X --profile p.json 1>telemetry.ndjson 2>summary.txt
#   → telemetry.ndjson is one JSON object per line; summary.txt is the human text
```

## Out of Scope (carries → later)

- **`metric_event` writer** (per-step cost/tokens, cache_read/cache_create) — deferred; cost telemetry comes from the `dispatch` table this milestone. Wiring it also needs `parseClaudeJson` cache-field parsing + `model`/`durationMs` on `AgentRunResult`.
- **`appendEvent` `dispatch_id`/`payload_json`** — the DDL has these columns but `appendEvent`/`EventLogRow` omit them; event_log telemetry dedups by `(ticket_id, seq)` instead. Persisting `dispatch_id` on event rows is a later refinement.
- **Computed dashboard *rates*** (autonomous-fix ratio, first-time CI pass rate) — the per-ticket summary emits the raw primitives (cycle_count, dispatch_outcomes, escalation_reasons, cost); the plane aggregates rates across runs.
- **Live streaming for a long-lived daemon** — not applicable (no OSS daemon); the injected-sink seam is daemon-ready if the commercial plane wants it.
- **A real-stdout integration test** (spawn the binary, parse stdout NDJSON) — the injected-sink test covers the stream; the stdout/stderr split is covered by the manual smoke.
