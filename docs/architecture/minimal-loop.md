# The Minimal Loop

> **This describes the per-ticket minimal loop that **`styre run`** executes (the OSS core). The
> **needs-you inbox** and multi-ticket orchestration are the **commercial Control Plane**, fenced
> below.**

> **Artifact for §9.4 checklist #5** of [`brainstorm.md`](brainstorm.md). Wires the pieces into the
> first end-to-end `design → released` run on the new substrate: the concrete **`next_step_key`
> state machine**, the **dispatch shell-out** to the kept leaves, the **budget numbers** (the
> deferred loose ends), and the **needs-you inbox** (D3). **NOT the autonomy layer** — deterministic
> routing only; supervisor/memory are post-cutover increments.
>
> Builds on [`control-loop.md`](control-loop.md) (resolver shape §2.3, step catalog §4, atlas §8,
> signals §7), [`projector.md`](projector.md), and [`schema.sql`](schema.sql). Status: draft 2026-06-19.

---

## 1. `next_step_key` — the deterministic state machine

The resolver's heart (control-loop §2.3 gave the shape; here is the concrete function). Given a
ticket's `stage` + work-unit states + the journal, it returns the next `step_key`. Transitions are
inline: the resolver advances `ticket.stage`, the runner enqueues the projection in the same tx
(projector §2), writes an `event_log` transition row, and recurses.

```
next_step_key(t):
  switch t.stage:

  'design':
    if not done('design:dispatch'):                 return 'design:dispatch'
    if t.work_units == ∅:                            return 'design:extract'
    if completeness_failed:                          return 'design:dispatch'     # D2 (re-design)
    if t.track == 'full' and not done('design:review'): return 'design:review'
    advance('design' -> 'implement'); recurse

  'implement':
    u = next_actionable_unit(t)        # first 'pending' unit whose depends_on are all 'verified'
    if u:
      if branch_behind_origin(t):                    return f'{u}:rebase'
      if u.status == 'pending':                      return f'{u}:dispatch'
      if u.status == 'verifying':
        c = next_unrun_check(u)        # a check-type in u.verify_check_types with no pass/fail signal
        if c:                                        return f'verify:{u}:{c}'
        # all checks ran clean → the verify step marks u 'verified' on its success commit
    if all_units_verified(t):
      if not done('verify:integration'):             return 'verify:integration'
      if t.needs_docs and not done('docs:revise'):   return 'docs:revise'
      advance('implement' -> 'review'); recurse
    # else: no actionable unit and not all verified → a unit is failed/blocked → §8 owns it

  'review':
    if not done('review'):                           return 'review'
    advance('review' -> 'merge'); recurse

  'merge':
    if not done('merge:push'):                       return 'merge:push'
    if not done('merge:pr-ensure'):                  return 'merge:pr-ensure'
    if not delivered('external_checks'):             return 'merge:await-checks'
    if not delivered('human_merge_approval'):        return 'merge:await-human'
    advance('merge' -> 'released'); recurse

  'released':
    if not done('released:project'):                 return 'released:project'
    t.status = 'done';                               return DONE
```

`done(key)` = a `workflow_step` row with `status='succeeded'`. The resolver never re-runs a succeeded
step (replay; control-loop §6.2). A `failed` step is handled by `apply_failure_policy` (§8), which
**resets state so the resolver re-picks correctly** (§2 below) — the resolver itself stays a pure
forward function.

## 2. Loopback effects — what a route *resets* (so §1 re-picks it)

The atlas (control-loop §8) says *where* a failure routes; the loop must set the state that makes
`next_step_key` go there. Per route:

| Route | Runner resets | `event_log` |
|---|---|---|
| → implement, unit-scope (I3/I4/I5, V1) | the named unit(s) → `status='pending'`; `stage='implement'` | `loopback{loop, route_to, signature}` |
| → implement, ticket-scope (N1, P1) | spawn a ticket-scoped reconcile unit (kind=`reconcile`); `stage='implement'` | `loopback` |
| → design / pivot (D2/D3, DV1, V3) | clear `work_units`; reset the design steps; `stage='design'` | `loopback{loop='plan'}` |
| retry (I1, I6, V4, P2, C1) | the step → `status='pending'`, `attempt+=1` (no state rewind) | — (retry, not loopback) |
| escalate (any exhaustion, R3/R4, V-def, X1/X2) | `t.status='waiting'`; raise a `human_resume` signal | `escalated{reason}` |

Only **distinct** loopbacks (signature changed) bump the per-loop counter (§3); a retry of the same
signature trips the consecutive-identical cap faster (control-loop §8.2).

## 3. Dispatch shell-out — keeping the leaves (§9.1)

> **Provider-agnostic (2026-06-21):** the `claude -p` invocation below is the *default Claude
> adapter*, not a core assumption. The agent runs behind a generic `AgentRunner` selected from
> config; see `docs/brainstorms/2026-06-21-provider-agnostic-agent-design.md`.

The runner owns control; the agent *work* runs through the kept bash leaves. For an agent step the
runner: resolves model (F1) + the step's tool allowlist (§4 catalog) + timeout (§4 below), renders
the prompt (`render-prompt.sh` + project-profile), invokes `dispatch.sh` (`claude -p --allowed-tools
… --model …` under `gtimeout`), **journals the spawned pid** (recover() orphan-kill), awaits, and
writes the result into SQLite (B2 — the worker never writes the DB).

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

## 4. Budget numbers (the deferred loose ends, pinned)

All operator-tunable in `config.json`; these are the cutover defaults.

| Knob | Default | Notes |
|---|---|---|
| `K_DISTINCT` (distinct corrective attempts / loop) | **3** | per-loop counter; resets on the loop passing |
| consecutive-identical cap | **2** | same failure signature back-to-back → escalate fast |
| `B2` escalation budget | **3 consecutive / 20 total** | per ticket-life; the cross-loop thrash catcher |
| `B3` spend ceiling (P3) | **3× rolling-median clean-ticket $** | auto-calibrated per project; bootstrap floor **$25** until ≥N clean tickets exist |
| `B3` wall-clock ceiling (P3) | **3× median clean-ticket wall-clock** | bootstrap floor **4h** |
| per-stage dispatch timeout | design/review **60m**, others **30m** | ports ENG-65; under `gtimeout` |
| `OUTBOX_RETRY_BUDGET` | **~10 attempts / ~30m backoff** | then escalate X1 (service down) |
| `POLL_INTERVAL` | **60s** | loop idle + checks-system poll cadence |
| `K` concurrency | **2** | `CLAUDE_MAX_CONCURRENT` → `orchestrator.max_concurrent_features` → 2 |

Spend/wall-clock per ticket are **derived**: `SUM(dispatch.cost_usd)` and `now − ticket.created_at`
(or summed dispatch durations). The median is a rolling window over `done` tickets per project.

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
- **Notify:** Slack on each new escalation (the kept `slack.sh` leaf).
- **Actions (CLI, deliver the `human_resume` signal):**
  - `styre resume <ticket>` — re-enter the parked step; reset per-loop + B2 counters; fresh B3 allowance.
  - `styre resume <ticket> --after-fix` — operator edited plan/code/config by hand; the runner
    picks up the changed worktree/SoT state.
  - `styre abandon <ticket>` — terminal (`status='abandoned'`; projector → Canceled).

## 6. End-to-end — the cutover acceptance run

> **[Commercial Control Plane — partial]** The flip criterion referencing **launchd** (repointing the
> host service) and the persistent daemon supervision apply to the commercial plane. The acceptance
> run itself — watching one full ticket `design → released` — is valid for the OSS `styre run` as
> a one-shot headless run.

The flip criterion (§9.4): repoint launchd → **watch one full ticket `design → released` on the new
loop** → if green, decommission the old write paths. A clean fast-track backend ticket exercises the
whole spine:

```
design:dispatch(Opus,plan) → design:extract(Haiku,work_units)            # fast-track: skip design:review
 → implement:wu1:rebase(runner) → implement:wu1:dispatch(Sonnet,code+tests; runner commits)
 → verify:wu1:build,test(runner,ground-truth) → verify:integration(runner)
 → review(Opus,findings via interface → 0 blocking) → merge:push → merge:pr-ensure(cheap-AI body)
 → merge:await-checks(poll) → merge:await-human(operator merges) → released:project(→ Done)
```
…with every step journaled (`workflow_step`), every transition mirrored (`event_log` + projector →
Linear), and a crash at any point resuming from the journal. Green = flip; misbehaves in week 1 =
flip back (§9.4 #7).

## 7. Scope — what's deliberately minimal

- **Deterministic routing only.** The §8 atlas is fixed rules keyed by the detecting step. No LLM
  supervisor, no memory/RAG, no learned deferral — those are post-cutover (§9.5 I-C/I-D).
- **The KEEP↻ gates** are the four irreducible ground-truth gates (builds / tests / diff-⊆-scope via
  the reviewer / independent reviewer) looping with feedback — nothing more.
- **Human gates wired = MERGE only** (`human_merge_approval`) + escalations (`human_resume`). The
  schema also defines `human_plan_approval` (the *optional large-ticket plan-approval* gate, D1 /
  control-loop §7) — **defined but not wired at cutover**; the minimal loop's design phase ends at
  the agent plan-review (S1c), and human plan-approval is added later for large tickets if wanted.
- **Increments after the flip** (§9.5): I-A forced-schema structured steps · I-B ground-truth
  deepening · I-C the UGL · I-D supervisor + memory on the clean trace.

## 8. Mapping to §9.4 #5

- ✅ **drives the deterministic state machine** — `next_step_key` (§1) + loopback resets (§2),
  the new C1 machine `design → implement[units] → verify → review → merge → released`.
- ✅ **+ the Deliverable-1 KEEP↻ gates** — §7.
- ✅ **shells out to `dispatch.sh`** for the agent step — §3, keeping the knowledge-dense leaves.
- ✅ **NOT the autonomy layer** — §7 scope boundary.

**This completes the substrate spec** (§9.4 #1 schema, #2 control-loop, #3 dropped, #4 projector,
#5 this). Remaining before a flip are operational, not design: #6 track-1 fixes (can ship on the old
substrate first), #7 the rollback path, and building + verifying the above in the downtime window.
