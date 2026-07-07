# Design-loop convergence — the review-loopback dead-end

**Status:** Design (brainstorm output) — approaches discussed with the operator (postcondition = plan-*exists*; one feedback-carrying re-engagement; repeated-finding → deliver-with-caveat, not hard-block). Pending written-spec review + independent review. Isolated on branch `feat/change-scoped-verify-brainstorm` (off `main`).
**Date:** 2026-07-07
**Scope:** one control-loop defect surfaced by the bench (darkreader-7241, SMOKE=2 re-run, styre @ `d7c5a1a`): a `design → review → design` loopback can **dead-end**, blocking a ticket whose plan is already correct. Two intertwined code causes + a convergence/exit rule. **This is separate from the verify-gate work** — it is a routing/convergence bug in the *design* loop, upstream of implement/verify. The change-scoped-verify design (Option B + T-min + pre-warm) is unaffected and stands as-is.
**Builds on:**
- `docs/architecture/control-loop.md` — the per-ticket event loop, CL-POSTCOND (dispatch postconditions), the Loopback Atlas (§8), review-origin loopbacks.
- `docs/brainstorms/2026-07-05-verification-as-differential-inference-design.md` — the **deliver-with-caveat** philosophy (a change styre could not fully bless is *delivered with an honest, surfaced caveat*, not silently blocked). §3's exit rule is that philosophy applied to a *review* disagreement.
- `CLAUDE.md` invariants: **loop-not-halt** (absorb-and-continue, don't dead-end to a human that the OSS headless path doesn't have); ground truth over self-report; structured agent output through a validated interface.

---

## 1. What happened (the darkreader trace)

On the SMOKE=2 re-run, darkreader-7241 (`ENG-270`) ended `blocked / loop-exhausted` at **`design:dispatch`**, never reaching implement — with the *correct* fix already written in its plan. The dispatch ledger:

```
design seq1 clean  ·  design seq2 clean
loopback: design → review   (finding at docs/plans/ENG-270-…​.md:45)
design seq3 clean            (plan written; root cause + WU1/WU2 correct)
design seq4 postcondition-failed   "no plan committed under docs/plans/"
escalated: step 'design:dispatch' failed
design seq5 postcondition-failed   → blocked
```

The design agent had **correctly diagnosed the bug** (an un-anchored delimiter regex in `indexSitesFixesConfig` mis-parsing Base64 `==` padding) and written a sound 2-work-unit plan. A **consistency review then raised a genuinely valid objection** (the plan's proposed `/^…$/gm` regex, with `m`, uses zero-width anchors that won't preserve the plan's own stated byte-identical-offset invariant) → loopback to design. On the revision the agent concluded *"No changes needed — the plan is correct and already committed"* and **wrote nothing**. That no-op revision tripped the postcondition, escalated, retried once, and blocked.

Two independent causes produced this. Either alone would have avoided the dead-end; both need fixing to make the loop *converge*.

---

## 2. The two code causes

### 2.1 The postcondition demands a *fresh commit*, not a *valid plan* — `[cause of the block]`

`src/dispatch/handlers.ts:195-203`:

```ts
postcondition: ({ worktreePath, changed }) => {
  const plansDir = join(worktreePath, "docs", "plans");
  const hasPlan =
    changed && existsSync(plansDir) && readdirSync(plansDir).some((f) => f.endsWith(".md"));
  if (!hasPlan) {
    throw new Error("design:dispatch postcondition: no plan committed under docs/plans/");
  }
},
```

The `changed &&` requires **this dispatch** to have committed something. A justified no-op revision (a valid plan already on disk, agent decides no edit is warranted) has `changed === false` → `hasPlan` is false → throw → `postcondition-failed`. The postcondition is asking the wrong question: it should assert **"a valid plan exists for this ticket"**, not **"this turn produced a commit."**

`changed` is also redundant as a failure guard here: a genuinely empty/failed dispatch is caught *upstream* — `runAgentDispatch` throws on transport failure and CL-PROFILE miss **before** the postcondition runs (`src/dispatch/run-dispatch.ts:52,125-127`). So the postcondition only executes on a dispatch that *did* run and produce structured output; the only thing it needs to verify is that the durable artifact (a plan) is present.

### 2.2 The re-dispatched design agent can't see the objection — `[cause of the dismissal]`

`design:dispatch` renders `designVars(ctx.ticket, deps.profile)` (`handlers.ts:190-194`). The review's findings are persisted (`insertFinding`, `handlers.ts:305-320`) but are **not** threaded into `designVars`, so the round-2 design agent re-runs on the *same inputs as round 1* — blind to the specific objection. It re-reads its own plan, finds it self-consistent, and says "no changes needed" (`seq4`/`seq5`). The loop can't converge on feedback the agent never receives. This is why a *correct* review was *dismissed* — not (only) agent stubbornness, but a missing input.

---

## 3. Design

Three changes; the first unblocks, the second gives the agent a real chance to converge, the third bounds the loop and turns an unresolved disagreement into a delivered-with-caveat outcome instead of a dead-end.

### 3.1 Postcondition = plan *exists* `[unblocks]`
Drop the `changed &&` term:
```ts
const hasPlan = existsSync(plansDir) && readdirSync(plansDir).some((f) => f.endsWith(".md"));
```
Now a no-op revision over a valid plan passes and routes **forward**; a genuinely planless dispatch still fails (empty `plansDir`). Transport/empty failures remain caught upstream, unchanged. *(Sibling postconditions that gate on a real commit — implement's diff postcondition — are untouched; "a durable plan artifact exists" is the right invariant only for design.)*

### 3.2 Carry the reviewer's exact findings into the design re-dispatch `[one real engagement]`
When a `design:dispatch` is entered **as a review-origin loopback**, inject the last round's *blocking* findings (verbatim `category` / `location` / `rationale`) into `designVars` — a `review_feedback` block the design template renders as "a prior review raised these; either revise the plan to address each, or state per-finding why it does not apply." The agent now sees the objection it must engage. First (non-loopback) design dispatches render an empty block (unchanged behaviour).

### 3.3 Bound the loop: repeated finding → deliver-with-caveat, not hard-block `[convergence + exit]`
The machinery already exists: `review-verdict.ts:23-38` computes a deterministic `findingsSignature` (sorted `category:location`) and `isRepeatedReviewLoopback` is true when the current review reproduces the previous loopback's signature — i.e. we bounced on the *same* finding and made no progress. Today that path **escalates** (a `human_resume` signal + `waiting`). In the **OSS headless** path there is no human before the PR, so "escalate/wait" is a hang — the very dead-end we are removing.

Rule: on a **repeated** review signature (agent engaged once — §3.2 — and the same objection survives), do **not** hard-block. Instead **record the finding and route forward** (to implement), carrying the finding as a **caveat surfaced on the PR** ("styre's plan review flagged X; the agent, given the objection, judged it did not apply / accepted the trade-off — here it is for a human"). This is the differential doc's *deliver-with-caveat* philosophy applied to a review disagreement: a bounded, honest hand-off, not silent suppression and not an infinite argument.

**One engagement, then forward.** Round 1 review flags → §3.2 re-dispatch with the feedback → round 2 review: a *new/absent* signature ⇒ converged (proceed clean); the *same* signature ⇒ forward-with-caveat (§3.3). The agent gets exactly one informed chance to fix it; an unresolved disagreement becomes a visible PR caveat, never a block.

---

## 4. What this deliberately does NOT do

- **Not** judging whether the agent's rebuttal is *correct* (that a human, seeing the caveat, decides). styre's job is to guarantee the objection was *shown* to the agent once and *surfaced* to the human if unresolved — not to adjudicate it.
- **Not** touching the verify gates, the plan's content quality, or the review's own quality bar (`computeBlocksShip` severity logic is unchanged).
- **Not** loosening what a design dispatch must *produce* — a real plan `.md` is still required; only the "must re-commit every turn" over-constraint is removed.

---

## 5. Open questions / risks

1. **Caveat plumbing.** §3.3 needs a plan-review finding to ride through implement→merge onto the PR body. Confirm the existing advisory/`untested-merge-risk` surfacing path (the same one Option-B packaging-build advisories use) can carry a `plan-review` caveat, or whether that path is net-new here.
2. **`review_feedback` var wiring (§3.2).** `designVars` must learn the loopback origin + read the last review's blocking findings for this ticket. Confirm the handler has (or can cheaply get) "why am I being re-dispatched" — the event log carries the loopback `reason`/`signature`; the finding rows carry the detail.
3. **Signature granularity.** `category:location` is coarse — an agent that *moves* the same objection to a new line changes the signature and could earn a second engagement. Acceptable (it's bounded by the review itself re-flagging), but note it: "same finding, relocated" reads as progress. Tightening is out of scope.
4. **Interaction with the implement-side review loopback.** `isRepeatedReviewLoopback` spans `loop ∈ {implement, design}`; confirm the forward-with-caveat rule keys on the *design*-origin case and doesn't alter implement-side review escalation.

## 6. Invariants held
- **Loop-not-halt:** the loop now *converges* (forward) instead of dead-ending or hanging on a human the headless path lacks.
- **Ground truth over self-report:** the postcondition still requires a real plan artifact on disk; §3.3 surfaces the *review's* finding, not the agent's self-grade.
- **Structured output:** review findings already flow through the validated `ReviewOutputSchema`; §3.2 reuses those rows, §3.3 reuses `findingsSignature`.

---

## 7. Evidence appendix (file:line)
- Postcondition: `src/dispatch/handlers.ts:195-203` (`changed && …` — the block); dispatch-failure caught upstream `src/dispatch/run-dispatch.ts:52,125-127`.
- Design vars (no feedback carried): `handlers.ts:189-203` (`designVars(ctx.ticket, deps.profile)`); review findings persisted `handlers.ts:305-320`; `design:review` handler `handlers.ts:280-320`.
- Ping-pong machinery to reuse: `src/daemon/review-verdict.ts:23-38` (`findingsSignature`, `isRepeatedReviewLoopback`); current escalate path `:40-46`.
- Bench evidence: `~/bench-rerun2/styre-bench-run-darkreader__darkreader-7241-1783401799740-238e3cea/` (`run.ndjson` dispatch ledger; `transcript.jsonl` seq4/seq5 "no changes needed").

## 8. Changelog
- *2026-07-07 (v1)* — design after the SMOKE=2 darkreader re-run isolated the `design→review→design` dead-end to two code causes (postcondition requires a fresh commit; re-dispatch carries no review feedback). Approaches discussed with the operator: postcondition = plan-exists; one feedback-carrying re-engagement; repeated-finding → deliver-with-caveat (not hard-block, matching the differential doc's philosophy). Reuses the existing `findingsSignature`/`isRepeatedReviewLoopback` guard.
