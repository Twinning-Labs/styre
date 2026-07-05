# Verification as differential, attributed inference over a characterized baseline

**Status:** Design (brainstorm output) — a *diagnosis + philosophy* doc, not a plan. Names a generic defect in styre's verify layer surfaced by two bench instances, and the direction that dissolves it. **Revised (v2) after an independent five-lens code-grounded review** (fact-check / coherence / feasibility / scope / adversarial); the review substantially downgraded the *mechanism* claims while affirming the *diagnosis* and the scope — see §13. Several pieces remain OPEN / AT-RISK (§9). Pending operator sign-off.
**Date:** 2026-07-05
**Scope:** what "ground truth" means when styre verifies a change, and why the current absolute-gate model produces false blocks, wasted rebuilds, and correct-code-thrown-away. Covers the verify layer, its relationship to provisioning, and the OSS↔commercial seam. Does **not** re-open detection/routing (the polyglot freeze) except where a detected command is *used* as a gate — with one honestly-named exception the review caught (§7.1: the astropy env-reuse path does re-touch the command layer).
**Builds on / touches:**
- `docs/design/2026-06-30-polyglot-setup-verify-frozen-design.md` (the "over-verify, never under-verify" cardinal rule; the OPEN T1 cost fulcrum; the deferred method-level/import-inference TIA rung; the `{unavailable}`→`untested-merge-risk`→gap-surfaced path).
- `docs/brainstorms/2026-07-03-provisioning-design.md` + its plan (the conda denial, the source-under-test probe, the named-deferred "can't-verify → deliver nothing" tail).
- `CLAUDE.md` invariants: **ground truth over self-report** (move 5), **loop-not-halt**, **capability isolation** (move 4), **deterministic routing**.
- **This modifies the closed S1–S10 control-loop catalog** (a baseline step; a change to what a verify verdict *means* and how failure-policy routes it) → it needs a `control-loop.md` revision + independent review before implementation, on the same footing as Milestone M-D. The review found the blast radius is *larger* than a within-verify tweak (§9.5).

---

## 0. TL;DR

styre verifies a change by running its detected gate command once, on the patched tree, in whatever environment it happens to be in, and **obeying the exit code as a verdict**. That is an *absolute oracle read*. Ground truth is not an absolute you read; it is a **differential you infer against a baseline, with the cause of every red attributed**. The current model distrusts green (all the machinery to avoid a false *pass*) but **blindly trusts red** — so it cannot tell "my change is wrong" from "the world was already broken," and it reacts to every red identically: loop the agent back to fix it.

Two bench instances (container-verified, §12) make it concrete: styre produced the **correct fix** for each, then blocked and delivered nothing — astropy by re-running a heavy harness that timed out, darkreader by gating on a build that was **red on the untouched base** for an environment reason no code change could fix.

**What the diagnosis buys, and what it does not (the honest line, post-review).** The near-term, buildable win is small and cheap: a **2-way, component-granular attributed verdict** — "is this gate green on the base *and* touched by the change?" — plus deliver-with-caveat and the provisioning env-probe. That alone turns darkreader from a silent block into a delivered fix with a truthful caveat, de-flails the reconcile loop, and (with the env-probe) makes astropy affordable. What it does **not** buy for free is the ambitious version: a *per-test* differential that recovers a verdict from a *red* baseline needs method-level test-impact selection that **does not exist** and is the frozen design's hardest-deferred problem (§9.1). This doc's contribution is the **diagnosis that unifies why the cheap fixes are right** — they are all instances of "make the verdict baseline-relative and attributed" — **not** a license to build the heavyweight differential before its prerequisites (method-level TIA, flakiness handling) are solved.

---

## 1. Origin — two correct fixes, both thrown away

The `SMOKE=2` bench pass (2026-07-04, styre `e5d28c04`) ran two real instances end-to-end. Both **blocked at `implement`**; the report headline read 0% resolve / 0% PR-opened. But the provisioning design's own problem statement already recorded the load-bearing fact: styre produced the **correct code** for both — astropy the exact gold fix, darkreader the right anchored regex. So the 0% is a **delivery-gate failure, not a reasoning failure.**

The container-verified root causes (full evidence in §12):

- **astropy-12907** (Python, `tox`): styre detected `tox` (from `tox.ini`), provisioned `pip install tox`, then ran `tox` at verify — which rebuilds its own environments from source. That rebuild ran under the **10-minute `VERIFY_TIMEOUT_MS`** and was SIGKILLed after each 10-minute window (`test:error` → retry → escalate once the attempt budget was exhausted).
- **darkreader-7241** (TypeScript, Rollup): styre detected `build: npm run build`, `test: npm run test:ci`, `lint`, `check:{unavailable}` — **all correct**. But `npm run build` **fails on the pristine base commit, in ~4 seconds, before compiling any source** (`ERR_PACKAGE_PATH_NOT_EXPORTED`: `rollup-plugin-typescript2@0.30.0` requires `tslib/package.json`, whose `exports` omits it, under the image's node 18 — the project's toolchain pins node 14). No worktree code change can make it pass. The committed fix (the regex) was correct; the gate was invalid. *(Honest nuance the review caught: the agent wrote no real test exercising the regex — it left junk placeholder tests — so a green `test:ci` means "did not break existing tests," not "the fix is verified." darkreader's honest verdict is "correct fix delivered, itself untested, build not judgeable," not "verified.")*

Neither failure is about the model getting the code wrong. Both are about **how styre decides whether a change is good.**

---

## 2. The generic diagnosis — an absolute oracle where a differential inference belongs

The invariant "**ground truth over self-report**" (move 5) was right to fire the agent as judge of its own work. But styre did not replace the agent-judge with *judgment* — it replaced it with a **single exit code, taken as infallible**. It swapped one unreliable oracle (the agent's opinion) for another (the gate's exit code) and this time forgot to distrust it. The consequences are structural:

1. **No reference frame.** styre never characterizes the untouched tree. A verdict without a baseline is a category error — measuring altitude with no sea level. "Does the build pass?" has no stable answer across environments; "is this gate green on the base, and did my change touch it?" does.
2. **Red is trusted blindly.** All the existing machinery — the run-all valve, the source-under-test guard, "over-verify never under-verify" — defends against a false *pass*. There is **no symmetric defense against a false *block*.** In our runs a red gate meant, variously: the base was already red (darkreader), the command was merely slow (astropy), the environment was broken (darkreader's node mismatch).
3. **Every red collapses to one reflex.** Regression, pre-existing failure, broken toolchain, and timeout all route to the same place: loop the agent to "fix it" — including causes (node's `exports` enforcement) no agent can touch. That is why the reconcile agents flailed.

One-line diagnosis: **styre judges a change against an ideal ("everything green in my environment") instead of against the world as it found it, because it inherited a gate as an oracle rather than as evidence.** The irony: a SWE-bench-style oracle is *definitionally* differential (targeted tests on base, then patched, then compare); styre reinvented verification as an absolute, and the bench is where an absolute verifier meets a differential oracle and loses.

**This section — the diagnosis — is what the review affirmed and what this doc most stands behind.** The sections that follow are the *direction*, and the review sharply bounded how much of it is buildable now (§4, §9).

---

## 3. The four symptoms share one root — but the fixes are not "free consequences"

| Symptom (observed) | The shared root | What actually fixes it near-term |
|---|---|---|
| darkreader build blocks a correct fix | verdicts were never *baseline-relative*, so a red-on-base gate had nowhere to be recognized | baseline-characterize → demote red-on-base gate → **deliver-with-caveat** |
| astropy tox times out | styre demanded absolute whole-harness green; a timeout is a *resource* fact, not a code verdict | **provisioning env-probe-and-reuse** (make the run affordable) + green→green component differential |
| "can't-verify → deliver nothing" | a binary oracle has nothing to emit but pass/fail | **deliver the attributed verdict** (was named+deferred in provisioning §12) |
| reconcile agents flail on the build | an *unattributed* red routed to an agent as if code could fix it | attribute red → environment/pre-existing never spawns a code-fixing dispatch |

**Correction from v1 (adversarial + scope review).** v1 claimed these were "consequences of one principle, not features to add." That over-unified. Two of the four fixes are *provisioning* wins (astropy's affordability is env-reuse; the deliver-with-caveat tail was already named+deferred in the provisioning doc), and none of them is free. The honest claim is narrower and still worth making: **the diagnosis explains *why* these otherwise-separate fixes are the right ones — each is an instance of "the verdict must be baseline-relative and attributed"** — and it supplies the missing piece none of them names on its own (the *structural attribution* that decides which red loops the agent and which is delivered-with-caveat). It does **not** license building the heavyweight per-test differential (§4.2) before its prerequisites exist.

---

## 4. The direction

### 4.1 The baseline is the reference frame, and it comes first

Before the agent's work is judged, styre **characterizes the untouched tree**: for each detected gate, is it green, red, or un-runnable *in this environment* — and does the change's declared/actual files touch that gate's component? This is the reference frame, not a bolt-on "validation feature." A gate red on the base is not a gate; it is noise, and styre knows that **before** it blames the agent, from a **fact about an exit code on an untouched tree** — no log-reading. Characterization includes the **environment** (is there a ready env that provably tests the worktree source — §7.1), not just the gates.

*Cost honesty (§9.1): baseline-first means an extra gate run on the base. In the modal fresh-checkout case that is real added compute (the T1 fulcrum, amplified). It is a net win only where the base run replaces an even more expensive rebuild (astropy's env-probe) — not in general.*

### 4.2 The verdict is a differential — and its safe, buildable form today is coarse

The question is "is this gate green on the base and did my change break it?" — never the absolute "is it green?". The green/red **baseline** asymmetry is about information quality:

- **Green baseline** → information-rich: any red after is attributable to the change. A **green→red** or **green→green** comparison **at whatever granularity styre can observe** is a clean verdict.
- **Red baseline** → information-poor and **epistemically degraded**: a pre-existing failure *masks* whatever the change may have broken (compiler stops at error A; the change's error B hides behind it). **"red→red = neutral" is forbidden** — it is the dangerous heuristic this whole doc exists to reject.

**What styre can actually observe today (feasibility review — the load-bearing correction):** `run-command.ts` yields *one exit code per whole command*; detected commands are whole-suite aliases (`tox`, `npm run test:ci`); file-identity routing maps a changed file to a **component/gate**, not to individual test IDs. So the **only** differential styre can compute now is **component-granular**: per-gate green/red on base vs after. That is enough for the common, high-value case — a gate green-on-base that stays green (verified) or goes red (regression) — and it is enough to demote a red-on-base gate to "not a valid regression gate."

**The two motivating cases resolve *without* fine isolation:** astropy has a **green** baseline suite (green→green component differential = verified, once the env-probe makes it affordable); darkreader's build is red-on-base and simply **demoted to caveat** (no isolation attempted). Neither needs per-test IDs.

**The ambitious form — a *per-test* differential that recovers a verdict from a *red* baseline by isolating the change's own target — is NOT buildable today.** It requires method-level test selection + structured per-test reporting per stack (`pytest path::node`, junit-xml, `jest -t`, `go test -run`), which is exactly the **import-inference / method-level TIA rung the frozen design deferred as "the cost ceiling."** v1 wrongly implied "styre already has file-identity routing to know which targets" — true only at component granularity. Fine isolation is a **named, deferred enhancement** (§11), and on a red-baseline-touched gate that cannot be isolated, the honest output is **caveat (couldn't-judge)** — never a text-based "same failure, neutral" guess.

### 4.3 Red must be attributed — but only the 2-way distinction is structural

Every non-green result is classified, and the review forced an honest split between what is *structurally decidable* and what is not:

- **Structurally decidable (load-bearing, from exit-on-base + files-touched):** is this red **attributable to the change** or not?
  - *green-on-base + component touched by the change + red-after* → **change-attributable** → the **only** case where looping the agent is legitimate (subject to the flakiness caveat, §9.3).
  - *red-on-base*, **or** *a component the change did not touch* → **not change-attributable** → do not loop the agent; surface / caveat.
- **Best-effort annotations (NOT structurally separable — do not gate on them):** "environment/toolchain-broken" vs "pre-existing failing test" are **structurally identical** (both red-on-base, unchanged locus); telling them apart needs the error text this doc forbids reading for verdicts. `timedOut` → "resource" is the one finer label that *is* structural. The rest are advisory colour for the human-readable caveat, produced by a **bounded, allowlisted match of known infrastructure-error signatures** (e.g. `ERR_PACKAGE_PATH_NOT_EXPORTED`) — explicitly **not** general log interpretation, and **never** verdict-affecting.

*v1 listed "failure-locus-vs-diff" as a structural signal; the review proved it is only readable from stderr. It is removed. darkreader's demotion rides on **red-on-base alone**, which is structural and sufficient.*

### 4.4 The deliverable is the attributed verdict, not a binary

styre's terminal is not "green → PR" xor "red → deliver nothing." It is "here is the change, and here is the honest, baseline-relative, attributed account of what I could and could not establish." A correct fix behind an environment-broken build is **deliverable with that caveat** — precisely the T2 "surface the gap" philosophy the frozen design already holds but the verify layer cannot currently feed, because it has no baseline or attribution to produce a gap. The philosophy is right; the verifier is too primitive to serve it.

---

## 5. How this holds — and sharpens — the invariants

- **Ground truth over self-report** — *preserved and made honest.* Verdicts still come from exit codes, never agent self-scoring. A gate result becomes **evidence attributed against a baseline**, not an oracle obeyed. Attribution is structural (exit-on-base, files-touched, `timedOut`); the advisory cause-labels use bounded signature-matching, never LLM judgment, so no self-report re-enters.
- **Over-verify, never under-verify** — *gains its missing mirror.* The frozen design defends only the false *pass*; a baseline-relative verdict defends the false *block* too. A red is a block only when it is a *new* red on a component the change touched.
- **Loop-not-halt** — *unchanged; the loop loops on the right thing.* Attribution ensures the agent is looped only for a *suspected* change-caused regression, not for environment/cost.
- **Capability isolation / deterministic routing** — *unchanged.* Baseline runs and attribution are runner-owned and deterministic.

---

## 6. The two images, worked through (honestly)

### 6.1 darkreader — deliver-with-caveat (no isolation, no CI-reading)

1. **Baseline-characterize:** `test:ci` green, `lint` green, `build` **red** on the pristine tree — a fact about an exit code, no interpretation. Red-on-base demotes `build` from a regression gate to "not judgeable here."
2. **Differential on the green gates:** the change keeps `test:ci` green and `lint` green (green→green, component granularity). Note the honest limit (§1): the agent added no real test for the regex, so this establishes "no regression in existing tests," not "the fix is verified."
3. **Attribution + deliver:** `build` stays red and **not change-attributable** (red-on-base) → never loops the agent. PR opens with the regex and the verdict: *"existing tests + lint green; the fix itself is not covered by a new test; build not gated — red on the untouched base (environment/toolchain)."* Bench: **0/0-blocked → PR-opened, correct fix delivered with an honest caveat.**

*Removed from v1 (adversarial review): the claim that styre reads `test.yml` to conclude "build is not a code gate here." CI-reading is the frozen design's unvalidated, pilot-gated capability (§8 Q2) and is judgment-laden — it must not be presented as a free structural signal. The red-on-base fact alone carries the demotion.*

### 6.2 astropy — the win is provisioning's env-reuse, then a green→green differential

1. **Characterize the environment (this is provisioning's probe, not this doc's differential):** the active conda `testbed` env is editable-installed against `/testbed` (§12) → the worktree is provably under test. Reuse it (fast) rather than rebuilding via `tox`. *Honest scope note (feasibility review): reusing conda means running the tests a way styre did not detect (a pytest subset instead of the detected `tox`) — this **does** re-touch the command layer, and it is gated on the probe correctly telling an editable link from a shadowing copy, which the provisioning design names its **highest** correctness risk (§9.6). tox pre-warm (§7.3) is the fallback that keeps the *detected* command.*
2. **Baseline is green:** astropy's base suite is green for the relevant tests → a clean reference frame, no red-baseline masking.
3. **Component-granular differential:** run the affected tests; green→green (with the target's flip) = verified. **No per-test-ID machinery required — a green baseline makes the coarse differential sufficient.**
4. **Deliver:** verified green → PR. Bench: **resolved.**

The honest credit: **astropy's green is delivered by provisioning (env-reuse) + a coarse differential over a green baseline; the "differential + attribution" thesis contributes the *routing* (stop treating the timeout as a code failure), not the green.** The through-line still holds — both images already contained what styre needed (a ready editable env; a build that is not a valid gate) and styre failed because it never looked — but the *machinery* credited with the win is mostly provisioning's, not new.

---

## 7. Relationship to existing design decisions

### 7.1 Conda: from "deny" to "probe" (legitimate, evidence-grounded — but the probe is deferred)

The provisioning design denies the conda shortcut because a conda env may editable-link the worktree (correct bytes) or carry a fixed-version copy that **shadows** it (wrong bytes), indistinguishable from outside. Sound as a statement about *assumption*. But it hardened into "*never* use conda, always rebuild," and that blanket denial cost astropy its timeout — the `testbed` env was already editable-linked (§12). The reconciliation is **probe, not deny or trust**: point the existing source-under-test check at the *ready environment* as a candidate. *Coordination note (coherence review): this reinterprets a closed decision in the provisioning doc; that doc should carry a revision pointer here. And the probe-as-reusable-orchestration is **net-new** — today the source-check runs only after a pip-editable `prepare`, not as an up-front environment candidacy test — so §7.1 cannot ship until that probe is specified (provisioning §13 names its false-positive as the highest correctness risk).*

### 7.2 "Can't-verify → deliver nothing" — this *would* subsume the deferred tail, pending review

The provisioning plan filed deliver-with-caveat as a named, separate, deferred fix. It maps onto principle 4.4. Stated conditionally (per scope review): *pending the control-loop revision, this would subsume that deferred tail rather than remain a separate fix.*

### 7.3 tox pre-warm — a fallback under this frame

Pre-warming tox's envs at provision (under the 15-min `PROVISION_TIMEOUT_MS`) so the verify run reuses them is still correct and consistent with the conda denial (you run *real* tox, just pre-built). It is the fallback for when the env-probe (§7.1) finds no ready editable env — not the primary path.

### 7.4 "Baseline gate validation" — this is principle 4.1

The standalone "smoke-test each gate on the base" idea is principle 4.1 named as a feature. Kept, as the reference-frame step.

### 7.5 The tension it amplifies: T1 cost

Principle 4.1 runs the gate suite an extra time on the base — feeding the frozen design's **open T1 cost fulcrum**. This is a **new compute category**, not covered by the existing `sweep-cost` instrumentation (which measures *patched-tree* sweeps). Baseline scoping cannot use the realized diff (it does not exist pre-implement) — it must key on the unit's declared `files_to_touch` from `design:extract`. Sharpest open risk (§9).

### 7.6 The integration reconcile-blind routing it *would* retire

`failure-policy.ts` answers a ticket-level integration failure by spawning a context-free `reconcile` unit and looping. Under attribution (4.3) a build red-on-base is not change-attributable → it *would* never spawn a code-fixing dispatch. Stated conditionally (scope review): this retirement is a proposal for the control-loop revision, not a settled outcome.

---

## 8. What this is NOT

- **Not a claim the heavyweight machinery is free or near-term.** The buildable win is the coarse (component-granular) 2-way verdict + caveat + env-probe. The per-test differential is deferred behind method-level TIA and flakiness handling.
- **Not semantic log-diffing.** Verdicts use only structural signals (exit-on-base, files-touched, `timedOut`). Cause-*labels* may use a bounded allowlist of known infra-error signatures — never general log interpretation, never verdict-affecting.
- **Not image-awareness.** styre detects *generic* facts (ready editable env? gate red on base?), consistent with provisioning decision 1.
- **Not abandoning ground truth.** The gate is still the source of truth — evidence against a baseline, not an oracle. Attribution is structural, never an LLM's opinion.
- **Not requiring curated F2P/P2P lists.** styre judges the gates its own change touches against their base state — no human-authored test manifest.

---

## 9. Open risks & tensions (confirm-before-build)

1. **★ Method-level test isolation does not exist (the biggest gap).** The per-test differential that recovers a verdict from a red baseline needs per-runner report emission + test-selection per stack — the frozen design's deferred rung-3 TIA. **Until it exists, red-baseline-touched gates degrade to caveat, and the "isolate a clean local target" move of §4.2 is unavailable.** The near-term design must be honest that its differential is component-granular only.
2. **★ Baseline cost (T1, amplified, new category).** An extra base gate-run per gate; a real doubling in the modal fresh-checkout case. Must be measured on a real fixture, scoped by declared `files_to_touch`, with an over-budget branch, before it calcifies. The astropy "cost win" is the env-probe replacing a rebuild — not a property of baseline-first, and not general.
3. **★ Flakiness breaks the one case that loops the agent.** A flaky/order-dependent/time-varying test can be green on the base run and red on the after run with locus inside the change's target — every structural signal says "change-caused regression → loop the agent," which is wrong. The 4.3 "change-attributable" verdict is therefore **suspected**, not certain; the mitigation (repeat-run / quarantine before looping) must be designed, or styre will confidently mis-route non-determinism to the agent on exactly the messy repos it targets.
4. **Environment/pre-existing are not structurally separable.** Only the 2-way (change-attributable vs not) gates behaviour; the finer cause-labels are advisory and produced by a bounded signature allowlist, not verdict logic (§4.3).
5. **★ Control-loop blast radius is larger than a verify tweak.** The `pass|fail` → attributed-verdict change ripples through the resolver's advance/re-verify core (`passingShasFor`), *all* of failure-policy's routing, the PR-body renderer, and the dual `schema.sql` result enum — a `control-loop.md` revision + spec + review, on M-D footing.
6. **Environment-probe false-positives** (inherited, provisioning §13): mistaking a shadowing copy for a ready editable env → verifying the wrong bytes. The §7.1 probe must assert worktree-source-under-test and fall through when it cannot prove it. Highest correctness risk of the reuse path.
7. **Taxonomy is half-grounded.** Of the four cause-labels, only "environment" (darkreader) and "resource" (astropy) are demonstrated by the two instances; "regression" and "pre-existing" are asserted for completeness and untested against a real fixture.

---

## 10. The OSS ↔ commercial seam

- **OSS owns:** baseline characterization (runner-owned, deterministic), the environment probe, the **component-granular** differential verdict, structural 2-way attribution, and deliver-with-caveat into the PR body. The OSS terminal stays **PR-ready** — now with an honest verdict attached instead of a silent block.
- **Commercial plane owns:** persisting/caching baselines across runs, managed environment provisioning (env rebuild for the un-displaceable-conda tail), and the hard pre-PR interactive hold. None of this is required for correctness; the plane only makes it cheaper.
- **Seam impact:** the verify verdict shape changes from `pass|fail` to a structurally load-bearing 2-way (`change-attributable | not`) with an advisory cause-label and a `couldn't-judge` state — a telemetry/state-export contract change, to be planned, not smuggled. *(The load-bearing enum is the 2-way + `couldn't-judge`; the cause-labels `environment | resource | pre-existing` are advisory annotations, not separate verdicts — v1 conflated these.)*

---

## 11. Deferred / named follow-ons

- **The `control-loop.md` catalog revision + spec** (baseline step; 2-way verdict semantics; failure-policy attribution routing; the reconcile-retirement) — the actual plan, gated on this doc's sign-off. Blast radius per §9.5.
- **Method-level TIA (the per-test differential)** — the deferred enhancement that would let a red-baseline-touched gate be *isolated* rather than caveated. Gated on the frozen design's rung-3, and on §9.3 flakiness handling. **Do not build before those.**
- **Flakiness handling** (repeat-run / quarantine) — prerequisite for trusting the "change-attributable → loop the agent" verdict.
- **The env-probe candidacy orchestration** (§7.1) + per-language source-under-test predicates — Python/Node first, mirroring provisioning's scope.
- **The T1 baseline-cost measurement + over-budget branch** — a new cost category (§7.5), not covered by existing `sweep-cost`.

---

## 12. Provenance & evidence appendix

All claims below were **reproduced in the actual bench Docker images** (not inferred from logs), 2026-07-04/05.

**darkreader-7241** — image `mswebench/darkreader_m_darkreader:pr-7241` (node 18.20.7, repo `/home/darkreader`, base `991883df`):
- `npm run build` on the **pristine base, zero agent changes** → **exit 1 in 4.4s**, `ERR_PACKAGE_PATH_NOT_EXPORTED` for `tslib/package.json` at `rollup-plugin-typescript2@0.30.0` (bundled `tslib@2.1.0` `exports` omits `./package.json`; strict under node 18; project CI pins node 14). Same failure with the agent's committed change applied → identical error in ~3s. The committed change carried empty/no-op `dbg.test.ts` placeholders that never enter the build graph and add no real coverage of the regex.
- Project PR CI (`.github/workflows/test.yml`): `npm ci` → `npm run test:ci` → `npm run lint`. **No build.** Build appears only in `tagged-release.yml`. *(Recorded as evidence, not used as a verify signal — CI-reading is pilot-gated, §6.1.)*
- Profile written by styre: `build:"npm run build"`, `test:"npm run test:ci"`, `lint:"npm run lint"`, `check:{unavailable:true}` — all **correct**; `check` genuinely absent as a standalone script.

**astropy-12907** — image `swebench/sweb.eval.arm64.astropy_1776_astropy-12907` (Python 3.9, conda):
- conda envs `base` + `testbed` (active). `python -c "import astropy"` → `astropy.__file__ = /testbed/astropy/__init__.py`. `pip show astropy` → `Editable project location: /testbed`. So the conda env **editable-links the worktree** — it tests the right bytes, and styre's blanket tox-rebuild threw that away.
- `/testbed/tox.ini` present; `tox` **not** pre-installed (styre `pip install tox`s it). Detected command `tox`; its rebuild ran under the 10-min `VERIFY_TIMEOUT_MS` and timed out (`test:error`), retried, and escalated at the attempt budget.

**Loop-mechanics (styre `e5d28c04`, cross-checked against current HEAD by the fact-check review):** `VERIFY_TIMEOUT_MS = 10*60*1000` (`handlers.ts:91`); `PROVISION_TIMEOUT_MS = 15*60*1000` (`:92`); verify maps `timedOut || exitCode===null → "error"` else `"fail"` (`:711`,`:844`); the integration signal persists `detail:{ran}` = per-job `{label, exitCode, timedOut}` — **timeout flags + exit codes, no stderr** (`:848-855`), unlike `verify:check` which stores 2000 chars of stderr (`:716`); integration failure spawns a context-free `reconcile` unit (`failure-policy.ts:148-170`); scope_diff is an advisory signal from `completeness`, never a step, so it never routes to a loopback. `run-command.ts` captures `{exitCode, stdout, stderr, timedOut}` — the runner *has* stderr; only `verify:integration` discards it.

---

## 13. Changelog
- *2026-07-05 (v1)* — initial diagnosis + philosophy, from the 2026-07-04 bench pass and a container-reproduction investigation. Principle 4.2 tightened after operator objection: naïve "red→red = neutral" is unsafe (masking).
- *2026-07-05 (v2)* — revised after an independent five-lens code-grounded review (fact-check / coherence / feasibility / scope / adversarial). **Diagnosis and scope affirmed; mechanism downgraded for candor.** Changes: (a) the differential is **component-granular** today — per-test itemized outcomes and fine isolation do **not** exist and are the frozen design's deferred method-level TIA; v1's "styre already has routing to know which targets" was false at that granularity (feasibility + adversarial MUST-FIX). (b) Attribution's load-bearing distinction is the **2-way change-attributable-vs-not**; "failure-locus-vs-diff" removed as non-structural; environment-vs-pre-existing conceded structurally inseparable; cause-labels demoted to advisory signature-matching (coherence + adversarial MUST-FIX). (c) **Flakiness** added as a first-class risk that breaks the one agent-looping verdict (adversarial, previously unaddressed). (d) The "four consequences of one principle" claim **deflated** — astropy's win is provisioning env-reuse, darkreader's is baseline-validation + deliver-with-caveat; the diagnosis unifies *why* they are right, it does not make them free (adversarial + scope). (e) darkreader "verified" corrected to "fix delivered, itself untested (junk placeholder tests), build not judgeable"; the CI-reading corroboration removed as pilot-gated. (f) §7.2/§7.6 asserted outcomes softened to conditional-pending-review; §9.5 control-loop blast radius enlarged; §7.5 baseline cost named a new category; taxonomy flagged half-grounded. (g) Fact-check wording fixes (integration detail carries timeout flags + exit codes, not "only exit codes"; astropy error→retry→escalate).
