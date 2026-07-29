# Glossary

A reference for the dense vocabulary used across the architecture docs. Each entry states what a
term means in this codebase — no more. Definitions are grounded in the source docs listed in the
[reading order](README.md).

---

### abandoned

one of the four terminal outcomes a run can reach (`pr-ready | done | paused | abandoned`). It has
**no producer in styre** — reserved, not currently emitted by any run — and would exit `1` if it
ever were. Cleaning a run's disk state (`styre clean`) is NOT abandoning the ticket. (build-operations.md
§3; conventions.md)

### acceptance criterion / ac_check

an `acceptance_criterion` row is one testable requirement derived from the ticket during the design
stage (`checks:dispatch`); an `ac_check` is a RED-first test authored for that criterion, stored in
the `ac_check` table. The checks author is deliberately plan-blind — it sees only the AC text — so a
check fails on current code *for the right reason* before any implementation exists. (control-loop
§4; schema.sql; ticket-template.md)

### AC checks-gate

the gate that actually blocks a ticket in the implement stage: the behavioral `ac_check` tests must
go green at the branch HEAD (`verify:checks-gate`). Unlike the advisory per-unit build/test checks,
a still-red AC gate does not advance — it routes into arbitration. Round-capped
(`GATE_ROUND_CAP = 3`). (control-loop §4; resolver.ts)

### arbiter (checks)

the `checks:arbitrate` step that judges *why* an AC check is still red at HEAD and assigns two-way
blame: `code-wrong` (loop back to re-implement) or `check-wrong` (loop to `checks:reauthor`, which
rewrites the check). It exists because a red check is ambiguous — the code may be wrong, or the test
may be. (control-loop §4; arbiter-verdict.ts)

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

*(Commercial Control Plane.)* The limit on concurrent in-flight tickets the persistent plane
advances at once, set via `orchestrator.max_concurrent_features`. K is a scheduling parameter for
the outer multi-ticket loop that the commercial Control Plane operates. `styre run` is
single-ticket by definition, so K does not apply to the OSS core. (minimal-loop.md §4)

### loopback

a reset that sends a ticket back to an earlier stage when a gate fails, so the
`next_step_key` resolver re-picks the correct next step. The Loopback Atlas (control-loop §8) defines
every route, its scope (unit / ticket / plan), and its escalation cap.

### needs-you inbox

*(Commercial Control Plane.)* The persistent queue of tickets **paused** on a `human_resume` signal
(reason `needs_you`), requiring an operator action (resume / abandon). Backed by SQLite and surfaced
via `styre inbox`; Linear is only the tracking mirror. `styre inbox` and `styre abandon` are
commercial-plane commands, not part of the OSS core. In OSS run-only mode the equivalent behavior is:
retry/tick exhaustion, or a loopback the loop cannot structurally resolve, pauses the run (reason
`needs_you`, exit code 75); an out-of-credits/session-limit interruption likewise pauses the run
(reason `budget`, exit code 75) — both resumable, never a bare nonzero-and-done. The operator resumes
with `styre run --resume <ticket> --profile <p>` (with `--accept-head` or `--inspect` available).
(minimal-loop.md §5; control-loop §7)

### next_step_key

the routing key computed by the deterministic resolver to select the next step
for a ticket. It is a pure function of the ticket's current `stage`, work-unit states, and the
`workflow_step` journal. (minimal-loop.md §1; control-loop §2.3)

### paused

one of the four terminal outcomes a run can reach (`pr-ready | done | paused | abandoned`) when it
cannot continue without an external event. Every pause carries an internal `reason`: `budget`
(out-of-credits/session-limit), `needs_you` (retry/tick exhaustion, or a loopback the loop cannot
structurally resolve), or `interrupted` (reserved for a hard crash — not currently emitted by a live
run). Every `paused` reason exits `75` (EX_TEMPFAIL), and so does `styre clean <ident>` refusing a
live run. The SoT + transcript already live at the run's checkpoint
(`$XDG_STATE_HOME/styre/<slug>/<ident>/`) — pausing writes nothing extra; `styre run --resume <ident>`
reads the checkpoint back and resumes. (conventions.md; build-operations.md §3)

### open-core seam (projector contract)

the set of versioned, stable interfaces the commercial
Control Plane integrates through without forking the OSS core: (1) the ticket input contract
(`IngestedTicket`: title / description / type — from Linear or Jira), (2) the project-profile
artifact (`profile.json`), and (3) the telemetry / state export (the structured NDJSON stdout stream
of `dispatch` / `event_log` / `ground_truth_signal` rows, plus a per-ticket summary on exit). Treat
these as a public API. (build-operations.md §5)

### projection_outbox

the table that holds pending outward writes. Every
outbox row is inserted in the *same transaction* as the state change that motivates it, so the SoT
and the intent-to-project can never disagree. Rows target one of three sinks — the issue tracker, the
forge, or the notifier. The projector drains it idempotently. (control-loop §5; projector.md §2;
schema.sql)

### projector

the component that drains `projection_outbox` and applies each row idempotently to
its target — the issue tracker (Linear/Jira), the forge (GitHub), or the notifier (Slack). It is the
sole outward write path from SQLite; it never reads the tracker or forge to decide control flow.
Implemented as `drainOutbox()` inside the runner (not a separate process). (projector.md §1–§4)

### signal

an inbound ground-truth fact delivered to the loop: e.g. PR merged
(`external_pr_result`), or a human action (`human_merge_approval`, `human_resume`). Signals are the
channel through which external facts the loop *waits on* reach the control loop; the runner never
reads Linear or GitHub directly for control-flow decisions. Checks status is **not** a signal: OSS
`styre run` takes one best-effort t+0 read of CI state on the merge path and reports it as
`ci_handoff` telemetry — it is observed once, never awaited, never delivered through the `signal`
table. (control-loop §7, §4 S8)

### SoT (Source of Truth)

the single transactional SQLite database. Only the runner writes it;
workers and agents return results but never persist to it. The schema has **16 `CREATE TABLE`
statements**; the `memory_record` table is a commented-out deferred stub (not one of the 16), and
`metric_event` / `external_id_cache` / `projection_state` are defined but currently unwired.
(control-loop §2; schema.sql; README.md invariants)

### stage

the ticket's position in the lifecycle. `ticket.stage` is one of exactly six valid values:
`design`, `implement`, `verify`, `review`, `merge`, `released`. In the current loop the runtime only
ever *assigns* `design`, `implement`, `review`, `merge`, `released` — verify work runs inside the
implement stage, so a ticket does not pass through a distinct `verify` stage (the value remains valid
in the vocabulary). There is no hardcoded stage for UI work (UI is a frontend work-unit with a visual
verify check-type) and no legacy gerund stage vocabulary. (control-loop §2.3; README.md invariants;
schema.sql)

### styre clean

the OSS command that reaps a run's on-disk state. `styre clean <ident>` reaps ONE effort's disk
artifacts (worktree + checkpoint) — no ticket-status change; refuses a live run (exit `75`). `styre
clean --all` reaps only provably-finished (`pr-ready`/`done`) efforts for the current project,
skipping resumable pauses and live runs. `styre clean <ident> --purge` additionally deletes the local
+ remote branch (closing the PR) — opt-in, single-ident (rejects `--all --purge`, exit `64`), silent
when there is no branch/PR; on the repo's default branch it skips the branch/PR deletion but still
reaps disk state (stderr warning, exit `0`). (build-operations.md §3; conventions.md)

### styre ls

the OSS command that lists every effort in three sections, in order: `Paused/resumable efforts:`
(each row followed by `resume: styre run --resume <ident> --slug <slug>`), `Finished leftovers (reap
per project with \`styre clean --all\`):` (slug-qualified rows), and `Running:`. A live effort never
appears as reapable. (build-operations.md §3)

### track (fast / full)

a ticket's review ceremony level, set by the `design:size` step. `full` runs the semantic
`design:review` gate; `fast` skips it. Sizing is deterministic (sprawl-only) unless
`complexityGrading` is enabled, which adds a cold read-only complexity grader. The track is a routing
heuristic, never a ship-gate verdict. (control-loop §4; runtime-config `complexityGrading`)

### work_unit

a per-`kind` decomposition of the implement stage (kinds include `backend`,
`frontend`, `data`, `reconcile`, etc.). The `design:extract` step produces one `work_unit` row per
kind from the plan; the runner then orchestrates a separate implement → verify dispatch sequence for
each unit. One ticket fans into multiple work-unit dispatches; units with `depends_on` relationships
are sequenced accordingly. (control-loop §4 S1b; schema.sql; minimal-loop.md §1)

### workflow_step

a durable journal entry representing one logical unit of progress, identified by
a stable `step_key`. A succeeded `workflow_step` is never re-run; the resolver returns its recorded
`result_json` on replay. Retries increment `attempt` on the same row. (control-loop §2.3, §3, §6.2;
schema.sql)
