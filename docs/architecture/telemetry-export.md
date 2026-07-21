# Telemetry Export — Wire Spec (SCHEMA_VERSION 2)

> **OSS core. Versioned public API of the open-core seam.** This is the field-by-field spec for
> the structured event stream `styre run` writes to stdout — one of the three stable contracts the
> commercial Control Plane integrates through (build-operations.md §5 item 3). It is **kept current
> with the code**: the source of truth is the zod schema in
> [`src/telemetry/events.ts`](../../src/telemetry/events.ts) (`SCHEMA_VERSION`), and any change to
> that schema must update this doc in the same PR (per [`README.md`](README.md), the docs-freshness
> convention). Do not hand-edit a field here without checking `events.ts` first.

---

## 1. Wire form

- **NDJSON to stdout** — one JSON object per line, one line per emitted row. Container-native (the
  orchestrator's log pipeline ingests it); no separate transport.
- **Every object carries `schema_version` and `type`.** `type` discriminates the five event shapes
  (§3); a consumer switches on it before reading the rest of the fields. `schema_version` is
  currently `2` — bump only on a breaking change to this stream (see `SCHEMA_VERSION` in
  `events.ts`).
- **Best-effort, non-fatal.** `stdoutSink` (`src/telemetry/emit.ts`) validates each event against
  the zod schema before writing; a validation failure is logged to **stderr** (never stdout) and
  the event is written anyway. A schema-drift bug must never flip an otherwise-successful run into
  a crash.
- **Idempotent under resume.** `event`/`dispatch`/`signal` rows are derived from the durable SQLite
  SoT and streamed by watermark (`src/telemetry/emitter.ts`), so a re-spawned/resumed worker never
  re-emits rows already flushed in a prior attempt of the same run. `summary` and `ci_handoff` are
  each emitted once, at their respective terminal points.
- **Five event types:** `event`, `dispatch`, `signal`, `summary`, `ci_handoff` — one zod object
  each, joined into `TelemetryEventSchema` as a `discriminatedUnion` on `type`.

## 2. Two identifiers — do not confuse them

### `run_id` — the cross-run join key

- **Opaque UUIDv4** (`randomUUID()`), minted fresh once per `styre run` invocation and inserted into
  the single `run` row for that ephemeral DB (`src/db/repos/run.ts`, `src/cli/run.ts`).
- **Stable across every row a run emits** — every `event`/`dispatch`/`signal`/`summary`/`ci_handoff`
  object carries the same `run_id` for the lifetime of that run (`runCtx()` reads the one `run` row
  once and reuses it).
- **Stable across `--resume`.** A parked-then-resumed run keeps its original `run_id` — resuming
  does **not** mint a new one. What changes on resume is the `run` row's own bookkeeping columns,
  not the identifier: `markResumed()` sets `resumed = 1` and increments `attempt`. (These two
  columns live on the `run` table, not on the telemetry wire events themselves — a consumer that
  needs "was this run resumed" reads the SQLite `run` row, not the stream. The one pre-v2-park edge
  case — a DB parked before the `run` table existed — assigns a fresh `run_id` for the resumed
  portion, since no identity was ever minted to preserve; this is a one-time bridge, not the steady
  state.)
- **Per-ephemeral-DB identity: reusing the same non-ephemeral `--db` path across separate (non-resume) `styre run` invocations reuses the first invocation's `run_id` (with `resumed` still 0).** Same `--db` = same run identity; different invocation without `--resume` = different run (new DB).
- **This is the field to join across runs on.** If you need "every row belonging to this
  invocation of `styre run`, across a resume," group by `run_id`.

### `ticket_id` — run-local only, NOT a cross-run key

- `ticket_id` is the SQLite `ticket.id` — an **`INTEGER PRIMARY KEY` rowid** in the run's own
  **ephemeral** per-run database (`schema.sql`). It is assigned when the row is inserted in *this*
  run's DB and has no meaning outside it.
- It is **not** stable across runs, resumes, or machines: a different run against the same Linear
  ticket gets a fresh ephemeral DB and a different `ticket.id`. Two rows with the same `ticket_id`
  from two different `run_id`s are **coincidence, not the same ticket**.
- The human-readable, stable identifier for "which ticket" is `ident` (e.g. `"ENG-5"`), carried on
  `summary` and `ci_handoff`. **To join telemetry across runs, group by `run_id` (per invocation)
  and/or `ident` (per ticket); never by `ticket_id` alone.**

## 3. Event types, field by field

Field tables below mirror the zod objects in `events.ts` exactly (name / type / nullable? /
source). "Source" is the durable row or computation each field is read from
(`src/telemetry/emitter.ts`).

### 3.1 `event` — the per-ticket timeline (`event_log` row)

One row per ticket-lifecycle happening: stage transition, loopback, escalation, resume, or a free
note (`EventKind` in `src/db/repos/event-log.ts`: `transition | loopback | escalated | resumed |
note | parked`).

| Field | Type | Nullable | Source |
|---|---|---|---|
| `schema_version` | `2` (literal) | no | constant |
| `type` | `"event"` (literal) | no | constant |
| `run_id` | string | no | the run row (§2) |
| `ticket_id` | number | no | `event_log.ticket_id` (run-local, §2) |
| `dispatch_id` | string \| null | **yes — reserved** | `event_log.dispatch_id`; see §5, currently always `null` |
| `seq` | number | no | `event_log.seq` — monotonic per-ticket sequence, also the streaming watermark |
| `kind` | string | no | `event_log.kind` (`transition`/`loopback`/`escalated`/`resumed`/`note`/`parked`) |
| `actor` | string \| null | yes | `event_log.actor` (defaults to `"runner"` when unspecified at write time) |
| `from_stage` | string \| null | yes | `event_log.from_stage` |
| `to_stage` | string \| null | yes | `event_log.to_stage` |
| `loop` | string \| null | yes | `event_log.loop` — which Loopback Atlas route fired, if any |
| `route_to` | string \| null | yes | `event_log.route_to` |
| `signature` | string \| null | yes | `event_log.signature` |
| `reason` | string \| null | yes | `event_log.reason` — free-text (e.g. an escalation reason) |
| `payload_json` | string \| null | yes, and optional (key may be absent) | `event_log.payload_json` — opaque JSON blob, kind-specific shape |
| `created_at` | string | no | `event_log.created_at` (UTC timestamp string) |

### 3.2 `dispatch` — one completed agent invocation (`dispatch` row)

One row per completed dispatch (an agent call that started and ended within this run). A dispatch
still in flight (no `ended_at`) is never emitted — only completed rows cross the wire.

| Field | Type | Nullable | Source |
|---|---|---|---|
| `schema_version` | `2` (literal) | no | constant |
| `type` | `"dispatch"` (literal) | no | constant |
| `run_id` | string | no | the run row (§2) |
| `dispatch_id` | string | no | `dispatch.dispatch_id` — the idempotency-key token (e.g. `ENG-5-d0003-push`) |
| `ticket_id` | number | no | `dispatch.ticket_id` (run-local, §2) |
| `work_unit_id` | number \| null | yes | `dispatch.work_unit_id` |
| `seq` | number | no | `dispatch.seq` — per-ticket dispatch sequence |
| `stage` | string \| null | yes | `dispatch.stage` |
| `kind` | string \| null | yes | `dispatch.kind` |
| `model` | string \| null | yes | `dispatch.model` |
| `provider` | string | no | the run row's `provider` (constant for the whole run — e.g. `"claude"`/`"codex"`), not a per-dispatch column |
| `trigger` | string \| null | yes | `dispatch.trigger` |
| `effort` | string \| null | yes | `dispatch.effort` |
| `exit_code` | number \| null | yes | `dispatch.exit_code` |
| `predecessor_dispatch_id` | string \| null | yes | `dispatch.predecessor_dispatch_id` |
| `outcome` | string \| null | yes | `dispatch.outcome` |
| `branch_head_sha` | string \| null | yes | `dispatch.branch_head_sha` |
| `started_at` | string \| null | yes | `dispatch.started_at` |
| `ended_at` | string \| null | yes | `dispatch.ended_at` — non-null is what gates emission (see above) |
| `duration_ms` | number \| null | yes | `dispatch.duration_ms` (computed at the single writer from `ended_at - started_at` when not passed explicitly) |
| `tokens_in` | number \| null | yes | `dispatch.tokens_in` — see §4 for why this can be null |
| `tokens_out` | number \| null | yes | `dispatch.tokens_out` |
| `cache_read` | number \| null | yes | `dispatch.cache_read` |
| `cache_create` | number \| null | yes | `dispatch.cache_create` |
| `cost_usd` | number \| null | yes | `dispatch.cost_usd` |

### 3.3 `signal` — a ground-truth verdict (`ground_truth_signal` row)

One row per objective verdict (build/test/lint/AC-check/integration result — never an agent's
self-report).

| Field | Type | Nullable | Source |
|---|---|---|---|
| `schema_version` | `2` (literal) | no | constant |
| `type` | `"signal"` (literal) | no | constant |
| `run_id` | string | no | the run row (§2) |
| `id` | number | no | `ground_truth_signal.id` (SQLite rowid; the streaming watermark for this type) |
| `ticket_id` | number | no | `ground_truth_signal.ticket_id` (run-local, §2) |
| `work_unit_id` | number \| null | yes | `ground_truth_signal.work_unit_id` |
| `signal_type` | string | no | `ground_truth_signal.signal_type` (open vocabulary — e.g. `ac-check-gate`, `integration`, a checkType) |
| `result` | string | no | `ground_truth_signal.result` (`pass`/`fail`/`error`) |
| `command` | string \| null | yes | `ground_truth_signal.command` |
| `branch_head_sha` | string \| null | yes | `ground_truth_signal.branch_head_sha` |
| `measured_at` | string | no | `ground_truth_signal.measured_at` |

Note: `ground_truth_signal.detail_json` (the parsed per-signal-type detail blob — RED-first output,
blame, re-author disposition, etc., see `src/db/repos/ground-truth-signal.ts`) is **not** part of
this wire event. It is an internal SoT column the runner's own control flow reads; it is not
projected onto the telemetry stream.

### 3.4 `summary` — the per-ticket terminal rollup, emitted once on exit

Computed by `buildSummary()` (`src/telemetry/emitter.ts`) from the durable SoT at the moment the
ticket finishes (or the run otherwise exits). The plane aggregates these across runs into the §5.3
dashboard rates (autonomous-fix ratio, first-time CI pass rate, unit cost per ticket).

| Field | Type | Nullable | Source |
|---|---|---|---|
| `schema_version` | `2` (literal) | no | constant |
| `type` | `"summary"` (literal) | no | constant |
| `run_id` | string | no | the run row (§2) |
| `ticket_id` | number | no | run-local (§2) |
| `ident` | string | no | `ticket.ident` (falls back to `""` if the ticket row is somehow missing) |
| `provider` | string | no | the run row's `provider` |
| `started_at` | string | no | the run row's `started_at` |
| `ended_at` | string | no | `nowUtc()` at summary-build time |
| `outcome` | string | no | the run result's `outcome` |
| `stage` | string | no | the run result's `stage` |
| `status` | string | no | the run result's `status` |
| `ticks` | number | no | the run result's `iterations` |
| `cost_usd` | number \| null | yes | floor-sum of dispatch `cost_usd` — see §4 |
| `tokens_in` | number \| null | yes | floor-sum of dispatch `tokens_in` — see §4 |
| `tokens_out` | number \| null | yes | floor-sum of dispatch `tokens_out` — see §4 |
| `cache_read` | number \| null | yes | floor-sum of dispatch `cache_read` — see §4 |
| `cache_create` | number \| null | yes | floor-sum of dispatch `cache_create` — see §4 |
| `usage_coverage` | object (below) | no | computed alongside the aggregates — see §4 |
| `usage_coverage.dispatch_count` | number | no | count of dispatch rows for this ticket |
| `usage_coverage.cost_usd` | number | no | count of those dispatches that reported a non-null `cost_usd` |
| `usage_coverage.tokens_in` | number | no | count reporting non-null `tokens_in` |
| `usage_coverage.tokens_out` | number | no | count reporting non-null `tokens_out` |
| `usage_coverage.cache_read` | number | no | count reporting non-null `cache_read` |
| `usage_coverage.cache_create` | number | no | count reporting non-null `cache_create` |
| `dispatch_count` | number | no | same value as `usage_coverage.dispatch_count`, top-level for convenience |
| `dispatch_outcomes` | `Record<string, number>` | no | count of dispatches per non-null `outcome` value |
| `cycle_count` | number | no | count of this ticket's `event` rows with `kind === "loopback"` |
| `escalation_count` | number | no | count of this ticket's `event` rows with `kind === "escalated"` |
| `escalation_reasons` | `string[]` | no | the `reason` of each escalated event (nulls filtered out) |

### 3.5 `ci_handoff` — a one-shot best-effort CI read at PR-open

**CI is reported, never gated.** This is a single best-effort t+0 read of remote CI state, handed
off to whoever owns the outer loop (the plane, or a human on GitHub) — never awaited, never re-read,
never a control-flow signal (§3.3's `signal` rows are the only ground truth the loop acts on).

| Field | Type | Nullable | Source |
|---|---|---|---|
| `schema_version` | `2` (literal) | no | constant |
| `type` | `"ci_handoff"` (literal) | no | constant |
| `run_id` | string | no | the run row (§2) |
| `ticket_id` | number | no | run-local (§2) |
| `ident` | string | no | `ticket.ident` (falls back to `""`) |
| `pr_ref` | string \| null | yes | caller-supplied at handoff time |
| `pr_url` | string \| null | yes | caller-supplied at handoff time |
| `branch_head_sha` | string \| null | yes | caller-supplied at handoff time |
| `checks_system` | string | no | caller-supplied (e.g. `"github-actions"`) |
| `read` | enum: `passing \| failing \| pending \| not-reported \| skipped` | no | caller-supplied |
| `measured_at` | string | no | `nowUtc()` at handoff time |

## 4. The cost / aggregate contract

Applies to the five aggregate fields on `summary`: `cost_usd`, `tokens_in`, `tokens_out`,
`cache_read`, `cache_create`.

- **Per field, independently: `null` iff zero dispatches for this ticket reported that field;
  otherwise the floor-sum of every dispatch that *did* report it.** ("Reported" = the dispatch's
  value for that field is non-null.) Concretely (`aggregate()` in `emitter.ts`): filter the ticket's
  dispatches to those with a non-null value for the field, sum them; if the filtered set is empty
  the aggregate is `null`, never `0`. A `0` therefore means "reported as zero," not "unknown."
- **This is a lower bound when coverage is partial.** If some dispatches reported the field and
  others didn't, the aggregate is the sum of only the ones that did — dispatches that didn't report
  are silently excluded from the sum, not treated as zero. `usage_coverage` is what tells a consumer
  whether that happened.
- **`usage_coverage` carries the per-field reported counts plus `dispatch_count`** (the ticket's
  total dispatch count). **A consumer's read:** for a given field `f`, `usage_coverage.f <
  usage_coverage.dispatch_count` means not every dispatch reported `f`, so `summary.f` is a lower
  bound, not a total. `usage_coverage.f === usage_coverage.dispatch_count` means every dispatch
  reported it — the aggregate is complete.
- **`provider` explains systematic (not random) gaps.** The `codex` provider adapter
  (`src/agent/providers/codex.ts`) never reports `cost_usd` or `cache_create` — its usage stream has
  no USD-cost field and no cache-write metric, so every `codex` dispatch has `cost_usd: null` and
  `cache_create: null` by construction, and a ticket run entirely on `codex` will show
  `usage_coverage.cost_usd === 0` and `usage_coverage.cache_create === 0` even though every dispatch
  "succeeded" — that's an expected, provider-level gap, not partial data. `tokens_in`/`tokens_out`/
  `cache_read` are reported by `codex` when its usage stream includes them.

## 5. `dispatch_id` on `event` rows is reserved

`event.dispatch_id` (§3.1) is part of the wire schema and is emitted on every `event` row today, but
its value is **currently always `null`** — nothing yet populates `event_log.dispatch_id` at write
time. It exists so that a future change (linking a lifecycle event to the dispatch that caused it)
does not require a schema-version bump; that population is deferred to a follow-up ticket. **Do not
treat a non-null value here as reachable today; do not build a consumer that assumes it's ever
present in v2.**

## 6. Compatibility

- **This is schema v2 of the wire stream** (`SCHEMA_VERSION = 2` in `events.ts`). Every event on the
  wire carries its own `schema_version`, so a consumer can detect a version bump per-line rather than
  assuming a whole stream is homogeneous.
- **Validation is non-fatal by design (§1).** A `stdoutSink` schema-validation failure is a stderr
  diagnostic, not a thrown error — the wire contract favors "the run finishes and telemetry is
  best-effort" over "a telemetry bug crashes the run." Consumers should be tolerant of unknown extra
  fields and should not hard-fail a whole run's ingestion on one malformed line.
- **Changing this schema is an open-core seam change.** Per build-operations.md §5, the plane
  integrates with the core *only* through these contracts — a breaking change here needs a
  `SCHEMA_VERSION` bump and an update to this doc in the same PR.
