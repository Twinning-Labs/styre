# Telemetry: run identity + cost truth (ENG-339 + ENG-349)

**Date:** 2026-07-21
**Tickets:** ENG-339 (cost reports `$0` for unknown; `duration_ms` dead column) + ENG-349 (NDJSON stream has no run identity). Attempted together because they **co-own a single `SCHEMA_VERSION 1→2` bump** to the open-core seam.
**Branch:** `feat/eng-339-349-telemetry-wire-v2`

---

## 1. Problem

The telemetry NDJSON export (`src/telemetry/`) is a **versioned public API of the open-core seam** — the commercial Control Plane's only view of spend and run outcomes (CLAUDE.md; `build-operations.md §5`). Today it has three classes of defect:

**A. Unknown cost is published as zero (ENG-339).** `buildSummary` (`emitter.ts:83`) sums with `sum = ns.reduce((a, n) => a + (n ?? 0), 0)` — coalescing `null → 0`. Summary `cost_usd` is typed non-nullable (`events.ts:73`) while per-dispatch `cost_usd` is correctly nullable (`events.ts:45`). When no dispatch reports cost — every **codex**-provider run, by design (`codex.ts:64-66`) — the summary emits `"cost_usd": 0`. A consumer cannot distinguish a genuinely free run from a run whose provider doesn't report cost. Any spend/budget/billing view built on the stream silently under-counts to zero. `tokens_*` / `cache_*` flow through the same `sum` and inherit the flaw.

**B. `duration_ms` is a dead column (ENG-339).** The writer supports it (`dispatch.ts:118,129,137`) but **no completion call site passes it** — `run-dispatch.ts:270-278` sets cost/tokens and omits `durationMs`. Both `started_at` and `ended_at` are recorded, so the value is trivially computable and simply never computed. Always `null` on the wire.

**C. The stream carries no run identity (ENG-349).**
- **No `run_id` / correlation id** exists anywhere (`grep run_id|runId|correlation` → 0 matches).
- **`ticket_id` is not a cross-run join key.** It is `ticket.id INTEGER PRIMARY KEY` (`schema.sql:83`), an autoincrement rowid scoped to *that invocation's* ephemeral temp DB (`run.ts:166-170`). It is `1` on essentially every run and collides across unrelated tickets.
- **Two runs of the same ticket are indistinguishable** — identical `ident` and `ticket_id: 1`.
- **This is already engineered-around downstream** — styre-bench correlates runs via a host filesystem path `styre-bench-run-${inst.id}-${Date.now()}-${random}` (`run-task.ts:457-459`) because the producer ships no identity; the comment notes `Date.now()` alone collides under rapid re-invocation.
- **`SummaryEvent` has no timestamp** — the only union member without a time field (`events.ts:64-83`).
- **No `provider` field anywhere** — cost is only interpretable per-provider (codex reports none, claude does), so a spend consumer needs it on the row it aggregates.
- **`event.dispatch_id` is dropped** by `toEvent` (`emitter.ts:20-37`) — a consumer cannot join a loopback/escalation event to the dispatch that caused it. Same drop for the dispatch forensic fields `trigger`, `exit_code`, `effort`, `predecessor_dispatch_id`.

---

## 2. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **One combined PR, one `SCHEMA_VERSION 1→2` bump.** | Both tickets change the wire shape and name the same bump as their central design call. styre-cloud has **no ingest code yet** — this is the free window to break the shape cleanly before anything depends on v1. |
| D2 | **`run_id` = opaque UUIDv4**, minted at fresh-run start, persisted in a new single-row `run` table. | Collision-free (unlike the composite `{slug, ident, started_at}`, which reproduces styre-bench's `Date.now()` collision). `slug`/`ident`/`provider`/`started_at` ride as their own named fields, so nothing is lost by `run_id` being opaque. |
| D3 | **Cost/aggregate contract = floor-sum + per-field coverage.** Each aggregate is `number \| null`: `null` iff **zero** dispatches reported it; otherwise the sum of the reported values (an explicit floor). A `usage_coverage` object carries **per-field** reported counts. | Unknown ≠ zero. Coverage differs per field (codex reports tokens but not cost), so a single shared count would itself lie. A consumer reads `coverage.<f> < dispatch_count` ⟹ lower bound; `null` ⟹ nothing reported; `provider` explains why. |
| D4 | **Compute `duration_ms` centrally in `completeDispatch`.** | One place ⟹ **every** completed row (success, parked, failed, postcondition-failed) gets it — instead of patching 3+ call sites and re-introducing the exact "one caller forgot" bug being fixed. |
| D5 | **`provider` injected at emit time** from `run.provider` (a run-level constant), not stored per-dispatch. | Avoids a redundant column holding a run-constant on every dispatch row. |
| D6 | **Park dir stays keyed by ticket ref; latest-wins.** Add a `dumpPark` stderr warning when overwriting a dump whose `run_id` differs. | The park path's job is "the latest parked run of ticket X"; ref-keying is load-bearing for the resume UX (you resume by typing a ref, not a UUID). Run identity belongs on the **wire**, where a *consumer* needs it. The warning kills the silent-loss surprise without changing behavior. |
| D7 | **`--resume` = same `run_id`, marked.** For a v2 park, resume reads the persisted `run_id` back and sets `resumed=1`, `attempt++`. | A resume is a continuation of the same logical run. The `run` row rides across the park boundary inside the copied `run.db`. See D10 for the pre-upgrade-park reality. |
| D8 | **Validate on the emit path, but never throw on the live wire.** `stdoutSink` runs `TelemetryEventSchema.parse` per event; on failure it writes a diagnostic to **stderr** (human channel) and still emits the row best-effort — it does **not** abort the run. Tests assert strict validity. | *(Revised after review — B3.)* Telemetry is best-effort/lossy by contract (§5.3; the CI-handoff comment in `emitter.ts:154-158` already says so). A serialization check must not be able to flip an otherwise-successful run — SoT committed, outbox drained, PR opened — into a hard `exit 70` (`run.ts:225`). Catches drift without gating. |
| D9 | **Run identity is a SoT invariant: the emitter requires a `run` row.** `getRun(db) == null` is an invariant violation (throws a clear error), never silently a null `run_id`. The runner always inserts the row at start; tests seed it. | *(Added after review — B2.)* Keeps `run_id: string` non-nullable on the wire and makes the failure legible instead of producing malformed events. |
| D10 | **Pre-upgrade-park resume degrades gracefully; it is not made to preserve the original identity.** `migrate()` is replay-once (`migrate.ts:30-33`) — an existing DB never gains a new table — so a v1 park has no `run` table. Resume runs `CREATE TABLE IF NOT EXISTS run` and, finding no row, inserts a **fresh** `run_id` (`resumed=1`) for the resumed portion. | *(Added after review — B1.)* General schema-change-across-park is a **pre-existing** limitation of the no-migration-framework design, not introduced here. This fix only turns a `no such table` crash into graceful, identity-bearing resumption. The v1-emitted rows predate run identity anyway (different `schema_version`). |
| D9 | **A field-by-field wire spec lives in `docs/architecture/telemetry-export.md`.** | ENG-349 AC: a wire spec must exist in `docs/`, not just the zod schema. It is a maintained reference kept current with the code. |

---

## 3. Design

### 3.1 Identity substrate — new `run` table

There is exactly one logical run per ephemeral DB. Add a single-row table:

```sql
CREATE TABLE run (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT    NOT NULL,               -- UUIDv4, minted at fresh-run start
    started_at  TEXT    NOT NULL,               -- run wall-clock start (UTC)
    provider    TEXT    NOT NULL,               -- run-level provider ('claude' | 'codex' | ...)
    resumed     INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
    attempt     INTEGER NOT NULL DEFAULT 1
);
```

- **Table count:** schema goes 16 → 17 `CREATE TABLE` statements. Update the count in CLAUDE.md and `docs/architecture/build-operations.md`, and keep `src/db/schema.sql` **byte-identical** to `docs/architecture/schema.sql` (CLAUDE.md rule).
- **Fresh run** (`run.ts`, after `migrate` + `openDb`): `migrate` on a fresh DB runs the full `schemaSql` (`migrate.ts:34`), so the `run` table exists. Insert one row — `run_id = crypto.randomUUID()`, `started_at = nowUtc()`, `provider = agentConfig.provider`, `attempt = 1`. Only-the-runner-writes-the-SoT (B2 invariant) is preserved: this write is on the runner path.
- **Resume** (`park.ts resumeRun`): `migrate()` is **replay-once** — for an already-bootstrapped parked DB it returns early and creates nothing (`migrate.ts:30-33`). So resume must not assume the table exists:
  - Call `ensureRun(db)` → `CREATE TABLE IF NOT EXISTS run (…)`, then read the row.
  - **v2 park:** table + row present in the copied `run.db` → read `run_id` back, set `resumed=1`, `attempt++`. Same logical run.
  - **v1 park (upgraded between park and resume):** table just created, no row → insert a **fresh** `run_id`, `resumed=1`, `attempt=2` (see D10). Graceful, identity-bearing; the original had no id to preserve.
  - **DDL-duplication note:** `ensureRun`'s `CREATE TABLE IF NOT EXISTS` mirrors the `run` DDL in `schema.sql`. Keep them identical; `schema.sql` remains the SoT and carries a comment pointing at `run.ts`. This small wart is the bridge given there is no incremental-migration framework — building one is out of scope (a separate ticket).
- **Reader:** `getRun(db): RunRow | null` in a new `src/db/repos/run.ts`. Per **D9**, callers that require identity (the emitter) treat `null` as an invariant violation and throw a clear error rather than emitting a null `run_id`.

### 3.2 `SCHEMA_VERSION` → 2

`events.ts:4`: `export const SCHEMA_VERSION = 2;`. The zod `version = z.literal(SCHEMA_VERSION)` follows automatically; every event stamps `schema_version: 2`.

### 3.3 Wire shape (v2)

Fields added per event type (existing fields unchanged unless noted):

**All events** — gain `run_id: string`.

**`SummaryEvent`** (`events.ts:64`):
- `run_id: string`
- `provider: string`
- `started_at: string` (run start, from `run.started_at`)
- `ended_at: string` (summary emit time — the missing wall-clock)
- Aggregates become nullable: `cost_usd`, `tokens_in`, `tokens_out`, `cache_read`, `cache_create` → `z.number().nullable()`
- `usage_coverage: { dispatch_count: number, cost_usd: number, tokens_in: number, tokens_out: number, cache_read: number, cache_create: number }` — per-field count of dispatches that reported each aggregate (`dispatch_count` is the denominator).

**`DispatchEvent`** (`events.ts:26`):
- `run_id: string`
- `provider: string` (injected from `run.provider`)
- Forensic fields restored: `trigger`, `exit_code`, `effort`, `predecessor_dispatch_id` (nullable) — requires adding them to `DispatchRow`'s `COLS`/interface in `db/repos/dispatch.ts` (schema already has the columns).

**`EventEvent`** (`events.ts:8`):
- `run_id: string`
- `dispatch_id: z.string().nullable()` — restore the dropped join key (`event_log.dispatch_id`, `schema.sql:287`).

**`SignalEvent`, `CiHandoffEvent`** — gain `run_id: string`.

### 3.4 `buildSummary` rewrite (`emitter.ts:79-109`)

Replace the lossy `sum` with a floor-sum-with-coverage helper:

```ts
// Sum of reported (non-null) values; null iff nothing reported. Plus the count reported.
function aggregate(ns: Array<number | null>): { value: number | null; reported: number } {
  const present = ns.filter((n): n is number => n !== null);
  return { value: present.length === 0 ? null : present.reduce((a, n) => a + n, 0), reported: present.length };
}
```

Each of `cost_usd`/`tokens_in`/`tokens_out`/`cache_read`/`cache_create` is computed via `aggregate(...)`; `.value` populates the field and `.reported` populates `usage_coverage.<field>`. `usage_coverage.dispatch_count` = `dispatches.length`. `run_id`/`provider`/`started_at` come from `getRun(db)`; `ended_at = nowUtc()`.

### 3.5 `duration_ms` (`dispatch.ts completeDispatch`)

`completeDispatch` computes `duration_ms` when not passed explicitly and both timestamps are available:

```ts
// duration_ms: computed here so every completed row carries it, not just the ones a caller remembered.
const startedAt = getByDispatchId(...)?.started_at // or SELECT started_at WHERE id = $id
const durationMs = p.durationMs ?? (
  startedAt && p.endedAt ? Date.parse(p.endedAt) - Date.parse(startedAt) : null
);
```

Implementation note: `completeDispatch` takes `id`, not the row — it does one `SELECT started_at FROM dispatch WHERE id = ?` before the `UPDATE`. `p.durationMs` remains an override. This covers all five call sites (`run-dispatch.ts:168,177,234,282,285` + `handlers.ts:782,997`) uniformly.

### 3.6 Emitter injection (`emitter.ts`)

`createTelemetryEmitter` reads the `run` row once at construction (via `getRun(db)`) and caches `run_id`/`provider` in the closure; `getRun == null` throws the D9 invariant error there (one legible failure, not per-row). Every projection stamps the cached values: `toEvent` restores `dispatch_id` and adds `run_id`; `toDispatch` adds `provider` + forensic fields (`trigger`/`exit_code`/`effort`/`predecessor_dispatch_id`); `toSignal`/`emitCiHandoff` add `run_id`; `buildSummary` as above. All emit points already hold `db`, so identity is available on the incremental (`flushNew`) and terminal paths alike.

### 3.7 Emit-path validation (`emit.ts stdoutSink`) — *non-fatal (revised, B3)*

`stdoutSink` runs `TelemetryEventSchema.safeParse(event)` before `JSON.stringify`. On **failure** it writes a one-line diagnostic to **stderr** (the human channel — stdout stays pure NDJSON) and still emits the row best-effort; it does **not** throw. Rationale: telemetry is best-effort/lossy by contract (§5.3), and the emitter is called on every tick and at `finish()` (`run-ticket.ts:85-99`) with no surrounding try/catch — a throw would propagate to `run.ts`'s catch and map to `exit 70` (`run.ts:225`), turning a fully-successful run (SoT committed, outbox drained, CI handoff sent) into a crash. Strict `.parse` (throwing) is used **in tests** to assert the producer emits valid events.

### 3.8 Park-dir warning (`park.ts dumpPark`) — *tolerant of a missing table (B1-aware)*

Before `copyFileSync(dbPath, destPath)`, if `destPath` exists, best-effort read its `run.run_id`: open a read connection, and if the query throws (a **pre-upgrade dump has no `run` table**) treat it as "no prior id" and skip. If a differing id is found, write one stderr line: `overwriting parked run <old-run_id> with <new-run_id> for <ident>`. Behavior unchanged (latest-wins); only the silent-loss surprise is removed, and the legacy dump never crashes the warning.

### 3.9 Docs

- **New:** `docs/architecture/telemetry-export.md` — the field-by-field wire spec: every event type and field, `SCHEMA_VERSION 2`, `run_id` semantics, `ticket_id` documented as **run-local (not a global join key)**, the floor-sum + coverage cost contract, provider/timestamp additions. Referenced from `build-operations.md §5`.
- **Update:** CLAUDE.md + `build-operations.md` table count (16 → 17). Keep `docs/architecture/schema.sql` in sync with `src/db/schema.sql`.

---

## 4. Testing (extend `test/telemetry/emitter.test.ts`)

**Test-substrate prerequisite (B2):** the emitter now requires a `run` row (D9). Update `makeTestDb` (`test/helpers/db.ts`) — or add a `seedRun(db, {provider?})` helper — to insert one, and call it wherever a telemetry test builds summaries/dispatches. Existing assertions that read `summary.cost_usd`/`cache_read` directly (`emitter.test.ts:65-68`) must handle `number | null`. The dispatch inserted at `emitter.test.ts:17` currently has no `started_at`; the new duration test must seed `startedAt` (else duration is correctly `null`).

- **Cost truth:** a run where no dispatch reports cost emits `cost_usd: null`, **not** `0`; `usage_coverage.cost_usd == 0`.
- **Mixed case:** some dispatches report, some don't ⟹ aggregate = sum of reported (floor), `usage_coverage.<f> < dispatch_count`.
- **Full case:** all report ⟹ real sum, `coverage == dispatch_count`.
- **`tokens_*` / `cache_*`** get the same treatment (no silent `null→0`).
- **`duration_ms`** populated on every completed row and equals `ended_at − started_at`.
- **Run identity:** two runs of the same ticket emit distinct `run_id`; resume emits the **same** `run_id` with `resumed=1`.
- **Summary** carries `started_at`, `ended_at`, `provider`.
- **`event.dispatch_id`** present on emitted event rows; dispatch forensic fields present.
- **Emit-path validation:** a valid event round-trips; an intentionally malformed event is still emitted **and** writes a stderr diagnostic — the sink does **not** throw (guards the exit-70 footgun). A separate producer-level test asserts real emitted events pass strict `.parse`.
- **Missing-run invariant (D9):** building a summary / flushing with no `run` row throws a clear, identifiable error (not a null `run_id` on the wire).
- **Pre-upgrade resume (D10):** resuming a DB with no `run` table creates it and emits a fresh `run_id` with `resumed=1` rather than crashing.
- The **STYRE-1 re-emit** acceptance check (ENG-339): re-emitted, cost is `null`, not `$0`.
- Existing suite green (`bun test`, `bun run lint`).

---

## 5. Scope boundaries (out)

- Making codex report cost — it exposes none; not our defect (ENG-339 OUT).
- The `metric_event` writer carry — tracked separately.
- Terminal/human output — ENG-338 (`formatRunSummary` is deliberately text-only).
- The wait-budget bug — ENG-337.
- Building plane-side ingest (styre-cloud) — producer-side only (ENG-349 OUT).
- Restructuring the park path to key by `run_id` (independently-recoverable same-ticket parks) — a resume-semantics change; a **separate** ticket if ever wanted. Latest-wins stays.

---

## 6. Acceptance criteria (both tickets)

**ENG-339**
- [ ] A run where no dispatch reports cost does **not** emit `"cost_usd": 0`; unknown is representable and distinct from zero.
- [ ] The mixed case has a decided, documented, tested contract (floor-sum + per-field coverage).
- [ ] `duration_ms` populated on every completed dispatch row, matching `ended_at − started_at`.
- [ ] The `SCHEMA_VERSION` decision is explicit and recorded (bump to 2; open-core seam contract stated).
- [ ] `tokens_*` / `cache_*` get the same treatment — no silent `null→0`.
- [ ] Audit findings on the rest of the stream recorded (this doc + the wire spec; residual items filed).
- [ ] The STYRE-1 run, re-emitted, reports cost as unknown rather than `$0`.
- [ ] Existing suite green.

**ENG-349**
- [ ] Two runs of the same ticket emit distinguishable telemetry (`run_id` differs).
- [ ] `--resume` is attributable to the original run (same `run_id`, `resumed=1`).
- [ ] `SummaryEvent` carries a timestamp.
- [ ] `provider` present where cost/tokens are aggregated (summary) and per-dispatch.
- [ ] `ticket_id`'s scope (run-local, not a global key) documented in the wire spec.
- [ ] `event.dispatch_id` present on emitted event rows.
- [ ] A field-by-field wire spec exists in `docs/architecture/`, `SCHEMA_VERSION` decision recorded jointly.
- [ ] Existing suite green.

---

## 7. Independent review — resolutions

An independent code-grounded review (2026-07-21) verified the cost-truth half (ENG-339) sound and confirmed most factual claims (forensic columns exist, 16-table count, byte-identical schema copies, provider is run-level, codex-vs-claude field coverage, no consumer reads the soon-nullable aggregates). It raised three blocking issues, now resolved in the design above:

- **B1 — migration mechanism was misstated.** `migrate()` is replay-once (`migrate.ts:30-33`), so an existing/parked DB never gains the `run` table; the original "resume upserts a row" would throw `no such table: run`. **Resolved:** D10 + §3.1 — resume runs `CREATE TABLE IF NOT EXISTS run` and backfills a fresh id for pre-upgrade parks; general cross-upgrade park resume is documented as a pre-existing limitation, not something this work must solve.
- **B2 — emitter silently coupled to a `run` row the test substrate never creates.** `makeTestDb` seeds only project + ticket, so `getRun` would be null in existing tests. **Resolved:** D9 (missing-run is a thrown invariant, not a null wire field) + §4 test-substrate prerequisite (seed a `run` row; handle now-nullable aggregate assertions; seed `started_at` for the duration test).
- **B3 — emit-path `parse` throw was a success-path footgun.** A throw in `stdoutSink` propagates to `exit 70`, flipping a green run to a crash after all durable/external work. **Resolved:** D8 + §3.7 — validate with `safeParse`, warn to stderr, never throw on the live wire; strict `.parse` only in tests.

Non-blocking notes folded in: the park-dir warning tolerates a missing `run` table in a legacy dump (§3.8); central `duration_ms` verified correct (all completion sites pass `endedAt`, none pass `durationMs`, rows insert `started_at`).
