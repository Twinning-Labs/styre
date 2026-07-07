# Change-scoped verify via AC-derived checks (concern → check)

**Status:** Design (brainstorm output) — **v2, revised after two independent reviews** (code-grounded feasibility + adversarial soundness, 2026-07-07). Core mechanism approved section-by-section by the operator through a live design dialogue; the v2 revisions (graded RED taxonomy, implement-sees-checks, the honesty reframes, the four feasibility corrections) fold in the review findings. Pending written-spec re-review. Isolated on its own branch off `main` (this stream is separate from the design-loop PR).
**Date:** 2026-07-07
**Scope:** the *general* fix for the class of bench blocks where **verify blames the change for the environment's pre-existing red** (astropy-12907 collection errors, darkreader-7241 base-build failures). It replaces "run the whole suite/build and gate on the exit code" with **a ground-truth check derived from each acceptance criterion**, authored by a dedicated plan-blind step, validated **RED-first** on clean `HEAD`, and required **GREEN** after implement. One primitive, and a **graded guarantee** (§2.3) that is honest about how much ground truth it actually earns per case. This is the generic, in-the-wild mechanism — **the bench is only the scoreboard; its `FAIL_TO_PASS`/`PASS_TO_PASS` oracle is never fed into styre** (that would teach-to-the-test).

**Builds on / aligns with:**
- `docs/brainstorms/2026-07-06-verify-gates-redesign-design.md` (**Option B**, approved). This design **keeps** Option B's detector/build→typecheck gate and its *"packaging is advisory, never a hard gate"* stance, and **evolves Option B's T-min test gate** (see "Relationship to T-min").
- `docs/brainstorms/2026-07-07-design-loop-convergence-design.md` (§3.1/§3.2 shipped). The arbiter's routing and exit **build on** that work's carry-feedback (`designFeedback`) and its existing terminal. The two designs share one spine.
- `docs/architecture/control-loop.md`, `docs/architecture/minimal-loop.md` — the per-ticket event loop, CL-POSTCOND, the Loopback Atlas, review-origin loopbacks, the resolver's stage sub-step chain.
- `CLAUDE.md` invariants: **ground truth over self-report**, **loop-not-halt**, **capability isolation**, **no silent scope deferral**, structured agent output through a validated interface, clean-break stage vocab (DS-2).

**Relationship to T-min (an honest evolution, not a silent contradiction).** Option B's T-min gate requires *the implementer's own added test* to depend on the change (go red on base). Option B itself names T-min's ceiling: a model that writes **and** grades its own test is contaminated — T-min "raises the floor, not the ceiling." This design lifts that ceiling by **separating the author**: checks are derived by a dedicated step that reads the acceptance criteria **without the implementation plan**, and are validated by ground truth (RED-first), not by the author's say-so. Option B's *principle* (a check that doesn't go red on the base is worthless) is preserved and generalized; its *placement* (self-authored, at implement, bench-softened to bugfixes) is superseded.

---

## 0. The general class — what actually blocks the bench

Both live blocks are one bug wearing two costumes: **styre gates on "everything," so anything already broken in the environment is scored as the change's fault.**

- **darkreader-7241** — the base image's build is already red; styre hard-gates on the whole build → a correct change is blocked by state it never touched.
- **astropy-12907** — the reuse gate runs `pytest --collect-only` over the *whole* suite, trips on pre-existing collection errors, and refuses to proceed.

The non-symptomatic fix is to make the gating set **what the change is responsible for**, and demote everything already-red to advisory. This is how a real developer proves a ticket is done.

### 0a. External evidence — how the OSS field actually does this (2026-07-07 code scan)

Three code-level investigations (SWE-bench/Multi-SWE-bench harnesses; solver agents Aider/SWE-agent/OpenHands/Agentless; issue→PR products Sweep/AutoCodeRover/Goose/Cline/micro-agent) converge:

1. **Nobody runs a live whole-suite baseline-diff as the gate.** Where baseline subtraction exists it is *scoped* — Sweep subtracts **lint** noise per-file; AutoCodeRover's test-level `failures - orig_failures` (`app/task.py:243`) is **default-off**/bench-coupled; Agentless computes baseline-green **once** and freezes it into a *selected* list.
2. **The products that fix bugs converge on a target check that flips red→green**, scoped small: ACR's reproducer (`data_structures.py:174`: `reproduced = returncode != 0 and "AssertionError" in stderr`), Agentless's reproduction test, micro-agent's test-as-spec, SWE-bench's declared `FAIL_TO_PASS`. The **RED-first gate** is the load-bearing invariant everywhere (Agentless `run_reproduction_tests.py:33-64`; ACR `agent_reproducer.py:111-126`).
3. **The check is derived from the *ticket text*, not the answer key** — no oracle leak.
4. **The whole peer field is bug-fix-only.** None derives a check from acceptance criteria; ACR *explicitly bails* when there's no reproducible example (`agent_reproducer.py:139`), degrading to open-loop patching with **no check at all**. Feature tickets — which styre gets in the wild — are the gap the field leaves open. **Closing it is the substance of this design — and, per the adversarial review, the place its guarantee is weakest (§2.3, §5).**

---

## 1. The core idea

**Derive a ground-truth check from each acceptance criterion. Prove it RED on clean `HEAD` before implement; require it GREEN after. Gate on nothing else.**

One primitive — *a concern becomes an executable check that flips red→green* — but **the guarantee it earns is graded by *what kind of red* the check produces on `HEAD`** (§2.3), because on the feature path "red" can mean very different things. The AC checklist styre's ticket contract carries **is** the concern set; turning each AC into such a check is the "concern → check synthesis" the design-loop doc named-and-deferred (§6) — promoted here to core.

---

## 2. The mechanism

### 2.1 A dedicated, plan-blind check-authoring step

A **new step** (suggested key `checks:dispatch`; **does not add a `ticket.stage` value** — DS-2 vocab is untouched) runs **after `design`, before `implement`**. (Feasibility-confirmed low-cost: the resolver's `design` case is a linear `done()`-gated sub-step chain; inserting one more sub-step before the advance to `implement` is a `registry.register` + an allowlist entry + a guard — `resolver.ts` `case "design"`.)

- **Input = the AC checklist + the project profile** (stacks, components, test commands, layout) — **NOT the implementation plan.** Profile is product *shape*; the plan is the *how*. Plan-blindness binds the check to the AC's *observable behavior*, not the implementation's chosen internals — the anti-gaming property.
- **Output = native tests written into the repo** (see 2.2), one or more per AC, each tagged to its AC, runner-committed (CL-COMMIT).
- **Postcondition:** every authored check exists **and passes the RED-first classification** (2.3) — i.e. produces an *acceptable* red (assertion-red or absence-red), not a green and not an environmental error mislabeled as feature-red.
- **Capability isolation** unchanged (worktree + profile; no `gh`/Linear/branch tools; feasibility-confirmed the allowlist infra supports a new per-step entry — note `allowlistFor` throws on an unknown handler, so the entry is mandatory).

*Why its own step:* folding it into `design` re-couples "what to build" and "what proves it" in one agent's head — the re-coupling that makes checks vacuous. A distinct dispatch keeps the independence and gives RED-first a clean place to run on unmutated `HEAD`.

### 2.2 What a check *is* — native tests, run in their suite context

A check is a **test in the repo's own framework** (pytest / jest / go test / junit / …), placed where the profile's already-probed test command discovers it. styre uniquely *can* do this — it owns the repo's test infra via `setup`/`profile` — where the peer tools resorted to standalone scripts only because they didn't.

- **Genericity** comes from the profile telling the author the stack + test command + component layout; an AC targeting a component is authored in *that component's* framework.
- **Per-check verdict via a scoped run, executed within the suite's setup context** (session fixtures, migrations, testcontainers) — **not naked-isolated.** The adversarial review flagged that `pytest path::node` run bare can error for infrastructural reasons (fixture/DB absent) that vanish in-suite; RED-first would misread that as feature-absent red. So a check is run *selected but in-suite* (e.g. `pytest -k`/node-id **with** the suite's conftest active), and the verdict is its exit/interpreted status. This deliberately sidesteps a per-language test-**output** parser at the cost of a per-stack **selector constructor** (net-new — §4).
- **Cross-cutting ACs** ("all endpoints require auth") may map to *several* checks or a suite-scoped selection rather than one node — the "one AC → one node" reading is not assumed.
- **The scoping is the fix.** Verify runs *only* the authored checks' selections, so pre-existing red elsewhere (astropy collection errors, darkreader base build) is never in the run — *except* when it lies on the check's own execution path (§2.3 environmental-red, H-A).

### 2.3 The RED-first gate — a graded taxonomy of red (the heart of v2)

At the check-authoring step, on **clean `HEAD`, before implement**, every authored check is run in-suite and its red is **classified**. The guarantee the check can later earn is a function of that class — this is the operator-approved "graded by red-type" model, and it is the honest answer to the review's load-bearing finding that *feature-path RED-first proves "the check touches a new surface," not "the check pins the AC's behavior."*

- **assertion-red** — the check *reached the behavior* and a specific assertion failed (bug path always; feature path when the AC modifies an existing, reachable surface). **Green-after here is ground truth**: the check demonstrably pins a behavior, and flipping it required producing that behavior.
- **absence-red** — the check fails/errors because the surface is *genuinely new* (`ImportError`/`NameError`/404 — no reachable behavior to assert yet). **Green-after here is a *named bias*, not ground truth**: it proves the new surface now responds, but not that it responds *correctly* (the `/preferences` → `200 {}` false-green). There is **no wild-side oracle** to close this; it is reinforced by independent review, and the author is pushed toward assertion-red wherever the surface is reachable enough to assert. This adopts the design-loop doc's own honesty standard (a *bias*, explicitly labeled, not a guarantee).
- **environmental / can't-run red** — the check cannot execute because the *base* is broken on its path (a shared import with a pre-existing syntax/collection error — H-A; a missing fixture). This carries **zero signal about the AC.** It must **not** be blessed as feature-red. It is routed to the **advisory / third arbiter outcome** (§2.5): demote, don't gate, don't churn. This is what stops the very astropy/darkreader cases from silently poisoning RED-first or dead-ending later.

**Green on clean `HEAD`** (no red at all) means one of two things we can't cheaply separate: the check is **vacuous** (common) or the **AC is already satisfied** (rare) — *or* a third the review surfaced: the AC is **qualitative/non-functional with no natural red state** ("clarify the wording," "improve the message"), where existing behavior makes any naive check green. Handling — honoring loop-not-halt (no mid-run pause) *and* no-silent-scope-deferral:

1. **Bounded re-author (1–2×).** A merely sloppy check is corrected cheaply.
2. **Still green ⇒ the arbiter (2.5) adjudicates** — shown the AC + the check + its passing-on-base trace — into one of: **vacuous** (→ re-author / cannot-verify), **already-satisfied**, or **not-expressible-as-red→green** (qualitative/subjective).
3. **already-satisfied ⇒ mark the AC `assessed-satisfied` with reason + evidence and continue; surface at MERGE.** *This determination is agent judgment, not ground truth* (we deliberately hold no known-green reference — §4); it is surfaced at the human gate **because** it is not ground-truth-decidable, so a human confirms it.
4. **not-expressible-as-red→green ⇒ route explicitly to review/human**, recorded as such — **never** silently `assessed-satisfied`. This keeps a whole AC class (qualitative/refinement) from hiding in the satisfied bucket.

### 2.4 What verify gates on — AC-checks only; everything else advisory (a bias *trade*, stated plainly)

- **GATE (blocks, loops back):** the AC-derived checks reach an *acceptable green* (assertion-red→green = ground truth; absence-red→green = the named bias of §2.3), scoped to their own selections, in-suite.
- **ADVISORY SWEEP (runs, records, never blocks):** the rest of the component suite + the build (incl. Option B's typecheck). Failures attach to the review context + telemetry so the reviewer *sees* them.

**This is a bias trade, not a strict win — and the doc says so.** Today `verify:check` **hard-gates** on the component's whole test command (`handlers.ts:720-724, 815`) and `verify:integration` on build+test across components (`:858-871`). The old gate **catches an unrelated regression** (whole-suite red → block) at the cost of **false-blocking on pre-existing red**. Demoting to advisory **removes that false-block** but also **removes the regression catch** — we trade a working protection to kill a different failure. It is *not* additive: it is a **rework** of the existing `verify:check` gate, entangled with the current `realImpacted`/behavioral-A1 logic (`handlers.ts:610-754`). The lost regression coverage is a named hole (§5 #5), closed later by the deferred regression-guard.

### 2.5 The arbiter — code-wrong / check-wrong / environmental (a distinct dispatch)

When an AC-check stays red *after* implement, "who is wrong?" must be answerable, or a wrong check sends implement chasing an unsatisfiable target. Ported and **extended** from ACR's two-decision reviewer (`agent_reviewer.py:155-179`) — the review showed a binary is insufficient:

- **Cheap path first:** a red check on the **first** pass bounces to implement with the failing output (today's `verify → implement` loopback). No arbiter tax on a transient miss.
- **Arbiter engages only on *persistent* red.** A **distinct dispatch** (the independent-reviewer capability, one responsibility), shown the AC + the check + the failing trace + the diff, returns **one of three**:
  - **code-wrong →** bounce to implement (as now);
  - **check-wrong →** bounce to the check-authoring step to re-derive, **carrying the arbiter's reason forward** via a **new sibling of `designFeedback`** keyed to the arbiter dispatch (the *shape* is reused — verbatim finding + disposition demand — but `designFeedback` is hardcoded to `"design:review"`, so this is a new function, not literal reuse);
  - **environmental / can't-run →** demote this check to **advisory** (H-B): the base can't run it, so it neither gates nor churns.
- **implement sees the checks (TDD contract).** Implement codes to make the checks pass — as ACR/Agentless/micro-agent all do. This resolves the review's H-C (a check needing a helper implement adds) and the interface-mismatch churn (author guesses `/preferences`, implement builds `/prefs`). The residual — implement conforming to a *weak* (absence-red) check — is exactly the bias §2.3 already labels, bounded by review.
- **Terminal = loop-budget exhaustion, honestly.** Not the tidy signature-escalate: on arbiter oscillation each re-authored check is textually different, so the design-loop's *predecessor-signature* escalate won't reliably trip; the real backstop is **loop-budget exhaustion → clean `blocked`** (`failure-policy.ts:65-81`, `run-ticket.ts:66-67`) — the design-loop doc's own named backstop. It terminates cleanly, but a **systematically-biased arbiter** (same model blind spot as author/implement, always ruling "code-wrong") can **burn the whole budget** re-thrashing implement before it blocks. Named as a hole (§5 #4).

*Distinct dispatch, not review-in-a-mode:* review judges a *green* change for merit (verify-success); the arbiter adjudicates a *red* check for blame (verify-failure). Two moments — conflating them is the overloading that bit the legacy harness.

### 2.6 Robustness — single author + arbiter (no sampling/vote)

Native tests committed into the repo make Agentless's 20-sample AST-normalized vote impractical. We take the **ACR shape**: one check-author dispatch → RED-first classification → the arbiter catches check-wrong / environmental downstream. The arbiter is our robustness mechanism.

---

## 3. How it maps onto styre

- **Loop order:** `design → checks → implement → verify → review → merge → released`. `checks` consumes AC + profile (not the plan); RED-first runs on the `design`-clean `HEAD`. **Provisioning dependency (feasibility P3):** running any native check needs the env installed, but `provision` is currently gated *inside* the implement stage (`resolver.ts:113,133`; for Python it's an editable-install + source probe). RED-first-before-implement therefore requires **provisioning available in/at the `checks` step** — net-new sequencing the plan must build.
- **Implement** sees and codes to the checks (2.5); **verify** gates on the graded flip (2.3–2.4); **review** and the **arbiter** reuse the independent-reviewer capability at their two distinct moments.
- **Schema (feasibility P1 — the largest hidden cost):** acceptance criteria are **entirely unmodeled today** — they live only as free text in `ticket.description` (`schema.sql:88`). So the AC representation, the AC↔check tag, the authored-check registry (selector + RED-first class + result), and the `assessed-satisfied` / `not-expressible` dispositions are **all net-new schema**. Per-check *verdict rows* reuse the existing `ground_truth_signal` table (`schema.sql:341-358`: open-vocab `signal_type`, `result IN ('pass','fail','error')`, `branch_head_sha`, `detail_json`) — that part is not net-new.
- **Projector / MERGE gate:** dispositions + advisory-sweep failures project outward through the existing one-way projector, surfaced at the human MERGE gate. No new outward write path.
- **The unification:** change-scoped verify and design-loop convergence are the **same spine** — *derive a ground-truth check from a concern, prove it RED (and classify the red) before trusting it, route code/check/environmental blame, exit via the existing budget backstop.* The design-loop's deferred "concern → verify check" (§6) is this design's core.

---

## 4. Explicitly NOT building (deferral line: anything needing a known-green *reference*)

- **Whole-suite baseline subtraction** (Option A / CL-BASELINE) — deferred (operator). Absent from the peer field; needs flakiness handling to be sound.
- **Regression-guard-by-subtraction** (Agentless) — same family (needs a scoped known-green micro-baseline). Deferred with the baseline; its absence is the collateral-breakage hole (§5 #5), not a silent omission. *Honest caveat (review #7):* §2.3's `assessed-satisfied` determination is itself a "was this already green" question resolved by **agent judgment**, not a reference — so the deferral line is defensible on cost/flakiness/cardinality grounds (RED-first observes one check expecting red; a green baseline observes N tests expecting green, flake-poisoned) but is *not perfectly clean*. Stated, not hidden.
- **Sampling + majority vote** — superseded by single-author + arbiter (2.6).
- **Feeding the bench oracle in** — rejected (teaching-to-the-test).

**Net-new dependencies this design requires** (so the plan sizes them honestly): net-new **AC/check-registry/disposition schema** (P1, the big one); a per-stack **in-suite selector constructor** (P3/2.2); **provisioning at the `checks` step** (P3); the **`verify:check` gate rework** to advisory-demote (P2); a **`designFeedback` sibling** for the arbiter (P4). None is a per-language test-output parser (2.2 uses the in-suite scoped verdict).

---

## 5. Named holes (honest limits — the review's findings, carried explicitly)

1. **Feature-path false-green (the load-bearing limit).** On the **absence-red** path, a check can go green on the *wrong* behavior (`200 {}`), and the arbiter — which engages only on persistent *red* — is **structurally blind to a false-green.** §2.3 demotes this case to a *named bias* (not ground truth) and leans on independent review; it is **mitigated, not closed.** This is the honest ceiling of a wild-side mechanism with no oracle.
2. **Vacuous-check misjudged as satisfied.** A vacuous green-on-`HEAD` check the arbiter *also* mislabels `assessed-satisfied` drops a real AC. Mitigated by the recorded evidence surfaced at MERGE; not eliminated.
3. **Base environment poisons RED-first (H-A).** When pre-existing base red lies on the check's own execution path, RED-first gets zero signal. Handled by the **environmental / can't-run** class (§2.3) → advisory (§2.5), but that requires *correctly classifying* the error's origin — itself imperfect.
4. **Biased-arbiter budget burn (H-B / review #4).** A systematically-biased arbiter converts genuine check-wrong into full-budget implement-thrash before the loop-budget backstop blocks. Terminates cleanly, but expensive — the design-loop dead-end reappears if the arbiter miscalibrates.
5. **Collateral-breakage coverage loss.** Advisory-demotion (§2.4) **removes** the current whole-suite regression catch. A change that greens its AC-checks but breaks an unrelated green test **passes verify.** A *trade* (kills the false-block), not a win; caught downstream by review/CI until the deferred regression-guard closes it.
6. **Qualitative/refinement AC class.** ACs with no natural red state route to `not-expressible-as-red→green` (§2.3 step 4) → review/human, degrading to a named bias for that class — explicit, not silently satisfied.
7. **Contaminated-but-plausible check.** A plan-blind author can still write an assertion-red check that subtly tests the wrong thing. Arbiter + review are the nets; ground truth bounds but does not close it.

---

## 6. Prior-art index (what we port, what we don't)

| Source | Mechanism | This design |
|---|---|---|
| AutoCodeRover | reproducer RED→GREEN; **two**-decision arbiter (patch/test), issue-text input | Port the arbiter, **extend to three** outcomes (code/check/environmental); generalize input issue-text→AC. |
| Agentless | baseline-green once; regression-guard by subtraction; 20-sample vote | Defer regression-guard + baseline (§4); drop voting (2.6). |
| SWE-bench / Multi-SWE-bench | declared `FAIL_TO_PASS`/`PASS_TO_PASS`, pinned offline | Oracle only — outside styre; scores, never fed in. |
| Sweep | per-file lint baseline subtraction; no test/build gate | Confirms "subtract what was already red" → applied as advisory demotion (2.4). |
| Aider / Cline / Goose | opaque exit-code / self-reported `verified` / no gate | The self-report anti-patterns styre rejects — motivation for ground-truth RED-first. |

---

## 7. Open questions → writing-plans

Design is plan-ready **after** the v2 revisions above. Deferred to plan-time (implementation detail, not open design):

- Exact schema: the AC model, the check-registry (selector + RED-first class + result), the `assessed-satisfied` / `not-expressible` disposition tables; verdict rows on `ground_truth_signal`.
- The per-stack in-suite selector-constructor surface (which stacks first — mirror bench targets: Python, then node) and the provisioning-at-`checks` sequencing.
- The `verify:check` gate rework to advisory-demote.
- Concrete bounded-retry / arbiter-engagement / loop-budget numbers (ACR's `rounds=5` is the reference).

**Next:** `superpowers:writing-plans` for the implementation plan, then independent review.
