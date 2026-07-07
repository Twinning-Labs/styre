# Design-loop convergence — the review-loopback dead-end

**Status:** Design (brainstorm output), **v3 — settled.** Two independent review rounds (code-grounded feasibility + adversarial). **Shipped scope = §3.1 + §3.2** (the dead-end fix + feedback carry). **The exit stays styre's *existing* `escalate`-on-repeat** — no new exit mechanism, no oscillation change (both held after review). The sound resolution (ground truth adjudicates a plan dispute) is named and **deferred** (§6). Isolated on branch `feat/change-scoped-verify-brainstorm` (off `main`).
**Date:** 2026-07-07
**Scope:** one **rare, intermittent** control-loop defect surfaced by the bench (darkreader-7241, SMOKE=2 re-run, styre @ `d7c5a1a`): a `design → review → design` loopback can **dead-end**, blocking a ticket *before implement* even when its plan is nearly right. A routing/convergence bug in the *design* loop, upstream of and **separate from** the verify-gate work. The change-scoped-verify design (Option B: build→typecheck, T-min test-pinning, pre-warm) is unaffected.
**Not the common darkreader failure.** Historically darkreader reached the **build** stage and failed there (the pre-existing-base-build problem the approved Option B addresses). The design-loop dead-end only fires when the design agent happens to write a plan carrying an *internal tradeoff* the review catches — intermittent (plan-dependent), rare (unobserved in months of harness use). This doc treats it with care *because* it is rare and surprising, and it ships the **minimum** that fixes it.
**Builds on:**
- `docs/architecture/control-loop.md` — the per-ticket event loop, CL-POSTCOND, the Loopback Atlas (§8), review-origin loopbacks.
- `docs/brainstorms/2026-07-05-verification-as-differential-inference-design.md` — the attributed-verdict philosophy and its named gap (the OSS headless path has no human before the PR). The deferred "concern → verify check" north star (§6) is that philosophy applied to a plan dispute.
- `CLAUDE.md` invariants: **ground truth over self-report**, **loop-not-halt**, structured agent output through a validated interface.

---

## 1. What happened (the darkreader trace)

darkreader-7241 (`ENG-270`) ended `blocked / loop-exhausted` at **`design:dispatch`**, never reaching implement — with a *nearly* correct plan on disk:

```
design seq1 clean · design seq2 clean
loopback: design → review   (finding at docs/plans/ENG-270-…​.md:45)
design seq3 clean            (plan: root cause + WU1/WU2 correct)
design seq4 postcondition-failed   "no plan committed under docs/plans/"
escalated: step 'design:dispatch' failed
design seq5 postcondition-failed   → blocked
```

The agent **correctly diagnosed the bug** (an un-anchored delimiter regex mis-parsing Base64 `==` padding). A **consistency review raised a genuinely valid objection**: the proposed `/^…$/gm` regex uses `m`-flag zero-width anchors that wouldn't preserve the byte-identical offsets the plan itself promised — a real *internal tradeoff* (anchor-the-delimiter vs keep-offsets). Loopback to design. On the revision the agent wrote **nothing** ("no changes needed — the plan is correct"). The no-op revision tripped the postcondition, escalated, retried, blocked.

Two code causes plus one behavioural dynamic.

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
The `changed &&` requires **this dispatch** to have committed. A justified no-op revision (a valid plan already on disk) has `changed === false` → throw.

`changed` is the *wrong question*, not a redundant one. A transport-empty dispatch is caught upstream (`run-dispatch.ts:61` CL-PROFILE, `:108-111` transport-failure, before the postcondition call at `:125`). But a dispatch that **ran, produced output, and committed nothing** (`commitWorktree` → `changed === false`) is exactly the no-op-revision case and reaches the postcondition. The right question is **"does a plan for *this ticket* exist?"**

### 2.2 The re-dispatched design agent never sees the objection — `[cause of the dismissal]`
`design:dispatch` renders `designVars(ctx.ticket, deps.profile)` (`prompt-vars.ts:75`) — ticket + profile only. **`prompts/design.md` has no review-feedback placeholder** (grep `feedback|review|finding` → nothing). Findings are persisted (`insertFinding`, `handlers.ts:309-321`) and survive the redesign loopback (`review-verdict.ts:91-109` deletes work-units, not `review_finding` rows) but are never threaded into the prompt. So round-2 design runs on the *same inputs as round-1*, blind to the objection. (`prompts/implement.md:10` already has a `{{feedback}}` slot — the design prompt lacks the equivalent.)

### 2.3 Why a fresh, independent agent still refuses — *posture, not ego* `[the behavioural dynamic]`
Design and review are **independent fresh invocations** — round-2 design is not defending "its own" work; this is *not* self-grading. The dynamic is **posture**, explicit in the prompts:
- `prompts/design.md` — a **builder**: *"write a brainstorm + implementation plan… reason about how this ticket interacts…"*
- `prompts/design-review.md:5` — a **cold critic**: *"you did **not** write this plan; judge it cold… file a finding for each real problem."*

Same model, opposite posture → the reviewer perceives the offset subtlety the builder didn't. Consequence for §3.2: re-dispatching to the *builder* posture, even with the feedback attached, may **still** under-engage a subtle objection. Carrying the feedback raises the odds of convergence; it does not guarantee it.

---

## 3. Design (shipped: §3.1 + §3.2; exit: unchanged existing behaviour)

### 3.1 Postcondition = *this ticket's* plan exists `[SHIP — unblocks]`
Replace commit-freshness with ticket-identity. The design prompt mandates `linear: {{ident}}` **frontmatter** (agent-chosen *filenames* aren't reliable):
```ts
const hasPlan = existsSync(plansDir) && readdirSync(plansDir)
  .filter((f) => f.endsWith(".md"))
  .some((f) => planFrontmatterLinear(join(plansDir, f)) === ctx.ticket.ident);
```
A no-op revision over *this ticket's* valid plan passes; a planless dispatch still fails; a stale/other-ticket plan no longer counts. Transport/empty failures remain caught upstream. Sibling postconditions (implement's diff gate) untouched.

**Honest limits (adversarial review):** frontmatter is a *string tag*, not a plan check — a correctly-tagged plan with a gutted body, or one written for a different problem, still passes; and a **stale same-ticket** plan passes too, because `redesignLoopback` never deletes the `.md`. None of these silently ship: a bad/stale plan that passes the postcondition goes to `design:review`, which re-flags it — so the *review*, not the postcondition, is the quality gate. The postcondition's only job is "a plan artifact for this ticket exists," and that is all §3.1 claims. `planFrontmatterLinear` is a **net-new** tiny reader (no YAML/frontmatter dep in the repo; treat a missing `linear:` as "not this ticket's plan").

### 3.2 Carry the review's findings into the re-dispatch — with a *disposition* demand `[SHIP — real engagement]`
When `design:dispatch` is entered as a review-origin loopback (detect via the event log — the design analog of `isUnitLoopback` `handlers.ts:113-120`, matching `loop === "design"` loopback events), inject the last round's *blocking* findings (verbatim `category`/`location`/`rationale`) into `designVars` as a `{{review_feedback}}` block. **Direct precedent:** `implement:dispatch` already does this — `implementVars(…, implementFeedback(ctx.db, unit.id))`, `feedback=""` param at `prompt-vars.ts:95`, `implementFeedback` at `feedback.ts:7`. (One wrinkle: `implementFeedback` keys on `branch_head_sha`; the design analog reads the *previous* `design:review` dispatch's findings — the re-dispatch mints a new dispatch — feasible, findings persist and are queryable.) The template renders it as: *"a prior review raised these. For **each**, revise the plan to address it, **or** state explicitly why it does not apply / is an accepted trade-off — a bare 'no changes needed' is not a disposition."*

**Honest limit (adversarial review):** the demand is not a guarantee. A builder can emit a plausible "accepted trade-off" that reads as engagement but isn't; and if it writes that rationale *into the plan*, the cold reviewer may downgrade the finding below `blocks_ship` → the loop goes clean and the plan forwards on the strength of a rationalization. §3.2 raises the odds of *genuine* convergence; it does not make the review infallible. That residual is the §6 problem, not something §3.2 closes.

### 3.3 Exit = styre's *existing* `escalate`-on-repeat `[HOLD — no new mechanism]`
The exit already exists and already *is* honest-block: `review-verdict.ts:131-142` — on a `design:review` loopback whose blocking findings reproduce the previous loopback's signature (`isRepeatedReviewLoopback`, `:33-39`), it calls `escalate("no progress")` (`:41-47`: `waiting` + `human_resume` + `escalated`). **Code-confirmed clean terminal:** `driveToTerminal` catches the `human_resume` signal in the same tick (`run-ticket.ts:66-67`) and returns `blocked` — so one-shot `styre run` **ends blocked, no hang.** §3.1 makes this reachable (today darkreader dies at the postcondition before the second review runs); nothing else changes.

**Two v2 exit ideas were HELD after review:**
- **The oscillation "match any prior signature" change is NOT shipped.** It would kill legitimate multi-round convergence (fix finding A → review raises B → fixing B reintroduces A → "any prior A" blocks a loop that round-4 would have converged), and it *still* misses a defect relocated to a new line (a new signature). A loopback-**count cap** is the safer variant if one is ever wanted; the current immediate-predecessor check ships unchanged, with loop-budget exhaustion as the backstop for a true oscillation.
- **v2's "forward-with-caveat" is NOT the exit** (it was killed in review): it ships a reviewer-confirmed flaw, and in the headless target nobody reads the PR body, so the caveat carries zero signal.

**The honest accounting (this is the crux).** A plan-quality disagreement between the builder and the reviewer has **no ground truth at the design stage** — both are agent verdicts. The two available exits each have a failure class:
- **Block** (what ships) never ships a reviewer-flagged flaw, but it is wrong for a reviewer **false positive** (§4 row 1), and it forgoes the **downstream self-healing** — `implement` writes real code that can fix a prose-level slip, `verify` runs real tests — that is *why darkreader historically reached build.*
- **Forward** never wrongly blocks, but ships a **latent bug** wherever `verify` doesn't cover the concern.

Neither is *sound*; the choice is a **bias**, not a proof. This doc keeps styre's existing **block** terminal because (a) it needs no new machinery, (b) it's a confirmed clean terminal, and (c) for a *rare, surprising* failure the conservative bias — never ship a flagged flaw — is defensible. It explicitly does **not** claim this is "ground truth over self-report": the block fires on the **reviewer agent's** verdict, a pragmatic bound. The *sound* resolution — synthesize a `verify` check from the surviving finding so **ground truth** adjudicates — is the deferred north star (§6).

---

## 4. Why the exit can't be "solved" here (the refusal-reasons argument)

"Refuses feedback N times" is several failures that demand *opposite* responses, indistinguishable from the refusal alone:

| The agent is… | e.g. | correct response |
|---|---|---|
| **right** — review is a false positive | reviewer misread the code | forward |
| **right** — out of scope | valid-but-tangential | forward |
| **wrong, can't act** — a subtle point | darkreader's `m`-flag/offset | needs a *test*, not the same words |
| **wrong** — talking past each other | ambiguous feedback | needs sharper feedback |
| **neither** — a genuine tradeoff | anchor-regex vs keep-offsets | make the tradeoff explicit + decided |

A fixed rule gets ~half wrong (forward the false-positive, block the real bug). The only thing that adjudicates right-vs-wrong is **ground truth** — turn "offsets must stay byte-identical" into a check `implement` must pass. That is the deferred north star (§6); it is the hard, general "concern → executable check" capability and belongs with the change-scoped-verify work. Until it exists, styre cannot referee this dispute — so it holds its conservative bound (block) and ships the two fixes that *are* sound (§3.1, §3.2).

---

## 5. What this deliberately does NOT do
- **Not** adjudicating the agent's rebuttal (no arbiter, no grading — rejected as an over-built subsystem for a rare case).
- **Not** building the "concern → check" synthesis (§6, deferred).
- **Not** changing the exit machinery, verify gates, plan/review quality bars (`computeBlocksShip` unchanged), or `implement`-side review routing.
- **Not** loosening what design must *produce* — a real, ticket-scoped plan is still required.

## 6. Open questions / deferred
1. **★ Deferred north star:** synthesize a ground-truth `verify` check from a surviving plan-review finding, so ground truth (not the agent, not a counter, not a bias) adjudicates. The principled fix for the whole §4 problem; the hard, general capability; belongs with change-scoped-verify.
2. **`{{review_feedback}}` wiring (§3.2):** `designVars` learns the loopback origin (event log carries `loop`/`signature`) and reads the ticket's last blocking findings — mirrors `implementFeedback`.
3. **Frontmatter reader (§3.1):** net-new; confirm plans reliably carry `linear:` (the prompt mandates it; hand-written/legacy plans may not).
4. **Whether to add a loopback-count cap** (§3.3) later, if loop-budget exhaustion on a true oscillation proves too expensive in practice. Not shipped now.

## 7. Invariants
- **Ground truth over self-report — honestly scoped:** §3.1 requires a real ticket plan; the shipped exit does **not** claim to be ground truth (it is the reviewer agent's verdict — a bias, named as such). The invariant is *served* only by the deferred §6 check-synthesis; this doc does not pretend otherwise.
- **Loop-not-halt:** the common path now *converges* (the agent usually addresses feedback it can see, §3.2); halt is the existing terminal for the rare genuine standoff — and no longer the spurious postcondition dead-end (§3.1).
- **Structured output:** review findings already flow through `ReviewOutputSchema`; §3.2 reuses those rows, the exit reuses `findingsSignature`/`isRepeatedReviewLoopback`.

## 8. Evidence appendix (file:line)
- Postcondition: `handlers.ts:195-203`; upstream guards `run-dispatch.ts:61,108-111` (before `:125`); `commitWorktree`→`changed` `run-dispatch.ts:114`.
- Feedback + precedent: `designVars` `prompt-vars.ts:75` (no feedback); `prompts/design.md` (no review slot) vs `prompts/implement.md:10` (`{{feedback}}`); `implementVars(…, feedback="")` `prompt-vars.ts:91-96`, called `handlers.ts:353`; `implementFeedback` `feedback.ts:7`; loopback detection `handlers.ts:113-120` (`isUnitLoopback` matches a `verify:wu{seq}:` route — design analog matches `loop==="design"`); findings survive redesign `review-verdict.ts:91-109`; persisted `handlers.ts:309-321`.
- Exit: `review-verdict.ts:23-39` (`findingsSignature`, `isRepeatedReviewLoopback`), `:131-142` (design:review verdict), `:41-47` (`escalate`); headless terminal `run-ticket.ts:66-67` (catches `human_resume` → `blocked`).
- Posture: `prompts/design.md` (builder); `prompts/design-review.md:5` ("judge it cold").
- Bench evidence: `~/bench-rerun2/styre-bench-run-darkreader__darkreader-7241-1783401799740-238e3cea/` (`run.ndjson` ledger; `transcript.jsonl` seq4/seq5 "no changes needed").

## 9. Changelog
- *2026-07-07 (v3, settled)* — after a second independent two-lens review. **Exit softened to *no new mechanism*:** keep styre's existing `escalate`-on-repeat (code-confirmed a clean headless terminal, `run-ticket.ts:66-67`); the v2 oscillation "match-any-prior" change **held** (kills legitimate 2-step convergence; a count-cap is the safer future option); **dropped the "ground truth over self-report" claim** for the block — it is the reviewer agent's verdict, a named *bias*, with the sound fix (concern→check) deferred (§6). Added honest limits to §3.1 (frontmatter is a tag; stale/gutted plans are caught by re-review, not the postcondition) and §3.2 (disposition demand can be rationalized → false-clean). Shipped scope narrowed to **§3.1 + §3.2**. Fixed line-refs (`escalate` `:41-47`; verdict block `:131-142`; `isUnitLoopback` matches a route prefix). §6.5 resolved (escalate terminates, does not hang).
- *2026-07-07 (v2)* — replaced v1 forward-with-caveat (unsound: ships a reviewer-confirmed flaw; caveat unread in headless) with honest-block; hardened §3.1 to the `linear:` frontmatter; added the posture analysis (§2.3) and the refusal-reasons argument (§4).
- *2026-07-07 (v1)* — initial design after the SMOKE=2 darkreader re-run isolated the dead-end (postcondition requires a fresh commit; re-dispatch carries no feedback).
