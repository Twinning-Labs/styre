# Execution Model

> **Diátaxis type:** explanation — how it works, away from the code. Read this to build a mental
> model of how Styre drives a ticket from start to finish before reading the step-by-step
> specifications in [`control-loop.md`](control-loop.md) and [`minimal-loop.md`](minimal-loop.md).

---

## The shape of a run

A ticket enters the system at `design` and the loop drives it through six stages to completion:

```
           ┌──────────────────────────────────────────────┐
           │                                              │
           ▼                                              │ re-design
        design ──────────────────────────────────────────►│
           │                                              │
           ▼                                              │
       implement ◄── loopback (build/test red) ──────────►│
           │                 ▲                            │
           │      re-implement (per work-unit)            │
           ▼                                              │
        verify  ──────────── (unit red → re-implement)   │
           │                                              │
           ▼                                              │
        review  ──── (plan defect → re-design) ──────────►│
           │                                              │
           │         (code finding → re-implement) ───────┘
           ▼
         merge  ──── (checks red → re-implement+review)
           │
           ▼
        released
```

These six values are the only valid values of `ticket.stage`. There is no stage for UI work: a
frontend `work_unit` is a decomposition of `implement`, and its visual check runs during `verify`.
The stage vocabulary is fixed; the legacy gerund names do not exist in this codebase.

---

## The loop, not a pipeline

Styre is not a pipeline that runs each stage once and stops. It is a **deterministic loop** that
evaluates a routing function — [`next_step_key`](minimal-loop.md) — against the ticket's current
persisted state on every tick and selects the next step to execute.

The loop's core resolver is a pure function of what is already in SQLite: the ticket's `stage`,
the state of each [work_unit](glossary.md#work_unit), and the durable [workflow_step](glossary.md#workflow_step) journal.
It is not a sequence of hard-coded transitions. Styre chooses what to do next by reading the
journal — if a step succeeded, advance; if it failed, apply the failure policy from the
[Loopback Atlas](control-loop.md#8-the-loopback-atlas); if it is in flight, wait.

This means **anomalies are absorbed rather than halted**. When a build fails, the loop routes back
to `implement` with the error in hand and retries against [ground truth](glossary.md#ground-truth). When a test is
red, the loop hands the failing test names to the agent and tries again. The default response to
any correctable failure is "absorb and loop," bounded by per-ticket retry budgets (capped by spend,
wall-clock, and distinct-failure counts — described in [minimal-loop.md §4](minimal-loop.md#4-budget-numbers-the-deferred-loose-ends-pinned)).

**Human gates are narrow by design.** The only wired human gate is MERGE approval
(`human_merge_approval`): the operator reviews the pull request and merges it personally. Escalations
reach the [needs-you inbox](glossary.md#needs-you-inbox) only when the loop has exhausted its retry budget or
encountered something it structurally cannot decide (a `major` finding flagged as a deferral
candidate, a persistent conflict the agent cannot resolve, an infrastructure outage). Every other
situation loops.

---

## Durability and exactly-once execution

Every unit of progress is a [`workflow_step`](glossary.md#workflow_step) row in SQLite, identified by a stable
`step_key` derived from the ticket and the logical position in the sequence. The journal is the
system's memo table.

When the daemon picks up a ticket, the resolver checks the journal first. If a step already
succeeded, the resolver reads its recorded `result_json` and moves on — it never re-executes the
step. This is what makes crash-resume work: restart the daemon, run the resolver, and the loop
re-enters at exactly the interrupted step, not at the beginning of the ticket.

For steps with external effects (pushing a branch, opening a pull request, posting to Linear), the
daemon writes its *intent* to the journal before the effect and makes the effect idempotent:

1. Begin a transaction: mark the step `running`, record the `attempt` count and the
   [`idempotency_key`](glossary.md#idempotency-key), commit.
2. Execute the effect — idempotently, using the key.
3. Begin a second transaction: mark the step `succeeded`, record the result, enqueue any
   downstream projection rows in the same transaction, commit.

A crash between steps 1 and 3 leaves the row in `running` state with a known key. On restart,
`recover()` finds it, kills any orphaned dispatch process, and re-queues the step — the key ensures
the re-applied effect is a safe no-op if it already landed.

---

## One writer

Only the daemon writes SQLite. Agents and workers return results; they never persist anything
themselves.

This constraint eliminates an entire class of bugs. The legacy harness allowed multiple concurrent
writers (documented as ENG-217: stage drift, marker-write races, state disagreements between
concurrent shell processes). With one daemon and one database, two-authoritative-writers is
impossible by construction, not by discipline.

The same principle applies to git. Agents edit files in the worktree. The daemon reads those files,
runs the build and tests, and commits — the agent never runs `git commit` or `git push`. Every
commit carries a deterministic message including the `dispatch_id`, so every piece of code on the
branch is traceable to a journaled step.

---

## Outward writes through the projector

Linear and GitHub are tracking surfaces, not control inputs. The loop never reads either service to
decide what to do next — that is the bug class move 2 deletes. All control decisions are computed
from SQLite alone.

When a state change happens — a stage transition, a PR becoming ready, a ticket completing — the
daemon computes the projection delta and inserts rows into [`projection_outbox`](glossary.md#projection_outbox) in
the **same transaction** as the state change. State and the intent-to-project can never disagree:
either both commit or neither does.

The [projector](glossary.md#projector) drains the outbox on every loop iteration, applying each pending row
idempotently to Linear or GitHub (declarative label/state updates, comment deduplication via a
`proj-key` tag, push with-lease, PR create-or-reuse). A Linear outage delays projection but never
blocks the control loop — the daemon continues advancing tickets; the outbox rows wait until the
service returns.

Inbound facts — checks green, PR merged, human action — arrive as [signals](glossary.md#signal): the daemon
polls the checks system and GitHub on an interval and delivers the results as structured rows in the
`signal` table. The loop waits on a signal by parking the ticket (`status='waiting'`); when the
signal is delivered the ticket re-enters `v_ready_tickets` and the resolver picks it up.

---

## Implement fans out

When the ticket advances from `design` to `implement`, it does not dispatch a single agent to write
all the code. The `design:extract` step has already decomposed the plan into one [`work_unit`](glossary.md#work_unit)
row per kind (`backend`, `frontend`, `data`, `reconcile`, …). The implement stage is a
daemon-orchestrated sequence of focused dispatches, one per unit, respecting `depends_on` ordering.

For each unit, the daemon runs: rebase → implement dispatch → per-check verify. The agent that
implements a unit edits only files; the daemon commits each dispatch's changes with a `dispatch_id`
in the message. Verify steps are daemon-executed, not agent self-report: the daemon runs the
profile's declared build and test commands against the committed SHA and records a structured
`ground_truth_signal` row. A unit's implement dispatch cannot silently declare itself done — the
ground-truth check catches hallucinated runs, weakened tests, and dirty-environment passes.

Once all units pass their per-unit checks, the daemon runs integration verification across the
whole branch (`verify:integration`). Only then does the ticket advance to `review`.

A frontend unit's visual check runs during verify, as one check-type among others, driven by the
profile's declared command. Frontend work is a work-unit kind, not a separate stage.

---

## Where the human shows up

The operator interacts with Styre in two places:

**The merge gate.** After review passes, the daemon pushes the branch, opens a pull request, waits
for the project's checks system to go green, and parks the ticket in the [needs-you inbox](glossary.md#needs-you-inbox).
The operator reviews the pull request and merges it. The daemon detects the merge by polling GitHub
and advances the ticket to `released`. Auto-merge is off at the substrate level.

**The needs-you inbox.** When the loop exhausts its retry budget, encounters an infrastructure
outage, or reaches an escalation point it cannot resolve autonomously, it parks the ticket on a
`human_resume` signal and adds it to the inbox (surfaced via `styre inbox` and mirrored as a
comment on the Linear issue). Each inbox entry shows the full trace: the failure history, the
loopback signatures, the ground-truth signals, and the available actions:

- `styre resume <ticket>` — re-enter the parked step; retry counters reset.
- `styre resume <ticket> --after-fix` — the operator edited the plan, code, or config by hand; the
  daemon picks up the changed state.
- `styre abandon <ticket>` — terminal; the ticket is projected to Canceled.

Every other situation — build failures, test regressions, review findings, flaky CI, merge
conflicts, docs that need updating — the loop handles itself.

---

## Read next

[`control-loop.md`](control-loop.md) contains the full step catalog (S1–S10) with per-step guards,
inputs, outputs, and tool constraints; the Loopback Atlas (§8) with every failure route; and the
invariants every step author must hold (§9). Start there for the implementation specification.
