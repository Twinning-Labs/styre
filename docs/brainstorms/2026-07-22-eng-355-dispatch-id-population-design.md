# Populate `event_log.dispatch_id` — the reserved join key — Design

**Date:** 2026-07-22
**Ticket:** [ENG-355](https://linear.app/twinning/issue/ENG-355)
**Status:** Approved (brainstorm). Next: implementation plan.
**Scope:** Make `event_log.dispatch_id` carry a real value for `loopback` and `escalated`
events, so an NDJSON consumer can join those events to the dispatch that caused them. Producer-side
only; no wire-shape change.

---

## 1. Goal

`event.dispatch_id` already exists on the v2 telemetry wire — [ENG-349](https://linear.app/twinning/issue/ENG-349)
shipped it as a **reserved** field (emitted on every `event` row, always `null`). Its purpose
(ENG-349 §7): a consumer **cannot join a `loopback`/`escalated` event to the dispatch that caused
it** without it. This ticket makes the field carry a real value.

Because the field already exists on the wire (shipped in the `SCHEMA_VERSION 1→2` bump), populating
it is a **non-breaking change** — no further `SCHEMA_VERSION` bump, no consumer contract change.

### Non-goals

- **No new wire fields, no `SCHEMA_VERSION` bump.** The field exists; we only supply its value.
- **No emitter change.** `toEvent` (`emitter.ts:47`) already passes `r.dispatch_id` straight
  through; the moment the column is populated it flows to the wire.
- **No change to the runner-writes-SoT / dispatch-creation path.** See §5 (the re-derivation
  decision) — we deliberately keep this change off the invariant-heavy runner surface.
- **`parked` stays out of scope.** The ticket scopes to `loopback`/`escalated`. `parked` already
  stashes its dispatch id in `payload.dispatchId` (`advance.ts:171`); we do not opportunistically
  fill its column here.

---

## 2. The two facts that shape the change

1. **`appendEvent` cannot write the column today.** `appendEvent` (`src/db/repos/event-log.ts:52`)
   has no `dispatchId` param, and `dispatch_id` is absent from its `INSERT` column list
   (`:69-71`). Every `event_log` row is therefore inserted with `dispatch_id` defaulting to SQL
   `NULL`. `EventLogRow` (`:7-22`) already carries `dispatch_id: string | null` and `COLS` already
   selects it, so **reads already round-trip the column** — only the write drops it.
2. **The column is a bare `TEXT`** (`schema.sql:287`, `src/db/schema.sql`), no `REFERENCES`
   foreign key. Population is a plain string write of the dispatch token (e.g. `ENG-5-d0003`).

The emit path is already complete downstream of the column: `toEvent` maps `dispatch_id: r.dispatch_id`
(`emitter.ts:47`), and `EventEvent.dispatch_id` is `z.string().nullable()` (`events.ts:13`).

---

## 3. The change

### 3.1 Widen the writer — `src/db/repos/event-log.ts`

- Add `dispatchId?: string` to `appendEvent`'s param object.
- Add `dispatch_id` to the `INSERT` column list and bind `$did: e.dispatchId ?? null`.

This is the only change that makes the column writable; every other change below supplies the value.

### 3.2 Promote the lookup — `src/db/repos/dispatch.ts`

Move `latestDispatchForStep(db, ticketId, stepKey)` from `review-finding.ts:105` into `dispatch.ts`
(its natural home), updating the one existing `review-finding` caller. This keeps the daemon from
importing a dispatch lookup out of the review-finding module. The query is:

```sql
SELECT d.dispatch_id FROM dispatch d
  JOIN workflow_step w ON d.step_id = w.id
 WHERE d.ticket_id = ? AND w.step_key = ?
 ORDER BY d.seq DESC LIMIT 1
```

It filters on `step_key` only (not `branch_head_sha`), so it correctly recovers read-only dispatches
(e.g. arbiter) that have no branch head — which is why it is preferred over the coarser
`getLatestForTicket` for this purpose.

### 3.3 Thread the id — 5 sites, each derives once from its `stepKey`

Every in-scope verdict runs in `advance.ts`'s `onSucceed` hook keyed to a `stepKey` (or, for
failure-policy, holds the failed `step.step_key`), and every dispatch row stamps its `step_id`. So
each entrypoint recovers the causing dispatch with a single `latestDispatchForStep` call and threads
it into its emit helpers.

| Entrypoint | Derivation | Threads into |
|---|---|---|
| `review-verdict.ts` | **already computed** (`:187`) | `escalate`, `codeLoopback`, `redesignLoopback` |
| `checks-verdict.ts` | `latestDispatchForStep(db, t, "checks:classify")` | inline `escalated`/`loopback` appendEvents |
| `checks-gate-verdict.ts` | `latestDispatchForStep(db, t, "verify:checks-gate")` | `escalate`, `gateOriginLoopback` (both exported — add param) |
| `arbiter-verdict.ts` | `latestDispatchForStep(db, t, stepKey)` | inline emits + its `gateOriginLoopback` calls |
| `failure-policy.ts` | `latestDispatchForStep(db, t, step.step_key)` | inline `escalated`/`loopback` emits |

Shared helpers gain a `dispatchId` param:

- `escalate(db, ticketId, reason, signature)` — exported from `checks-gate-verdict.ts:34`. Callers:
  `checks-gate-verdict.ts:113,124` and `advance.ts:94` (the resolver's `escalate` descriptor —
  derives from `"verify:checks-gate"`).
- `gateOriginLoopback(...)` — exported from `checks-gate-verdict.ts:54`. Callers:
  `checks-gate-verdict.ts:131`, `arbiter-verdict.ts:100,175`.
- `escalate`, `codeLoopback`, `redesignLoopback` — local to `review-verdict.ts` (`:66,:74,:125`);
  `applyReviewVerdict` already has the `dispatchId` local at `:187`.

### 3.4 Left null — by design, verified at the call site

These emit `escalated`/`note` with **no causing dispatch**, so `null` is correct (matches the ACs):

- **`projector.escalateProjection`** (`projector.ts:183`) — fired during outbox drain
  (`drainOutbox`), a projection/transport failure, not a dispatch outcome. No dispatch caused it.
- **`transition`** (stage advance), **`note`** (housekeeping), **`resumed`** (operator resume) —
  not dispatch-caused events.

---

## 4. Docs

`docs/architecture/telemetry-export.md`:

- **§5** ("`dispatch_id` on `event` rows is reserved", `:238`) — rewrite from "reserved, always
  `null`, deferred to a follow-up ticket" to "populated for `loopback`/`escalated` with the causing
  dispatch; `null` for `transition`/`resumed`/`note` and projection-transport escalations."
- **§3.1 field table** (`:83`) — change the `dispatch_id` row from `**yes — reserved** … currently
  always null` to populated-with-the-noted-null-cases.

No `SCHEMA_VERSION` bump. The `dispatch_id` column already exists in both `schema.sql` and
`src/db/schema.sql`, so no schema edit is expected; if any column comment is touched, keep the two
schema copies byte-identical (per CLAUDE.md).

---

## 5. Decision: re-derive at the verdict site (not source-threading)

**Chosen:** each verdict entrypoint re-derives the causing dispatch via
`latestDispatchForStep(db, ticketId, stepKey)` — the exact pattern `review-verdict.ts:187` already
uses.

**Alternatives considered and rejected:**

- *Centralize the derivation in `advance.ts` onSucceed and pass down* — one derivation point, but
  diverges from review-verdict's established internal-lookup pattern and adds signature churn
  across the daemon.
- *Thread the true dispatch id out of `runAgentDispatch`* — ground-truth identity, immune to any
  future concurrency change, but the most invasive: it touches the invariant-heavy
  runner-writes-SoT path that the ticket explicitly flags as the risky surface.

**Invariant this relies on:** the daemon is single-threaded, so at verdict time "the latest dispatch
for this step" *is* the dispatch that just ran (the verdict fires in `onSucceed` immediately after
the dispatch is recorded, before any new dispatch on the same step is created). If the daemon ever
gains concurrency or defers verdicts across ticks, this re-derivation must become source-threading
(the rejected third option).

**Gate exception:** `verify:checks-gate` events derive from the **code dispatch**
(`getLatestForTicket(db, ticketId)`) instead of `latestDispatchForStep`, because the gate is an
in-process handler (`src/dispatch/handlers.ts`) that never calls `runAgentDispatch` and so has no
dispatch row of its own — `latestDispatchForStep` would return `null`. Where a judged step runs
multiple sub-dispatches (e.g. `checks:arbitrate`), "latest" deliberately means the final sub-dispatch.

---

## 6. Testing (TDD)

- **Flip the reserved-behavior assertions:** `test/db/row-widen.test.ts:19` ("carries dispatch_id
  (null until populated)") updates to cover the writable column; `test/telemetry/events.test.ts`
  stays green (schema unchanged).
- **Positive writer coverage:** add a `dispatch_id`-write case in `test/db/repos/event-log.test.ts`.
- **Per-verdict coverage:** add `dispatch_id` assertions to the five daemon verdict tests
  (`checks-verdict`, `checks-gate-verdict`, `arbiter-verdict`, `review-verdict`, `failure-policy`),
  and assert the projector escalation stays `null`.
- **End-to-end (where the join is genuinely exercised):** assert the joined `dispatch_id` on the
  emitted `loopback`/`escalated` events in `test/dispatch/arbiter-e2e.test.ts`,
  `review-e2e.test.ts`, `verify-gate-e2e.test.ts`, `checks-reauthor-e2e.test.ts`.
- **Existing suite green** (final AC).

---

## 7. Acceptance criteria (from the ticket)

- [ ] `event_log.dispatch_id` populated for `loopback` and `escalated` with the causing dispatch.
- [ ] Events with no causing dispatch remain `null`.
- [ ] `event.dispatch_id` on the v2 wire carries the value (no `SCHEMA_VERSION` bump).
- [ ] `docs/architecture/telemetry-export.md` updated: `event.dispatch_id` moves from
      "reserved (currently null)" to populated.
- [ ] Existing suite green.
