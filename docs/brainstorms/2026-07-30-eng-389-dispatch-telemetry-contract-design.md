# Dispatch telemetry: make the column contract enforceable — Design

**Date:** 2026-07-30
**Ticket:** [ENG-389](https://linear.app/twinning/issue/ENG-389)
**Status:** Approved (brainstorm). Next: implementation plan.
**Scope:** Close the two boundaries a `dispatch` field can die at — call-site → SoT, and SoT → wire —
so the nine dead columns are fixed *and* the mechanism that produced them stops working.

---

## 1. Goal

An NDJSON consumer cannot tell a `design:extract` dispatch from a `design:review` one, and nine of
`dispatch`'s thirty columns are never written by anything. Both facts share one cause. This design
fixes the instances and removes the conditions that let them exist.

### Non-goals

- **No change to `tokens_*` / `cost_usd` semantics.** [ENG-339](https://linear.app/twinning/issue/ENG-339)
  and [ENG-356](https://linear.app/twinning/issue/ENG-356) settled that codex's nulls are correct and
  deliberate. Reopening that is scope creep.
- **No per-dispatch transcript archival.** See §6 — `transcript_path` stays unwritten because
  populating it means building a feature, not passing an argument.
- **No `SCHEMA_VERSION` bump.** See §5.
- **No generalized reserved-field framework.** Two columns are reserved; two maps and a doc
  convention cover it. A framework can earn its way in at the sixth instance.

---

## 2. Root cause

Three facts, established from history rather than inferred:

1. **The columns predate every writer.** `git log -S"predecessor_dispatch_id" -- src/db/schema.sql`
   returns exactly one commit: `9981b75 feat(m0): styre migrate`. `kind`, `trigger`, `effort`,
   `exit_code`, and `predecessor_dispatch_id` have been in the schema since bootstrap with no writer
   ever authored. This is not drift; the schema was speculatively wider than the code from day one.

2. **The audit that should have caught them certified them instead.**
   `test/db/row-widen.test.ts` was created by `b3be1be` — ENG-339/ENG-349, the ticket scoped to
   "audit the NDJSON export ... dead columns." Its first test is named *"DispatchRow carries forensic
   fields (null when unset)"* and asserts `toHaveProperty` on four of the five, then pins
   `row.trigger` to `null`. The audit named these fields, widened the row type so they'd reach the
   wire, and encoded their emptiness as expected behavior. ENG-355 later flipped the `event_log` half
   of that same file and left the `dispatch` half standing.

3. **The reference doc overstates them, and the repo has a convention it didn't apply.**
   `telemetry-export.md:113-119` lists all five as ordinary nullable fields sourced from their
   columns — formatted identically to `model` and `outcome`, which are genuinely populated. Yet
   ENG-349 shipped `event.dispatch_id` documented as *"yes — reserved … currently always null"*, so
   an honest marker for this exact state exists and went unused.

**The mechanism:** a column can be born, typed, exported to a public wire, documented, and
unit-tested without anyone answering *"who writes this?"* — and every layer independently reports
success. `insertDispatch`'s params are all optional, so the compiler is satisfied. The row-widen test
asserts presence, so CI is satisfied. The doc table mirrors the column list, so the docs look
complete.

**Two boundaries, two failure modes.** The five die at call-site → SoT: never written. `step_key`
dies at SoT → wire: `step_id` *is* populated correctly on every row, but `toDispatch`
(`emitter.ts:63-100`) does not project it. One contract cannot catch both.

---

## 3. Inventory: 30 columns, 21 written, 9 dead

Ground truth: `PRAGMA table_info(dispatch)` against a live run DB (`styre run STYRE-7`,
`styre-events`, 2026-07-29), cross-referenced with the two writers.

| Category | Columns |
|---|---|
| **Written** (21) | `id`, `ticket_id`, `work_unit_id`, `step_id`, `dispatch_id`, `seq`, `stage`, `model`, `outcome`, `branch_head_sha`, `worktree_path`, `started_at`, `ended_at`, `duration_ms`, `tokens_in`, `tokens_out`, `cache_read`, `cache_create`, `cost_usd`, `partial`, `created_at` |
| **Modelled but unwritten** (5) | `kind`, `trigger`, `effort`, `exit_code`, `predecessor_dispatch_id` |
| **Unmodelled entirely** (4) | `exit_subcode`, `branch`, `transcript_path`, `envelope_json` |

The last four are absent from `DispatchRow` *and* from `COLS`, so nothing writes them and nothing
reads them. They are invisible above SQLite. **This is why the §4.3 completeness test must
interrogate the database rather than reflect over the TypeScript type** — a check written against
`DispatchRow` passes today while four columns sit outside it.

---

## 4. The change

### 4.1 Writer contract — the input type encodes combinations, not fields

Making the params required is insufficient: a caller satisfies it with `kind: null, trigger: null`
and nothing improves. `dispatch` has two shapes, and `work_unit_id`/`kind` are a pair — both null or
both set. A discriminated union makes the invalid shape unconstructible:

```ts
type DispatchScope =
  | { scope: "ticket-level" }
  | { scope: "work-unit"; workUnitId: number; kind: string };

type InsertDispatchInput = DispatchScope & {
  ticketId: number;
  dispatchId: string;
  seq: number;
  stepId: number;                            // was optional; always known at the call site
  handlerKey: string;                        // NEW column — the step discriminator (§4.4)
  stage: string;
  model: string;
  trigger: DispatchTrigger;                  // transition | retry | loopback | resume
  effort: Tier;                              // deep | standard | cheap
  predecessorDispatchId: string | NotApplicable;
  startedAt: string;
  worktreePath: string;
};
```

`kind` is not "required" — it is unreachable unless the dispatch has been declared work-unit-scoped,
at which point `workUnitId` arrives with it or it does not compile. The guarantee comes from the
union, not from required-ness.

`completeDispatch` receives the same treatment for `exitCode` and `branchHeadSha` only; usage/cost
params are untouched (§1 non-goals).

**`NotApplicable`** — a branded value carrying a reason, for absences that are legitimate:

```ts
const na = (reason: string): NotApplicable => ({ _na: reason });
// completeDispatch(db, id, { exitCode: na("agent timed out before exit"), ... })
```

It persists as SQL `NULL`; the reason lives in source, not schema, so no column is added. Its job is
to make honest absence cost more keystrokes than lazy absence, and to be greppable — `grep -rn "na("
src/` enumerates every declared absence, which is the audit ENG-339 performed by hand.

**Consequence:** `stepId` becoming required breaks loose constructions like
`insertDispatch(db, { ticketId, dispatchId, seq })` (`row-widen.test.ts:9`). Those move to a
`makeDispatch()` fixture helper with defaults, so tests stay terse without the production writer
being permissive.

### 4.2 SoT constraints — domain rules only

```sql
-- dispatch, schema_meta v9
handler_key TEXT NOT NULL,
CHECK ((work_unit_id IS NULL) = (kind IS NULL)),
CHECK (trigger IS NULL OR trigger IN ('transition','retry','loopback','resume')),
CHECK (effort  IS NULL OR effort  IN ('deep','standard','cheap')),
CHECK (stage   IS NULL OR stage   IN ('design','implement','verify','review','merge','released'))
```

The `stage` CHECK mirrors `ticket.stage`'s existing constraint (`schema.sql:97`) — it is a snapshot of
that column, so it takes the same six values even though only three are reachable on a dispatch row
(§4.5). Constraining it to the reachable three would break the day a new stage dispatches.

Verified against SQLite: the paired CHECK accepts `(NULL, NULL)` and `(1, 'php')` and rejects
`(1, NULL)` and `(NULL, 'php')`.

The line drawn here matters. **Closed vocabularies and pairings are real domain rules and belong in
the SoT** — they constrain the value space, and `event_log.kind` already sets this precedent.
**Nullability of `trigger`/`effort` stays TypeScript-enforced**: a `NOT NULL` there only relocates
laziness to writing `'unknown'`, whereas the union and `na()` can express intent. `handler_key` takes
`NOT NULL` because no dispatch can legitimately lack a handler — `resolveTier` throws without one,
and non-agent steps never dispatch.

**No migration to write.** `migrate()` (`src/db/migrate.ts:26`) is create-only: given an existing
`schema_meta` version it returns immediately and never alters. Runs use ephemeral per-run SQLite, so
the constraints apply from the first run after this ships. Checkpoints resumed with `--resume` keep
their v8 schema and simply do not enforce the CHECKs — the TypeScript writer still populates
correctly. That is existing migrate behavior, not something introduced here.

### 4.3 Projection contract — ask the database, not the type

```ts
// test/telemetry/dispatch-projection.test.ts
const EXCLUDED: Record<string, string> = {
  id:            "run-local rowid; dispatch_id is the portable wire identity",
  step_id:       "run-local FK; handler_key is its portable projection",
  worktree_path: "operator filesystem path — must not leak into telemetry",
  created_at:    "row bookkeeping; started_at/ended_at are the meaningful times",
  partial:       "internal SIGTERM bookkeeping; outcome carries the wire meaning",
};

const RESERVED: Record<string, string> = {
  envelope_json:   "reserved — no writer; retained by decision, see §6",
  transcript_path: "reserved — needs per-dispatch transcript archival first, see §6",
};

test("every dispatch column is projected, excluded, or reserved", () => {
  const { db } = makeTestDb();
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(dispatch)")
                 .all().map((c) => c.name);
  const wire = new Set(Object.keys(DispatchEventSchema.shape));
  expect(cols.filter((c) => !wire.has(c) && !(c in EXCLUDED) && !(c in RESERVED))).toEqual([]);
});
```

`EXCLUDED` and `RESERVED` are deliberately separate: *internal by nature, never going on the wire*
versus *no writer yet, revisit*. Collapsing them would hide the second category, which is the one
that produced this ticket.

The check runs one direction only — the wire legitimately carries fields with no column
(`schema_version`, `type`, `run_id`, `provider`, `cost_usd_estimated`), and the compatibility policy
(§6 of `telemetry-export.md`) requires consumers to tolerate extras.

Requires exporting the member schemas from `events.ts`; today only `TelemetryEventSchema` is
exported. Zod's `.shape` supplies field names at runtime, which the erased TS interface cannot.

### 4.4 Field-by-field resolution

| Field | Resolution |
|---|---|
| `handler_key` | **New column + wire field.** `spec.handlerKey`, already in hand at `run-dispatch.ts` for `resolveTier`/`allowlistFor`. Values: `design:dispatch`, `design:extract`, `design:review`, `checks:dispatch`, `implement:dispatch`, … |
| `step_key` | **Not added to the wire.** `handler_key` + `work_unit_id` reconstructs it losslessly (`implement:wu1:dispatch` ⇒ `implement:dispatch` + unit 1) without the unbounded cardinality. |
| `kind` | From the work unit via the scope union; NULL only for ticket-level, enforced by CHECK. |
| `trigger` | Derived at `run-dispatch.ts`, precedence: `resume` (`deps.resumeContext.stepKey === ctx.step.step_key`) → `retry` (`ctx.step.attempt > 0`) → `loopback` (`spec.loopback`) → `transition`. |
| `effort` | Carries the capability **tier** (`deep`/`standard`/`cheap`), computed at `run-dispatch.ts:141` and currently discarded. Column keeps its name for wire stability; the schema comment is corrected to say what it holds. Provider reasoning-effort, if ever configured, gets its own column then. |
| `exit_code` | `result.exitCode` at `completeDispatch`; `na("agent timed out before exit")` where the runner never completed — `runner.ts:16` types it nullable for exactly that case. |
| `predecessor_dispatch_id` | `getLatestForTicket` before insert; `na("first dispatch of the ticket")` at `seq === 1`. |
| `stage` | **Kept on the wire as a decoupling convenience, not as information.** It is fully derivable from `handler_key` (§4.5) and carries nothing that field doesn't. It stays so consumers computing spend-by-phase need not embed styre's internal handler taxonomy — a mapping that would break silently on any handler rename. Gains an enum CHECK (§4.2); the docs must stop implying it identifies a step. |

**Vocabulary change:** `trigger`'s schema comment lists `'transition'/'retry'/'escalation'/'resume'`.
`escalation` is vestigial — escalations route to needs-you and park; they do not dispatch — and the
comment predates the Loopback Atlas. Replaced with `loopback`, which is the case that actually occurs
and is already available as `spec.loopback`.

### 4.5 Why `stage` is redundant, and why it stays anyway

`ticket.stage` is a six-value enum, but **only three are reachable on a dispatch row**. `verify`,
`merge`, and `released` produce no agent dispatches at all — their steps are `step_type`
`verify`/`project`/`completeness` and never reach `runAgentDispatch`, so no dispatch row is created.

Mapping every dispatching handler against the resolver's `switch` (`resolver.ts:97,127,227`):

| handler_key | stage |
|---|---|
| `design:dispatch`, `design:extract`, `design:size`, `design:review`, `checks:dispatch`, `checks:classify` | `design` |
| `implement:dispatch`, `checks:arbitrate`, `checks:reauthor`, `docs:revise` | `implement` |
| `review` | `review` |

`handler_key → stage` is a **total function**. No handler dispatches under two ticket stages, and none
can: `ticket.stage` is what selects the `case` block that returns the step. Loopbacks preserve this —
a redesign loopback resets `ticket.stage` to `design` *and* re-enters the design case, so the pair
stays consistent. Once `handler_key` ships, `stage` adds no information.

**It is kept regardless.** Removing it would force every consumer to embed styre's handler taxonomy
to answer "cost by phase", coupling the plane to step-level naming that is free to churn. And
removing a wire field is a breaking change under `telemetry-export.md` §6, costing a
`SCHEMA_VERSION` 2 → 3 bump on the open-core seam — a steep price for deleting a redundant short
string from a design that is otherwise purely additive (§5).

The observation that every sampled STYRE-7 row read `design` is a property of that run (it never left
the design stage), not of the field. That framing should not survive into the docs.

---

## 5. Wire and versions

Two version numbers, and only one moves:

- **`schema_meta.version` (SQLite SoT): 8 → 9.** New column, new CHECKs, two columns dropped.
- **`SCHEMA_VERSION` (NDJSON wire): stays 2.** Per `telemetry-export.md` §6 only a *breaking* change
  requires a bump, and consumers are required to tolerate unknown extra fields. Adding `handler_key`
  is additive; populating fields already typed nullable is within contract — the same reasoning
  ENG-355 applied when it populated `event.dispatch_id` without a bump. Dropping `branch` and
  `exit_subcode` does not touch the wire, since neither was ever projected.

---

## 6. The four unmodelled columns

| Column | Decision | Rationale |
|---|---|---|
| `branch` | **Delete** | Redundant with the run's branch; no writer, reader, test, or doc reference. |
| `exit_subcode` | **Delete** | `subcode` appears nowhere in `src/`, `test/`, or `docs/`. ENG-384 shipped the exit-code taxonomy as `EXIT` constants + `errorKindForExit` with no subcode concept. |
| `transcript_path` | **Retain, marked reserved** | Transcripts are not written per dispatch. The only one persisted is on park — `park.ts:131` writes a single `transcript.json` per checkpoint dir, overwritten each time. Populating this means building per-dispatch transcript archival, with disk, retention, and secret-content implications. That is a separate ticket. |
| `envelope_json` | **Retain, marked reserved** | Retained by operator decision. Recorded honestly: it has **no writer and no consumer anywhere**. Every `envelope` reference in the codebase is the provider CLI's JSON output envelope that `claude.ts:48,134` unwraps in memory — `runner.ts:18` states outright that `stdout` is "NOT a provider envelope." No test or design doc mentions this column. |

Retained columns appear in `RESERVED` (§4.3) and are marked in the docs table the way ENG-349 marked
`event.dispatch_id` — so the state is visible in three places rather than inferable from none.

---

## 7. Docs

`docs/architecture/telemetry-export.md`:

- **§3.2 dispatch field table** — add `handler_key`; rewrite `stage`'s description to *"a denormalized
  snapshot of the ticket's stage, derivable from `handler_key`, carried so consumers need not embed
  the handler taxonomy — not a step identifier"*; mark nothing else reserved (the two reserved
  columns are SoT-only and never appear in this table).
- **§6** — record that the SoT went to v9 while the wire stayed v2, with the reasoning.

`docs/architecture/schema.sql` is a byte-identical copy of `src/db/schema.sql` (CLAUDE.md) — both
edited in the same PR.

---

## 8. Testing (TDD)

- **Invert `row-widen.test.ts`.** Its dispatch test currently asserts shape and pins `trigger` to
  null. It becomes: a completed dispatch, inserted through the real path, has no modelled column null
  unless the call site passed `na(...)`. This is the test that would have caught all five.
- **Projection completeness** (§4.3) — fails today on the four unmodelled columns.
- **Scope union negative cases** — type-level tests that a work-unit dispatch without `kind`, and a
  ticket-level dispatch with one, do not compile.
- **CHECK constraint coverage** — the `work_unit_id`/`kind` pairing accepts both legal shapes and
  rejects both illegal ones; the `trigger`/`effort`/`stage` enums reject an out-of-vocabulary value.
- **`trigger` precedence** — one case per branch (resume / retry / loopback / transition).
- **End-to-end** — assert `handler_key` on emitted dispatch events distinguishes `design:extract`
  from `design:review` in an existing e2e run.
- **Existing suite green** (final AC).

---

## 9. Acceptance criteria

- [ ] A consumer distinguishes `design:extract` / `design:review` / `checks:dispatch` from the NDJSON
      stream alone, with no access to `run.db`
- [ ] `kind` populated on every work-unit-scoped dispatch, NULL for ticket-level, CHECK-enforced
- [ ] `trigger`, `effort`, `exit_code`, `predecessor_dispatch_id` populated on every completed
      dispatch, or carrying an `na()` reason at the call site
- [ ] A work-unit dispatch without `kind` does not compile
- [ ] `branch` and `exit_subcode` dropped; `transcript_path` and `envelope_json` marked reserved in
      `RESERVED` and the docs
- [ ] The projection test fails if a new column is added and neither projected nor excused
- [ ] `stage` retained, CHECK-constrained, and documented as a derived denormalization of
      `handler_key` — explicitly not a step identifier
- [ ] SoT at `schema_meta` v9; wire stays `SCHEMA_VERSION` 2, with the reasoning recorded
- [ ] `bun run lint` + `bun test` green

---

## 10. Decisions

1. **Union-typed input over required params.** Required-ness admits `kind: null`; the union makes the
   invalid combination unconstructible. Rejected: required params with `| null`.
2. **`na()` token over bare `null`.** Legitimate absence must stay expressible (codex cost, timeout
   exit codes) but must not be indistinguishable from oversight in a diff.
3. **CHECK for vocabularies and pairings; TypeScript for nullability.** SQL cannot tell "considered"
   from "considered lazily" — `NOT NULL` on `trigger` relocates the problem to `'unknown'`.
4. **PRAGMA-based completeness over type reflection.** The TS type is itself incomplete by four
   columns; reflecting over it would pass while the bug persists.
5. **`handler_key` over `step_key` on the wire.** Stable low-cardinality class; `work_unit_id`
   supplies the instance.
6. **Retain two reserved columns rather than delete all four.** Operator decision on
   `envelope_json`; `transcript_path` blocked on a feature. Both explicitly marked, because an
   unmarked reserved column is precisely this ticket.
7. **Keep `stage` on the wire despite it being fully derivable from `handler_key`** (§4.5).
   Redundant-in-information is not the same as useless: it decouples consumers from styre's internal
   step naming, and deleting it would spend a `SCHEMA_VERSION` 2 → 3 breaking bump on an otherwise
   additive change. Rejected: dropping the field; keeping it undocumented as-is.
