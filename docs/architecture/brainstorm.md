# Styre — Architecture & Design Rationale

> **Styre** is the open-source execution core of an open-core autonomous-SDLC product (a commercial
> "Control Plane" wraps it — vision in `~/code/SDLC SaaS Product.md`). This document is Styre's design
> rationale and running decision log, carried over from the effort that re-architected the **legacy
> bash harness** Styre supersedes. The full substrate spec lives beside it in `docs/architecture/`.
> *(Running scratchpad — append, don't rewrite history; the diagnosis below grounds the design in the
> legacy harness's measured failure modes.)*

> **▶ RESUME HERE (2026-06-19):** substrate spec CLOSED (§10); **SQLite schema DONE (v2, coherent with the control-loop)** → `docs/architecture/schema.sql` (§12); **durable control-loop semantics FROZEN** → `docs/architecture/control-loop.md` (§9.4 #2 — daemon + event loop; a full **step catalog S1–S10** with per-step guards/inputs/outputs/tools walked + approved with the operator; validated-tool-interface for structured output (§3a); **review redesigned** (findings filed via tool calls, verdict derived from state, no deferral dictionary); generic checks-system (CL-CHECKS, polling); stale-branch handling (CL-STALE); **S1c shift-left plan-review**; the **Loopback Atlas rebuilt from first principles** (§8 — cost/time auto-calibrated budget governs every loop; loopback-scope = failure-scope; §8.5 records the ~35 reasons the new substrate deletes, audited vs the current harness); GOAL-INSTALL §10). **#3 state-import DROPPED** (3 halted in-flight tickets, all obsolete → abandoned; no import mechanism). **§9.4 #4 projector** → `docs/architecture/projector.md`; **§9.4 #5 minimal loop** → `docs/architecture/minimal-loop.md` (concrete `next_step_key` state machine + loopback resets + dispatch shell-out + the pinned budget numbers + the D3 needs-you inbox). **▶▶ SUBSTRATE SPEC COMPLETE** — #1 schema(v2) · #2 control-loop · #3 dropped · #4 projector · #5 loop, all mutually coherent. **Remaining is operational, not design:** build + verify in the downtime window, #6 track-1 fixes, #7 rollback. Read minimal-loop → control-loop → projector → schema → §9 → §10. **Build/ops + open-core strategy:** `docs/architecture/build-operations.md` (new repo · port-the-leaves · run modes · dual-auth · the open-core seam) — the redesign is the free OSS execution core of an open-core product; commercial vision in `~/code/SDLC SaaS Product.md`. Only open spec item is **E2** (`decision_class`/`action_surface` vocabularies), post-cutover (UGL). Read control-loop.md → §12 → §10 → §9.
>
> **Status:** living doc. Started 2026-06-18.
> **Purpose:** capture the evolving hypothesis for re-architecting the autonomous SDLC
> harness toward the goal: **minimal human involvement, self-correcting/learning behaviour,
> quality software output.**
>
> **How to use:** append, don't rewrite history. Tag items `[DECIDED]`, `[HYP]` (hypothesis to
> test), `[OQ]` (open question), `[EVIDENCE]`. Everything should be grounded in ticket IDs,
> telemetry, or code — not vibes. This is a scratchpad, not a spec; it gets messy and that's fine.

---

## 0. One-line thesis

The harness's gates, hand-rolled durability, static recoverability dictionary, and after-the-fact
detectives are all **compensations for a fragile substrate** (state can be forged/stale, agents reach
production, there is no coherent execution trace). Fix the substrate and ~75% of the gates have nothing
left to defend. Add the supervisor layer the design never had, and novelty stops requiring an engineer.

---

## 1. Diagnosis (grounded in telemetry + code, 2026-06-18)

**Telemetry baseline** — `$PROJECT_STATE_DIR/metrics/events.jsonl`, 29 days, 552 stage-end dispatches:
- 47% clean success. ~20 tickets shipped / ~23 started → throughput is NOT zero; **autonomy/efficiency** is the failure (~27 dispatches per shipped ticket ≈ 4× the 8-stage floor).
- `dispatch-failed: 56`, **all `exit=20`** (claude -p death: session-limit / out_of_credits / crash) = biggest single failure bucket, bigger than all gate-trips combined. 23 of 56 escalated to operator-action halts.
- `human-decision: 72` (~2.5 explicit operator touches/day; excludes uncaptured Linear-UI edits). `halt-resume: 747` cycles. `soft-pending: 139` = build stage parking at the single human-approval gate.

**Recoverability model today** — `bin/common.sh::failure_outcome_for_exit`: **41 mapped exit codes**, 3 policies, dominant = `skip-until-human-acts` (**185 refs vs 82 `retry-immediately`**). Catch-all is `unknown-exit-N`, which the retrospective explicitly cannot classify. → A static dictionary whose default is "wake a human," and whose blind spot is anything unanticipated. This is *why* gates accreted: every novel failure → new code + new policy + new gate.

**Three meta-findings** (from the 195-ticket sweep, ENG-7→218):
1. **State model is the root.** ~30 tickets (~15% of all ever filed) exist only to reconcile a 3-medium state machine (Linear labels + Linear comments + per-issue JSON files): ENG-41, 56, 60, 61, 63, 72, 73, 77/78/79, 87/88, 89, 104, 110, 111, 112, 115, 150–153, 180, 183, 193, 211, 217, 218.
2. **Learning loop designed but dead.** ENG-33/37/39/40 architected it; ENG-129/130/158 split/extended it; it has **never run** on the host (bash 3.2 + gtimeout). So the system only accretes gates, never simplifies.
3. **Gate accretion.** ~40+ gate/detective tickets; the harness's own tickets repeatedly note the gates are simultaneously its main safety mechanism and its main source of operator toil (false halts: ENG-138/143/144/145/146/164/179/180/208/211).

**The autonomy layer is entirely in Backlog** — stage-contracts (ENG-181–188), stack-agnosticism (ENG-165–177), metrics normalization (ENG-197–201), calibration/model-bump (ENG-37/39/40). Years of effort went into the substrate; it never reached the part that makes it autonomous.

---

## 2. Current SDLC flow (where autonomy leaks)

```
brainstorm → plan → implement → ui → review → qa → build → release
   ENG-65     ENG-157  ENG-66/87  ENG-194 ENG-190 ENG-117 ENG-86  ENG-177
```
Each transition has ≥1 halt-to-human gate. The default response to *any* anomaly — claude death, malformed payload, out-of-plan file, stale marker — is **halt and wait for a human**, not absorb-and-continue. That default is the disease.

---

## 3. Design moves (target architecture)

| # | Move | Replaces (current pain / ticket-class) |
|---|---|---|
| 1 | **Durable execution: ticket = workflow** (step journal, checkpoint/resume, idempotent effects, durable signals) | tick lock, stuck-tick alarm, ENG-87 dispatch-id contract, ENG-218 seq reset, ENG-78/73/61 staleness guards |
| 2 | **Single transactional SoT (Postgres); Linear/GitHub are one-way projections** | the entire ~30-ticket reconciliation class; rogue-write pollution (ENG-217) |
| 3 | **Structured-output, repair-not-halt; orchestrator owns artifact envelopes** | qa-payload / plan-contract / review-ledger / init-sh detective family (~21 exit codes) |
| 4 | **Capability isolation** (scoped creds, no ambient `LINEAR_API_KEY`, per-task sandbox) | ENG-42/43/66/87/155 transcript detectives; ENG-217 rogue writes; ENG-14 self-leak |
| 5 | **Ground-truth verification over self-report; loop-not-halt** | dimensional grading (ENG-31/117/118), self-scored thresholds ("numerical theater" — ENG-39) |
| 6 | **Supervisor + monitored learning loop** (the missing layer) | static `failure_outcome_for_exit` dictionary; the dead retrospective |

### Decisions locked so far

- `[DECIDED]` **Build a minimal Postgres step-journal, don't buy DBOS/Temporal.** Retries/failover are the trivial 20%; the value is durable-execution *semantics* (idempotent exactly-once effects, deterministic replay, durable human-waits) which the harness hand-built badly (ENG-87/218/78/73/104/110). For a solo self-hosted operator, a ~300–500 LOC journal (`workflow_steps`, `signals`, idempotency keys) is the right call — own + debug everything, no opaque framework internals. Build *against the canonical pattern*; revisit buying Temporal only if the workflow graph gets complex or the team grows.
- `[DECIDED]` **Self-report verdicts (dimensional thresholds) are discarded**, replaced by ground truth (CI/tests/scope-diff/independent review). ENG-39 already called them uncalibrated theater.
- `[DECIDED]` **Cheapest highest-leverage isolation = remove the ambient `LINEAR_API_KEY` from the agent env** and route all Linear writes through the orchestrator. Kills the worst blast-radius class (ENG-217) without containers. Per-task containers are the second increment (OS-level write boundary → kills self-leak).
- `[DECIDED]` **Stage count scales with ticket size** (the existing sizing rubric already knows 1-subsystem tickets don't need full ceremony); fuse brainstorm+plan into "design", implement+verify into one test-running loop.
- `[DECIDED — operator 2026-06-19]` **Trivial installation is a first-class goal (`GOAL-INSTALL`).** A new operator must reach first-ticket with **one command, no server setup**. Drives concrete substrate choices: a single self-contained binary (no global npm/runtime dance, escapes bash-3.2), embedded zero-ops SQLite, a self-bootstrapping schema migration, and one idempotent `setup` command that installs the host service (**launchd on macOS, systemd on Linux — both first-class install targets**). Spec'd in [`control-loop.md`](control-loop.md) §10 + build-operations §3.1.
- `[DECIDED — operator 2026-06-19]` **Structured agent output goes through a validated tool interface; the daemon computes decisions from state — it never parses a free-form blob.** A serialized verdict conflates "malformed output" with "a real no," forcing expensive re-runs and making the format-error rate unmeasurable. Instead: forced-schema tool calls (self-correct in-context on a bad call), and the daemon sees only two unambiguous states — *completed* (decision derived from state) or *transport failure* (retry). Refines the reason/extract split: a cheap model formalizes *mechanical* structure (plan → work-units); judgment-bearing fields (review severity) are filed by the reasoner itself. Detailed in control-loop.md §3a. This is what reframed the review stage (findings filed one at a time; verdict derived; **no deferral dictionary** — deferral is a later memory-backed decision, recorded-now/learn-later).

### Stack `[DECIDED 2026-06-18 — full rationale in §9.2]`
- TypeScript (not bash — bash 3.2 is a large fraction of fragility: UTF-8 hang, locale-masked tests, untyped state). Go defensible but loses on zod + Agent-SDK-optionality; viable only because we keep the CLI leaf.
- **SQLite** = single SoT + step journal (zero-ops; Postgres only on concurrency demand).
- Claude Messages API (structured outputs via `messages.parse` + zod) for deterministic-artifact steps; Claude Agent SDK for the code-writing loop. Opus 4.8 for design/review, Sonnet 4.6 for implement (tiered).
- GitHub Actions = ground-truth CI (required status check) once the gate is hermetic (PR #184 is a prerequisite).
- Per-task Docker (or worktree+scoped-tools as the cheap first increment).

---

## 4. DELIVERABLE 1 — Gate taxonomy: keep / discard / transform

The 41 `failure_outcome_for_exit` codes sorted by **what they defend against**, mapped to the owning new component. Verdict legend: **DISCARD** (weakness it guarded is gone) · **FOLD** (collapses into one primitive) · **MOVE** (belongs to the execution layer) · **KEEP↻** (genuine, but reframed to ground-truth + loop).

| Current exit code(s) | Class | Verdict | Owning component | Mechanism in new system |
|---|---|---|---|---|
| 33–35 plan-contract; 36–38 review-payload; 39–41 qa-payload; 42–44 qa-predicate; 45–47 init-sh; 48–50 review-ledger; 31 progress-md; 25 agent-contract-missing | Artifact-shape (agent owns a load-bearing write) | **FOLD** (~21 codes → 1) | Artifact boundary (move 3) | Orchestrator owns the envelope; agent emits content-only; **one** schema-validate-or-reprompt primitive. "Missing/incomplete envelope" → structurally impossible. "Malformed content" → bounded re-prompt, never halt. |
| 13 lane-violation; 14 legacy-marker-write; 29 envelope-violation; 24 linear-post-failed | Lane / forgery / staleness | **DISCARD** | Single SoT (move 2) | No agent write-path to authoritative state ⇒ nothing to forge / stale-read. `linear-post-failed` becomes a local DB write + async projection. |
| 22 pr-opened-too-early; 23 branch-creation-forbidden; 26 worktree-mutation-forbidden; 27 self-leak; 28 leaked-in-scope-threshold | Behavioral / blast-radius | **DISCARD** | Capability isolation (move 4) | Agent has no `gh`/branch/Linear tools and only the worktree is writable. The action fails harmlessly in-sandbox instead of succeeding against production. |
| 12 stage-drift; 11 paused | Concurrency / scheduling artifact | **DISCARD** | Execution engine (move 1) | A real workflow engine has no tick-races or label-vs-policy drift. |
| 20 dispatch-failed (claude death); 124 dispatch-timeout | Liveness / infra | **MOVE** | Execution engine (move 1) | Retry-with-backoff at the step layer. **Never** a pipeline halt. (= 70 of 552 dispatches today.) |
| 21 scope-violation; 30 noop-implementation; 10 guards-tripped (rejection counters) | Genuine correctness | **KEEP↻** | Ground-truth verify (move 5) | scope-violation → diff vs plan's declared `files_to_touch`, re-prompt to fix/justify. noop → diff-is-empty check, re-prompt. rejection counters → bounded retry **against ground truth** (tests red / reviewer found real defect), escalate after K distinct attempts. |
| dimensional-threshold (ENG-31/117/118, self-scored) | Self-reported quality | **DISCARD** | Ground-truth verify (move 5) | Replaced by build-green + tests-pass + independent reviewer approval. |

**Score: ~31 of 41 halt classes (≈75%) vanish or fold; ~4 survive (reframed); ~2 move to the engine.**

The surviving correctness gates (the irreducible core):
1. **Builds / compiles.** (ground truth)
2. **Tests pass** — including a test that encodes the plan's `test_plan`. (ground truth)
3. **Diff ⊆ plan's declared scope** (or the agent justifies the expansion). (cheap deterministic check + re-prompt)
4. **Independent reviewer agent approves** (cold-context, ground-truth-anchored, not self-score).

All four are **loop-with-feedback**, escalating to the supervisor only after a bounded number of *distinct* corrective attempts.

`[OQ-1]` Is "diff ⊆ plan scope" too rigid? Plans are often wrong mid-implement. Maybe scope is advisory and the *reviewer* judges scope expansion, rather than a hard gate. → test both.
`[OQ-2]` Where does "review" live — a stage, or a verify-substep of implement? Leaning verify-substep for small tickets, separate stage for large.

---

## 5. DELIVERABLE 2 — The supervisor + learning loop (the missing layer)

### 5.1 Three layers (neither pure-dictionary nor pure-LLM)

- **Layer 1 — deterministic fast-path.** High-frequency, unambiguous cases decide without an LLM: claude-death → retry; tests-red → loop; timeout → backoff-retry. This is the dictionary, kept *small* and only for known-and-cheap. (Today's `failure_outcome_for_exit`, minus the ~31 codes that no longer exist.)
- **Layer 2 — supervisor agent.** For anything Layer 1 flags `novel` / `ambiguous` / `needs_review`: reads the ticket's **durable execution trace** (possible only because of single-SoT), diff, test output, logs. Classifies: transient (retry) / recoverable mistake (re-dispatch w/ corrective feedback) / real blocker (escalate to human) / harness bug (file for learning loop).
- **Layer 3 — learning loop.** Consumes supervisor `decision→action→outcome` records. Recurring + correct judgments get **promoted to Layer-1 rules under human review**; stale rules pruned. The dictionary *grows from observed reality* instead of engineer pre-imagination.

### 5.2 Recoverability = confidence-tiered against evidence (NOT a static lookup)

| Tier | Condition | Action |
|---|---|---|
| Known signature | deterministic match (e.g. `out_of_credits` in stderr) | known action, no LLM |
| Novel, low-stakes, reversible | no rule match, action is retry/re-prompt/re-route | supervisor acts + logs |
| Novel, high-stakes or irreversible | merge / force-push / delete / data mutation | supervisor **proposes**, human confirms |
| Recurring + correct | same judgment N times, good outcomes | promote to Layer-1 rule (human-approved) |

Recoverability is judged against the **durable trace + ground-truth signals**, never vibes. "Tests still red after 3 *distinct* corrective re-prompts" = strong evidence of not-autonomously-recoverable.

### 5.3 Supervisor authority boundary `[DECIDED — needs pressure-test]`

**CAN do autonomously:** retry a step, re-prompt an agent with corrective feedback, re-route (e.g. send back to design), adjust model tier / effort, escalate to human, annotate the ticket, file a learning-loop record.
**CANNOT do autonomously (requires human confirm):** merge, force-push, delete, any irreversible/outward action, direct mutation of the SoT outside its sanctioned action set, spend beyond a per-ticket token/retry budget.
**Invariants:** every action logged as a structured decision record; subject to the same "confirm before hard-to-reverse" rule as worker agents; bounded by a per-ticket budget (retries, tokens, wall-clock) — exhaustion forces escalation.

### 5.4 Promote-to-rule mechanism (the compounding engine)

Decision record schema (`[HYP]`):
```
{ ticket_id, trace_ref, signature_features{...}, classification, action_taken,
  outcome{resolved|escalated|recurred}, confidence, model, ts }
```
Promotion criteria: same `signature_features` + same `action` + `outcome=resolved` across **≥N independent tickets**, no contradicting record, **human approves** the proposed rule. Rules carry provenance (which records justified them) and can be **demoted** when they stop matching outcomes. Guard: a rule that would *mask* a recurring harness bug must be flagged by the learning loop (recurrence without root-fix) rather than silently promoted.

### 5.5 Who watches the watcher? (supervisor failure modes)

| Failure mode | Guard |
|---|---|
| Mis-classifies a real bug as transient → retries forever | bounded retries + per-ticket budget; escalate-on-repeat; "K distinct attempts" not "K attempts" |
| Promotes a rule that hides a regression | promotion requires learning-loop + human; rules have provenance + are demotable; recurrence-without-root-fix is itself flagged |
| Prompt-injected / rogue supervisor | no destructive authority; all actions logged + reversible; SoT mutations limited to a sanctioned action set; supervisor runs with its own scoped creds (not ambient) |
| Escalation storm (everything → human) | the thing we're trying to avoid; measured directly (escalations/day is the north-star metric); if high, the deterministic + ground-truth layers are too weak — fix those, don't loosen the supervisor |

`[OQ-3]` Is the supervisor one agent per ticket (event-driven on failure) or one global monitor polling all tickets? Leaning event-driven (fires on a step failure / escalation signal) + a periodic sweep for stuck/silent tickets.
`[OQ-4]` Does the supervisor share the worker's model, or run a cheaper/smaller one? It needs strong judgment → Opus tier, but only fires on the (now-rarer) failures, so cost is bounded.
`[OQ-5]` How is "outcome=resolved" measured for promotion? Needs the ticket to actually reach a ground-truth-green state after the supervisor's action, not just "didn't immediately re-fail."

---

### 5.6 Memory-backed decision-making (supervisor + retrospective share it) `[DECIDED — operator suggestion 2026-06-18]`

The supervisor does NOT decide from a static rule dictionary alone. There is a single **shared decision memory** (markdown / jsonl / db rows — schema TBD) that the supervisor **RAGs over for every non-fast-path decision**, and that both the supervisor and the retrospective read AND write.

- **Record:** `{trace_ref, signature_features, situation, decision, action, outcome{resolved|escalated|recurred}, provenance{human|supervisor|retrospective}, confidence, supersedes?, ts}`.
- **HITL dominates.** A human's prior decision on a similar situation outranks any autonomous supervisor judgment in retrieval (provenance weight: human > retrospective-curated > supervisor-autonomous). This is the compounding mechanism: **the human teaches once; the memory enforces it forever** — directly serving the minimal-human goal.
- **Retrieval is provenance- AND outcome-weighted** (resolved > unknown > recurred), scoped/tagged (stage, failure-class, code-area) for precision. The supervisor must reason about whether a retrieved precedent *actually applies* (no blind-apply); **ground truth still arbitrates the result**, so a mis-retrieval is caught at the next verify.
- **The retrospective becomes a CURATOR of this memory** (dedup, consolidate, prune bad-outcome self-authored records, detect masking-bug signatures, promote high-confidence records into the Layer-1 fast-path index) — not a separate analysis producing separate artifacts.
- **Layer-1 deterministic dictionary = a high-confidence cache/index OVER the memory**, not a separate store. §5.1's three layers collapse: fast-path is just the hot subset of the same memory.

Pressure-test guards: poisoning/echo-chamber → provenance+outcome weighting, retrospective prunes bad self-authored records; retrieval precision → scoped tags + reason-about-applicability + ground-truth arbitration; HITL conflict → recency + explicit `supersedes`, surface unresolved conflicts to the human.

**Grounding:** this is exactly the shape of the memory system *this* Claude Code session uses — markdown files + frontmatter (`type: user|feedback|project|reference`) + a loaded index (`MEMORY.md`) + recall-by-relevance. Proven; mirror it.

### 5.7 Context assembly — "the right context at the right time" `[the make-or-break problem]`

Mis-retrieval (applying a superficially-similar but wrong precedent) is the dominant failure mode of a memory-backed gate. This is a **context-engineering problem — precision over recall, minimal-sufficient context** — not "stuff top-K into the prompt." Pure vector search fails: (a) semantic similarity ≠ decision-relevance (two "tests red" failures need opposite actions); (b) context is structured (stage/class/locus/scope), not a blob; (c) recency, supersession, and scope decide applicability and embeddings ignore them.

**Assembly pipeline (per decision):**
1. **Decision-type frame.** Each decision type (retry / scope-expansion / merge-readiness / recover-from-X) has a CONTEXT TEMPLATE: which dimensions to filter on, which ground-truth signals to pull. Prevents under-context (miss the rule) AND over-context (context rot).
2. **Hard structured scope-filter (deterministic, FIRST).** Narrow to memories whose declared SCOPE could apply: global always; project if same project; code-area if the diff touches it; per-ticket ONLY for that ticket. Kills cross-contamination — a per-ticket HITL never leaks to another ticket.
3. **Immutable constraints always injected in full.** Operator `hard_deny` + global HITL are small and load-bearing — never subject to top-K ranking. You must never "miss" a hard rule because it didn't rank.
4. **Semantic + structured ranking within the ADVISORY remainder only.** `score = sim(embedding) × provenance(human>retro>supervisor) × outcome(resolved>recurred) × recency(supersession applied) × freshness(content-fingerprint decay)`. Top-K.
5. **Explicit applicability judgment.** The supervisor first decides whether each retrieved precedent ACTUALLY applies (why / why-not) before deciding — no blind-apply. The applicability reasoning is itself recorded.
6. **Ground-truth arbitration.** Outcome verified regardless; a wrong retrieval → `outcome=recurred` → down-weights that precedent next time. Self-correcting.
7. **Agentic expansion fallback.** Default = deterministic assembly (fast, predictable); the supervisor MAY query memory/trace for more on hard cases (RAG-agent style), bounded by budget.

**HITL scope is a first-class captured attribute (the "varies per instance" answer).** When a human instructs, capture its INTENDED SCOPE. The system can't infer scope reliably → **default to narrowest (this instance); the retrospective PROMOTES to broader scope only on confirmed recurrence + human OK.** Optionally ask the human to scope at capture time. Scope narrow by default, widen on evidence.

**Freshness:** every memory carries a context-fingerprint (≈ the harness's existing `pipeline_content_hash`); relevance decays when the substrate it referenced changed. Stale precedents down-weighted/dropped.

**Injection-hardening (from §8):** agent/tool OUTPUT in the trace is quoted as DATA, never instructions.

**Decision-time working set (what's IN the context):**
1. Decision frame: type, proposed action, blast-radius tier.
2. Live situation (structured): stage, failure-class, **this ticket's trace summary incl. prior supervisor actions + their outcomes** (don't repeat a failed action), diff, branch/ref state.
3. Ground-truth signals: build / tests / CI / reviewer verdict / scope-diff-vs-plan.
4. In-scope immutable constraints (full).
5. Top-K advisory precedents (full records + provenance + outcome + recency).
6. Authorization context: what the human authorized for THIS run/ticket + standing boundaries.
7. Budget state: retries used, escalation budget remaining, tokens spent.

**Kept OUT:** raw tool output as instructions; the whole memory store; unscoped cross-ticket precedents; stale precedents.

**Memory record schema (index keys for retrieval precision):** `{scope_level(global|project|ticket-class|code-area|ticket), stage, decision_class, action_surface, code_locus, provenance, outcome, confidence, created_at, last_confirmed_at, supersedes, context_fingerprint, situation, decision, action, rationale}`.

**Irreducible hard part (honest):** applicability is an inference problem — we don't *solve* it, we **contain** it. Structured scoping reduces it; explicit applicability-judgment surfaces it; ground truth catches the errors; narrow-default-widen bounds the blast radius of a mis-scope.

### 5.8 The Unified Gate Layer (UGL) — consolidated spec `[DECIDED — consolidates §5.1–5.7 + §8]`

**ONE component.** Every consequential action by any autonomous actor routes through it **before execution**. Two callers, three scopes, one mechanism:
- worker-agent tool-call → **capability** scope
- supervisor recovery-action → **authority** scope
- a failure needing classification → **recoverability** scope (same machinery)

#### 5.8.1 Decision pipeline (deny-precedent, first match wins; gates BEFORE the action)
```
operator hard_deny (immutable)
  → protected paths (SoT / orchestrator-owned; never auto-approved)
  → static rules: deny > ask > allow  (broad deny beats narrow allow)
  → deterministic fast-path (known signatures: claude-death→retry, tests-red→loop, timeout→backoff)
  → [residual only] context assembly (§5.7) + model classifier
  → escalate if uncertain, irreversible-without-authorization, or budget exhausted
```
Read-only / in-scope-by-rule actions **skip the classifier** (bounds cost + latency). The classifier is the expensive path and fires only on the residual.

#### 5.8.2 Authority model (four tiers — from Claude Code, §8)
`hard_deny` (operator-set, **IMMUTABLE** by supervisor/learning loop) · `soft_deny` (overridable ONLY by explicit authorization + allow exception) · `allow` (exceptions) · **explicit intent** (read from durable MEMORY, not the transcript). The autonomous layer may **ADD** rules, never **DELETE** operator constraints.

#### 5.8.3 Tagging — who assigns each field `[DECIDED]`
- **DETERMINISTIC** (classifier/extractor, closed vocabulary — these gate scope & retrieval precision, so they must be reliable): `scope_level`, `stage`, `decision_class`, `action_surface`, `code_locus`, `context_fingerprint`, `provenance`, timestamps.
- **GROUND-TRUTH-MEASURED**: `outcome` (resolved/recurred), `confidence` (updated each firing).
- **MODEL-WRITTEN** (free text): `situation`, `decision`, `rationale`.
- Rule of thumb: **anything that filters or scopes retrieval is deterministic; only the narrative is model-written.**

#### 5.8.4 HITL scope capture `[VERBATIM — do not lossy-edit]`
- Capture scope as a first-class field on every HITL record.
- Default to the narrowest scope (this instance). A human correction applies to this ticket unless stated otherwise — so it can never silently over-generalize and cause collateral damage.
- The retrospective promotes to broader scope only on confirmed recurrence + explicit human OK. If the same narrow ruling keeps getting made across tickets, the learning loop proposes "make this a code-area rule," and a human confirms.
- Optionally, ask the human to scope at capture time (one cheap question) when the stakes are high.

This is why durable memory beats Claude Code's transcript-re-read: a scoped HITL instruction survives compaction and carries its blast radius with it. **"Narrow by default, widen on evidence" is the whole answer to per-instance variation.**

#### 5.8.5 Memory record — index keys (what makes retrieval precise) `[VERBATIM]`
`scope_level` (global/project/ticket-class/code-area/ticket) · `stage` · `decision_class` · `action_surface` · `code_locus` · `provenance` (human/retro/supervisor) · `outcome` (resolved/recurred) · `confidence` · `created_at` / `last_confirmed_at` / `supersedes` · `context_fingerprint` (≈ the harness's existing `pipeline_content_hash` — relevance decays when the world it described changed) · and the payload: `situation` / `decision` / `action` / `rationale`.

#### 5.8.6 Decision-time working set (what the gate reasons over) `[VERBATIM]`
1. **Decision frame** — type, proposed action, blast-radius tier.
2. **Live situation, structured** — stage, failure-class, and critically this ticket's own trace summary including prior supervisor actions and their outcomes (so it never repeats an action that already failed), the diff, branch/ref state.
3. **Ground-truth signals** — build / tests / CI / reviewer verdict / scope-diff-vs-plan. The arbiter.
4. **In-scope immutable constraints**, in full.
5. **Top-K advisory precedents**, each with full record + provenance + outcome + recency so the model can weigh them.
6. **Authorization context** — what the human authorized for this run/ticket + standing boundaries.
7. **Budget state** — retries used, escalation budget left, tokens spent (so it knows when to stop and escalate).

**Kept out:** raw tool/agent output as instructions (it's quoted as data — injection hardening); the whole memory store; unscoped cross-ticket precedents; stale precedents whose `context_fingerprint` no longer matches.

#### 5.8.7 Context assembly
Per §5.7: decision-type template → deterministic structured scope-filter → immutable-constraints-always-injected → semantic rank within advisory remainder → explicit applicability judgment → ground-truth arbitration → agentic-expansion fallback.

#### 5.8.8 Escalation budget (from CC fallback threshold)
N consecutive / M total denials-or-failed-recoveries → escalate to human (start at **3 consecutive / 20 total**); an allowed/resolved action resets the consecutive counter; exhaustion forces escalation. Per-ticket token / retry / wall-clock caps on top.

#### 5.8.9 End-to-end flow (one gate decision)
```
gate(actor, action, situation):
  tags = deterministic_classify(action, situation)     # 5.8.3 deterministic fields
  if match(operator_hard_deny, tags):  return DENY      # immutable
  if touches(protected_paths, action): return ASK_or_DENY(by_mode)
  r = static_rules(tags)                                # deny > ask > allow
  if r is decisive: return r
  if fast_path_known(tags): return fast_path_policy(tags)   # high-freq deterministic
  ctx = assemble_context(tags.decision_class, tags, situation)   # §5.7 / 5.8.6
  d = classifier(ctx)                                   # judges precedent applicability; closed action vocab
  if d.action in irreversible_tier and d.authorization != explicit: return ESCALATE
  if budget_exhausted(actor, ticket): return ESCALATE
  record(memory, tags, situation, d, provenance=actor_kind)   # outcome filled later by ground truth
  return d.decision
```

#### 5.8.10 Self-correction
Ground truth records `outcome` → `confidence` updates → reweights future retrieval → the retrospective curates (dedup / prune bad self-authored records / detect masking-bug signatures / promote on recurrence+human-OK). The gate learns from its own decisions; operator `hard_deny` stays immutable throughout.

## 6. North-star metrics (how we'll know it's working)

- **Operator touches / day** (today ≥2.5 via `human-decision`, + uncaptured UI edits). Target: ↓↓.
- **Escalations / shipped ticket** (the supervisor's escalation rate). The real autonomy signal.
- **Dispatches / shipped ticket** (today ~27). Target: → near the stage floor.
- **Halt/resume cycles** (today 747/29d). Target: ↓↓ (most become silent auto-recovers).
- **Learning-loop rule promotions / month** (today: 0 — loop is dead). Target: > 0 and rising then plateauing.
- **Time-to-first-ticket for a new operator** (`GOAL-INSTALL`). Today: a multi-step bash + launchd + secrets setup. Target: **one command, minutes** — single binary + embedded SQLite + self-bootstrapping schema (control-loop.md §10).

---

## 7. Open questions parking lot
- `[OQ-1]` scope-as-hard-gate vs reviewer-judged. (see §4)
- `[OQ-2]` review = stage vs verify-substep. (see §4)
- `[OQ-3]` supervisor: per-ticket event-driven vs global poller. (see §5.5)
- `[OQ-4]` supervisor model tier. (see §5.5)
- `[OQ-5]` promotion "resolved" measurement. (see §5.5)
- `[OQ-6]` merge: agent-driven (`gh pr merge --auto` + required CI) vs a second human `recv()` gate?
- `[RESOLVED→§9.2]` ~~OQ-7~~ isolation v1 = worktree + scoped creds + scoped tools; **Docker deferred** (add OS write-boundary only if self-leak persists; not per-task Docker-on-Mac). Container mgmt is language-agnostic.
- `[RESOLVED→§9]` ~~OQ-8~~ migration = **downtime-window clean cutover** (no shadow/dual-write, since 1–2 wk shutdown is OK) + greenfield-substrate / keep-leaves; autonomy layer incremental after.

---

## 8. Reference pattern: Claude Code's permission pipeline = spec for the unified gate `[claude-code-guide verified 2026-06-18]`

Claude Code already ships the thing we're designing: a layered, **deny-precedent, model-classifier-for-the-residual** permission system that decides allow/ask/deny **per action, BEFORE the action** (PreToolUse) — not after. Use it as the reference impl for BOTH the worker capability gate (move 4) and the supervisor authority gate (§5.3).

**Decision pipeline (first match wins, deny-precedent):** managed-deny (immutable) → PreToolUse hook exit-2 (hard block) → explicit `deny > ask > allow` (specificity does NOT override — a broad deny beats a narrow allow) → protected paths (never auto-approved) → ask rules → mode baseline → **auto-mode model classifier** → hook JSON allow/deny/ask → allow rules → fallthrough.

**The classifier's four-tier authority model — adopt as the supervisor + worker authority spec:**
1. `hard_deny` — unconditional; user intent CANNOT override (force-push to protected refs, prod deploy, `curl|bash`, mass deletion, IAM grants, irreversible destruction).
2. `soft_deny` — destructive-but-sometimes-legitimate; overridable ONLY by explicit authorization + allow exception.
3. `allow` — exceptions to soft_deny.
4. explicit intent — "force-push this branch now" overrides soft_deny; "clean up the repo" does NOT (generic ≠ authorization).

**Map to harness:**

| Claude Code mechanism | Harness component |
|---|---|
| 4-tier hard/soft/allow/intent | supervisor authority boundary (§5.3) AND worker capability set (move 4) — **same spec, two scopes** |
| explicit-intent-override (read from transcript) | §5.6 memory HITL records (read from durable memory) — **STRICTLY BETTER**: CC notes "scope loss on context compaction"; our memory survives it |
| fallback threshold (3 consecutive / 20 total blocks → resume prompting; an allowed action resets the counter) | the supervisor escalation budget — concrete starting numbers |
| classifier strips tool RESULTS (sees user msgs + tool calls + CLAUDE.md only; server-side probe flags hostile results) | supervisor must treat agent/tool output in the trace as **DATA not instructions** (prompt-injection hardening — directly relevant to the rogue-dispatch class) |
| protected paths (`.git/`, `.claude/`; never auto-approved even in bypass) | SoT + orchestrator-owned files — a baseline category, never a rule exception |
| managed settings (extend but never remove; `allowManagedPermissionRulesOnly`) | operator `hard_deny` is **IMMUTABLE by the supervisor/learning loop** — the key guard on promote-to-rule/memory: the autonomous layer may ADD rules, never DELETE operator constraints |
| read-only/in-scope ops skip the classifier | deterministic fast-path handles the bulk; supervisor fires only on the residual → bounds cost + latency |

**Bash matcher reality (corrects an earlier claim):** CC splits compound commands on operators and requires EACH subcommand to match — `Bash(git status *)` does NOT permit `git status && rm -rf .`. The harness's envelope-validator "chained-command blind spot" is the harness being *worse* than CC's own matcher. The irreducible gap is **variable injection** (`Bash(safe *)` can't stop `safe $X`) — which is exactly why a real capability boundary (scoped tools / sandbox / no raw shell) beats string-pattern gating. Reinforces move 4: isolation > detectives.

**Dividend:** worker capability gate, supervisor authority gate, and recoverability classifier (§5) are ONE layered, memory-backed, ground-truth-arbitrated mechanism at three scopes — and CC is the shipping reference. We improve on it in one place: durable memory for intent/HITL instead of transcript-re-read (no compaction scope-loss).

---

## 9. Migration plan — downtime-window cutover, then incremental autonomy `[DECIDED 2026-06-18 — operator OK'd a 1–2 week full shutdown]`

### 9.1 Shape: greenfield-the-substrate, keep-the-leaves, clean cutover
The 1–2 week downtime removes the strangler's hardest constraint (never two authoritative writers), so we do **NOT** dual-write/shadow. Instead:
- **Greenfield (fresh, in the window):** the SQLite SoT + state model, and a minimal durable control loop (TS).
- **Keep (call as leaves):** `dispatch.sh`, `render-prompt.sh`, the per-stage tool allowlists, `AGENT_PROMPTS.md`, `scope-check`'s diff logic. The agent-INVOCATION mechanics are the least-buggy, most-knowledge-dense part (the 195 tickets of edge cases live here). The new loop shells out to them.
- **Cut over:** repoint launchd from `run-local.sh` to the new loop; bring the pipeline back up on SQLite.

**Scope boundary (hard):** the window buys the **substrate swap, NOT the autonomy layer.** UGL / supervisor / memory / ground-truth-verify are built incrementally *after*, pipeline live. Attempting them in the window blows it up.

This is the piecemeal-greenfield the operator was open to: greenfield for the net-new (substrate, loop, later autonomy); reuse for the leaves.

### 9.2 Stack `[DECIDED]`
- **Language: TypeScript.** zod for the schema-validate-or-reprompt primitive (central, everywhere); first-class Anthropic SDKs; keeps the native Agent SDK open; typed state (untyped state is what bit the harness). `node v26` is on the host and **escapes the bash-3.2 curse entirely.** *Go is defensible* (single static-binary daemon, native Docker SDK, concurrency) and viable **because we keep the CLI leaf** (orchestrator only needs Messages SDK + process-spawn + SQLite) — but loses on zod + Agent-SDK-optionality. Python is the third option; TS wins on typed state.
- **SoT: SQLite** (zero-ops, transactional, `sqlite3` CLI writable from bash during transition, single-writer fine for one operator). Postgres only on real concurrency demand (`psql 18` also present).
- **Isolation v1: worktree + scoped creds + scoped tools. Docker DEFERRED.** No ambient `LINEAR_API_KEY`; no `gh`/Linear tools; worktree is the only writable surface. Add an OS write-boundary (`sandbox-exec` / a Linux VM — **not** per-task Docker-on-Mac, which is a Linux-VM overhead) only if self-leak still occurs. **Container management is language-agnostic and does not drive the stack choice.**
- **Agent invocation: keep `dispatch.sh` (`claude -p` CLI) as the leaf** initially — this keeps the stack open and the embedded knowledge intact. Go native Agent SDK later only if richer loop control is needed (TS/Python).

### 9.3 Why the open pieces don't pin the stack
ground-truth-verify (shell out / GH Actions API), durable control loop (SQLite journal), isolation (CLI/socket) are all **stack-agnostic**. The ONLY stack pin is agent-invocation IF it goes native Agent SDK — and keeping the CLI leaf keeps even that open. ⇒ deciding TS now is safe; the fluid design pieces affect **WHAT we build, not WHICH language.**

### 9.4 Cutover checklist — what must be TRUE to flip launchd
Build during the window; verify before the flip:
1. **SQLite schema** holds everything `run-local`/`poll`/`run-stage` reconstruct each tick today: per-ticket stage, dispatch seq/id, policy, wait/skip state, rejection counters, branch shape, the step journal. (Port from `issue-state.json` + labels + the marker vocabulary.)
2. **Idempotent step journal** working: a step that already ran returns its recorded result on replay; external side-effects carry idempotency keys; crash mid-step resumes at that step.
3. **Hand-handle the in-flight tickets (one-time, manual — NO import mechanism).** `[revised 2026-06-19]` The in-flight surface is tiny: at any time only the handful of Linear `started` tickets carry harness state (Backlog/Todo carry none). For each, decide *abandon* / *finish on the old harness first* / *hand-insert one `ticket` row*. **2026-06-19 disposition: ENG-204/205/206 — the only three in-flight, all halted, all children of ENG-202 — are ABANDONED:** they implement orchestrator-merge for agent-written `plan.json`/`review.json`/`ledger.jsonl`, i.e. exactly the artifact-shape gate class the new substrate *deletes* (§8.5 / control-loop), so they're obsolete in the new world, not migratable. No import code, no mapping doc; the v2 schema deliberately stores no legacy `pipeline:skip-until-*` / gerund-stage state.
4. **Linear → one-way projection**: close the 2 direct-API bypasses (`run-stage.sh`, `setup.sh`); all Linear writes go through one projector reading SQLite; **no code path reads Linear to decide control flow.**
5. **Minimal loop** drives the deterministic state machine + Deliverable-1 KEEP↻ gates, shelling out to `dispatch.sh` for the agent step. **NOT the autonomy layer.** `[revised 2026-06-19 per DS-2 clean break]` This is the **new** C1 machine (`design → implement[work-units] → verify → review → merge → released`), not a literal port of today's 8-gerund machine — the clean-break stage vocab + work-unit decomposition (both substrate BLOCK items) are in from day one; the in-flight tickets are hand-mapped at import (#3).
6. **Track-1 fixes carried in** (can ship on old substrate first): claude-death→retry, no-ambient-key, pre-existing-red-doesn't-block.
7. **Rollback path**: old `run-local.sh` + Linear/files intact and re-flippable for the window; the SQLite import reproducible. If the new loop misbehaves in week 1, flip back.

Flip = repoint launchd → watch one full ticket (idea→PR) on the new loop → if green, decommission the old write paths (NOT the leaves).

### 9.5 Post-cutover increments (pipeline live; retire gates per Deliverable 1 §4)
- **I-A** orchestrator-owns-artifact-envelope + schema-reprompt → folds the ~21 artifact gates.
- **I-B** ground-truth verify (build/tests/CI/scope-diff/reviewer) replaces self-report; correctness gates loop-not-halt → discards dimensional grading.
- **I-C** UGL (§5.8) as the single gate for worker tool-calls + supervisor actions.
- **I-D** supervisor + memory (§5) on the clean trace.
- **I-E (optional)** containers if self-leak persists; Postgres if concurrency demands.

Each increment fully cuts over its concern; retire each gate only when its substrate dependency is **complete**.

---

## 10. Open Decisions Register `[closing the spec — 2026-06-18]`

Status legend: **DECIDED** (confirmed by operator) · **RATIFIED** (proposed, no objection — revisit anytime) · **LATER** (default set, tune post-cutover) · **OPEN** (still needs work).

| ID | Item | Gate | Status | Decision |
|----|------|------|--------|----------|
| A1 | Ground-truth verification | BLOCK | **DECIDED** | Objective + EXTERNAL to the agent (no self-report). Layered: build → tests (existing + the plan's `test_plan` realized as real tests; **behavioral ⇒ test required, non-behavioral exempt; design stage classifies**) → diff⊆scope (advisory → reviewer) → independent reviewer → CI green (required check = merge arbiter; PR #184 hermeticity is a prereq). Runs in the worktree via project-profile commands. |
| A2 | Independent reviewer agent | BLOCK | RATIFIED | Cold context; sees diff+plan+test-results, NOT the implementer's narrative; emits approve / blocking-findings+severity; judges scope expansion. |
| A3 | Scope: hard gate vs reviewer-judged | BLOCK | DECIDED | Reviewer-judged (diff-scope is advisory). Kills the ENG-194 catch-22. |
| A4 | Review: stage vs substep | BLOCK | DECIDED | Distinct gate (separate cold context) after implement↔verify converges. |
| B1 | Durable control loop | BLOCK | DECIDED | Single long-running TS daemon (kept alive by the host service manager — launchd on macOS / systemd on Linux); event loop picks ready tickets from SQLite → runs next step → journals result → replay-on-restart. Minimal home-built (no DBOS). |
| B2 | Concurrency | BLOCK | DECIDED | Cap K=2–3; **only the daemon writes SQLite** (workers return results) → single-writer is the design; two-authoritative-writers (ENG-217) impossible by construction. |
| B3 | Idempotent side-effects | BLOCK | DECIDED | Every external-effect step (git push, `gh pr create`, Linear projection) carries an idempotency key + did-this-already-happen check before replay. |
| B4 | service model | LATER | DECIDED | Long-running daemon under the host service manager (launchd/systemd), not a cron/`StartInterval` tick. |
| C1 | Stage model + impl decomposition | BLOCK | **DECIDED (revised)** | design (brainstorm+plan) → **IMPLEMENT phase = the plan decomposes the ticket into focused work-units, each tagged by KIND (backend/frontend/data/… per the project-profile's stack vocabulary), each its OWN dispatch with kind-appropriate tools + clean focused context** (NOT one overloaded implement) → verify → review → merge. UI = a *frontend work-unit* (implementation) + a *verify check-type* (visual/Playwright); **no hardcoded `ui` stage**. Backend-only ticket = 1 unit = 1 dispatch (no waste). Scales to ticket size; stack-agnostic (de-webs ENG-167). |
| C2 | Ticket-size → track | BLOCK | DECIDED | Reuse the sizing rubric: fast-track (skip heavy design persona-review) vs full-track. |
| C3 | Verify granularity | LATER | DECIDED | Two-level: per-work-unit local verify (bounded generator↔verify loop) + ticket-level integration verify before review. |
| D1 | Human gates | BLOCK | DECIDED | Genuine HITL = supervisor escalations + MERGE + optional large-ticket plan-approval. |
| D2 | Merge | BLOCK | **DECIDED** | **Fully human-gated initially** — reviewer + CI make the PR *ready*; the human performs the merge. Auto-merge earned later per ticket-class via the learning loop (dial starts fully closed). The single human gate relocates to merge. |
| D3 | Escalation surface / needs-you inbox | LATER | DEFAULT | Slack notify + SQLite-backed queue via a status command; Linear stays the human tracking projection. |
| E1 | Memory + RAG substrate | LATER | DEFAULT | Same SQLite (structured cols = the index keys) + embedding col; brute-force cosine while small → `sqlite-vec` when it grows; cheap external embedder (Anthropic has no embeddings API). |
| E2 | `decision_class` / `action_surface` vocab | BLOCK-for-UGL | **OPEN** | Enumerate from the 41-code taxonomy (~6 decision classes) + the supervisor's closed verb set. Needed before the UGL (post-cutover), not before the substrate. |
| E3 | Supervisor: event vs poll | LATER | DECIDED | Event-driven (on step-failure/escalation) + periodic stuck/silent sweep. |
| E4 | Supervisor model tier | LATER | DECIDED | Opus 4.8. |
| E5 | Promotion "resolved" measurement | LATER | DEFAULT | High bar + human above the lowest blast tier; resolved = ground-truth-green after the action + no recurrence in N similar situations. Contained, not solved. |
| E6 | Learning-loop cadence + curator | LATER | DEFAULT | Triggered (on record accumulation) + periodic; curator = dedup/prune/promote/demote/masking-detect. |
| F1 | Model tiering | LATER | DECIDED | design/review = Opus 4.8 · implement = Sonnet 4.6 · supervisor = Opus 4.8 · build = Haiku 4.5. |
| F2 | Budgets | LATER | DEFAULT | per-ticket token/retry/wall-clock caps + escalation budget (3 consecutive / 20 total). Tunable. |
| F3 | Self-hosting meta-gate | LATER | DECIDED | Survives as a CI required check; ground truth applies to the harness's own code. |
| F4 | Project-profile reuse | BLOCK | DECIDED | The existing per-project profile = source of build/test/tools/file-layout. Carries forward; A1 depends on it. |

**Closure status:** every BLOCK item is DECIDED except **E2** (vocabularies) — and E2 only blocks the UGL, which is post-cutover. ⇒ **the substrate spec (A/B/C/F BLOCK items) is CLOSED → ready to design the SQLite schema + daemon.**

---

## 11. Changelog
- **2026-06-19** — **SQLite schema shipped** → `docs/architecture/schema.sql` (§9.4 checklist #1). 16 tables grounded in a field-level inventory of the current state (issue-state.json, dispatch_history.jsonl, wait/verdict payloads, pipeline-events.json marker vocab, linear-ids.json). Loads clean (`PRAGMA integrity_check=ok`, `foreign_key_check` clean); invariants smoke-tested (idempotency-key uniqueness, step_key replay anchor, rejection-counter derivation, signal-parking). Memory/UGL tables deferred to post-cutover (commented stub). Added §12. Decisions logged there (DS-1…DS-7); none block the next artifact.
- **2026-06-19** — **durable control-loop semantics drafted** → `docs/architecture/control-loop.md` (§9.4 #2). Daemon (B1) + event loop; a step catalog with per-step **guards / inputs / outputs** (S1–S10); write-ahead-intent step contract; all external effects via the outbox (CL-2); re-attempt + probe reconciliation (CL-3); durable signals; deterministic failure→escalate-as-wait; crash-resume discharged. Operator added **`GOAL-INSTALL`** (trivial one-command install) as a first-class goal → §3 decision + §6 metric + control-loop.md §10. Forks resolved: CL-2/CL-3 + step granularity. Open: CL-1 (one daemon/all projects).
- **2026-06-20** — **build & operations captured (open-core)** → `docs/architecture/build-operations.md`. Operator confirmed the redesign is the **free OSS execution core** of an **open-core** product, with a commercial SaaS "Control Plane" around it (vision: `~/code/SDLC SaaS Product.md`). Decisions: **new repo** (Styre — not built inside the legacy harness repo); **do NOT vendor the leaves — port them authoritatively into the new TS codebase** (supersedes minimal-loop §3's shell-out-to-`dispatch.sh`; dispatch invocation becomes native TS); old repo stays for the rollback window. Re-thought install/setup for two audiences: distribution = binary + GitHub Action + container; **run modes** = `setup` (probe) / `daemon` (persistent local) / **`run <ticket>`** (one-shot headless runner — the CI/fleet primitive, ephemeral per-run SQLite); **dual auth** (subscription session locally + `ANTHROPIC_API_KEY` headless); **four-tier config** (per-ticket `styre_config` block > workspace `config.json` > profile > defaults). Defined the **open-core seam** (the stable contracts the plane plugs into: the Linear ticket contract, the profile artifact, the telemetry export, a later API) as the build priority. Confirmed: the three run modes, dual auth, and the seam-as-build-priority. **Corrected:** there is **no "pre-scoped" track** — a SaaS-enriched ticket is just richer *input* to the design stage, which always runs full-strength (same as design from any rich Linear ticket); fast/full-by-size stays the only track. Per-ticket budget = N-cycles/strictness → K_DISTINCT/block-threshold; telemetry is a first-class paid-product output.
- **2026-06-19** — **final 5-doc coherence pass — STRONG, two minor fixes.** Cross-referenced all five (schema · control-loop · projector · minimal-loop · brainstorm) for stale-vocab, schema-reference integrity, cross-doc vocabulary, decision-consistency, and dangling refs. Result: clean across the board (no pre-v2 vocab leaked; every referenced table/column exists; signal types / event_log kinds / budget numbers / model tiers / stage vocab all consistent; D2/CL-NODEFER/CL-COMMIT/CL-1/F4 honored everywhere). Two fixes: (1) control-loop §12 had a stale "next artifact = §9.4 #3" forward-ref + listed the budget-numbers/inbox as still-open — both now resolved (pointed at minimal-loop §4/§5; #3 marked dropped); (2) `human_plan_approval` was defined-but-unwired — clarified in minimal-loop §7 as the optional large-ticket D1 gate, intentionally not wired at cutover. Substrate spec is now mutually coherent and PR-ready.
- **2026-06-19** — **§9.4 #5 minimal loop drafted → SUBSTRATE SPEC COMPLETE** → `docs/architecture/minimal-loop.md`. The concrete `next_step_key` deterministic state machine (`design → implement[units] → verify → review → merge → released`) + the loopback-reset table (what each atlas route resets so the resolver re-picks it) + the dispatch shell-out keeping the bash leaves (two modes: worktree-agent CLI leaf vs structured-judgment sidecar→forced-schema-at-I-A; §3a disambiguation holds at cutover, the in-context self-correct cost-optimization is I-A) + the **pinned budget numbers** (K_DISTINCT=3, consecutive=2, B2=3/20, B3=3× rolling-median clean-ticket $/wall-clock with $25/4h bootstrap floors, per-stage timeouts, OUTBOX_RETRY_BUDGET, POLL_INTERVAL=60s, K=2) + the **D3 needs-you inbox** (SQLite-backed `styre inbox`/`status`, Slack notify, resume/resume--after-fix/abandon actions) + the cutover acceptance run. All five §9.4 design artifacts done and coherent; what's left is operational (build in the window, #6 track-1, #7 rollback).
- **2026-06-19** — **§9.4 #4 one-way projector drafted** → `docs/architecture/projector.md`. The sole outward write path (move 2): a daemon subsystem that drains `projection_outbox` and applies each row to Linear/GitHub idempotently (CL-3 re-attempt + probe; label-safe declarative `set_labels`). Enqueue is daemon-side in the same tx as the state change (vs `projection_state` delta — no-op projections suppressed); the drain is decoupled so an outage delays projection (escalates X1 past the retry budget) but never blocks the loop. Projection mapping table (stage/status → Linear state+labels+comments, branch/PR → GitHub; `pr_merge` NOT projected at cutover — human merges, D2). No control-flow reads of Linear (inbound facts = signals). Closes the legacy run-stage/setup bypasses by construction.
- **2026-06-19** — **dropped §9.4 #3 (the state-import mechanism); abandoned the in-flight tickets.** Checked Linear: the *entire* in-flight surface was 3 tickets (ENG-204/205/206), all halted, all children of ENG-202 — and all implementing orchestrator-merge for agent-written `plan.json`/`review.json`/`ledger.jsonl`, exactly the artifact-shape gate class the new substrate deletes (§8.5). So there is nothing to migrate: **abandoned all three (Linear → Canceled + rationale comment).** #3 collapses from "build a one-shot import" to a 3-line manual cutover checklist; cutover artifacts remaining = #4 projector, #5 minimal loop.
- **2026-06-19** — **coherence pass: schema → v2, aligned to the frozen control-loop.** Cross-referenced `schema.sql` against `control-loop.md` (mechanical + semantic). Removed old-model drift: the ticket skip-policy block (policy/exit_code/retry_count/pipeline_content_hash — no skip-dance in the new loop) and `status='halted'` (P1); `pipeline_event` → lean **`event_log`** (transition/loopback/escalated/resumed; verdicts are derived from `review_finding`, not stored); **`review_finding` realigned** off the ENG-191 shape to single-severity + category + factors + `deferral_candidate` + daemon-computed `blocks_ship` + `review_kind` (plan|code) + a critical-floor CHECK; removed `dispatch.verdict_emitted/target`. Added `ticket.needs_docs`, `project.checks_system`(+config), `workflow_step.pid`, `ground_truth_signal.signal_type`=open check-type, signal vocab (`external_checks`/`external_pr_result`); `v_rejection_counts` rebuilt on `event_log`. Kept idempotency keys globally-unique-by-construction (overrode the audit's scope-it suggestion). Re-verified clean + invariants smoke-tested. Forensic/projector orphans confirmed fine.
- **2026-06-19** — **Loopback Atlas rebuilt from first principles + plan-review added.** Audited the *current* harness for every failure/halt/loopback reason (~60); ~35 are deleted by the substrate (capability isolation / single-SoT / ground-truth / daemon-owns-envelope), recorded in control-loop §8.5 so coverage isn't re-litigated. Rewrote §8 from 7 first principles — **P3: cost+time is the governing budget, auto-calibrated to ~3× this project's median clean-ticket** (attempt-caps are proxies); **P5: loopback scope = failure scope** (unit/ticket/plan column, reconciles partial-vs-full resets). Pinned the failure-signature definition, the counter hierarchy (per-loop / B2 thrash / B3 resource), and the post-escalation lifecycle (park→inbox→resume/fix/abandon). Fixed the six operator-flagged defects (D2 daemon-completeness; unified rebase primitive w/ phase-dependent aftermath; sharpened blocking-finding; reviewer-judged scope; V5 removed; V3/P1 scoped). Added **S1c `design:review`** — a cold semantic plan-quality gate (full-track), shift-left to catch plan defects an order of magnitude cheaper than at code-review (shrinks V3). Added CL-POSTCOND (per-step postconditions) + CL-PROFILE (pre-dispatch profile gate) + X1/X2 (external-effect/worktree-corruption escalations).
- **2026-06-19** — **control-loop step catalog FROZEN after a full operator walkthrough (S1–S10).** Decided: CL-1 (one daemon/all projects); daemon-commits (CL-COMMIT); daemon-orchestrates-the-sequence, no master LLM agent (CL-ORCH); **design split** into Opus plan-doc + cheap forced-schema extract; **implement phase** = hybrid rebase (daemon-clean / agent-on-conflict) → Sonnet implement (tests inside, internal code↔test loop) → daemon ground-truth verify; conditional ticket-level `docs:revise`; **review redesigned** — findings filed one-at-a-time via validated tool calls, daemon derives ship/no-ship from state, **no deferral dictionary** (record-now/learn-later), critical-floor absolute (§3a validated-interface principle added to §3); **generic checks-system** (CL-CHECKS) by polling (CL-POLL); push-once-after-review; cheap-AI PR descriptions; single human merge gate, no deadline, auto-merge off; **stale-branch handling** (CL-STALE, tiered re-validation); the **Loopback Atlas** (control-loop §8) enumerating every loopback + the bounded/escalate-as-wait invariants. Open: per-ticket budget numbers; needs-you inbox surface (with #4).
- **2026-06-19** — **operator review of the DS-# decisions.** DS-3/4/5/6/7 approved as-is. **DS-2 revised → clean break:** `ticket.stage` now carries the new C1 vocab (`design/implement/verify/review/merge/released`), not the legacy gerund stages — migration surface is tiny (only In-Progress / In-Review tickets hand-mapped; Backlog has no harness stage). §9.4 #5 annotated accordingly (cutover loop drives the new machine). **DS-1 revised:** store UTC + **display in the operator's local timezone everywhere** (status/Slack/logs); tz lives only at the display edge. Schema re-verified (loads clean; new vocab accepted, legacy rejected).
- **2026-06-18** — doc created. Captured diagnosis, 6 design moves, DBOS→build-minimal decision, §4 gate taxonomy, §5 supervisor design.
- **2026-06-18** — added §5.6 memory-backed decision system (operator suggestion); added §8 (Claude Code permission pipeline as the unified-gate spec, claude-code-guide verified). Seeded north-star metrics + OQs.
- **2026-06-18** — added §5.7 context assembly (the make-or-break retrieval problem); added §5.8 the consolidated Unified Gate Layer spec. Locked the tagging split (deterministic scope-gating fields vs model-written narrative). §5.8.4/5.8.5/5.8.6 carry verbatim-fidelity content (HITL scope capture, index keys, working set) — do not lossy-edit.
- **2026-06-18** — operator simplifications: OK to shut down 1–2 weeks; greenfield-piecemeal acceptable; SQLite confirmed. Added §9 migration plan (downtime-window clean cutover + checklist). Locked stack: TS + SQLite + defer-Docker + keep-CLI-leaf. Resolved OQ-7 (isolation) and OQ-8 (migration).
- **2026-06-18→19** — closed the spec: added §10 Open Decisions Register. Operator confirmed: fully-human-gated merge (D2); behavioral-vs-non-behavioral test gate (A1); sizing rubric (C2). Revised C1 — implementation decomposes into focused per-work-unit dispatches tagged by kind (backend/frontend/…); no hardcoded `ui` stage; UI = a frontend work-unit + a verify check-type (fixes the "overloaded implement" concern). Only E2 (vocabularies) remains OPEN and is post-cutover. Substrate spec CLOSED.

---

## 12. The SQLite schema `[SHIPPED 2026-06-19 → docs/architecture/schema.sql]`

The cutover SoT (move 2). Single transactional store; **only the daemon writes** (B2);
Linear/GitHub are one-way projections. Scope = substrate only (§9.1) — the UGL/supervisor/
memory tables (§5.8) are a commented `-- DEFERRED` stub, created in increment I-D, not at
cutover. Grounded in a field-level inventory of the current 3-medium state (issue-state.json +
labels + comment markers), so every column ports a real field rather than an invented one.

**16 tables, mapped to the requirement each satisfies:**

| Table(s) | §/Decision | Replaces |
|---|---|---|
| `project`, `ticket` | per-ticket state; A-group | issue-state.json + `stage:*`/`pipeline:*` labels |
| `work_unit` | C1 | the hardcoded `ui` stage (UI = frontend `kind` + visual verify check-type) |
| `workflow_step`, `signal` | B1/B3 | tick lock, ENG-87 dispatch-id contract, wait-`<stage>`.json, soft-pending |
| `dispatch` | — | dispatch_history.jsonl + usage-`<stage>`.json |
| `pipeline_event` | move 2 | state-driving Linear comment markers (verdict/transition/decision) |
| `metric_event` | §6 | metrics/events.jsonl |
| `ground_truth_signal`, `review_finding` | A1/A2 | dimensional-grading self-report (verdict-qa/review.json) |
| `linear_id_cache`, `projection_state`, `projection_outbox` | §9.4 #4 | linear-ids.json + the ~30-ticket reconciliation class |
| `v_rejection_counts`, `v_ready_tickets` | — | guards.sh comment-grepping; poll.sh slot logic (derived, not stored) |

**Verified (not just written):** loads clean (`integrity_check=ok`, `foreign_key_check` clean);
idempotency-key UNIQUE rejects a duplicate external effect; `(ticket_id, step_key)` UNIQUE is the
deterministic-replay anchor; `v_rejection_counts` correctly returns *1* across a 2-fail → resume →
1-fail sequence (the guards.sh "since last operator-resume" semantic, now a SQL view); a ticket
parked on a pending `signal` drops out of `v_ready_tickets`.

**Schema decisions (DS-#) — sensible defaults, all revisable; flag any to change:**
- **DS-1 Timestamps: store UTC, display local** `[operator 2026-06-19]`. Stored as TEXT ISO-8601-UTC
  — one canonical internal form (lexically sortable; sqlite3-CLI debuggable; `strftime()` for
  arithmetic). **All operator-facing display — status CLI, Slack, logs — converts UTC → the host's
  local timezone at render time.** Storage is never local-tz; tz-conversion lives only at the display
  edge. Carried forward as a daemon/CLI display requirement (not a schema concern).
- **DS-2 Clean break to the new C1 stage vocab from day one** `[operator 2026-06-19]` —
  `ticket.stage ∈ {design, implement, verify, review, merge, released}`, NOT the legacy gerund stages.
  Rationale: the migration surface is tiny — only the handful of In-Progress / In-Review tickets are
  hand-mapped at import; Backlog tickets carry no harness stage yet, so there is nothing to translate.
  Implement decomposes into `work_unit` rows; UI is a frontend work-unit + a visual verify check-type,
  never a stage. (Supersedes the earlier "keep legacy names, rename later" default — no transitional
  dual-vocab, no drift pair.) **Consequence for §9.4 #5:** the cutover loop therefore drives the *new*
  5-stage + work-unit-decomposition machine, not a literal port of today's 8-gerund machine. Still
  substrate-only — C1 (decomposition) is a substrate BLOCK item, not the autonomy layer — but it is
  marginally more design surface in the window than a verbatim reproduction.
- **DS-3 `stage`/`status`/`policy` split into 3 columns** — the legacy model conflated them into
  `stage:X` + `pipeline:halted` + `pipeline:skip-until-*` labels. Linear labels become projections of
  these. (`pipeline:paused` → `project.paused` global breaker; `pipeline:rule-reviewed` is the
  orthogonal retro gate, lives with the deferred memory tables.)
- **DS-4 Control markers are a first-class `pipeline_event` table** (the durable SoT), NOT derived
  from `dispatch` rows. Verdict freshness (ENG-87 `dispatch_id`) and rejection counters need the
  full marker stream; Linear comments become its projection.
- **DS-5 `work_unit.kind` is OPEN text, not a CHECK enum** — sourced from the project-profile stack
  vocabulary; stack-agnostic by design (de-webs ENG-167). The verify check-types (`unit`/`visual`/
  `playwright`/…) are JSON, same reason.
- **DS-6 Transactional outbox for projection** (`projection_outbox` + `projection_state`) rather than a
  `dirty` flag — same-tx SoT-write + outbox-row, drained idempotently → exactly-once one-way writes
  (B3) and crash-safety, the cleanest expression of "no two authoritative writers" (ENG-217).
- **DS-7 Memory/UGL tables deferred** (commented stub w/ the §5.8.5 index keys). E2 (`decision_class`/
  `action_surface` vocab) is still OPEN → those CHECK enums are placeholders until enumerated.

**Next:** §9.4 #2 — the durable control-loop / step-journal *semantics* (the daemon B1 that drives
this schema: replay-returns-recorded-result, idempotent effects, crash-resume), then #3 the one-time
import mapping and #4 the projector.
