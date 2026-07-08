# Change-scoped verify M3 — `checks:classify` (grade the RED + adjudicate + re-author)

**Status:** Design (brainstorm output) — **v2, revised after two independent reviews** (code-grounded feasibility + adversarial soundness, 2026-07-08). Core shape approved by the operator through a live design dialogue; v2 folds the review findings: the assertion tier is reframed (determinism = prior, adjudicator classifies), dispositions are per-check with an AC rollup, the re-author is scoped, and — per operator direction — **M2b is *adjusted* (not treated as frozen) to persist what M3 needs at the source** (the per-check exit code + framework + command in the RED-first signal `detail_json`), so M3's prior keys on the real exit code rather than reverse-engineering it. Loopback is net-new wiring; disposition schema migrated from M6. Pending written-spec re-review. On branch `feat/change-scoped-verify-m3` (based on the M2b tip; rebases onto `main` after M2b/PR #63 merges).

**M2b is not frozen (§2b).** M2b (#63, ready but unmerged) and M3 are one feature shipping together. Where M3 needs data or behavior from the RED-first step, M2b is adjusted to provide it directly — no downstream workarounds. Two such adjustments: (i) persist `{exit_code, framework, command}` next to `rawOutput` (amended into #63); (ii) support the scoped re-author (§2). Both are self-consistent parts of the checks step, done where they belong.
**Date:** 2026-07-08
**Scope:** the step that turns M2's *coarse* RED-first verdict into the **graded RED taxonomy** (assertion / absence / environmental), **adjudicates** the green-on-HEAD cases (vacuous / already-satisfied / not-expressible), and runs the **bounded, scoped re-author loop**. Still **non-gating** (the gate rework is M4).

**Builds on:**
- `docs/brainstorms/2026-07-07-change-scoped-verify-ac-checks-design.md` (v2, overall) — §2.3 (the graded taxonomy; assertion-red = ground truth, absence-red = named bias, environmental = advisory), §2.5 (the convergence note — signature-escalate vs budget-exhaustion), §5 (the load-bearing false-green, H-A).
- `docs/brainstorms/2026-07-08-change-scoped-verify-m2-checks-step-design.md` (v2) + the merged M2b code — the coarse `red`/`green`/`error` bucket and the **untruncated raw output** stored in `ground_truth_signal.detail_json` (`signal_type = "ac-check-red-first"`).
- M1 schema: `ac_check.red_class` (nullable, `CHECK IN ('assertion','absence','environmental')`) reserved for this; `acceptance_criterion` (no disposition column — net-new).
- `docs/brainstorms/2026-07-07-design-loop-convergence-design.md` — the loopback + carry-feedback + escalate-on-repeat *shape* M3's re-author loop mirrors (but re-implements — see §2).
- `CLAUDE.md`: ground truth over self-report; loop-not-halt; capability isolation; validated (zod) agent output; **no silent scope deferral**; edit BOTH `schema.sql` copies on any schema change.

**Release/inertness note (no flag).** M3 accumulates on `main` but isn't live until a release is cut after all Mx. M3 gates nothing — it records `red_class` + dispositions and drives the re-author loop. So the failure axis is "does M3 record a *sound, M4/M5/M6-consumable* classification," not "wrong live outcome."

---

## 1. What M3 delivers (and defers)

**Delivers:**
- A new **`checks:classify`** step in the resolver's `design → provision → checks:dispatch → checks:classify → implement` path.
- **Classify** each check's RED-first outcome into `ac_check.red_class` (assertion / absence / environmental) — **determinism is a prior; the adjudicator is the classifier** (§3).
- **Adjudicate green-on-HEAD** → *vacuous* / *already-satisfied* / *not-expressible*, **per check** (§4).
- **Bounded, SCOPED re-author loop:** a *vacuous* check triggers a resolver loopback that re-authors **only its AC** (§2).
- **Record** `red_class` (write-once, per check) + per-check green dispositions; the AC-level `assessed-satisfied` is a rollup (§6).

**Defers (named):** M4 (the verify-gate rework — gate on an assertion-red check flipping green) · M5 (the code/check/environmental **arbiter** on *persistent red after implement* — a different decision, and it writes a *separate* field, never M3's `red_class`) · M6 (the **projection** of M3's dispositions to the MERGE gate — M3 *decides + records*, M6 *shows*).

---

## 2. The `checks:classify` step + the scoped re-author loopback

Resolver chain: `design:* → provision → checks:dispatch → checks:classify → advance`. `checks:classify` is `done()`-gated; the resolver stays **pure**.

**The re-author loop is net-new wiring (not a config-reuse of design→review).** The design-loop loopback is a bespoke verdict path (`VERDICT_BEARING_STEPS`, `redesignLoopback` with a hardcoded reset list + `"design"` loop label, `isRepeatedReviewLoopback` filtering `loop ∈ {implement,design}`). M3 must add, in the same shape:
- `"checks:classify"` to `VERDICT_BEARING_STEPS`;
- a new verdict function that `resetToPending`s **`checks:dispatch` + `checks:classify`** and appends a loopback event with a new **`"checks"`** loop label + the **flagged AC ids** as payload;
- a new `isRepeated…` variant filtering `loop === "checks"`;
- a new **`checksFeedback`** carrier (paralleling `designFeedback`) rendered into the re-authored `checks:dispatch` prompt.
- *Simpler than redesign in one way:* `checks:dispatch` and `checks:classify` are in the **same `design` stage**, so the loopback needs **no stage flip** — after the reset, `case "design"` naturally re-serves both.

**Scoped re-author (an M2b adjustment, §2b).** M2b's `checks:dispatch` deletes-then-inserts the **whole ticket**. For a re-author loopback that would churn every check and let good checks regress (the period-2 oscillation the adversarial review found). So `checks:dispatch` is adjusted: on a **loopback re-dispatch** (a `loop === "checks"` event carrying flagged AC ids), it re-authors **only those ACs** (delete+re-insert their `ac_check` rows; leave the rest untouched). A fresh/crash-resume dispatch keeps the whole-ticket delete-then-insert. Because M2b is not frozen, this is a normal extension of the checks step (not a reopening) — and it kills both the churn and the oscillation, making the **escalate bound sound** (§7).

### 2b. The M2b adjustments (persist-at-the-source)

Two changes land in the M2b step (exit-code persistence amended into #63; the scoped-re-author branch alongside M3 since it consumes M3's loop-event contract):
- **Persist `{exit_code, framework, command}`** into the RED-first signal's `detail_json` (next to the existing `rawOutput`) — `runCheckForRed` returns the exit code instead of dropping it, and the handler records the framework (`frameworkFor`) + the assembled command. No schema change (open JSON). This is the ground-truth signal M3's prior reads; recording it at the source (where it's free) rather than re-deriving it in M3 is the point of not treating M2b as frozen.
- **Scoped re-author branch** in `checks:dispatch` (above).

## 3. Classifying `red` — determinism is a prior, the adjudicator classifies

The Q1 "deterministic assertion-vs-error = ground truth" premise is **unsound** and is reframed here. Why: **"an assertion statement failed" ≠ "the check reached the behavior."** The dominant feature-path absence is *proxy-mediated* — AC "POST /preferences persists a pref" → author writes `assert r.status_code == 201` → clean HEAD has no route → 404 → `assert 404 == 201` → **AssertionError**. A syntactic "assertion" label would promote this false-green-prone absence into the ground-truth tier — the exact case §2.3 quarantines to the *bias* tier. The exit code (now persisted by M2b, §2b) separates *errored-before-running* from *assertion-failed* cleanly, but it **cannot** separate a proxy-absence from a real assertion (both exit 1) — so the semantic call is judgment, not determinism.

So:
- **Deterministic prior (from the M2b-persisted exit code + framework + rawOutput).** `checks:classify` reads the `{exit_code, framework}` M2b now persists (§2b) — no re-derivation — and settles a coarse observation: *passed* / *errored-before-running* (pytest exit 2 collection/import error, a Go build error, jest "Cannot find module", …) / *assertion-failed* (pytest exit 1 with an assertion in the trace). It resolves only the **unambiguous** cases on its own: a clean `ImportError`/`NameError` of the AC's **own new** symbol ⇒ `absence`; M2's coarse `error` (couldn't-attempt) ⇒ `environmental`. The exit code makes the prior robust (not a brittle text-only parse); it remains only a *prior* — the semantic classification below is the adjudicator's.
- **The adjudicator is the classifier for everything ambiguous** (§5). It produces the semantic `red_class` by reading the AC + the check + the rawOutput trace + the repo (Grep). **`assertion` = ground truth is earned only when the adjudicator confirms the failed assertion was over genuinely-executed new behavior** (not a 404/sentinel/`None`-from-missing standing in for absence). The prior is *input* to the adjudicator, **never an override** — where the adjudicator sees a missing target surface behind an AssertionError, its `absence` call wins.
- `absence` carries the design's **named-bias** caveat (not ground truth); `environmental` is advisory.

Net: determinism grounds the trivially-clear cases and feeds a prior; the semantic taxonomy — especially the assertion-vs-proxy-absence call the feature path lives on — is the adjudicator's judgment, honestly labeled.

## 4. Green-on-HEAD adjudication (per check)

For each `ac_check` with coarse `green` (passed on clean HEAD), the adjudicator returns, **per check**:
- **vacuous** — trivially passes / doesn't test the AC ⇒ **scoped re-author loopback** for its AC (§2), bounded by escalate.
- **already-satisfied** — genuinely met by existing code ⇒ record a per-check `satisfied` disposition (§6).
- **not-expressible** — qualitative AC with no natural red state ⇒ record a per-check `not-expressible` disposition; routed to human review (M6 surfaces). **Never folded into satisfied.**

## 5. The adjudicator — one dispatch, judgment from the trace (not re-run)

- **One shared M3 adjudicator dispatch** handles all judgment: the semantic `red_class` for ambiguous reds (§3) **and** the green-on-HEAD per-check disposition (§4). Dispatched only when ≥1 check is ambiguous-red or green (all-clean-assertion tickets — after the prior settles them — skip the agent).
- **Capability-isolated, judgment-only:** `Read/Grep/Glob` + the AC + the check + the recorded RED-first trace. **No Bash — it does NOT re-run** (execution/ground-truth already happened in `checks:dispatch`; the adjudicator *interprets* the trace). Its output is judgment (a labeled bias for absence, a disposition for green), never re-derived ground truth. Distinct from M5's post-implement arbiter.
- **Structured output (zod sidecar), per-check + fault-isolated:** per check `{ ac_check_id, class, reason }`, `class ∈ {assertion, absence, environmental, vacuous, already-satisfied, not-expressible}`. To avoid one malformed element re-running the whole batch (and re-labeling good judgments — nondeterministic churn), a malformed/absent per-check result re-dispatches **only the affected checks**, not the batch (plan-time: batching granularity).

## 6. What M3 records

- **`ac_check.red_class` — write-once at first-classify.** It is a **clean-HEAD historical fact** (why this check was red before implement) — exactly what M4 needs to grade a green-after, and it is **not** made stale by implement changing the code. M5's post-implement verdict is a **separate field**, never an overwrite of `red_class`. (M1 column exists; M3 adds the first writer.)
- **Per-check green disposition** (`satisfied` / `not-expressible`) — **net-new schema**. Because the substrate allows **multiple checks per AC**, the disposition is **per check** (on `ac_check`), not per AC. An **AC is `assessed-satisfied` only when *every* one of its checks is adjudicated satisfied** (a rollup, no mixed state) — this is what M6 projects. Storage mechanism (a per-check disposition column on `ac_check` vs a disposition signal) is plan-time; the decision is that M3 stores its adjudication outcome per check with linked **evidence** (the adjudicator's reason + trace), and M6 reduces to reading+projecting it.
- **Schema-comment migration:** the disposition storage moves earlier than the M1 decomposition planned (`schema.sql:401` and the M1 plan say "M6"). The plan updates those notes (both `schema.sql` copies) to reflect M3 owning storage, M6 owning projection.

## 7. Postcondition, resume, terminal, non-gating

- **Postcondition (per check, not per AC):** **every `ac_check` is resolved** — a non-NULL `red_class`, OR a green disposition (satisfied / not-expressible), OR it triggered a re-author. An AC-level `assessed-satisfied` does **not** discharge a sibling live `assertion-red` check (fixes the mixed-AC masking).
- **Resume:** `checks:classify` **recomputes all checks in one transaction** (the deterministic prior is idempotent, but the adjudicator is nondeterministic — a partial write must not leave mixed-vintage labels). Matches M2b's resume discipline.
- **Terminal — escalate-on-repeat, now sound.** Because the re-author is **scoped**, a stuck AC produces a **repeated, AC-keyed vacuous finding** across re-authors (same AC, same "green on HEAD" finding, even though the check text differs) → escalate-on-repeat trips reliably. (Whole-ticket re-author was what made signatures textually-different and defeated escalate per overall §2.5; scoping removes that.) The re-author finding signature is keyed on **(ac_id, "vacuous")**, compared against history, not on the check text.
- **Non-gating:** records `red_class` + dispositions; nothing blocks a merge on this yet (M4).

## 8. Explicitly NOT in M3

The verify-gate rework / advisory-demote (M4) · the code/check/environmental arbiter on persistent-red-after-implement (M5, writes its own field) · the MERGE projection of dispositions (M6) · any feature flag.

## 9. Named risks

- **The false-green is still unclosed (overall §5.1).** M3 classifies the *RED-first-on-clean-HEAD* outcome; it does not re-run post-implement, so a check that greens on the *wrong* behavior after implement is invisible here. M3 does not claim to close it — and the §3 reframe specifically *stops M3 from mislabeling those absences as ground-truth `assertion`*.
- **absence-vs-environmental is judgment with a blind spot (H-A / §5.3), sharper than named.** The adjudicator judges from the trace + static repo — it **cannot probe runtime env state**. A provision-gap error (`ModuleNotFoundError: redis`, where `redis` is listed in `requirements.txt` but not installed) is indistinguishable by Grep from a real dependency — likely mis-called `absence` when it's `environmental`. This is the label M4 *inverts* on (absence → expect a green-after; environmental → demote), so a systematic mis-call could make M4 chase an unsatisfiable target. Mitigation: advisory-until-M4, the deterministic prior catching the clean own-symbol cases, evidence recorded — **not eliminated**; a runtime env-probe is deferred.
- **Adjudicator self-report (bounded).** Independent of the author, judges from the runner's trace. The green-on-HEAD `already-satisfied` call is the softest (can bless a vacuous check as satisfied → a scope-drop) — its `assessed-satisfied` disposition is a **postcondition-satisfier**, so the no-silent-scope-deferral guarantee now rests entirely on **M6 faithfully forcing the disposition onto the MERGE surface** (M6-surfacing is load-bearing, non-optional). Evidence recorded; not eliminated.
- **errors-to-green misroute (NEW).** A check that swallows an exception / warns-but-passes exits 0 → coarse `green` → green-on-HEAD adjudication, never `environmental`. If the adjudicator calls such an env-masked green `already-satisfied`, it's a false-satisfied scope-drop. Flagged for the adjudicator prompt (treat a suspiciously-empty green with skepticism) + M6 surfacing.
- **Prior fragility (much reduced by the persisted exit code).** The exit code carries most of the errored-vs-assertion split; the only residual text-matching is the own-new-symbol `ImportError` shortcut. A miss there degrades to "adjudicator decides" (the prior is never an override), not a silent mislabel.

## 10. Next

`superpowers:writing-plans` for the M3 plan (after re-review), then subagent-driven execution. Likely task shape: (0) **the M2b adjustment** — persist `{exit_code, framework, command}` in the RED-first signal `detail_json` (`runCheckForRed` returns the exit code; handler records it) — amended into #63; (1) the deterministic prior (reads the persisted `exit_code`+`framework`; light rawOutput matching only for the own-new-symbol absence shortcut, pure); (2) the per-check disposition schema + repo (`red_class` writer + disposition) + the schema-comment migration (both copies); (3) the adjudicator prompt + zod contract + tier/allowlist (no Bash); (4) the `checks:classify` handler (prior → adjudicator dispatch → record red_class + dispositions, recompute-all-in-txn → emit scoped re-author loopback / postcondition); (5) the loopback wiring (`VERDICT_BEARING_STEPS` + verdict fn + `checks` loop label + `isRepeated` variant + `checksFeedback`) **and** the M2b `checks:dispatch` scoped-re-author branch; (6) the resolver insert + affected-test updates.
