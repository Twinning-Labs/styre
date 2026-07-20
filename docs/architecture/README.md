# Architecture

Styre is the open-source execution core of an open-core autonomous-SDLC product (GPLv3,
[github.com/Twinning-Labs/styre](https://github.com/Twinning-Labs/styre)). Its substrate is a
single-process control loop (`styre run`) driving a local SQLite journal through a deterministic state machine:
`design → implement → verify → review → merge → released`. The substrate is the contributor's
concern; a commercial Control Plane wraps it without forking it. The docs in this directory are
the **maintained reference** — kept current with the code, mutually coherent, and written to be read
top-to-bottom. When a change alters a documented behavior, update the reference in the same PR.
Start here before touching anything.

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

4. **`schema.sql`** — the SQLite source of truth: **16 `CREATE TABLE` statements** (a byte-identical
   copy of `src/db/schema.sql` — keep them in sync). The Memory/UGL `memory_record` table is a
   commented-out `-- DEFERRED` stub (not one of the 16); `metric_event`, `external_id_cache`, and
   `projection_state` are defined but currently unwired.

5. **`brainstorm.md`** — the running decision log and rationale. §10 Open Decisions Register
   is the ADR-style DECIDED/OPEN/SUPERSEDED status of every design item. Append-only — never
   rewrite its history; the `▶ RESUME HERE` banner at the top is the live status pointer.

Alongside the reading order, this directory holds:

- **`execution-model.md`** — a from-the-outside explanation of how a run flows through the six
  stages; read it before the step-by-step specs if you want the mental model first.
- **`glossary.md`** — definitions for the dense vocabulary used across these docs.
- **`build-operations.md`** — repo, distribution, install targets, run modes, auth, and the
  open-core seam (operational/deployment context, not execution semantics).
- **`ticket-template.md`** — the operator guide to writing a ticket Styre can actually deliver.
- **`runtime-parameters.md`**, **`configuration.md`**, **`conventions.md`**, **`prompts.md`** — the
  operator/contributor references for the CLI surface, config and profile keys, on-disk conventions,
  and the agent prompt templates.

---

## Invariants (stated as absences)

These are the load-bearing NOTs. Code that violates them is wrong even if it works.

- There is exactly **one writer**: only the runner writes SQLite. Workers and agents return
  results; they never persist.

- The issue tracker (Linear/Jira) and the forge (GitHub) are never read for control flow — they are
  one-way projections. Inbound facts the loop waits on (merged, human action) arrive only as signals.
  CI is reported, not gated: OSS `styre run` takes one best-effort snapshot of CI state at PR-open and
  moves on regardless — it never waits on, polls, or loops back on a checks verdict.

- A succeeded `workflow_step` is **never re-run** — the resolver returns its recorded result
  on replay (exactly-once semantics; crash-resume re-enters at the interrupted step, not before it).

- Verdicts are **never** agent self-scores — they come from build output, tests, CI, scope-diff,
  or an independent reviewer (ground truth over self-report).

- There is **no** hardcoded stage for UI work and **no** legacy gerund stage vocabulary.
  `ticket.stage` is one of `{design, implement, verify, review, merge, released}`. UI is a
  frontend work-unit with a visual verify check-type.

- Agents have **no** `gh` or tracker tools; the runner strips `LINEAR_API_KEY`, `JIRA_API_TOKEN`,
  and `GITHUB_TOKEN` from their environment (the provider key is retained for the agent CLI's own
  auth; verify-time commands strip that too). The worktree is the only writable surface available
  to a worker.

- The runner's default response to an anomaly is **not** halt-to-human — it is loop (bounded
  retry against ground truth). Human gates are MERGE approval and escalations only.

---

## Codemap

Canonical code-layout decisions live in `build-operations.md`. The `src/` top-level directories
are: `cli`, `config` (runtime-config + profile resolution, the config seam), `daemon` (the
control-loop engine), `dispatch`, `db`, `engine`, `integrations`, `agent`, `setup`, `telemetry`,
`util`.

Multi-ticket orchestration, persistent supervision, the needs-you inbox, and K-concurrency are
**not** part of this core — see the "How the commercial plane fits" section in the root `README.md`.
