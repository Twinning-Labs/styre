# The One-Way Projector

> **OSS core.** The projector is part of `styre run` — the one-way outward-write subsystem that
> drains `projection_outbox` to three sinks: the **issue tracker** (Linear/Jira), the **forge**
> (GitHub), and, when configured, the **notifier** (Slack). It runs inside the OSS runner, not as a
> separate process. The persistent **needs-you inbox** (a SQLite-backed queue with `styre inbox` /
> two-way Slack) remains the commercial Control Plane; the **outbound** Slack notifier documented
> here ships in the OSS core.

The component that makes "the tracker and forge are one-way projections" (move 2) real: the single
outward write path from the SQLite SoT. It drains [`schema.sql`](schema.sql)'s `projection_outbox`
and applies each row idempotently. It **never reads the tracker or forge to decide control flow** —
the inbound facts the loop waits on (merge, human action) arrive as **signals** (control-loop §7),
not through the projector. CI status is reported, not awaited: OSS takes one best-effort t+0 read on
the merge path (control-loop §4) and never a signal. Builds on the outbox mechanics in
[`control-loop.md`](control-loop.md) §5.

---

## 1. Role + invariants

- **Sole outward writer (move 2).** Every per-ticket outward write goes through the projector;
  nothing else holds write credentials. Agents have none (capability isolation, move 4); the
  **runner holds the creds and the projector is its outward-write subsystem** — not a separate
  process (one binary). `drainOutbox()` is the projector, called each loop (control-loop §2.2).
- **No control-flow reads.** The projector only *writes* outward. The runner never reads the tracker
  or forge to decide what to do next — that's the bug class move 2 deletes. The closed-loop facts the
  runner *does* need (merged? human action?) enter as **delivered signals** (control-loop §7). CI
  status is not one of them: OSS takes a single best-effort t+0 read on the merge path and reports it
  as `ci_handoff` telemetry — never awaited, never a signal, never re-read.
- **Idempotent.** Two layers: the outbox row's `idempotency_key` (globally unique by construction →
  enqueue-twice is a no-op insert) **and** a per-adapter **probe** of external state before applying
  (§5).
- **No direct-write bypass.** The only per-ticket outward write path is the outbox — there is no
  code path that writes the tracker or forge directly.

## 2. Enqueue (the runner, write-half) vs drain (projector, read-half)

The split keeps the SoT and its projection atomic:

- **Enqueue — the runner, in the SAME transaction as the state change.** When a step commits a state
  change, the runner inserts `projection_outbox` rows in that same tx (`enqueueStageProjection` for
  stage transitions; the merge handlers for `push`/`pr_create`; the notify watermark for `post`).
  State and the intent-to-project can never disagree. Each row's `idempotency_key` includes a
  **stage-change epoch** (`stageChangeEpoch`), so a loopback that re-enters a stage re-projects under
  a new epoch, while a re-enqueue *within the same transaction* is a no-op insert against the unique
  key. (There is no separate `projection_state` snapshot or computed delta — the epoch-keyed
  idempotency key is the whole mechanism; the `projection_state` table exists in the schema but is
  currently unwired.)
- **Drain — the projector.** Reads pending rows and applies them. Decoupled from the runner's control
  decisions; a tracker outage delays projection but never blocks the loop.

## 3. The projection mapping (SoT → external)

What the runner actually enqueues today. The tracker is the human tracking mirror; the outward
projection (state/label/notification) is OSS.

| SoT change | target | op | payload |
|---|---|---|---|
| stage transition X → Y | `issue_tracker` | `set_state` | neutral state for stage Y (adapter maps to the vendor's vocabulary) |
| stage transition X → Y | `issue_tracker` | `set_labels` | add `stage:Y`, remove `stage:X` |
| merge stage: push the branch | `forge` | `push` | branch → remote (with-lease, never `main`) |
| merge stage: ensure the PR | `forge` | `pr_create` | create-or-reuse; returns `response_ref` = PR number/url, delivered as an `external_pr_result` signal |
| notify policy fires (escalation / transition / loopback, per `notify`) | `notify` | `post` | the rendered `NotificationMessage` |

The `add_comment` and `pr_comment` adapter operations exist in the projector (`applyRow`) but are
**not currently enqueued by any step** — they are wired capability, not live projections. Comment
projection of review findings and escalations is deferred. `pr_merge` is not projected: the human
performs the merge (OSS `styre run` ends at PR-ready). `ticket.status = 'abandoned'` has a `set_state`
mapping in principle but is never written by OSS code.

## 4. The drain loop

```
drainOutbox(budget = OUTBOX_RETRY_BUDGET):        # OUTBOX_RETRY_BUDGET = 5
  for row in pending rows, per-ticket FIFO by created_at:
    try:
      ref = ADAPTER[row.target][row.op].apply(row)    # §5 — probe-idempotent
      BEGIN
        markSent(row.id, ref)                          # status='sent', response_ref, sent_at
        # a structured telemetry note is committed WITH markSent so a crash-replay can't double-count
      COMMIT
      if row delivers a result: deliverSignal(row, ref)   # pr_create → external_pr_result (§7)
    catch transient:
      attempts += 1                                   # retried on the NEXT drain (no backoff)
      if attempts >= budget: escalate(row.ticket_id)  # §7 — external service down
```

- **Ordering** is per-ticket FIFO by `created_at` (a `set_state` after a `set_labels` lands in order).
- **Retry is next-drain, not backed off** — a failed row stays pending and is re-attempted on the
  following loop iteration until it succeeds or the budget (5) is exhausted.
- **Result-bearing rows** (`pr_create`) deliver their `response_ref` to the awaiting signal
  (`external_pr_result`) so the workflow resumes with the PR number (control-loop §5).

## 5. Adapters (per target + op): apply + probe

Each adapter re-attempts and **probes external state** to absorb a duplicate (probe, not key-only —
keys can't dedup a non-keyed external API).

**Issue tracker (Linear/Jira):**
- `set_labels` — **declarative**: read the issue's current labels, compute the target set (swap
  `stage:*`, preserve human labels), update to it. Idempotent by nature; label-safe — never
  overwrites the full set blindly.
- `set_state` — **declarative**: update the issue's coarse state to the target; no-op if already
  there. A workflow mismatch is a *skipped* projection (a `projection_skipped` note), not a transport
  failure.
- `add_comment` — **probe** (adapter capability; not currently enqueued): dedups on a
  `<!-- proj-key: <idempotency_key> -->` tag in the issue's recent comments.

**Forge (GitHub):**
- `push` — **probe**: if the remote ref is already at the local SHA → skip. Feature branch only;
  force is with-lease and never on `main`/protected.
- `pr_create` — **probe**: look up a PR for the branch; reuse if present, else create. Returns
  `response_ref`.
- `pr_comment` — **probe** (adapter capability; not currently enqueued): dedups like `add_comment`.

**Notifier (Slack):**
- `post` — sends one message via `chat.postMessage`; idempotency-keyed on the event `seq` / terminal
  outcome so a re-drain does not double-notify. A notify-row transport failure is retried but never
  escalates the ticket.

## 6. Name → id resolution (`external_id_cache`)

Some tracker APIs take internal UUIDs while the SoT speaks names (`stage:implement`, `In Review`,
`Bug`). A vendor adapter resolves these as needed. The `external_id_cache` table is reserved for
caching that resolution but is **currently unwired** — the Linear adapter resolves inline and the
cache optimization is deferred.

## 7. Failure + escalation

- **Transient** (network blip, rate-limit) → the row stays `pending`, retried on the next drain.
- **Persistent** (past `OUTBOX_RETRY_BUDGET`) → **escalate the ticket**: it parks and the operator is
  told the *external service* is down — never a silent infinite retry, never a lost projection (the
  row is durable; it drains when the service returns). A `notify`-target failure is the exception: it
  is retried but never escalates the ticket (a failed notification must not block a run).
- A projection failure **never** blocks control flow — the runner's loop runs on the SoT regardless.
