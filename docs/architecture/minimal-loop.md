# The Minimal Loop

> **OSS core.** This describes the per-ticket minimal loop that `styre run` executes. The
> **needs-you inbox** and multi-ticket orchestration are the **commercial Control Plane**, fenced
> below.

> The concrete per-ticket routing spec: the **`next_step_key`** state machine (§1), what each
> loopback **resets** (§2), the **dispatch** mechanism (§3), the **budget numbers as implemented**
> (§4), and the (commercial) needs-you inbox (§5). This is **deterministic routing only** — no LLM
> supervisor, no memory/RAG; those are explicitly out of scope.
>
> Builds on [`control-loop.md`](control-loop.md) (resolver shape §2.3, step catalog §4, atlas §8,
> signals §7), [`projector.md`](projector.md), and [`schema.sql`](schema.sql). Mirrors
> `src/daemon/resolver.ts`; keep them in sync.

---

## 1. `next_step_key` — the deterministic state machine

The resolver's heart (control-loop §2.3 gave the shape; here is the concrete function). Given a
ticket's `stage` + work-unit states + the journal, it returns the next `step_key`. Transitions are
inline: the resolver advances `ticket.stage`, the runner enqueues the projection in the same tx
(projector §2), writes an `event_log` transition row, and recurses.

```
next_step_key(t):        # mirrors src/daemon/resolver.ts nextStepKey
  switch t.stage:

  'design':
    if not done('provision'):                          return 'provision'         # runs FIRST (env fault before any spend)
    if not done('design:dispatch'):                    return 'design:dispatch'
    if t.work_units == ∅:                              return 'design:extract'
    if t.track == null:                                return 'design:size'       # sets fast/full
    if t.track == 'full' and not done('design:review'):return 'design:review'
    if not done('checks:dispatch'):                    return 'checks:dispatch'   # author RED-first AC checks
    if not done('checks:classify'):                    return 'checks:classify'
    advance('design' -> 'implement'); recurse

  'implement':
    u = next_actionable_unit(t)        # first 'pending' unit whose depends_on are all 'verified'
    if u:
      if u.status == 'pending':                        return f'implement:wu{u.seq}:dispatch'
      if u.status == 'verifying':
        if not done('provision'):                      return 'provision'         # once per ticket
        if not done(f'completeness:wu{u.seq}'):        return f'completeness:wu{u.seq}'
        c = next_unrun_check(u)        # check-type with no verdict at u's current sha
        if c:                                          return f'verify:wu{u.seq}:{c}'   # ADVISORY
        return mark-verified(u)        # any verdict (pass OR fail) at the sha satisfies; only 'error' re-arms
    if all_units_verified(t):
      if gate_has_active_ac_checks(t) and gate not passed at branch HEAD:
        if behavioral_still_red(HEAD) and not blamed(HEAD): return 'checks:arbitrate'
        if blamed(HEAD) and not done('checks:reauthor'):    return 'checks:reauthor'
        if blamed(HEAD) and done('verify:checks-gate'):     escalate   # stuck HEAD, no further movement
        if not done('provision'):                           return 'provision'
        return 'verify:checks-gate'                                    # re-run the behavioral AC gate
      if integration not ran at branch HEAD:
        if not done('provision'):                      return 'provision'
        return 'verify:integration'                                    # ADVISORY (ran-at-sha)
      if t.needs_docs and not done('docs:revise'):     return 'docs:revise'
      advance('implement' -> 'review'); recurse
    else: blocked            # no actionable unit and not all verified → §8 owns it

  'review':
    if not done('review'):                             return 'review'
    advance('review' -> 'merge'); recurse

  'merge':
    if not done('merge:push'):                         return 'merge:push'
    if not done('merge:pr-ensure'):                    return 'merge:pr-ensure'
    # CI is reported, not gated (2026-07-18): merge:pr-ensure fires a best-effort t+0 CI read +
    # `ci_handoff` telemetry, then OSS `styre run` exits PR-ready. There is no merge:await-checks
    # branch, no `external_checks` signal, and nothing loops back on CI.
    if not delivered('human_merge_approval'):          return WAIT(human_merge_approval)   # OSS run exits here
    advance('merge' -> 'released'); recurse            # human merge + released = commercial plane

  'released':
    if not done('released:project'):                   return 'released:project'
    return DONE
```

`done(key)` = a `workflow_step` row with `status='succeeded'`. The resolver never re-runs a succeeded
step (replay; control-loop §6.2). A `failed` step is handled by `apply_failure_policy` (§8), which
**resets state so the resolver re-picks correctly** (§2 below) — the resolver itself stays a pure
forward function.

**`provision` (S2c, control-loop §4) fires once per ticket**, not once per unit: it gates the first
`verify:{u}:{c}` the ticket reaches *and* `verify:integration`, but a single `succeeded` row satisfies
both guards above — installs aren't repeated per work-unit. It is **reset to `pending`** (never
re-executed as a retry of the same attempt) in exactly two places outside the failure path: `styre run
--resume` (the worktree was wiped, so installed deps are gone) and when an `implement:{u}:dispatch`'s
committed diff touches a dependency manifest (`package.json`, a lockfile, `pyproject.toml`, …) — so a
loopback that adds a dependency doesn't verify against a stale environment. Both resets zero `attempt`
too (a fresh install is not a retry of a prior failed one).

**`completeness:wuN` (S2d, control-loop §4) fires once per unit**, gated after `provision` and before
the unit's first `verify:{u}:{c}` — a deterministic, runner-computed reconciliation of the unit's
declared `files_to_touch` against its diff, no LLM. `under = declared − cumulativeTouched` (the
lowest-seq unit's `base_sha` as the cumulative base, so a sibling's coverage counts — the fix for a
redundant/over-decomposed unit that would otherwise false-block on an empty diff): non-empty →
`under-delivered`, a **hard gate** that loops back to `implement:{u}:dispatch` with the missing files
named. Empty `under` with an empty own-diff → `covered-by-sibling` (no-op advance); empty `under` with
a non-empty own-diff → `completed-by-self` (advance). Over-delivery (`ownTouched − declared`) is always
advisory — emitted as `scope_diff`, an input to review, never a gate. This step is **recomputable**
(like `provision`): no exactly-once effect, safe to re-run on replay.

**The AC checks-gate is the real ship-gate of the implement stage.** The per-unit `verify:{u}:{c}`
build/test checks are **advisory** — a recorded verdict (pass *or* fail) at the unit's current sha
marks it `verified` and lets routing proceed; only a could-not-run `error` re-arms the check. What
actually blocks the ticket is the behavioral acceptance-criterion gate authored back in the design
stage: `checks:dispatch` derives acceptance criteria and writes RED-first `ac_check` tests (the
author is plan-blind — it sees only the AC text), and `checks:classify` triages the red-first traces.
Once all units are verified, if the ticket has active `ac_check`s and the gate has not passed at the
branch HEAD, the loop runs `verify:checks-gate` (integrity + a re-run of the AC checks). A still-red
gate is not simply a loopback — a red check is ambiguous, so `checks:arbitrate` assigns two-way
blame: `code-wrong` loops back to re-implement the blamed unit(s); `check-wrong` loops to
`checks:reauthor`, which rewrites the check. The gate is round-capped (`GATE_ROUND_CAP = 3`); a
pure-code-wrong round that commits nothing new leaves HEAD frozen and escalates as *stuck* rather
than spinning to the tick cap. Only after the gate passes does the (advisory) `verify:integration`
run, then the optional `docs:revise`, and the ticket advances to `review`.

## 2. Loopback effects — what a route *resets* (so §1 re-picks it)

The atlas (control-loop §8) says *where* a failure routes; the loop must set the state that makes
`next_step_key` go there. Per route:

The `event_log.loop` value is one of `implement`, `design`, `integration`, `checks`, `reauthor`
(there is no `plan` or `rebase` loop value in code). `resetToPending` does **not** touch `attempt`
(it increments at `markRunning`); several paths deliberately *zero* the attempt.

| Route | Runner resets | `event_log.loop` |
|---|---|---|
| verify/completeness fail, unit-scope | the unit → `pending` **and all its steps** → `pending` (previously-passed checks re-run at the new commit) | `implement` |
| integration throw | insert a `kind='reconcile'` unit depending on all others; reset the integration step, `verify:checks-gate` (attempt zeroed), `checks:arbitrate`, `checks:reauthor` | `integration` |
| code-review blocking finding (non-plan-defect) | blamed unit(s) (or all, if a finding has no unit) + their steps; the `review` step; the ticket verify/gate steps (gate attempt zeroed); `stage='implement'` | `implement` |
| plan-review blocking, or code-review `plan-defect` with `onPlanDefect='redesign'` | **delete all work_units**; reset+zero `design:dispatch`/`design:extract`/`design:review`/`review`; reset ticket verify steps; `stage='design'` | `design` |
| `checks:classify` leaves unresolved checks | supersede flagged `ac_check`s; reset `checks:dispatch` + `checks:classify`; **no stage flip** | `checks` |
| AC gate integrity-only still-red | all units → `pending` + their steps; the gate/arbiter/reauthor steps → `pending` (gate **attempt preserved** — it is the round counter) | `implement` |
| arbiter `check-wrong` | reset `checks:reauthor` + `checks:arbitrate` | `reauthor` |
| arbiter/reauthor `code-wrong` (or rejected) | gate-origin reset (units → pending) | `implement` |
| reauthor pure `check-wrong`, all installed | reset `verify:checks-gate` + `checks:arbitrate` only (units stay verified) | `checks` |
| escalate (attempt exhaustion, stuck gate, unresolved review) | `t.status='waiting'`; raise a `human_resume` signal | `escalated{reason}` |
| escalate, provision | **immediate on first failure** — no attempt exhaustion, no unit/ticket/plan reset (an env fault can't be fixed by re-implementing) | `escalated{reason}` |

A retry (no state rewind) — a could-not-run verify `error`, a completeness with no `fail` signal, or
the catch-all `resetToPending` — re-runs the same step; a repeated *identical* failure signature vs
the immediately-previous one escalates fast (the consecutive-identical guard, §4).

**CM1's loopback assumes no vacuous unit ever reaches implement:** `design:extract` (S1b) requires
every planned unit to declare ≥1 `files_to_touch`, so `completeness` never has to bounce a unit that
has nothing to touch back to implement with an empty instruction. `completeness` and
`verify:{u}:{c}` carry **independent** per-step `attempt` counters, not a shared per-unit budget — a
unit alternating between the two failure modes escalates at up to `maxAttempts × 2` implement
re-dispatches, still bounded, just not by a single cap. The semantic **AC-completeness** layer — a
dropped acceptance criterion, or a file declared by multiple units where the real work landed on none
of them — is **out of scope for CM1**; it is a deferred follow-up folded into S5 review.

## 3. Dispatch — the agent step

> **Provider-agnostic:** the agent runs behind a generic `AgentRunner` selected from config (the
> default is the Claude adapter; Codex is also registered). Model ids are per-tier config, not core
> assumptions.

The dispatch leaves were **ported into native TypeScript** — there is no shell-out to bash scripts
(`render-prompt.sh` / `dispatch.sh` / `gtimeout` are gone; the logic lives in
`src/dispatch/run-dispatch.ts` + `src/agent/runner.ts`). For an agent step the runner resolves the
model (via the step's tier), the step's tool allowlist (§4 catalog), and the timeout (§4), renders
the prompt from the compiled template + project profile (`render-prompt.ts`), spawns the agent CLI
with a scrubbed environment, **journals the spawned pid** (`recover()` orphan-kill), awaits, and
writes the result into SQLite (the worker never writes the DB).

**Two dispatch modes:**
- **Worktree agent (CLI leaf).** Steps that read/write the worktree — `design:dispatch` (plan doc),
  `implement`, conflict-resolution, `docs:revise`. The agent edits files; the runner commits (CL-COMMIT).
- **Structured judgment.** `design:extract`, `design:review`, `review` produce schema rows from
  artifacts. **At cutover** they use the CLI leaf with a **content-body sidecar** the runner
  zod-validates — and the §3a disambiguation still holds: an absent/malformed sidecar is a
  *transport* failure (re-dispatch, V4-class), a valid sidecar with findings is the verdict (no
  "bad-blob vs deny" ambiguity). The **in-context self-correction** of forced tool calls (the cost
  optimization) is **increment I-A** (§9.5: orchestrator-owns-artifact-envelope), which moves these
  steps to the forced-schema API. *Disambiguation now; cheaper self-correction at I-A.*

## 4. Budget numbers (as implemented)

The caps and timeouts actually enforced today, with their source constants. This table was once a
set of design targets; it is now reconciled to code.

| Knob | Value | Source | Notes |
|---|---|---|---|
| per-step attempt cap | **3** | `DEFAULT_MAX_ATTEMPTS`, failure-policy.ts | `attempt >= 3` on a step row → escalate. The primary budget. |
| consecutive-identical guard | **2** | failure-policy.ts | the same failure signature vs the immediately-previous loopback → escalate fast. |
| provision failure | **immediate** | failure-policy.ts | any `provision`/env failure escalates on the first occurrence (no attempt exhaustion). |
| AC-gate round cap | **3** | `GATE_ROUND_CAP`, arbiter-verdict.ts | keyed to `verify:checks-gate.attempt`; also caps re-author rounds. |
| re-author cap per AC | **2** | `REAUTHOR_ESCALATE_CAP`, checks-verdict.ts | an AC still flagged after 2 re-authors → no-progress escalation. |
| dispatch timeouts | design/review **60m**, default **30m**, verify **10m**, provision **15m** | handlers.ts | per step-type. |
| `OUTBOX_RETRY_BUDGET` | **5** | projector.ts | retried on the **next drain** (no backoff), then escalate (service down). |
| `CI_READ_TIMEOUT_MS` | **8s** | run-ticket.ts | bounds the one-shot t+0 checks read at merge; never a poll cadence — nothing in OSS polls. |
| `MAX_TRANSITIONS` | **100** | advance.ts | pure transitions per `advanceOneStep`. |
| per-ticket tick cap / idle cap | **200** / **3** | run-ticket.ts | overall iteration budget; 3 consecutive zero-advance ticks → `no-progress`. |
| `K` concurrency | **2** | `DEFAULT_MAX_CONCURRENT`, loop.ts | the multi-ticket cap — *commercial Control Plane*; OSS `styre run` is single-ticket. |

**Not implemented (deferred, despite earlier design notes):** the per-loop `K_DISTINCT` distinct-
attempt counter, the `B2` cross-loop escalation budget (3-consecutive / 20-total), and the `B3`
spend / wall-clock ceilings. No code reads `dispatch.cost_usd` for control. Do not describe these as
live behavior.

## 5. The needs-you inbox (D3)

> **[Commercial Control Plane]** The persistent needs-you inbox described in this section — including
> `styre inbox`, `styre status`, `styre resume --after-fix`, and `styre abandon` — is a **commercial
> Control Plane** feature. It requires a persistent service that can hold escalated tickets across
> runs. The design record below is preserved for reference.
>
> **OSS equivalent (`styre run` only):** an escalation that the loop cannot resolve makes
> `styre run` exit nonzero. A session-interruption (credits/limit hit) **parks (exit 75)** and
> resumes with `styre run --resume <ticket> --profile <p>` (see also `--accept-head`, `--inspect`).

The actionable surface for escalations — **SQLite-backed, not Linear** (Linear is the tracking mirror).
- **Source:** tickets with `status='waiting'` on a `human_*` signal, joined to their `event_log`
  `escalated` row and full trace.
- **Surface:** `styre inbox` / `styre status` (reads SQLite; renders **local tz**, DS-1). Each
  entry shows the reason, the failure history (the loopback signatures, the ground-truth signals,
  the failed dispatch), and the available actions.
- **Notify:** the *outbound* Slack notifier ships in the OSS core (a `NotifierPort` drained through
  `projection_outbox`, configured via `notifier`/`notify`/`slack`); the persistent *inbox* around it
  is commercial.
- **Actions (CLI, deliver the `human_resume` signal):**
  - `styre resume <ticket>` — re-enter the parked step; reset per-loop + B2 counters; fresh B3 allowance.
  - `styre resume <ticket> --after-fix` — operator edited plan/code/config by hand; the runner
    picks up the changed worktree/SoT state.
  - `styre abandon <ticket>` — terminal (`status='abandoned'`; projector → Canceled).

## 6. End-to-end — a clean run

A clean fast-track backend ticket exercises the whole spine:

```
provision(runner; installs each component's prepare — runs FIRST)
 → design:dispatch(deep,plan) → design:extract(cheap,work_units) → design:size(cheap → fast track)
 → checks:dispatch(standard; author RED-first AC checks) → checks:classify(standard)   # fast track: skip design:review
 → implement:wu1:dispatch(standard,code+tests; runner commits)
 → completeness:wu1(runner,plan-vs-diff reconciliation; once per unit)
 → verify:wu1:build,test(runner,ground-truth; ADVISORY) → mark wu1 verified
 → verify:checks-gate(runner; behavioral AC checks green at HEAD)     # the real gate; arbiter/reauthor on red
 → verify:integration(runner; ADVISORY)
 → review(deep,findings via interface → 0 blocking) → merge:push
 → merge:pr-ensure(cheap body; t+0 CI read → `ci_handoff` — OSS `styre run` exits PR-ready here)
 → [commercial plane] human merge → released:project(→ Done)
```
…with every step journaled (`workflow_step`), every transition mirrored (`event_log` + the
projector), and a crash at any point resuming from the journal.

## 7. Scope — what's deliberately minimal

- **Deterministic routing only.** The §8 atlas is fixed rules keyed by the detecting step. No LLM
  supervisor, no memory/RAG, no learned deferral — those are post-cutover (§9.5 I-C/I-D).
- **The KEEP↻ gates** are the four irreducible ground-truth gates (builds / tests / diff-⊆-scope via
  the reviewer / independent reviewer) looping with feedback — nothing more.
- **Human gates wired = MERGE only** (`human_merge_approval`, the point OSS `styre run` exits) +
  escalations (`human_resume`). The schema comment also names `human_plan_approval` (an optional
  large-ticket plan-approval gate) — **defined but not wired**: no code inserts or awaits it; the
  design phase ends at the agent plan-review (`design:review`).
- **Post-cutover increments** (out of scope here): forced-schema structured steps, ground-truth
  deepening, the Unified Gate Layer, and a supervisor + memory on the clean trace.
