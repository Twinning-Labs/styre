# Baseline-relative verify verdict — Implementation Plan (v2, post-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans **only after Phase 0 lands** (see below). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop styre from blocking a correct change on a gate that was already red on the untouched base — by establishing each gate's base result and routing a *red-on-base* gate to an honest **couldn't-judge → deliver-with-caveat** verdict instead of looping the agent or falsely claiming "verified."

**Architecture (v2, corrected after review):** A **lazy, on-demand baseline** — when a gate *fails* at verify (by which point the unit's `base_sha` exists), run just that gate on a **base checkout** to establish its base result, recorded as a `baseline` signal keyed on `base_sha`. A gate that was **red on base** yields a **`couldn't-judge`** verdict: the loop advances (deliver-with-caveat, honestly surfaced in the PR body) but the gate is **not** recorded as a verified `pass`. A gate **green on base and red after** loops the agent, as today.

**Tech Stack:** TypeScript, Bun (`bun test`), embedded SQLite, Zod.

## ⚠ STATUS: this plan's code is PROVISIONAL pending Phase 0

The independent five-lens review (fact-check / coherence / feasibility / scope / adversarial, 2026-07-05) found that the v1 plan's central shortcut — degrading a red-on-base gate to `result:"pass"` — is **unsound**: it re-enters the masking hazard the brainstorm §4.2 forbids and corrupts the SoT / telemetry / PR body. The honest correction (`couldn't-judge` as a distinct verdict that advances-but-is-not-verified) is a **control-loop semantics change** — exactly the S1–S10 catalog modification the brainstorm gates behind a `control-loop.md` revision + review. **Therefore Phase 0 (the spec revision) is the real next deliverable, and the code tasks below cannot be finalized to no-placeholder TDD until Phase 0 settles the six design decisions in §Phase 0.** The code section is a *corrected sketch*, not an executable plan yet.

---

## ⚠ Divergences from the brainstorm & our conversation (COMPLETE list, v2)

1. **Scope split — verify-verdict/darkreader ONLY; astropy is a separate provisioning plan.** *Validated by review as honest.* astropy (`tox` timeout) needs provisioning env-reuse + pre-warm; it is **not handled here** (see #7). Your prior pre-warm agreement is preserved as deferred, not dropped.
2. **Phase 0 (`control-loop.md` revision) is the genuine first deliverable — the review confirmed it is required, not ceremonial.** v1 pre-baked Phase-0's answers into code tasks (prejudicing the gate); v2 leaves the mechanics as Phase-0 *decisions* (§Phase 0) and marks the code provisional.
3. **REVERSED from v1: there IS a new verdict state.** v1 claimed "no new verdict enum" by reusing `untested-merge-risk` + degrade-to-`pass`. The review proved that flattening `couldn't-judge` into `pass` masks regressions (a change adding failure B behind pre-existing failure A ships as "verified") and makes the projector print a false "Verified against the project's checks." v2 reinstates a **distinct `couldn't-judge` verdict** (advance-but-not-verified). *This is a real control-loop + projector change — the §9.5 blast radius the brainstorm named and v1 under-scoped.*
4. **Attribution lives in the verify handlers, not failure-policy.** *Validated.* Intercepting before the throw means `failure-policy`'s context-free `reconcile` spawn is never reached for red-on-base gates.
5. **Flakiness — two gaps, both named:** (a) the green→red loopback stays "suspected" (deferred, acceptable boundary); (b) **NEW (review):** a single flaky *red* base run must not license a permanent degrade — v2's lazy baseline recomputes per verify, and repeat-confirmation of base redness is a named Phase-0 question, not assumed.
6. **NEW mechanic: lazy on-demand baseline** replaces v1's pre-implement baseline step. v1's step ran before `implement:dispatch` writes `base_sha` (→ null keys → silent no-op) and resequenced the shipped `provision` step for every ticket. Lazy baseline (compute at verify-time on the failing gate, when `base_sha` exists) avoids both.
7. **NEW correction: astropy is NOT rescued by a "resource caveat" here.** v1 claimed a `tox` timeout would degrade via red-on-base. The review showed the asymmetric budgets (base 15min vs verify 10min) break the degrade, and baseline *doubles* the heavy rebuild. Removed. astropy waits for the provisioning plan.
8. **Advisory cause-labels (environment/toolchain) are out of scope** (brainstorm §6.1's "bounded infra-signature match"). v2 emits a generic `reason:"red-on-base"`; the human-readable "environment/toolchain" colour is deferred. *Cosmetic, flagged per review.*

**If any of #1, #3, #6, #7 is not the scope you intend — especially #3 (a real verdict/projector change, bigger than v1 implied) and #7 (astropy unhandled) — stop and adjust before Phase 0.**

---

## Phase 0 (THE deliverable right now): `control-loop.md` revision + review

Produce the spec revision and get it independently reviewed + operator-signed-off. It must decide these six, each surfaced by the review:

- [ ] **D1 — the `couldn't-judge` verdict semantics.** How is "delivered but not verified" represented so that (a) the resolver **advances** past the check (no infinite re-run, no loopback), (b) `passingShasFor` / advance logic does **not** count it as a verified pass, (c) the projector/`renderPrBody` surfaces it honestly and does **not** print "Verified against the project's checks." Recommended: a new signal disposition (e.g. `result:"inconclusive"` or a `verify-inconclusive` signal) that the resolver treats as "check resolved, not passed," plus a `renderPrBody` branch. **This is the load-bearing decision; everything else depends on it.**
- [ ] **D2 — the lazy baseline mechanic.** On a gate failure at verify, run that one gate on a **base checkout** of `base_sha` (a separate provisioned worktree, since the live worktree holds the change), record a `baseline` signal keyed on `base_sha`. Decide: worktree lifecycle for the base checkout, whether/how it is provisioned (reuse the `provision` handler against the base), and caching (compute-once per (base_sha, gate)).
- [ ] **D3 — the `verify:integration` degrade rewrite.** `verify:integration` (`handlers.ts:809-858`) has **no** degrade path (unlike `verify:check`); it `break`s on first failure and throws. Spec the rewrite: `break`→`continue` past a red-on-base job, derive `component`+`checkType` from the job label (`${c.name}:${key}`), and keep a genuine `pass` only if *every* remaining job passed (a green-on-base job that fails must still fail).
- [ ] **D4 — projector honesty.** `renderPrBody` (`handlers.ts:138-181`) renders only `detail.component` and ends with a hardcoded "Verified…passed" line. Spec: render the `reason`, and make the "Verified" line conditional on there being **no** `couldn't-judge`/`untested-merge-risk` signal.
- [ ] **D5 — flaky-red-baseline.** Decide whether a red base result is trusted from one run or requires repeat-confirmation before licensing a degrade (the review's "single flaky red base → permanent degrade" hole).
- [ ] **D6 — the masking boundary + caveat wording.** Component-granular red-on-base **cannot** tell "same pre-existing failure" from "pre-existing + new regression" (brainstorm §4.2). The caveat MUST say "this gate was red on the base, so the change's effect on it is **unknowable** — human review required," **never** "not your change's fault." Confirm this is the accepted honesty bar (couldn't-judge, not exonerated).
- [ ] **Independent review of the revision + operator sign-off. Do not start any code task until this lands.**

---

## Provisional code sketch (finalize to TDD tasks AFTER Phase 0)

Corrected for lazy baseline + `couldn't-judge`. Interfaces confirmed against the repo by the fact-check review (file:line noted). **Not yet no-placeholder TDD — the exact verdict signal (D1) and base-checkout mechanic (D2) are Phase-0 outputs.**

- **T1 — `baseline` signal + `baselineResultFor(db, {ticketId, component, checkType, baseSha})`** in `ground-truth-signal.ts`. `signal_type` is free `TEXT` (`schema.sql:346`) → **no schema edit**. `insertSignal` requires `result` (non-optional — v1 Task 4 omitted it; fix). Confirmed: `insertSignal` shape (`ground-truth-signal.ts:49-60`).
- **T2 — lazy base-gate runner** `runBaselineGate(ctx, {component, checkType, command, dir, baseSha})`: ensure a base checkout worktree at `base_sha`, provision it (D2), `runCommand(command, {timeoutMs: VERIFY_TIMEOUT_MS})` — **same 10-min budget as verify** (fix the v1 15-vs-10 asymmetry the review flagged), record the `baseline` signal. Called on-demand from the verify handlers, not a resolver step (so no `provision` resequencing; `base_sha` is already set by `implement:dispatch`, `handlers.ts:338`).
- **T3 — `verify:check` couldn't-judge branch:** on a component gate non-zero, `const base = baselineResultFor(...)` (compute lazily if absent). If `base` is `fail`/`error` → emit the D1 `couldn't-judge` verdict + `untested-merge-risk(reason:"red-on-base")`; **do not** record a verified pass. If `base` is `pass`/`null` → fail/loopback as today (null = green-or-untaken must never degrade — the review's "untaken must not silently pass").
- **T4 — `verify:integration` rewrite (D3):** the real loop restructure — not a "reuse." Same couldn't-judge routing per job.
- **T5 — `renderPrBody` honesty (D4):** render `reason`; gate the "Verified" line on absence of couldn't-judge signals. *(v1 omitted this file entirely; Task 5's e2e could not have passed.)*
- **T6 — e2e:** darkreader-shaped (build red-on-base) → reaches PR-ready with a couldn't-judge caveat, PR body does **not** say "Verified"; and the negative case (green-on-base gate that fails → still loops the agent).

## Deferred / named follow-ons (NOT in this plan)

- **astropy / provisioning plan (separate):** tox pre-warm + env-probe reuse. Without it, astropy is **unhandled** here (divergence #7) — not "resource-caveated."
- **Per-test itemized differential (method-level TIA):** the only thing that could *recover a verdict* from a red-baseline-*touched* gate instead of couldn't-judge. Frozen design's deferred rung-3. Do not build before its prerequisites.
- **Flakiness handling (repeat-run/quarantine):** for both green→red (loopback) and red-base-confirmation (D5).
- **Advisory infra-signature cause-labels** (divergence #8).
- **Fix-pinning test gate (strengthen A1) [follow-on, brainstorm §13.2]:** for a behavioral unit, require the agent's *new* test to **fail on base and pass on the change** — reusing this plan's base-state check. Turns verify from "no regression" into "the change is pinned by a test that demonstrably exercises it" (the bar both upstream PRs used). Necessary-not-sufficient (reviewer judges test quality; escape needed for untestable changes). Separate decision — needs its own control-loop note + review.
- **Build-gate reconsideration [open, brainstorm §13.1]:** styre gates on whatever `build` script exists, conflating typecheck / bundler / release-packager. A build gate is defensible only as a *check-only* compile (`tsc --noEmit`/`cargo check`), never packaging — part of the darkreader block was self-inflicted (gating on a packaging build). `inconclusive` band-aids it; the root fix is detector-side (don't gate on packaging). Out of this milestone.
- **Regression strategy [open, the T1 fulcrum, brainstorm §13.3]:** the build catches only *type-level* cross-breakage; behavioral regressions need running the covering tests. Principled cheap answer = coverage-guided selection / import-graph TIA (deferred). This plan's component-granular differential **under-catches cross-component regressions** — an honest, named limit, not a solved problem.

## Open risks

1. **★ Masking is real and only mitigated by honesty (D6).** Component-granular red-on-base cannot exonerate a change; the couldn't-judge caveat must say so. This is an *accepted* limit (surfaced to the human), not a solved problem — its safety rests entirely on D1 not recording a verified pass and D4 not printing "Verified."
2. **★ Base-checkout cost.** Lazy baseline bounds cost to failing gates, but each still needs a provisioned base checkout. For heavy harnesses (astropy) this is prohibitive — another reason astropy is out.
3. **Flaky-red baseline (D5).** Until repeat-confirmation exists, a red base is trusted from one run.
4. **Control-loop blast radius (D1).** The couldn't-judge verdict touches resolver advance + failure-policy + projector + telemetry export — the §9.5 change the brainstorm flagged. Bigger than a within-verify tweak; hence Phase 0.

## Recommendation

**Do not execute code yet.** The review's verdict is that the honest mechanism (couldn't-judge, lazy baseline) is a genuine control-loop change, so the next deliverable is the **Phase 0 `control-loop.md` revision** (the six decisions above), reviewed and signed off — then this sketch becomes finalizable to no-placeholder TDD. Recommend I (a) write the Phase-0 control-loop revision next, or (b) hold for your call on divergences #3/#6/#7 first.
