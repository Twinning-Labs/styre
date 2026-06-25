# Glossary

A reference for the dense vocabulary used across the architecture docs. Each entry states what a
term means in this codebase — no more. Definitions are grounded in the source docs listed in the
[reading order](README.md).

---

### ground truth

a verdict produced by an objective mechanism: build output, test results, CI
status, scope-diff, or an independent reviewer. Ground truth is the only basis on which the loop
decides to advance or retry; agent self-report is never a verdict. (control-loop §8 P2; move 5)

### idempotency key

a globally unique token, constructed by prefixing the `dispatch_id` (e.g.
`ENG-5-d0003-push`), attached to every external effect so that re-applying it after a crash is safe.
The globally unique constraint on the key is the dedup mechanism — enqueuing the same effect twice is
a no-op insert. (control-loop §3; schema.sql)

### K (concurrency cap)

the limit on concurrent in-flight tickets the daemon will advance at once.
The default at cutover is K=2, set via `orchestrator.max_concurrent_features`. (minimal-loop.md §4)

### loopback

a reset that sends a ticket back to an earlier stage when a gate fails, so the
`next_step_key` resolver re-picks the correct next step. The Loopback Atlas (control-loop §8) defines
every route, its scope (unit / ticket / plan), and its escalation cap.

### needs-you inbox

the queue of tickets parked on a `human_resume` signal, requiring an operator
action (resume / resume-after-fix / abandon). Backed by SQLite, surfaced via `styre inbox`; Linear is
only the tracking mirror. (minimal-loop.md §5; control-loop §7)

### next_step_key

the routing key computed by the deterministic resolver to select the next step
for a ticket. It is a pure function of the ticket's current `stage`, work-unit states, and the
`workflow_step` journal. (minimal-loop.md §1; control-loop §2.3)

### open-core seam (projector contract)

the set of versioned, stable interfaces the commercial
Control Plane integrates through without forking the OSS core: (1) the Linear ticket input contract
(`IngestedTicket`: title / description / type), (2) the project-profile artifact (`profile.md`), and
(3) the telemetry / state export (the structured NDJSON stdout stream of `dispatch` /
`event_log` / `ground_truth_signal` rows, plus a per-ticket summary on exit). Treat these as a
public API. (build-operations.md §5)

### projection_outbox

the table that holds pending outward writes (to Linear and GitHub). Every
outbox row is inserted in the *same transaction* as the state change that motivates it, so the SoT
and the intent-to-project can never disagree. The projector drains it idempotently. (control-loop §5;
projector.md §2; schema.sql)

### projector

the component that drains `projection_outbox` and applies each row idempotently to
Linear and GitHub. It is the sole outward write path from SQLite; it never reads Linear or GitHub to
decide control flow. Implemented as `drain_outbox()` inside the daemon (not a separate process).
(projector.md §1–§4)

### signal

an inbound ground-truth fact delivered to the loop: e.g. checks green
(`external_checks`), PR merged (`external_pr_result`), or a human action (`human_merge_approval`,
`human_resume`). Signals are the *only* channel through which external facts reach the control loop;
the daemon never reads Linear or GitHub directly for control-flow decisions. (control-loop §7)

### SoT (Source of Truth)

the single transactional SQLite database. Only the daemon writes it;
workers and agents return results but never persist to it. The schema has 14 active tables; the
`memory_record` table is a deferred stub, intentionally out of scope for the substrate.
(control-loop §2; schema.sql; README.md invariants)

### stage

the ticket's position in the lifecycle. `ticket.stage` is one of exactly six values:
`design`, `implement`, `verify`, `review`, `merge`, `released`. There is no hardcoded stage for UI
work (UI is a frontend work-unit with a visual verify check-type) and no legacy gerund stage
vocabulary. (control-loop §2.3; README.md invariants; schema.sql)

### work_unit

a per-`kind` decomposition of the implement stage (kinds include `backend`,
`frontend`, `data`, `reconcile`, etc.). The `design:extract` step produces one `work_unit` row per
kind from the plan; the daemon then orchestrates a separate implement → verify dispatch sequence for
each unit. One ticket fans into multiple work-unit dispatches; units with `depends_on` relationships
are sequenced accordingly. (control-loop §4 S1b; schema.sql; minimal-loop.md §1)

### workflow_step

a durable journal entry representing one logical unit of progress, identified by
a stable `step_key`. A succeeded `workflow_step` is never re-run; the resolver returns its recorded
`result_json` on replay. Retries increment `attempt` on the same row. (control-loop §2.3, §3, §6.2;
schema.sql)
