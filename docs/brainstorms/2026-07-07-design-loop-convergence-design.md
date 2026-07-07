# Design-loop convergence — the review-loopback dead-end

**Status:** Design (brainstorm output) — approaches settled with the operator (postcondition = *this ticket's* plan exists; carry the review's findings into the re-dispatch; on a genuinely-unresolved finding **honest-block** via the existing escalate path — not forward-with-caveat, not an adjudicator; ground-truth-check synthesis named as deferred). Revised (v2) after an independent two-lens review (code-grounded feasibility + adversarial) that killed the v1 exit rule. Pending written-spec review + independent review of v2. Isolated on branch `feat/change-scoped-verify-brainstorm` (off `main`).
**Date:** 2026-07-07
**Scope:** one **rare, intermittent** control-loop defect surfaced by the bench (darkreader-7241, SMOKE=2 re-run, styre @ `d7c5a1a`): a `design → review → design` loopback can **dead-end**, blocking a ticket *before implement* even when its plan is nearly right. This is a routing/convergence bug in the *design* loop, upstream of and **separate from** the verify-gate work. The change-scoped-verify design (Option B: build→typecheck, T-min test-pinning, pre-warm) is unaffected and stands.
**Not the common darkreader failure.** Historically darkreader reached the **build** stage and failed there (the pre-existing-base-build problem the approved Option B addresses). The design-loop dead-end only fires when the design agent happens to write a plan carrying an *internal tradeoff* the review catches — so it is intermittent (plan-dependent) and rare (unobserved in months of harness use). This doc treats it with care *because* it is rare and surprising, not because it is common.
**Builds on:**
- `docs/architecture/control-loop.md` — the per-ticket event loop, CL-POSTCOND (dispatch postconditions), the Loopback Atlas (§8), review-origin loopbacks.
- `docs/brainstorms/2026-07-05-verification-as-differential-inference-design.md` — the **deliver-with-caveat / attributed-verdict** philosophy, and its named soundness gap: *the OSS headless path has no human before the PR.* That gap is exactly why the v1 "forward-with-caveat" exit was unsound (§4).
- `CLAUDE.md` invariants: **ground truth over self-report** (the load-bearing one here); **loop-not-halt**; structured agent output through a validated interface.

---

## 1. What happened (the darkreader trace)

On the SMOKE=2 re-run, darkreader-7241 (`ENG-270`) ended `blocked / loop-exhausted` at **`design:dispatch`**, never reaching implement — with a *nearly* correct plan on disk. The dispatch ledger:

```
design seq1 clean · design seq2 clean
loopback: design → review   (finding at docs/plans/ENG-270-…​.md:45)
design seq3 clean            (plan: root cause + WU1/WU2 correct)
design seq4 postcondition-failed   "no plan committed under docs/plans/"
escalated: step 'design:dispatch' failed
design seq5 postcondition-failed   → blocked
```

The design agent **correctly diagnosed the bug** (an un-anchored delimiter regex in `indexSitesFixesConfig` mis-parsing Base64 `==` padding). A **consistency review then raised a genuinely valid objection**: the plan's proposed `/^…$/gm` regex uses `m`-flag zero-width anchors that would *not* preserve the byte-identical offsets the plan itself promised. That is a real *internal tradeoff* in the plan (anchor-the-delimiter vs keep-offsets). Loopback to design. On the revision the agent concluded *"No changes needed — the plan is correct and already committed"* and **wrote nothing**. The no-op revision tripped the postcondition, escalated, retried once, blocked.

Two independent code causes, plus one behavioural dynamic, produce this.

---

## 2. The causes

### 2.1 The postcondition demands a *fresh commit*, not *this ticket's plan* — `[cause of the block]`
`src/dispatch/handlers.ts:195-203`:
```ts
postcondition: ({ worktreePath, changed }) => {
  const plansDir = join(worktreePath, "docs", "plans");
  const hasPlan =
    changed && existsSync(plansDir) && readdirSync(plansDir).some((f) => f.endsWith(".md"));
  if (!hasPlan) throw new Error("design:dispatch postcondition: no plan committed under docs/plans/");
},
```
The `changed &&` requires **this dispatch** to have committed. A justified no-op revision (a valid plan already on disk) has `changed === false` → throw → `postcondition-failed`.

Note the redundancy is *not* what v1 claimed. A **transport-empty** dispatch is caught upstream (`run-dispatch.ts:61` CL-PROFILE, `:108-111` transport-failure — both before `spec.postcondition` at `:125`). But a dispatch that **ran, produced output, and committed nothing** (`commitWorktree` → `changed === false`) is *exactly the no-op-revision case* and does reach the postcondition. `changed` is not redundant "because empties are upstream"; it is the *wrong question*. The right question is **"does a plan for *this ticket* exist?"** — which independently rejects a planless dispatch and (unlike `changed`) also rejects the *opposite* failure the adversarial review found:

> Dropping `changed &&` to "any `*.md` under `docs/plans/`" **fails open**: `readdir…endsWith(".md")` is not ticket-scoped, `redesignLoopback` never deletes the plan file, and most repos already carry committed plans. A design dispatch that writes nothing would then pass on a *stale or other-ticket* plan.

So the postcondition must key on **ticket identity**, not commit-freshness and not mere existence.

### 2.2 The re-dispatched design agent never sees the objection — `[cause of the dismissal]`
`design:dispatch` renders `designVars(ctx.ticket, deps.profile)` (`prompt-vars.ts:75`) — ticket + profile only. The review's findings are persisted (`insertFinding`, `handlers.ts:309-321`) and **survive** the redesign loopback (`review-verdict.ts:91-109` deletes work-units, not `review_finding` rows) but are **never threaded into the design prompt**. So round-2 design runs on the *same inputs as round-1*, blind to the specific objection.

### 2.3 Why a fresh, independent agent still refuses — *posture, not ego* `[the behavioural dynamic]`
Design and review are **independent fresh invocations** — round-2 design is not defending "its own" work, so this is *not* self-grading. The real dynamic is **posture**, and it is explicit in the prompts:
- `prompts/design.md` — a **builder**: *"write a brainstorm + implementation plan… reason about how this ticket interacts…"*
- `prompts/design-review.md` — a **cold critic**: *"you did **not** write this plan; judge it cold… do NOT read it as what the designer intended… file a finding for each real problem."*

Same model, opposite posture → the reviewer perceives the offset subtlety the builder didn't. The consequence for §2.2's fix: re-dispatching to the *builder* posture, even with the feedback attached, may **still** under-engage a subtle objection (a builder re-reads its plan and finds it self-consistent). Carrying the feedback (§3.2) raises the odds of convergence; it does not guarantee it — which is why the exit rule (§3.3) must be a sound *residual*, not a hope.

---

## 3. Design

Three changes: the first unblocks, the second gives real engagement a chance, the third bounds the loop into an honest terminal.

### 3.1 Postcondition = *this ticket's* plan exists `[unblocks, ticket-scoped]`
Replace commit-freshness with ticket-identity. The design prompt mandates `linear: {{ident}}` **frontmatter** in the plan (agent-chosen *filenames* are not reliable). So:
```ts
const hasPlan = existsSync(plansDir) && readdirSync(plansDir)
  .filter((f) => f.endsWith(".md"))
  .some((f) => planFrontmatterLinear(join(plansDir, f)) === ctx.ticket.ident);
```
A no-op revision over *this ticket's* valid plan passes and routes forward; a planless dispatch still fails; a stale/other-ticket plan no longer counts (closes the fail-open hole). Transport/empty failures remain caught upstream. Sibling postconditions (implement's diff gate) are untouched — "a durable plan artifact for this ticket exists" is the right invariant only for design.

### 3.2 Carry the review's exact findings into the re-dispatch — with a *disposition* demand `[real engagement]`
When `design:dispatch` is entered as a review-origin loopback (detect via the event log, exactly as `isUnitLoopback`, `handlers.ts:114-119`), inject the last round's *blocking* findings (verbatim `category`/`location`/`rationale`) into `designVars` as a `review_feedback` block. **Direct precedent, no new machinery:** `implement:dispatch` already does this — `implementVars(…, implementFeedback(ctx.db, unit.id))` with a `feedback=""` param (`prompt-vars.ts:95`). The design template renders the block as: *"a prior review raised these. For **each**, either revise the plan to address it, **or** state explicitly why it does not apply / is an accepted trade-off. A bare 'no changes needed' is not a disposition."* The disposition demand pushes the builder to *engage* each point (countering §2.3's posture gap) and surfaces genuine tradeoffs as explicit decisions rather than silent horn-picking. First (non-loopback) dispatches render an empty block — unchanged behaviour.

### 3.3 Bounded exit = honest-block, via the existing escalate path `[convergence + honest terminal]`
The exit machinery already exists and already *intends* this: `review-verdict.ts:133-139` — on a `design:review` loopback whose blocking findings reproduce the previous loopback's signature (`isRepeatedReviewLoopback`), it calls `escalate("no progress")` (sets `waiting`, emits `human_resume`, logs `escalated`). Two fixes make it *reachable* and *sound*:

1. **Reachable:** today darkreader never reaches this — it dies at the §2.1 postcondition on the first no-op revision. §3.1 fixes that: the revision passes → `design:review` runs again → *this* logic decides.
2. **Oscillation-robust:** `isRepeatedReviewLoopback` compares only the *immediately previous* loopback (`prev = prior[last]`), so an A/B/A/B pattern (same defect flagged at alternating lines, or relocated) never trips "repeated" and loops until budget exhausts — a *more expensive* block. Fix: match the signature against **any** prior review-loopback for the ticket (or cap the count of design-review loopbacks). Convergence must not rest on immediate-predecessor equality.

**The terminal is honest-block, deliberately not forward-with-caveat.** v1 routed the surviving finding *forward* to implement with a PR caveat. The adversarial review killed this, correctly:
- it **ships a plan with a reviewer-confirmed flaw** — darkreader's regex was genuinely wrong; forwarding it implements a regex that corrupts offsets, and if no test exercises that invariant, verify goes green and a **latent bug merges**. That is **self-report beating ground truth** (the agent's "I judged it doesn't apply" winning by exhaustion) — a core-invariant violation.
- in the **headless** target there is no human before the PR *and* nobody reads PR bodies (the bench scores on tests), so a caveat carries **zero signal** — forward-with-caveat reduces to "ship the flaw, hope a test catches it."

So on a genuinely-unresolved finding (agent engaged once via §3.2, same objection survives, oscillation-robust check fires) styre **escalates / honest-blocks**: the ticket ends "unresolved plan-review finding" — a *truthful* terminal (no fix shipped) rather than a false green. In OSS `styre run` this is the run's blocked terminal (the bench scores it unresolved — honest); the commercial plane surfaces the same escalation through its needs-you inbox. This is the *existing* escalate path made reachable + robust — **no new plumbing** (and in particular, no PR-caveat surfacing, which would have crossed the `signal.ts` ⇄ `ground-truth-signal.ts` seam v1 wrongly called "reuse").

---

## 4. Why honest-block is the right residual (the refusal-reasons argument)

"Refuses feedback N times" is not one phenomenon; it is several that demand *opposite* responses, and styre cannot tell them apart from the refusal alone:

| The agent is… | e.g. | correct response |
|---|---|---|
| **right** — review is a false positive | reviewer misread the code | forward (blocking would be the bug) |
| **right** — concern is out of scope | valid-but-tangential | forward |
| **wrong, can't act** — doesn't grasp a subtle point | darkreader's `m`-flag/offset subtlety | needs a *different modality* (an example, a **test**) — not the same words again |
| **wrong** — talking past each other | ambiguous/location-less feedback | needs sharper feedback |
| **neither** — a genuine internal tradeoff | anchor-regex vs keep-offsets | make the tradeoff **explicit and decided** |

A fixed counter gets ~half of these wrong (forward the false-positive, block the real bug). The only thing that *can* adjudicate right-vs-wrong is **ground truth** — turn "offsets must stay byte-identical" into a check implement must pass. That is the sound answer, and it is the deferred north star (§6). It is **not built here** because it is the hard, general "concern → executable check" capability, and it belongs with the change-scoped-verify work.

Absent ground-truth adjudication, the residual choices are (a) trust the agent's word (forward — self-report wins, §3.3), (b) build an independent arbiter (a whole grading subsystem of its own — rejected as over-built for a rare case), or (c) **honest-block** — refuse to ship what styre could not establish. For a rare, worrying edge case, (c) is the disciplined choice: it never ships a latent bug, it needs no new subsystem, and — because §3.1/§3.2 mean a block only happens *after* a real engagement fails — it is honest, not the old spurious dead-end.

---

## 5. What this deliberately does NOT do
- **Not** adjudicating whether the agent's rebuttal is correct (no arbiter, no grading). styre guarantees the objection was *shown* once and *not shipped* if unresolved.
- **Not** building the "concern → check" synthesis (§6, deferred).
- **Not** touching verify gates, plan/review quality bars (`computeBlocksShip` unchanged), or `implement`-side review routing.
- **Not** loosening what design must *produce* — a real, ticket-scoped plan is still required; only "must re-commit every turn" is removed.

## 6. Open questions / risks / deferred
1. **Deferred north star:** synthesize a ground-truth verify check from a surviving plausibility finding, so ground truth (not the agent, not a counter) adjudicates. The principled fix for the whole §4 problem; the hard, general capability; belongs with change-scoped-verify.
2. **`review_feedback` wiring (§3.2):** `designVars` must learn the loopback origin (event log carries the `loop`/`signature`) and read the ticket's last blocking findings — both available; mirrors `implementFeedback`.
3. **Frontmatter parse (§3.1):** needs a tiny `linear:`-frontmatter reader over `docs/plans/*.md`. Confirm plans reliably carry it (the prompt mandates it; older/hand-written plans may not — treat a missing `linear:` as "not this ticket's plan").
4. **Signature granularity:** `category:location` is coarse; "same finding, relocated to a new line" reads as a new signature. §3.3's "match any prior signature / cap count" bounds it; a semantic finding-identity is out of scope.
5. **Escalate-in-headless:** confirm `escalate()` (`waiting` + `human_resume`) is a clean *terminal* for one-shot `styre run` (run ends, ticket blocked), not a hang — the differential doc's "no human before the PR" gap means it must terminate, not wait.

## 7. Invariants held
- **Ground truth over self-report:** the postcondition requires a real ticket plan; the exit refuses to *ship* on the agent's self-grade (honest-block), rather than letting "I judged it doesn't apply" win by exhaustion.
- **Loop-not-halt:** the common path now *converges* (the agent usually addresses feedback it can see); halt is reserved for the genuine, rare, unresolved disagreement — and it is a truthful terminal, not the old spurious postcondition dead-end.
- **Structured output:** review findings already flow through `ReviewOutputSchema`; §3.2 reuses those rows, §3.3 reuses `findingsSignature`/`isRepeatedReviewLoopback`.

## 8. Evidence appendix (file:line)
- Postcondition: `src/dispatch/handlers.ts:195-203`; upstream failure guards `src/dispatch/run-dispatch.ts:61,108-111` (before `:125` postcondition call); `commitWorktree`→`changed` at `run-dispatch.ts:114`.
- Feedback plumbing + precedent: `designVars` `prompt-vars.ts:75` (no feedback param); `implementVars(…, implementFeedback(...))` + `feedback=""` `prompt-vars.ts:95`; loopback-origin detection `handlers.ts:114-119` (`isUnitLoopback`); findings survive redesign `review-verdict.ts:91-109`; findings persisted `handlers.ts:309-321`.
- Exit machinery: `src/daemon/review-verdict.ts:23-39` (`findingsSignature`, `isRepeatedReviewLoopback`), `:133-139` (design:review verdict → `escalate`/`redesignLoopback`); `escalate` `:40-46`.
- Posture: `prompts/design.md` (builder), `prompts/design-review.md:5` ("judge it cold").
- Bench evidence: `~/bench-rerun2/styre-bench-run-darkreader__darkreader-7241-1783401799740-238e3cea/` (`run.ndjson` ledger; `transcript.jsonl` seq4/seq5 "no changes needed").

## 9. Changelog
- *2026-07-07 (v2)* — after independent two-lens review. **Exit rule replaced:** v1's forward-with-caveat was unsound (ships a reviewer-confirmed flaw; self-report beats ground truth; caveat is unread in the headless target) → now **honest-block via the existing `escalate` path**, made reachable (§3.1) + oscillation-robust (§3.3). **§3.1 hardened:** postcondition keys on the ticket's `linear:` frontmatter (v1's "any `.md`" failed open on stale/other-ticket plans — the review's most important find). **§2.1 rationale corrected** (`changed` is the wrong question, not "redundant because empties are upstream"; real throw sites `run-dispatch.ts:61,108-111`). **§2.3 added** (posture, not ego — design=builder vs review=critic, from the prompts). **§3.2 strengthened** with the disposition demand + the `implementFeedback` precedent. **§4 added** (the refusal-reasons argument for why honest-block, with ground-truth-check as the deferred north star). Reframed as a rare, intermittent edge case (darkreader's common blocker is the build stage — approved Option B).
- *2026-07-07 (v1)* — initial design after the SMOKE=2 darkreader re-run isolated the `design→review→design` dead-end (postcondition requires a fresh commit; re-dispatch carries no feedback; forward-with-caveat exit).
