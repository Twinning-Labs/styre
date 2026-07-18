# Architecture

Styre is the open-source execution core of an open-core autonomous-SDLC product (GPLv3,
[github.com/Twinning-Labs/styre](https://github.com/Twinning-Labs/styre)). Its substrate is a
single-process control loop (`styre run`) driving a local SQLite journal through a deterministic state machine:
`design → implement → verify → review → merge → released`. The substrate is the contributor's
concern; a commercial Control Plane wraps it without forking it. The docs in this directory are
the substrate spec — frozen, mutually coherent, and written to be read top-to-bottom. Start here
before touching anything.

---

## Reading order

Read in this order. Each doc builds on the ones before it.

1. **`minimal-loop.md`** — the concrete `next_step_key` state machine, loopback resets, budget
   numbers, and the needs-you inbox. The most grounded starting point: you can read the whole
   ticket lifecycle as code.

2. **`control-loop.md`** — durable control-loop semantics: the control loop, the per-ticket event loop,
   the full step catalog S1–S10 (per-step guards, inputs, outputs, tools), the structured-output
   interface (§3a), the Loopback Atlas (§8), and the invariants every step author must hold (§9).

3. **`projector.md`** — the one-way projector: the sole outward write path from SQLite to
   Linear and GitHub. Drains `projection_outbox`; never reads Linear/GitHub for control flow.

4. **`schema.sql`** — the SQLite source of truth: **14 active tables**; the Memory/UGL
   `memory_record` table is a deferred (`-- DEFERRED`) stub, intentionally out of scope for
   the substrate.

5. **`brainstorm.md`** — the running decision log and rationale. §10 Open Decisions Register
   is the ADR-style DECIDED/OPEN/SUPERSEDED status of every design item. Append-only — never
   rewrite its history; the `▶ RESUME HERE` banner at the top is the live status pointer.

(`build-operations.md` covers repo, distribution, install targets, run modes, auth, and the
open-core seam — read it for operational and deployment context, not for the execution semantics.)

---

## Invariants (stated as absences)

These are the load-bearing NOTs. Code that violates them is wrong even if it works.

- There is exactly **one writer**: only the runner writes SQLite. Workers and agents return
  results; they never persist.

- Linear and GitHub are never read for control flow — they are one-way projections. Inbound facts
  the loop waits on (merged, human action) arrive only as signals. CI is reported, not gated: OSS
  `styre run` takes one best-effort snapshot of CI state at PR-open and moves on regardless — it
  never waits on, polls, or loops back on a checks verdict.

- A succeeded `workflow_step` is **never re-run** — the resolver returns its recorded result
  on replay (exactly-once semantics; crash-resume re-enters at the interrupted step, not before it).

- Verdicts are **never** agent self-scores — they come from build output, tests, CI, scope-diff,
  or an independent reviewer (ground truth over self-report).

- There is **no** hardcoded stage for UI work and **no** legacy gerund stage vocabulary.
  `ticket.stage` is one of `{design, implement, verify, review, merge, released}`. UI is a
  frontend work-unit with a visual verify check-type.

- Agents have **no** `gh` or Linear tools and **no** ambient `LINEAR_API_KEY`. The worktree is
  the only writable surface available to a worker.

- The runner's default response to an anomaly is **not** halt-to-human — it is loop (bounded
  retry against ground truth). Human gates are MERGE approval and escalations only.

---

## Codemap

Canonical code-layout decisions live in `build-operations.md`. The `src/` top-level directories
are: `engine`, `daemon` (the control-loop engine), `dispatch`, `db`, `integrations`, `agent`,
`telemetry`, `setup`, `cli`.

Multi-ticket orchestration, persistent supervision, the needs-you inbox, and K-concurrency are
**not** part of this core — see the "How the commercial plane fits" section in the root `README.md`.
