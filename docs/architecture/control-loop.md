# Durable Control-Loop Semantics

> **OSS boundary.** This describes the per-ticket control loop that **`styre run`** executes (the OSS
> core): resolve `next_step_key` → dispatch → persist → project → loopback, driving **one** ticket to
> PR-ready, then exit. The **outer multi-ticket loop** — ready-ticket pickup, K-concurrency, persistent
> host-service supervision, and the needs-you inbox — is the **commercial Control Plane** and is fenced
> as such below (§2.1, §2.2, §10, and the human-merge/inbox passages). The OSS core has zero knowledge
> of the plane; the plane integrates only through the versioned seam.

> **Artifact for §9.4 checklist #2** of [`brainstorm.md`](brainstorm.md). The execution semantics of
> the single-process control loop — **the runner** (decision **B1**) — that drives
> [`schema.sql`](schema.sql). Substrate only — NOT the autonomy layer (no LLM supervisor / memory;
> those are post-cutover increments).
>
> **Acceptance (§9.4 #2), discharged in §6–§7:** (1) a step that already ran returns its recorded
> result on replay; (2) external side-effects carry idempotency keys; (3) crash mid-step resumes
> at that step.
>
> Status: step catalog frozen 2026-06-19 after a full operator walkthrough (S1–S10). Decisions
> tagged **CL-#**.

---

## 0. Vocabulary

- **The runner** — the single-process control loop, `styre run` (decision **B1**). The only writer of
  the SQLite SoT (**B2**). It drives one ticket to PR-ready and exits. *(Commercial Control Plane: in
  the plane, many such runs are kept alive / orchestrated by a persistent host service — launchd on
  macOS, systemd on Linux; **B4**. The persistent service is not part of the OSS core.)*
- **Workflow** — the lifecycle of one `ticket`, `design → released`. Long-running; many dispatches
  and human waits.
- **Step** — one durable unit of progress, a `workflow_step` row. Deterministic `step_key`; carries
  a recorded result; re-entrant via replay. `UNIQUE(ticket_id, step_key)` → one row per logical
  step; retries increment `attempt`.
- **Worker / dispatch** — a `claude -p` agent run (the kept `dispatch.sh` leaf). Workers return
  results; they never write SQLite (B2).
- **Effect** — a change outside SQLite. **Local** = on this host (spawn a worker, run a build, local
  git). **External** = on a remote service (Linear, GitHub, git push) → always via the outbox (§5).

---

## 1. Design goals

1. **Recover, don't halt.** Any anomaly is absorbed, looped with feedback, or parked as a resumable
   wait — never a dead halt that strands a ticket.
2. **Durable + replayable.** Crash anywhere resumes from the journal; effects are exactly-once.
3. **Single-writer simplicity (B2).** One runner writes one SQLite file.
4. **Trivial to install (`GOAL-INSTALL`).** A new operator brings up the whole system with one
   command, no servers, no runtime dance (§10). A hard constraint that shapes real choices below
   (e.g. polling over webhooks in S8).

---

## 2. Execution model (B1 / B2 / B4)

### 2.1 One process, one SoT, all projects `[CL-1 — DECIDED 2026-06-19]` *(commercial Control Plane)*
> **Commercial Control Plane.** This §2.1 multi-project pickup model is the *outer* loop and lives in
> the commercial plane, not the OSS core. In the OSS core, `styre run` drives **one** ticket against a
> single (ephemeral, per-run) SQLite SoT and exits; there is no multi-project, always-on process.

A single process serves all projects against one SQLite file (a shift from today's per-project
launchd jobs). The single-writer invariant only means something with exactly one writer; one DB +
one writing process makes two-authoritative-writers (ENG-217) impossible globally. K=2–3 concurrency
makes contention a non-issue, and it serves GOAL-INSTALL (one service, not N). Projects stay isolated
by the `project_id` FK and the per-project `project.paused` breaker.

### 2.2 The multi-ticket event loop *(commercial Control Plane)*
> **Commercial Control Plane.** The `while`-poll/`v_ready_tickets`/K-concurrency event loop below is
> the *outer* multi-ticket loop — it belongs to the commercial plane. The OSS `styre run` does **not**
> poll for ready tickets or run multiple tickets concurrently; it bootstraps (`on_start`), recovers
> (§6.1), then runs the **inner** per-ticket loop (`advance_one_step`, §2.3) on its single ticket to
> PR-ready and exits. The inner-step mechanics referenced here — `drain_outbox` (§5),
> `advance_one_step` (§2.3), result journaling — *are* OSS-core; only the multi-ticket scheduling
> wrapper is commercial.
```
on_start():
  open_db(); PRAGMA foreign_keys=ON; busy_timeout=5000
  migrate()                       # §10 self-bootstrap / apply pending schema migrations
  recover()                       # §6.1 reconcile crash-interrupted steps + drain outbox
  loop()

loop():                           # (commercial Control Plane: the multi-ticket scheduler)
  while running:
    drain_outbox()                # §5 execute pending external effects idempotently
    poll_external_signals()       # §7.3 checks-system status, PR-merged -> deliver signals
    ready = SELECT * FROM v_ready_tickets ORDER BY <stage_index DESC, priority DESC, created_at ASC>
    for ticket in ready:
      if inflight_count() >= K: break       # K = orchestrator.max_concurrent_features (2–3)
      spawn_async(advance_one_step, ticket)
    await_any_completion_or(timeout=POLL_INTERVAL)
```
`v_ready_tickets` already excludes paused projects and tickets parked on a pending signal. Workers
run concurrently; the runner journals each result as it returns. **No worker touches SQLite.**

### 2.3 `advance_one_step(ticket)` — the resolver
A pure resolver maps current state + journal to the next `step_key`; the workflow definition is code.
```
key  = next_step_key(ticket)              # deterministic (CL-INV-1); the state machine
step = upsert_step(ticket, key)
if step.status == 'succeeded': recurse    # already applied; move on (§6.2)
if step.status == 'running':   return     # in-flight; recover() owns it
if step.status == 'failed':    return apply_failure_policy(step)   # §8
if not guard_holds(step):      return park_or_block(step)
execute(step)                              # §3
```
The lifecycle is the new C1 vocab (DS-2): `design → implement → verify → review → merge → released`,
expanded by the step catalog (§4).

---

## 3. The step contract

**Pure step** (result is a deterministic function of SQLite data) — single transaction: compute →
`UPDATE … status='succeeded', result_json=…` + downstream changes + outbox enqueues, all atomic.
Replay returns `result_json`; never re-runs.

**Effectful step** — the effect can't join the DB transaction, so **intent is journaled before the
effect** and the effect is **idempotent** (universal write-ahead discipline):
```
(1) BEGIN; UPDATE step SET status='running', attempt+=1, idempotency_key=K, started_at=now; COMMIT
(2) result = do_effect(step, K)          # idempotent; EXTERNAL effects via the outbox (§5)
(3) BEGIN; UPDATE step SET status='succeeded', result_json=result;
           <state transition + outbox enqueues>; COMMIT
```
A crash between (1) and (3) leaves `status='running'` with a known `idempotency_key` — the sole
signal `recover()` needs (§6.1).

> **Idempotency keys are globally unique BY CONSTRUCTION** — `K` is built by prefixing the
> `dispatch_id` (e.g. `ENG-5-d0003-push`), so the schema's *global* `UNIQUE` on `idempotency_key`
> **is** the dedup mechanism. (Don't scope the constraint to a ticket — that would weaken the
> exactly-once guarantee an effect key exists to provide.)

---

## 3a. Structured output: act through a validated interface, never parse a free-form blob `[CL-FROZEN]`

The single most load-bearing reliability rule, and the reason the review stage was redesigned:

> **An agent never emits a serialized decision for the runner to parse. It takes actions through a
> schema-validated tool interface, and the runner computes the decision from the resulting state.**

Why: a serialized JSON verdict conflates two failure modes the runner must distinguish — *malformed
output* vs *a real "no" decision*. If they share one channel, a formatting slip masquerades as a
deny, the runner conservatively re-runs an expensive agent, and the format-error rate is
unmeasurable (so unhardenable). The validated-interface pattern dissolves this:

- structured values are submitted via a **validated sidecar**: the agent emits a fenced
  ```` ```styre-sidecar ```` JSON block that the runner extracts and zod-validates
  (`dispatch/sidecar.ts`); an absent/malformed block is a transport failure (re-dispatch), never a
  verdict. (Provider-native constrained decoding — e.g. Codex `--output-schema` — is a possible
  future hardening, DEC-CX-8b; the fenced sidecar is provider-independent and ships today.)
- the runner then only ever observes two unambiguous states: **completed** (a clean dispatch end /
  an explicit `complete()` call → state present → deterministic decision) or **transport failure**
  (dispatch died / never completed → retry the dispatch). These are separately counted and
  separately hardenable.
- the runner **computes** the decision from the accumulated state, never from a parsed blob.

**Reason/extract, refined.** The expensive reasoner emits rich content (its strength). Turning that
into schema rows happens via the validated interface, by one of two means:
- **mechanical formalization** (e.g. a plan → `work_unit` rows) → a *cheap* model does it, as a cost
  optimization (the cheap-extractor split). It is not judging, only formalizing.
- **judgment-bearing fields** (e.g. a review finding's severity) → the *reasoner itself* files them
  via forced-schema tool calls, because the fields *are* its judgment; a cheap model must not
  re-derive judgment from prose.

The cheap extractor is an optimization; the validated interface + state-derived decision is the
correctness mechanism.

---

## 4. Step catalog — guards, inputs, outputs, tools

> **Provider-agnostic (2026-06-21):** the per-step **Model** (Opus/Sonnet/Haiku) is the *default
> Claude adapter*'s preset. Steps map to abstract tiers (deep/standard/cheap); the concrete model id
> + provider come from config behind a generic `AgentRunner`. See
> `docs/brainstorms/2026-06-21-provider-agnostic-agent-design.md`.

Each step declares **Guard** (precondition to fire), **Input**, **Output** (postcondition + rows),
**Tools** (agent steps) or **Commands/Capability** (runner-executed steps), **Model** (agent steps),
and **Failure → route** (see the Loopback Atlas, §8). An unmet guard *parks or blocks*, it does not
fail.

Capability frame (move 4) applies to every agent step: the **worktree is the only writable surface**;
agents have **no outward tools** — no `gh`, no `git push`, no Linear, no ambient key, no `curl`.
Every external effect is the runner's (§5). **The runner commits, not the agent** (`[CL-COMMIT]`):
agents only edit files; the runner commits each dispatch's worktree changes with a deterministic
message (incl. `dispatch_id`) and records the SHA — so agents need no git tool at all.

> **Orchestration is the runner's, not a master agent's (`[CL-ORCH]`).** The implement phase is a
> *sequence of focused steps the runner orchestrates* (rebase → implement → verify …), not one
> LLM "master agent" driving sub-agents. An LLM orchestrator would be non-deterministic, unjournaled,
> and un-resumable mid-sequence, and would need broad spawn authority. The runner owns the
> *between-step* orchestration; an agent owns only its *within-step* loop (e.g. implement's
> code↔test iteration).

**Per-step postcondition (`[CL-POSTCOND]`).** Every dispatch step has a concrete runner-checked
postcondition — *did this step actually produce its output?* (design → plan committed; review →
completed with a findings ledger). A clean dispatch that fails its postcondition is that step's
failure, routed per §8 — **no step can silently no-op.** (This decomposes the legacy
`agent-contract-missing` into per-step checks.) **Implement is the exception:** its dispatch has no
non-empty-diff postcondition (the plan gate at `design:extract` already guarantees every unit
declares ≥1 file, so a vacuous unit never reaches implement); an empty *actual* diff is instead
caught downstream as under-delivery by `completeness:wuN` (S2d, §8 row CM1), not thrown as a
dispatch-level failure.

**Pre-dispatch profile-completeness gate (`[CL-PROFILE]`).** Before *any* dispatch, the runner
verifies the project-profile resolves every input the rendered prompt needs (no unresolved
placeholder). An incomplete profile **does not dispatch** — it escalates as a setup error (a
GOAL-INSTALL touchpoint; replaces the legacy `header-missing-inputs`).

### Design

**S1a · `design:dispatch`** — fused brainstorm + plan (Opus 4.8)
- **Guard:** `stage='design'`; worktree exists (else `worktree-ensure` runs first); no succeeded
  `design:dispatch` unless a re-design loopback was requested.
- **Input:** ticket identity/title/`type_label` + description **injected by the runner** (the agent
  does not read Linear); the design prompt (`render-prompt.sh`) + project-profile.
- **Output:** a committed **plan artifact** (`docs/plans/<date>-<eng-n>-*.md`, `linear: ENG-N`
  frontmatter). The plan must *contain*, per work-unit, the facts S1b needs (kind, files, behavioral?
  + how tested, verify check-types, dependencies) — as prose, never as JSON. Sets `needs_docs`
  (whether the change is doc-impacting).
- **Tools:** `Read`, `Grep`, `Glob`; `Write`/`Edit` **restricted to `docs/**`**; `WebSearch`,
  `WebFetch`, Context7 (read-only). ❌ no `Bash`, no outward tools.
- **Failure → route:** D2/D3 in §8.

**S1b · `design:extract`** — decomposition into `work_unit` rows (Haiku 4.5, forced structured output)
- **Guard:** S1a succeeded (plan committed).
- **Input:** the committed plan doc + the `work_unit` schema.
- **Output:** validated **`work_unit` rows** (kind / files_to_touch / behavioral / test_plan /
  verify_check_types / depends_on). The runner then runs the **mechanical completeness check** (zod
  shape + required fields present + behavioral⇒`test_plan` present + `depends_on` acyclic & valid) —
  deterministic, no LLM. **Postcondition: ≥1 work_unit, completeness clean.** **Track** (fast/full,
  C2) is set here from the sizing rubric: fast-track → `stage='implement'`; full-track → S1c first.
- **Mechanism:** mechanical formalization → cheap model, forced-schema tool calls (§3a). The
  extractor fills only what the plan supports and leaves unsupported fields empty — it never
  invents; an empty *required* field means the **plan** is missing that info (→ D2).
- **Failure → route:** shape failure → cheap retry (D1); completeness gap, an empty required field
  the plan didn't supply → re-design (D2); no plan / no units (D3).

**S1c · `design:review`** — semantic plan-quality gate (cold; Opus 4.8; **full-track only**, C2)
- **Guard:** S1b completeness clean; `track='full'`.
- **Input — cold (anti-anchoring):** the plan + the ticket requirements + the codebase. **NOT** the
  designer's reasoning.
- **Mechanism (§3a):** files findings via tool calls (`file_finding` / `complete_review`); the runner
  derives the verdict from the ledger — the **same machinery as code-review (S5)**, applied to the
  plan.
- **Dimensions:** feasibility/correctness · completeness-of-substance · internal consistency · scope
  (over/under, vs the sizing rubric) · conciseness/anti-slop · testability (a *meaningful* test_plan,
  not just present) · decomposition quality.
- **Verdict (runner-derived):** any blocking plan-finding → loop back to **S1a re-design** with the
  findings; else → `stage='implement'`.
- **Tools:** `Read`, `Grep`, `Glob` (+ read-only git); `file_finding`, `complete_review`. ❌ no
  `Write`/`Edit`, no execution, no outward tools.
- **Why (shift-left):** one Opus read of the plan is an order of magnitude cheaper than catching the
  same defect at code-review/implement; it **shrinks V3** (the full-ticket reset). Serves the cost
  principle (§8 P3/P4).
- **Failure → route:** DV1/DV2 in §8.

### Implement (per work-unit; runner-orchestrated sequence)

**S2a · `implement:wuN:rebase`** — keep the branch current (hybrid: runner-first, agent-on-conflict)
- **Guard:** branch is behind `origin/<base>`.
- **Runner path (common, no LLM):** `git rebase origin/<base>`; clean → done, journal new HEAD.
- **Conflict → conflict-resolution agent (Sonnet 4.6; Opus on repeat):**
  - **Input:** conflicted files (markers), the plan doc (intent), both sides, profile.
  - **Output:** resolved files. The **runner** then `git add` + `rebase --continue` and re-runs verify.
  - **Tools:** `Read`, `Grep`, `Glob`, `Write`, `Edit` (worktree); scoped `Bash` = read-only git +
    profile test/build self-check. ❌ no git-write (runner drives `--continue`), no push/`gh`.
- **Note:** during implement the branch is local-only (push is at merge), so rebase needs no
  force-push. A rebase *after* push uses **force-push-with-lease to the feature branch only — never
  `main`/protected** (`hard_deny`).
- **Failure → route:** R1/R2 in §8.

**S2b · `implement:wuN:dispatch`** — write the code + its tests (Sonnet 4.6; Opus on loopback)
- **Guard:** `stage='implement'`; `wuN.status='pending'`; every `wuN.depends_on` unit `verified`;
  plan committed; rebase current.
- **Input:** the `work_unit` spec; the plan doc; implement prompt + profile; worktree at branch HEAD.
- **Output:** code **+ the unit's tests** edited in the worktree → **runner commits** → SHA recorded,
  `dispatch` row, `wuN.status='verifying'`. **Postcondition: branch HEAD advanced** (the commit
  happened) — there is no dispatch-level non-empty-diff check; that guarantee now comes from the plan
  gate (every unit declares ≥1 file at `design:extract`) plus `completeness:wuN` (S2d) gating
  under-delivery downstream. No schema-extraction step — implement's output is code, judged by
  ground-truth verify, not a payload.
- **Tools:** `Read`, `Grep`, `Glob`; `Write`/`Edit` **full worktree** (`files_to_touch` is advisory,
  A3 — reviewer-judged, not tool-enforced); `Bash` = **profile's kind-appropriate build/test/lint
  runners only** (the within-step code↔test self-check loop). ❌ no git tools, no outward tools,
  no arbitrary Bash.
- **Failure → route:** I1 in §8 (empty-diff is no longer routed here — the plan gate rejects
  no-file units and `completeness:wuN`/CM1 gates under-delivery; I2 is superseded by CM1).

**S2c · `provision`** — ready the verify environment (runner-executed, no LLM)
- **Guard:** `stage='implement'`; a work-unit is `verifying` (about to run its first unrun check) **or**
  all units are verified and integration hasn't passed at the current SHA; `!done('provision')`. Fires
  **once** per gate — before the first `verify:wuN:<check>` of the ticket **and** before
  `verify:integration` — never re-runs while its step row stands `succeeded`.
- **Input:** each profile `Component`'s `prepare` (the setup-recorded, `isCommandSafe`-validated
  install command, §3 flip — stored→executed); worktree at current HEAD.
- **Output:** each not-yet-ready component installed; a `ground_truth_signal(signal_type='provision')`
  row per component (`pass`/`fail`/`error`). For Python editable-install components, an additional
  worktree-source assertion — `import <pkg>` resolves under the worktree, not a shadowing
  pre-installed/conda copy — remediated once (`pip install -e . --force-reinstall --no-deps`) before
  failing. All actions clean → `done('provision')`, unblocking the gated verify step.
- **Commands/Capability:** **only** each component's `prepare` (never `commands.test`) run via
  `runCommand` under `verifyEnv` (creds scrubbed), on an **independent** `PROVISION_TIMEOUT_MS` (15
  min — not the shared dispatch timeout, review F-5); plus, for editable Python, a generated
  source-check script run the same way. Never arbitrary shell. A component with no `prepare` is
  skipped (graceful degradation, never a hard fail at run-start).
- **Idempotency / re-arm:** a component already ready (e.g. Node's completed
  `node_modules/.package-lock.json` marker) is skipped on re-entry. The step itself is reset to
  `pending` (attempt zeroed, not counted as a retry) by `styre run --resume` (the worktree was wiped)
  and when an `implement:wuN:dispatch`'s committed diff touches a dependency manifest (review F-2) —
  so a once-gated `provision` never goes silently stale.
- **Failure → route:** **escalate immediately** — an environment error (broken lockfile/env, or a
  worktree source that can't be proven under test), never a code defect, so it is never routed back to
  implement (re-implementing can't reach it under capability isolation). See §8, row E1.

**S2d · `completeness:wuN`** — deterministic plan-vs-diff reconciliation (runner-executed, no LLM)
- **Guard:** a work-unit is `verifying`; `done('provision')`; `!done('completeness:wuN')`. Fires
  **once** per unit, gated between S2c `provision` and the unit's first `verify:wuN:<check>` — after
  the provision gate, before the unit's next-unrun-check lookup.
- **Input:** `wuN.files_to_touch` (the declared scope); two diffs, both via `changedFilesBetween`,
  because under- and over-delivery need opposite bases — the unit's **own** diff (base = `wuN`'s own
  `base_sha`, head = its latest dispatch SHA — identical to what `verify:check` used before this step
  absorbed the calculation) and the **cumulative** ticket diff (base = the **lowest-seq unit's**
  `base_sha`, the ticket fork point — never the processed unit's own base, which for a later unit would
  exclude an earlier sibling's already-landed work); worktree at the unit's latest SHA.
- **Output:** a **`completeness`** ground-truth signal (`result ∈ pass|fail`, `detail_json =
  {disposition, under, declared}`); an advisory **`scope_diff`** signal (own-diff-based over-delivery —
  the same signal `verify:check` used to produce, now emitted here instead).
  `under = declared − cumulativeTouched` (did *anyone* touch the declared file — a sibling's coverage
  counts, so a redundant/over-decomposed unit is not flagged); `over = ownTouched − declared` (did
  *this* unit touch something undeclared — always its own diff, never cumulative, or every prior unit's
  files would be misattributed as this unit's over-reach).
- **Dispositions:** `under ≠ ∅` → `under-delivered` — **hard gate**, loopback (§8); `under = ∅` and
  `ownTouched = ∅` → `covered-by-sibling` — no-op success, advance (fixes the false-block where a
  redundant unit's declared work was already done by a sibling); `under = ∅` and `ownTouched ≠ ∅` →
  `completed-by-self` — advance. `over` is always advisory; it never fails this step.
- **Precondition (plan gate):** `design:extract` (S1b) requires every planned unit to declare ≥1
  `files_to_touch`, so a vacuous unit fails plan validation and re-dispatches `design:extract` instead
  of ever reaching implement — `completeness` is never asked to loop back a unit with nothing to touch.
  The runner-created `reconcile` unit (ticket-scoped, declares no files by design, §8 N1) is exempt and
  is governed by `verify:integration`, not this step.
- **Commands/Capability:** none — pure git-diff + set arithmetic against already-committed state; no
  install, no build/test runner, no LLM. **Recomputable, no exactly-once effect** (like `provision`/S3):
  safe to re-run on replay.
- **Scope (a known, deliberate limit):** file-granular and plan-anchored — verifies *self-consistency*
  (implement matches the declared plan), not *validity* (the plan matches the ticket) or
  content-completeness (a stub or partial edit within a touched file). The semantic
  **AC-completeness** layer — a dropped acceptance criterion, or a file declared by multiple units
  where the real work landed on none of them — is a **deferred follow-up**, folded into S5 review as a
  new finding category, not a parallel journaled step.
- **Failure → route:** under-delivery in §8 (**Completeness**, row CM1).

### Verify (ground truth; runner-executed, no LLM)

**S3 · `verify:wuN:<check>`** — per-work-unit ground truth (one step per check-type)
- **Guard:** `wuN.status='verifying'`; `<check> ∈ wuN.verify_check_types`; profile declares a command
  for it.
- **Input:** the profile command for this check-type (F4); worktree at wuN's SHA.
- **Output:** a **`ground_truth_signal`** row (`signal_type` = the declared check-type, `result ∈
  pass|fail|error`, `detail_json` = counts / failing tests / changed paths). All of wuN's checks
  pass → `wuN.status='verified'`.
- **Commands/Capability:** **only** the profile's declared command for this check-type, run under a
  timeout — never arbitrary shell.
- **Behavioral gate (A1), deterministic:** when `wuN.behavioral=1`, the test check requires *the
  dispatch diff touched a test file* (path-classified via the profile) **and** tests green — both
  deterministic. Whether the test is *good* is the reviewer's job (S5), never the runner's.
- **`scope_diff` moved to `completeness` (S2d, A3):** the advisory over-delivery signal is produced
  there now, not here — it becomes an input to review; it never fails S2d or S3.
- **Value (vs the agent's inner loop):** the agent's loop is self-report on its working tree with a
  command it chose; S3 is the **independent** re-run on the **committed SHA** with the **canonical**
  profile command, producing a **structured durable signal** the control loop trusts. It catches
  hallucinated/partial runs, weakened/deleted tests, dirty-env passes, and premature "done."
- **Failure → route:** I3/I4/I5/I6 in §8.

**S4 · `verify:integration`** — ticket-level ground truth (C3); always run
- **Guard:** every `work_unit` is `verified`.
- **Input:** the profile's full build + full test suite (+ any integration/e2e); worktree at branch HEAD.
- **Output:** `ground_truth_signal('integration')`; on pass → ready for `docs:revise` then review.
- **Commands/Capability:** profile-declared full-suite commands only.
- **Failure → route:** N1 in §8 — integration failure is cross-unit, so the loopback is a
  **ticket-scoped reconcile** implement dispatch (may edit any unit's files), then re-run S4.

### Docs

**`docs:revise`** — ticket-level documentation sync (conditional; Haiku 4.5)
- **Guard:** S4 passed **and** S1 set `needs_docs=true`. (Otherwise skipped.)
- **Input:** the full ticket diff + plan + existing docs + profile (doc locations).
- **Output:** updated `docs/**` → runner commits; a `dispatch` row. Output is content, not a payload.
- **Tools:** `Read`, `Grep`, `Glob`; `Write`/`Edit` **`docs/**` only** (cannot touch source/tests, so
  it can't invalidate S4's pass — no re-verify needed). ❌ no `Bash`, no outward tools.
- **Doc quality:** judged by the reviewer at cutover (no separate `docs:verify`).
- **Failure → route:** C1 in §8.

### Review (cold, independent; redesigned)

**S5 · `review`** — independent cold-context reviewer (A2/A4; Opus 4.8)
- **Guard:** S4 passed; `docs:revise` done if it ran.
- **Input — artifacts only (anti-anchoring, A2):** the full diff + plan + ground-truth signals +
  `scope_diff`. **Explicitly NOT the implementer's transcript.**
- **Mechanism (§3a):** the reviewer **files each finding via a forced-schema tool call**
  (`file_finding`), then `complete_review()` (or a clean end). The judgment fields *are* the
  reviewer's, so it files them directly — no cheap extractor. A malformed call self-corrects
  in-context; a dead dispatch is a transport failure (retry), never a deny.
- **Finding fields:** `severity` (critical|major|minor|nit), `category` (correctness | security |
  perf | maintainability | test-quality | scope | **plan-defect** | …), `location`, `rationale`,
  `factors{in_changed_code, is_regression, user_visible, reversible_post_ship, has_workaround}`,
  optional `deferral_candidate`. → written as **`review_finding`** rows.
- **Verdict — runner-derived from the ledger, never a reviewer self-pass:**
  - any open finding `severity ∈ {critical,major}` → **loopback**, routed by `category`:
    `plan-defect` → **design (pivot, V3)**, else → **implement (V1)**. **Critical-floor: critical
    always blocks** (non-deferrable).
  - a `major` tagged `deferral_candidate` → **escalate that finding to the human** (V-defer).
  - else → **ship-ready**, transition `review → merge`.
- **No deferral dictionary (`[CL-NODEFER]`).** At cutover the threshold is fixed (major+ blocks);
  deferral ("this major is OK to ship *here*") is a *judgment that varies by project* — a
  post-cutover memory-backed decision, not a deterministic rule list. The human decides the rare
  `deferral_candidate`; **those decisions are recorded now** to seed the future learning layer.
  Nothing learns automatically at cutover.
- **Tools:** `Read`, `Grep`, `Glob` (+ read-only git); `file_finding`, `complete_review`. ❌ no
  `Write`/`Edit`, no execution, no outward tools.
- **Failure → route:** V1–V6 in §8.

### Merge (runner; external effects via the outbox)

**S6 · `merge:push`** — put the reviewed branch on GitHub
- **Guard:** review ship-ready; branch local-only with commits ahead of base (push-once-after-review:
  the branch lives only on the host until here).
- **Output:** branch on GitHub at the reviewed SHA; outbox row sent.
- **Capability:** push **this feature branch only**. Force-change allowed **only** on the feature
  branch and **only** with-lease (no one else moved it); **never** `main`/protected.
- **Idempotency:** **probe** — remote ref already at the SHA → skip.
- **Failure → route:** transient → retry; lease/unexpected-remote-move → escalate (H-class).

**S7 · `merge:pr-ensure`** — ensure a pull request exists (result-bearing)
- **Guard:** branch pushed.
- **Input:** branch, base, and a PR title/description. The **description is written by a cheap AI**
  (smoother write-up) from facts the runner already has — the changed work-units, test results,
  review outcome. (Facts are assembled deterministically; only the prose is the cheap model's.)
- **Output:** a PR exists; `response_ref` = PR number/url; **delivers the parked signal** so the
  workflow resumes with the PR ref (§5.3). Opening the PR is what makes the checks-system start.
- **Capability:** create **one** PR for this branch.
- **Idempotency:** **probe** — `gh pr view <branch>` → use the existing PR if present.
- **Failure → route:** transient → retry.

**S8 · `merge:await-checks`** — wait for the project's checks system (generic) `[CL-CHECKS]`
- **Guard:** PR exists.
- **Generic by design:** each project has a **checks system** (GitHub's built-in checks, a *separate*
  CI system, or none), discovered or asked at setup and saved in the project's settings. The step
  asks one **standard question** — *"for this change, are the checks passing, failing, or still
  running?"* — answered by a small **per-system translator**. Build the GitHub translator + the
  "none" case now; other systems are added later as new translators, **this step unchanged.**
- **Delivery = polling, not webhooks (`[CL-POLL]`):** the runner *reaches out* to the checks system
  periodically. This serves GOAL-INSTALL — works behind any firewall, no public endpoint. The
  checks/merge facts enter as **delivered signals** (§7.3), never a control-flow read.
- **Output:** green → in OSS the run exits here (PR-ready); in the commercial Control Plane, proceed to S9. failing → loop back through the normal coding-and-review steps
  (P1); flaky/infra → re-run the checks (P2); **none configured → skip** (human merge stays the gate).
- **Timeout:** bounded wait; stuck/unreachable → escalate to the human.

**S9 · `merge:await-human`** — the single human gate (D2)
> **OSS boundary.** The OSS `styre run` is **PR-ready terminal**: once the PR exists with checks
> green (S7/S8), the run has done its job and exits — it does **not** wait indefinitely for a human
> merge, does not maintain a persistent needs-you inbox, and does not keep the branch current across a
> slow human approval. Everything in this S9 step — the indefinite park in the **needs-you inbox**,
> polling GitHub for the merge, and the `[CL-STALE]` keep-branch-current-while-waiting behavior — is
> the **commercial Control Plane**'s outer loop. It is the design record for that plane; it is fenced,
> not deleted.
- **Guard:** checks green (or none).
- **Behavior *(commercial Control Plane)*:** parks the work in the operator's **needs-you inbox** with
  full context (what changed, test/check results, review outcome). **No deadline** — waits indefinitely
  (optional gentle reminder). Detected by polling GitHub for the merge.
- **Auto-merge fully off at cutover** — earned later, per ticket-class, via the learning layer.
- **Stale-branch handling while waiting (`[CL-STALE]`)** *(commercial Control Plane)* — main may
  advance during a slow approval: the runner keeps the branch current and re-validates, tiered to
  risk:
  - **clean catch-up** → re-run tests (S4) + re-run checks (S8); if green, mergeable and the prior
    review stands (the change's own diff is unchanged);
  - **catch-up needs conflict resolution** → re-run tests + checks **and re-review (S5)**, and **flag
    the needs-you item** "updated to keep up with main; code was reconciled — re-check";
  - **catch-up breaks tests** → send back to fix through the normal steps (a real behavior clash);
  - **invariants:** the human always merges a branch **current with main and green**; if the change
    was altered while catching up, the human is told; if main moves faster than the branch can be
    kept current (repeated thrash), **stop and hand the merge to the human**.
- **Output *(commercial Control Plane)*:** operator merges → transition `merge → released`. Operator
  requests changes → loop back (H1).

### Released

**S10 · `released:project`** — wrap up (runner; external via outbox)
> **OSS boundary.** Released is reached only *after* a human merge, which in OSS happens outside the
> run (the run already exited at PR-ready). The released-stage projection (tracker → Done, worktree
> cleanup) is driven by the **commercial Control Plane**, which delivers the merge signal; the OSS
> `styre run` has already exited at PR-ready and does not drive it. The step semantics below are the design record.
- **Guard:** PR merged (signal delivered).
- **Output:** ticket recorded done; tracker (Linear) projected to **Done**; the per-ticket worktree
  cleaned up. `ticket.stage='released'`, `status='done'`. ("Done" = merged + tracked at cutover;
  watch-for-deployment is an optional later addition per project.)
- **Capability:** project this one ticket's terminal state; remove its worktree.
- **Idempotency:** declarative (set-to-Done is idempotent).
- **Failure → route:** transient → retry.

---

## 5. External effects — the outbox (B3) `[CL-2: all external effects via the outbox]`

Every external effect (Linear, GitHub API, git push) is a `projection_outbox` row, enqueued in the
**same transaction** as the state change that motivates it, and drained idempotently by the runner.
Local effects (dispatch, verify, local git) use the §3 write-ahead discipline but execute inline.

```
drain_outbox():
  for row in SELECT * FROM projection_outbox WHERE status='pending' ORDER BY created_at:
    try: ref = apply(row); UPDATE … status='sent', response_ref=ref; if delivers_result: deliver_signal(row)
    catch transient: UPDATE … attempts+=1, error=…           # retried next loop
```
`idempotency_key` is `UNIQUE` (enqueue-twice is a no-op insert). **Reconciliation = re-attempt +
probe (CL-3):** re-run the effect and probe the external system for the change (comment already
posted? PR already open? remote ref already at SHA? already merged?), using a key where one exists;
probe-first guards no-native-key and irreversible effects (`pr_create`, `pr_merge`). Result-bearing
effects (`pr_create`) park on a signal the drainer delivers with `response_ref` (§7).

---

## 6. Crash & resume — discharging §9.4 #2

### 6.1 Recovery on start
```
recover():
  for step in SELECT * FROM workflow_step WHERE status='running':
    kill_orphan(step)                 # journaled PID still alive (dispatch) -> kill (ENG-131 lesson)
    if reattemptable(step): reset to 'pending'
    else (irreversible w/ probe): if probe_says_done: mark 'succeeded'(reconstructed) else 'pending'
  drain_outbox()
```
Intent-before-effect (§3) makes a `running` row the complete record of "an effect may be half-done."

### 6.2 Replay returns the recorded result
The resolver never re-executes a `succeeded` step — it reads `result_json`. The journal is the memo
table; with §5 idempotency every operation is at-least-once-attempted, exactly-once-effective.

### 6.3 Dispatch crash
A `claude -p` dies mid-run: step `{running, pid}`, no `result_json` → restart → `kill_orphan` →
re-dispatch as a fresh `dispatch_id`. Partial work committed to the branch is the next worker's
start point — git is the durable substrate for code, the journal for control. *Dispatch retry =
fresh attempt, not cached replay; only external effects get exactly-once keys.*

---

## 7. Durable waits — signals (B1)

A step of `step_type='await_signal'` inserts a `signal` (pending), sets `await_signal_id`, and sets
`ticket.status='waiting'` — the ticket leaves `v_ready_tickets`, so **no busy-wait** for human/CI
waits. A deliverer flips the signal to `delivered` (+ payload) and the ticket back to `active`; the
await step then succeeds.

| Signal | Delivered by |
|---|---|
| `human_merge_approval` (D2) | operator, via the needs-you inbox (D3) *(commercial Control Plane)* |
| `human_resume` (escalation, §8) | operator |
| `external_checks` | §7.3 poll of the project's checks system (CL-CHECKS/CL-POLL) |
| `external_pr_result` | the outbox drainer completing `pr_create` (delivers `response_ref`) |

**7.3 External delivery = polling.** Checks-system status and PR-merged are obtained by the runner
*reaching out* on an interval (no inbound endpoint → GOAL-INSTALL). Budget fields (`attempts`,
`max_attempts`, `first_attempt_at`) bound the wait; exhaustion → `human_resume` escalation. *(The
indefinite human-merge wait and PR-merged polling are the commercial Control Plane's outer loop, §9;
in OSS, `styre run` exits at PR-ready. The OSS escalation/park semantics — exit nonzero, or park at
exit 75 on a session interruption, resumable with `styre run --resume` — are in execution-model.md.)*

---

## 8. The Loopback Atlas

### 8.1 First principles (the atlas is *generated by* these, not curated)

- **P1 — Recover, don't halt.** Every failure resolves to auto-recover or a resumable wait. Never a
  dead end.
- **P2 — Ground truth triggers, never self-report.** A loop fires only on an objective signal
  (build/test/checks red, a filed finding, a crash) — never an agent's claim.
- **P3 — Cost and time are the governing budget; attempt-counts are proxies.** Each ticket carries a
  **spend budget** (tokens→$) and a **wall-clock budget**, **auto-calibrated to ~3× this project's
  own median clean-ticket** (measured from telemetry, not a guessed constant). A ticket burning 3×
  what a clean one costs is, by definition, not converging → escalate. The hard ceiling is spend/time.
- **P4 — Recovery cost matches failure cost.** Cheap failure → cheap recovery (a format slip
  self-corrects in-dispatch; a flaky check re-runs free). Expensive recovery (Opus re-design) fires
  only for an expensive-to-detect failure. Never spend Opus to fix a formatting hiccup.
- **P5 — Loopback scope = failure scope.** Reset no more than the failure demands (the **Scope**
  column below): **unit** (one work-unit), **ticket** (cross-unit reconcile), **plan** (full re-plan).
- **P6 — Distinct-progress.** Each loop must move the **failure signature**; repeating the identical
  failure isn't progress and escalates fast.
- **P7 — Deterministic routing now; learned routing later.**

### 8.2 The mechanics under the table

- **Failure signature (what "distinct" means), computed deterministically:** tests red = the *set of
  failing test names*; build red = the *set of (file, error) pairs*; review/plan-review = the *set of
  finding identities* (`finding_class_key`); claude death = the *death reason*; noop = constant. Two
  counters off it: **consecutive-identical** (cap ~2 → escalate fast) and **total-distinct** (cap ~3
  → escalate). Different-failure counts as a distinct attempt (no reset); counters reset **only on a
  clean pass**.
- **Counter hierarchy (first to trip wins):** ① a **per-loop** distinct counter (resets when that
  loop passes) ② **B2**, the cross-loop escalation budget (3 consecutive / 20 total, per-ticket-life)
  — the **thrash catcher** for stage ping-pong where each loop stays under its own cap ③ **B3**, the
  P3 spend/time ceiling. B2/B3 reset only on operator resume.
- **What "escalate" *does* (post-escalation lifecycle):** the ticket parks (`status='waiting'`) on a
  `human_resume` signal **with the full trace**. *In OSS*, `styre run` surfaces the escalation by
  exiting nonzero with the trace (a session-interruption parks at exit 75; resume with `styre run
  --resume`). *In the commercial Control Plane*, the parked ticket appears in the **needs-you inbox**
  and the operator can: **(a) resume as-is** (re-enter the parked step, counters reset); **(b) fix by
  hand then resume** (edit plan/code/config; the runner picks up the changed state); **(c) abandon**
  (terminal). Worst case = *parked, with the whole story, you decide* — never "stuck."

### 8.3 The atlas (Scope per P5; **first match** within a phase)

| # | Detected at | Scenario | Routes to | Scope | Bound → exhaustion |
|---|---|---|---|---|---|
| CFG | pre-dispatch | profile incomplete (unresolved prompt input) | escalate (setup error) | — | immediate (CL-PROFILE) |
| **Design** ||||||
| D1 | design:extract | JSON shape invalid (rare; forced output) | re-run extract (cheap) | — | K_shape → escalate |
| D2 | runner completeness check | empty *required* field — the plan lacks the info | → S1a re-design | plan | K_distinct → escalate |
| D3 | post-design postcondition | no plan committed / zero work-units | → S1a re-design | plan | K_distinct → escalate |
| DV1 | S1c plan-review | blocking plan-finding | → S1a re-design with findings | plan | K_distinct → escalate |
| DV2 | S1c plan-review | reviewer death / transport | retry dispatch | — | K_retry → escalate |
| **Rebase** (one primitive; aftermath = function of phase ¹) ||||||
| R1 | rebase | clean | continue → re-validate by phase ¹ | unit/ticket | — |
| R2 | rebase | conflict | → conflict-resolution agent → re-validate by phase ¹ | unit/ticket | — |
| R3 | rebase | resolution fails / post-rebase verify red | pre-impl → escalate; post-review → S2b (behavior clash) | ticket | K → escalate |
| R4 | rebase (post-review) | main outpaces keep-current (thrash) | stop; hand merge to the human | — | — |
| **Implement + unit verify** ||||||
| I1 | S2b | claude death / timeout | retry fresh dispatch (backoff) | unit | K_retry → escalate |
| I2 | ~~S2b postcondition~~ | ~~noop — empty diff~~ — **superseded by CM1**: S2b no longer has a non-empty-diff postcondition (§ CL-POSTCOND); an empty dispatch diff for a real unit now surfaces as `under ≠ ∅` at `completeness:wuN` and routes via CM1 below | — | — | — |
| I3 | S3 | build red | → S2b with build error | unit | K_distinct → escalate |
| I4 | S3 | tests red | → S2b with failing tests | unit | K_distinct → escalate |
| I5 | S3 | behavioral unit, no test in the diff | → S2b to add the test | unit | K_distinct → escalate |
| I6 | S3 | toolchain/infra error | retry (transient) | — | K_retry → escalate(infra) |
| **Provision** ||||||
| E1 | S2c `provision` | `prepare` install fails, or (Python editable) the worktree-source assertion fails after remediation | escalate immediately (env error, **not** a code loopback — never routed to S2b) | — | immediate, no retry |
| **Completeness** ||||||
| CM1 | S2d `completeness` | `under-delivered` — a declared file untouched by anyone (cumulative diff) ³ | → S2b, targeted (missing-files feedback) | unit | K_distinct (per-step `maxAttempts`) → escalate |
| **Integration** ||||||
| N1 | S4 | cross-unit integration red | → ticket-scoped reconcile implement | ticket | K_distinct → escalate |
| **Docs** ||||||
| C1 | docs:revise | claude death | retry | — | K_retry → escalate |
| **Code review** ||||||
| V1 | S5 | blocking finding, **code** category (runner `blocks_ship`: critical-floor, or major-not-deferred) | → S2b, targeted | unit | K_distinct → escalate |
| V2 | S5 | reviewer judges scope expansion **unjustified** → files a `scope` finding ² | = V1 (justify or revert) | unit | K_distinct → escalate |
| V3 | S5 | blocking finding, **plan-defect** category (impl correct, plan wrong) | → S1a re-design | plan | K_distinct → escalate |
| V-def | S5 | a `major` tagged `deferral_candidate` | escalate that finding to the human | — | — |
| V4 | S5 | reviewer death / transport (dispatch didn't complete) | retry dispatch | — | K_retry → escalate |

> ENG-164: a transport death is now classified by cause. session-limit / out-of-credits →
> `parked` (resumable, attempt NOT consumed); crash / timeout / unknown → `transient` retry as
> before. The `parked` dispatch outcome + `event_log.kind='parked'` make a quota pause countable
> separately from a real failure.

| V6 | across reviews | same finding (`finding_class_key`) persists N cold rounds | escalate (agent can't fix it) | — | fast |
| **Checks (CI)** ||||||
| P1 | S8 | checks red — real failure | → ticket-scoped reconcile (then verify+review+re-push) | ticket | K_distinct → escalate |
| P2 | S8 | checks flaky / infra | re-run the checks | — | K_retry → escalate |
| P3 | S8 | checks system unreachable / wait-budget exhausted | escalate | — | — |
| **Human merge** ||||||
| H1 | S9 | operator requests changes | → S2b or S1 per feedback | operator | human-driven |
| **External effects & infra** ||||||
| X1 | outbox drainer | external effect fails past retry budget (GitHub/Linear outage) | escalate (infra); ticket parks | — | K_retry → escalate |
| X2 | any | worktree/git corrupted (wedged rebase, disk) | escalate (infra) | — | — |
| **Cross-cutting terminators** ||||||
| B1 | any loop | per-loop distinct cap reached | escalate (resumable wait) | — | — |
| B2 | any | cross-loop budget (3 consecutive / 20 total) — thrash | escalate | — | — |
| B3 | any | spend/wall-clock past ~3× clean-ticket median (P3) | escalate | — | — |

¹ **Re-validate by phase** — *pre-implement* (branch local): re-verify the rebased unit. *Post-review
while waiting* (CL-STALE): clean catch-up → re-verify integration + checks, **review stands**;
reconciled-code catch-up → re-verify integration + checks **and re-review (S5)** + **flag the operator**
("updated to keep up with main"). One rebase mechanism; the aftermath is the only thing that differs.

² **Scope is reviewer-judged (A3):** the reviewer first decides if an expansion is **benign/justified**
(→ files *no* finding, nothing loops back) or **unjustified** (→ a `scope` finding, then exactly V1).
There is no automatic "diff expanded → loopback."

³ **CM1's plan-gate precondition:** the under-delivered loopback assumes no vacuous unit ever reaches
implement — S1b's `design:extract` completeness check requires every planned unit to declare ≥1
`files_to_touch` (D2 if it doesn't), so a unit with nothing to do never produces an incoherent
"touch these files" loopback with no files named. `completeness` and `verify:wuN:<check>` carry
**independent** per-step `attempt` counters (not a shared per-unit budget) — an alternating
completeness/verify failure can therefore cost up to `maxAttempts × 2` implement re-dispatches before
either exhausts. The semantic **AC-completeness** layer (a dropped acceptance criterion; a file
declared by multiple units where none did the real work) is explicitly **out of scope for CM1** — it
is a deferred follow-up folded into S5 review, not this row.

### 8.4 Loopback targets, by meaning
**→ implement** (unit or ticket scope — the code is wrong; most failures — including CM1's
under-delivery, where the code is *missing* rather than wrong). **→ design / re-design**
(plan scope — the plan is wrong; caught early at DV1, or late at V3). **→ escalate** (a resumable
park — budget exhausted, or an inherently human case: R3/R4, V-def, V6, P3, H1, X1/X2; **or an
environment error, E1** — provision, always immediate, never bounded by attempt-count; in OSS the run
exits with the trace, in the commercial Control Plane it surfaces in the needs-you inbox).

### 8.5 Deleted by design (why most current failure reasons need no row)

The 2026-06-19 audit of the current harness cross-mapped ~60 failure/halt reasons. **~35 are
eliminated by the substrate**, not handled by a loop — recorded here so we never re-litigate "is it
missing":

- **Capability isolation (move 4)** kills the whole transcript-detective family: `pr-opened-too-early`,
  `branch-creation-forbidden`, `worktree-mutation-forbidden`, `lane-violation`,
  `dispatch-envelope-violation`, `progress-md-entry-missing`, `sandbox-contract-violation`,
  `worktree-mutated-by-agent`, `self-leak`, `leaked-in-scope-threshold`, `scope-approval-pending` —
  the agent has no tool to do any of them.
- **Single SoT (move 2):** `stage-drift`, `legacy-marker-write`, `protocol-violation`,
  `linear-post-failed`-as-halt (now X1, a delayed projection, not a control halt).
- **Ground truth over self-report (move 5):** the entire `qa-payload` (39–41), `qa-predicate` (42–44),
  and `dimensional-threshold-not-met` classes — the qa *stage* is gone; verify = runner-run commands.
- **Runner owns the envelope + validated tool interface (move 3):** `plan-contract` (33–35),
  `review-payload` (36–38), `review-ledger` (48–50), `init-sh` (45–47, → a verify check-type),
  `agent-contract-missing` (→ per-step postconditions, CL-POSTCOND), `summary_*` (→ the journal).

**Deferred to the learning layer (post-cutover, not a cutover gap):** `gotcha_triggered`,
`learned_rule_renewal`, and the *auto-defer* half of `ship-with-deferred-majors` (the human-escalate
half is V-def). **New rows the audit surfaced:** CFG, X1, X2.

---

## 9. Invariants a step author MUST hold

- **CL-INV-1 — stable keys.** `step_key` is a pure function of (ticket, work_unit, logical position);
  never embed a timestamp/random/`dispatch_seq`/attempt.
- **CL-INV-2 — allocate-once.** Ids/timestamps an effect needs are allocated at step creation and
  journaled; replay reuses, never re-allocates.
- **CL-INV-3 — one transaction.** Every state transition + its outbox enqueues commit in one tx;
  effects sit outside it behind write-ahead intent.
- **CL-INV-4 — validated interface, not parsed blobs.** Structured agent output is submitted via
  forced-schema tool calls; the runner computes decisions from state (§3a). Never parse a free-form
  verdict.
- **CL-INV-5 — keyed/probed effects.** External effects are idempotent via probe + key (§5).
- **CL-INV-6 — DB is the only control input.** Control flow reads SQLite only; external facts (checks,
  human, merge) arrive as delivered signals, never a live read.
- **CL-INV-7 — single writer.** Only the runner writes SQLite (B2); the runner commits, not agents.
- **CL-INV-8 — display-local.** Timestamps stored UTC; every operator-facing surface renders host
  local time (DS-1).

---

## 10. Installation & operability `[GOAL-INSTALL]`

> **OSS / commercial split.** The binary-shaped properties below (single self-contained binary,
> embedded SQLite, self-bootstrapping schema, reach-out-only networking) are **OSS-core**. The
> **persistent host-service supervision** (launchd/systemd keep-alive), the always-on multi-ticket
> process, and the **needs-you inbox** are the **commercial Control Plane**'s outer loop — fenced
> below, not deleted. In OSS, `styre setup` probes the repo and writes the project profile; `styre run`
> is an ephemeral per-ticket process (no host service); `styre migrate` bootstraps the SoT.

One command, no server setup. Implications the runner owns *(OSS-core unless marked commercial)*:
- **Single self-contained binary** (TS compiled, node bundled) — no global installs; escapes the
  bash-3.2 curse entirely.
- **Embedded SQLite, zero-ops** — no DB server; WAL on by default.
- **Self-bootstrapping schema** — `migrate()` creates/upgrades the DB on start; no manual SQL.
- **One idempotent `setup <target-repo>`** — seeds the `project` row, refreshes the `linear_id_cache`,
  and **discovers/asks the checks system**. *(Commercial Control Plane: setup also creates+migrates a
  shared DB and installs the host service — **launchd on macOS, systemd on Linux**, both first-class
  install targets; see build-operations §3.1. The OSS `setup` does not install a host service.)*
- **Minimal host contract** — the binary + `claude` + `git` + `gh`; one config file + one secrets
  file; no ambient `LINEAR_API_KEY`.
- **Reach-out-only networking** — polling (not webhooks) for checks/merge → works behind any
  firewall, no public endpoint.
- **Built-in `status` (local-tz, DS-1)** — no extra dashboards. *(Commercial Control Plane: the
  persistent **needs-you inbox** surface.)*

---

## 11. Worked example — ENG-9, full-track backend+frontend feature

| # | `step_key` | executor | result |
|---|---|---|---|
| 1 | `design:dispatch` | Opus | plan doc committed; `needs_docs=true`; `track=full` |
| 2 | `design:extract` | Haiku | `work_unit` wu1(backend), wu2(frontend); completeness clean |
| 3 | `design:review` | Opus | files plan-findings; 0 blocking → `stage=implement` |
| 4 | `implement:wu1:rebase` | runner | clean (no-op if current) |
| 5 | `implement:wu1:dispatch` | Sonnet | backend code + tests; runner commits (d-row) |
| 6 | `verify:wu1:build` / `:test` | runner | ground-truth pass; wu1 verified |
| 7 | `implement:wu2:dispatch` | Sonnet | frontend code + tests; runner commits |
| 8 | `verify:wu2:visual` | runner | Playwright pass; wu2 verified |
| 9 | `verify:integration` | runner | full suite pass |
| 10 | `docs:revise` | Haiku | docs updated (needs_docs was set); runner commits |
| 11 | `review` | Opus | files findings via tools; 0 blocking → ship-ready; `stage=merge` |
| 12 | `merge:push` | runner/outbox | branch pushed (probe on SHA) |
| 13 | `merge:pr-ensure` | runner/outbox + Haiku | PR opened (probe), cheap-AI description |
| 14 | `merge:await-checks` | runner (poll) | checks green — **OSS `styre run` exits PR-ready here** |
| 15 | `merge:await-human` | operator | *(commercial)* merges (branch kept current meanwhile); `stage=released` |
| 16 | `released:project` | runner/outbox | *(commercial)* tracker → Done; worktree cleaned; `status=done` |

The OSS `styre run` drives steps 1–14 (through PR-ready + checks-green) and exits; steps 15–16
(indefinite human-merge wait, released-stage projection) are the **commercial Control Plane**'s outer
loop. A **fast-track** ticket skips step 3 (plan-review); a backend-only ticket drops 7–8 and (no doc
impact) 10; **1 work-unit = 1 implement dispatch.**

---

## 12. Mapping to §9.4 #2 + open questions

**Discharged:** ✅ replay returns recorded result (§6.2) · ✅ external effects keyed (§5) · ✅ crash
mid-step resumes (§6.1).

**Decided in the walkthrough:** CL-1 (one process serves all projects — the multi-ticket variant is
the commercial outer loop, §2.1) · CL-COMMIT (runner-commits) · CL-ORCH (runner-orchestrates, no
master agent) · validated-interface for structured output (§3a) · review
redesign (findings via tool calls; verdict from state) · CL-NODEFER (no deferral dictionary;
record-now-learn-later) · CL-CHECKS/CL-POLL (generic checks system, polling) · CL-STALE
(stale-branch handling) · **S1c plan-review** (shift-left semantic plan gate, full-track) ·
CL-POSTCOND (per-step postconditions) · CL-PROFILE (pre-dispatch profile-completeness gate) ·
**§8 rewritten from first principles** — P3 cost/time auto-calibrated budget governs every loop;
P5 loopback scope (unit/ticket/plan); failure-signature + counter-hierarchy + post-escalation
lifecycle pinned; §8.5 records the ~35 reasons the substrate deletes (audited against the current
harness).

**Coherence pass (2026-06-19) → schema v2.** Cross-referenced this doc against `schema.sql` and
realigned the schema to the frozen loop model: dropped the ticket skip-policy block + `status=halted`
(P1); `pipeline_event` → lean **`event_log`** (transition/loopback/escalated/resumed — verdicts are
derived, not stored); **`review_finding` realigned** (single severity + category + factors +
`deferral_candidate` + runner-computed `blocks_ship` + `review_kind` plan|code, with a critical-floor
CHECK); added `ticket.needs_docs`, `project.checks_system`, `workflow_step.pid`; `ground_truth_signal.
signal_type` = the open check-type; signal vocab (`external_checks`/`external_pr_result`). Idempotency
keys stay globally-unique-by-construction (§3). Re-verified: loads clean, all invariants smoke-tested.

**Resolved downstream:** the per-ticket budget numbers (K_DISTINCT, the P3 cost/time ceiling) and
the needs-you inbox surface (D3, **commercial Control Plane**) are now pinned in
[`minimal-loop.md`](minimal-loop.md) §4/§5.

**Substrate spec status:** §9.4 #1 schema(v2) · #2 (this) · **#3 dropped** (no state-import mechanism
— the in-flight tickets were obsolete and were abandoned) · #4 [`projector.md`](projector.md) ·
#5 [`minimal-loop.md`](minimal-loop.md). All five drafted and mutually coherent; what remains is
operational (build + verify in the downtime window).
