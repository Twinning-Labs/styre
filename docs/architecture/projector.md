# The One-Way Projector

> **Artifact for §9.4 checklist #4** of [`brainstorm.md`](brainstorm.md). The component that makes
> "Linear/GitHub are one-way projections" (move 2) real: the **single outward write path** from the
> SQLite SoT to Linear + GitHub. It **drains [`schema.sql`](schema.sql)'s `projection_outbox`** and
> applies each row idempotently. It **never reads Linear/GitHub to decide control flow** — the only
> inbound external facts (checks status, merge, human action) arrive as **signals** (control-loop §7),
> not through the projector.
>
> Builds on the outbox mechanics in [`control-loop.md`](control-loop.md) §5 (CL-2 / CL-3). Status:
> draft 2026-06-19.

---

## 1. Role + invariants

- **Sole outward writer (move 2).** Every per-ticket write to Linear/GitHub goes through the
  projector; nothing else holds write credentials. Agents have none (capability isolation, move 4);
  the **daemon holds the creds and the projector is its outward-write subsystem** — it is *not* a
  separate process (GOAL-INSTALL: one binary). `drain_outbox()` is the projector, called each loop
  (control-loop §2.2).
- **No control-flow reads (CL-INV-5).** The projector only *writes* outward. The daemon never reads
  Linear/GitHub to decide what to do next — that's the bug class move 2 deletes. The closed-loop
  facts the daemon *does* need (checks green? merged?) enter as **delivered signals** (control-loop §7.3).
- **Idempotent (B3 / CL-3).** Two layers: the outbox row's `idempotency_key` (globally unique by
  construction → enqueue-twice is a no-op insert) **and** a per-adapter **probe** of external state
  before applying (§5).
- **Closes the legacy bypasses.** In the old harness, `run-stage.sh` and `setup.sh` wrote Linear
  directly. Here there is no bypass *by construction*: the only per-ticket write path is the outbox.
  Setup's one-time bootstrap (create the `stage:*` labels, refresh the id cache) is the *only* other
  Linear write, and it's not control flow.

## 2. Enqueue (daemon, write-half) vs drain (projector, read-half)

The split keeps the SoT and its projection atomic:

- **Enqueue — the daemon, in the SAME transaction as the state change.** When a step commits a state
  change (stage transition, escalation, PR-ready, done), the daemon computes the **projection delta**
  vs `projection_state` (the last-projected snapshot) and inserts `projection_outbox` rows in that
  same tx. State and the intent-to-project can never disagree → the ~30-ticket reconciliation class
  is gone by construction. A delta that matches the snapshot enqueues nothing (no-op projections
  suppressed).
- **Drain — the projector.** Reads pending rows and applies them. Decoupled from the daemon's control
  decisions; a Linear outage delays projection but never blocks the loop.

## 3. The projection mapping (SoT → external)

What the daemon enqueues for a given SoT change. Linear is the **human tracking mirror** (D3); the
*actionable* needs-you queue is the SQLite inbox + Slack + `status`, **not** Linear.

| SoT change | Linear (op) | GitHub (op) |
|---|---|---|
| ticket picked up (Todo → active, stage=design) | `set_state` In Progress; `set_labels` +`stage:design` | — |
| stage transition X → Y | `set_labels` swap `stage:X`→`stage:Y` | — |
| stage → `merge` (PR-ready) | `set_state` In Review | `push`; `pr_create` (→ `response_ref`=PR#) |
| review produced findings (any) | `add_comment` review summary (on the PR) | `pr_comment` review summary |
| escalation (a `human_resume` raised) | `add_comment` "needs you: <reason>" (mirror; the *action* is the inbox) | — |
| status → `done` (merged) | `set_state` Done | — (the human merged) |
| status → `abandoned` | `set_state` Canceled + `add_comment` rationale | — |

- **`stage:*` labels are projection-only** (cosmetic human visibility into the fine stage); nothing
  reads them back. They can be dropped if the coarse Linear *state* (In Progress / In Review / Done)
  is enough — operator preference.
- **`pr_merge` is NOT projected at cutover** — the human performs the merge (D2). Post-cutover
  auto-merge (earned via the learning layer) would add it.

## 4. The drain loop

```
drain_outbox():
  for row in SELECT * FROM projection_outbox WHERE status='pending' ORDER BY created_at:
    try:
      ref = ADAPTER[row.target][row.op].apply(row)        # §5 — probe-idempotent
      BEGIN
        UPDATE projection_outbox SET status='sent', response_ref=ref, sent_at=now WHERE id=row.id
        update_projection_state(row)                       # advance the last-projected snapshot
      COMMIT
      if row delivers a result: deliver_signal(row, ref)   # e.g. pr_create → external_pr_result (§7)
    catch transient:
      UPDATE projection_outbox SET attempts=attempts+1, error=… WHERE id=row.id   # retried next loop
      if row.attempts >= OUTBOX_RETRY_BUDGET: escalate(row.ticket_id, X1)          # §7 — service down
```

- **Ordering** is per-ticket FIFO by `created_at` (a `set_state` after a `set_labels` lands in order).
- **Result-bearing rows** (`pr_create`) deliver their `response_ref` to the parked signal
  (`external_pr_result`) so the workflow resumes with the PR number (control-loop §5.3).

## 5. Adapters (per target + op): apply + probe (CL-3)

Each adapter re-attempts and **probes external state** to absorb a duplicate (re-attempt + probe,
not key-only — keys can't dedup a non-keyed external API).

**Linear** (UUIDs resolved via `linear_id_cache`, §6):
- `set_labels` — **declarative**: read the issue's current labels, compute the target set
  (swap `stage:*`, preserve human labels), `issueUpdate` to it. Idempotent by nature (set-to-desired).
  **Label-safe** — never overwrites the full set blindly (the `save_issue`-clobbers-labels lesson).
- `set_state` — **declarative**: `issueUpdate` state → target; no-op if already there.
- `add_comment` — **probe**: the body carries a `<!-- proj-key: <idempotency_key> -->` tag; grep the
  issue's recent comments for that tag and post only if absent (Linear has no native idempotency key).

**GitHub**:
- `push` — **probe**: if the remote ref is already at the local SHA → skip. Feature branch only;
  force is with-lease and never on `main`/protected.
- `pr_create` — **probe**: `gh pr view <branch>` → if a PR exists, reuse it; else create. Returns
  `response_ref` = PR number/url.
- `pr_comment` — **probe**: like `add_comment`, dedup on the `proj-key` tag in PR comments.

## 6. `linear_id_cache` — name → UUID resolution

The Linear API takes UUIDs; the SoT speaks names (`stage:implement`, `In Review`, `Bug`). The
projector resolves via `linear_id_cache` and **refreshes on a miss** (one network pull, re-query).
**Setup seeds it** (and creates any missing `stage:*` labels) as part of the one-command install.

## 7. Failure + escalation

- **Transient** (network blip, rate-limit) → the row stays `pending`, retried next drain with backoff.
- **Persistent** (outage past `OUTBOX_RETRY_BUDGET`) → **escalate the ticket (atlas X1)**: it parks,
  and the operator is told the *external service* is down — never a silent infinite retry, never a
  lost projection (the row is durable; it drains when the service returns).
- A projection failure **never** blocks control flow — the daemon's loop runs on the SoT regardless.

## 8. Setup integration (GOAL-INSTALL)

The one-command `setup`:
1. refreshes `linear_id_cache` (team/project/states/labels → UUIDs),
2. creates any missing `stage:*` projection labels,
3. seeds `projection_state` for imported tickets (none, post-abandonment — §9.4 #3).

This is the *only* Linear write outside the per-ticket projector path, and it's one-time bootstrap,
not control flow.

## 9. Mapping to §9.4 #4

- ✅ **all Linear/GitHub writes go through one projector reading SQLite** — the outbox is the sole
  per-ticket write path (§1/§2).
- ✅ **no code path reads Linear to decide control flow** — the projector is write-only outward;
  inbound facts are signals (§1, control-loop §7).
- ✅ **the 2 direct-API bypasses are closed** — they don't exist in the greenfield design; setup's
  one-time bootstrap is the only other write (§8).

**Open (don't block #4):** `OUTBOX_RETRY_BUDGET` value; whether to keep `stage:*` labels or project
coarse state only (§3); the per-target rate-limit/backoff constants.

**Next artifact:** §9.4 #5 — the minimal loop wiring the resolver + step catalog + verify gates +
this projector together (the first end-to-end `design → released` on the new substrate).
