# Change-scoped verify M5 — the persistent-red arbiter (code-wrong / check-wrong blame)

**Status:** Design (brainstorm output) — **v2, revised after two independent reviews** (code-grounded feasibility + adversarial soundness, 2026-07-09). Core shape approved by the operator through a live design dialogue; v2 folds the review findings — the adversarial review found **two Criticals** that both broke M4's "no silent pass" invariant, sharing one root cause: M5 v1 replaced the M2b/M4 **RED-first ground-truth oracle** with an oracle-less agent judgment. v2's throughline: **M5 keeps the RED-first oracle** and **no agent can un-gate a check**. Pending written-spec re-review. On branch `feat/change-scoped-verify-m5` (off merged main = M1+M2a+M2b+M3+M4).
**Date:** 2026-07-09
**Scope:** M5 — the **arbiter on a check that stays red after implement**. M4 made the AC-checks the hard gate but its response to a still-red assertion/absence check is a blind loopback-to-implement + escalate-on-repeat — which burns the whole implement budget then blocks a *correct* ticket whenever the check's plan-blind shape-guess was wrong (M4 §7). M5 replaces that blind response with an **adjudicated blame decision per still-red check: code-wrong (loop implement) / check-wrong (re-author the check, AC-driven + RED-first-validated)** — and retires M4's oscillation-prone predecessor-signature escalate in favour of a monotone gate-round counter.

**Key v2 changes from v1 (the review folds):**
- **Two-way blame, not three.** The `environmental` route is **dropped** (operator decision) — it was a silent-pass hole (an agent re-deciding a *frozen* clean-HEAD fact post-implement could demote a genuinely broken feature to advisory and merge it). A gated check that ERRORS post-implement is **code-wrong**, never advisory (§3).
- **Every check-wrong re-author is RED-first-validated against the frozen clean-HEAD sha** (§5) — restoring the M2b oracle that v1 wrongly claimed "doesn't apply post-implement."
- **check-wrong requires a *positive* AC-contradiction** (§4) — when the AC is silent on the disputed detail, the arbiter must NOT route check-wrong (which would conform the check to the code); it defaults to code-wrong → escalate.

**Requirements carried from M4 §11 (R1–R6):** three-way→**two-way** blame (R1, revised), separate verdict record (R2), termination via a counter (R3), structurally blind to false-greens (R4), consumes M4 outputs (R5), placement on the gate-fail branch (R6).

**Release / co-release (unchanged):** dark until a release after all Mx; operator committed to not releasing until M6; M5 co-ships with M4's gate.

`CLAUDE.md` load-bearing: **ground truth over self-report** (verdicts from build/tests, never agent self-scoring) — *this is the invariant v1 violated and v2 restores*; current state in the SoT table, the signal log is audit-only (the M4 lesson); loop-not-halt; capability isolation; structured (zod) agent output.

---

## 1. What M5 delivers (and defers)

**Delivers:**
- **A new arbiter dispatch step** (`checks:arbitrate`) served on the gate-fail branch, per round (§2). Capability-isolated (Read/Grep/Glob, **no Bash**, never re-runs), zod output.
- **Two-way blame per behavioral still-red check** (§3): **code-wrong** → loopback to implement; **check-wrong** → re-author the check (§4–5). No environmental route.
- **The check-wrong re-author pipeline** (§5): author from the AC (code-blind, fresh dispatch) → **RED-first-validate on the frozen clean-HEAD sha** → classify → install (supersede + integrity re-freeze) → re-run at the gate.
- **A monotone per-ticket gate-round counter** (§6) bounding both routes → escalate at the cap; retires M4's predecessor-signature compare.
- **A separate blame verdict record** (§7).

**Defers:** M6 (project the dispositions + advisory sweep + the blame record to the MERGE human gate).

## 2. When/where the arbiter fires — routes each round; integrity split out first

M4's gate: `verify:checks-gate` runs the integrity gate + the post-implement re-run, records an `ac-check-gate` signal with `detail:{ stillRed, tampered, advisory }` (integrity violations vs behavioral still-red are ALREADY recorded separately — `handlers.ts:1259`); `applyAcCheckGateVerdict` (onSucceed) does blind loopback + signature-escalate.

M5 restructures the **fail** branch, each round:
1. **Split first (integrity is never arbitrated).** The `tampered` set is a **hard fail** — implement must not be able to force a re-author by tampering (R5). Only the **behavioral** still-red set (`stillRed \ tampered`) is arbitrated. If the behavioral set is empty (fail was integrity-only), the arbiter is a **no-op** → the tampered checks route straight to loopback/escalate as M4 does.
2. **Serve the arbiter.** When behavioral still-red is non-empty, the resolver serves **`checks:arbitrate`** (a new agent dispatch), which reads each behavioral still-red check + its post-implement trace + its AC text and emits a blame per check.
3. **The gate verdict routes on the persisted blame** (§4). *(Feasibility note: this is a RESTRUCTURE, not a drop-in. Today the verdict fires the loopback synchronously in `onSucceed`; M5 must defer that and add a "gate=fail-with-behavioral-still-red → serve arbiter" arm to the resolver `case "verify"`. `applyAcCheckGateVerdict` is rewritten, not extended.)*

## 3. Two-way blame + the adjudicator

Per **behavioral** still-red check, the arbiter (capability-isolated; judges from the AC text + the check source + the recorded post-implement trace + the repo; **never re-runs**) emits one of:
- **`code-wrong`** — the code doesn't satisfy a check that faithfully encodes the AC → **loopback to implement**. **This includes a check that ERRORS post-implement** (import break, 500, collection error): a gated assertion/absence check RAN on clean HEAD (M3 classed it, not environmental), and M4 §4 already re-provisions the implemented HEAD before re-running, so a post-implement error is the *code's* fault, not the env's → code-wrong. *(There is no environmental route — an agent may never demote a frozen-gated check to advisory; that was v1's silent-pass hole.)*
- **`check-wrong`** — the check **positively contradicts the AC** (§4) → **re-author the check** (§5).

zod output `{ ac_check_id, blame ∈ {code-wrong, check-wrong}, reason }`; absent/malformed = transport failure (re-dispatch), not a default. A behavioral still-red check with **no AC text** is a **loud error** (M4 §4 NULL/NULL-adjacent), never an arbiter input.

## 4. check-wrong requires a POSITIVE AC-contradiction (closes the code-as-oracle hole)

The check-wrong route is available **only when the arbiter can establish the check asserts something the AC explicitly rules out** (AC says "201", the check asserts 200; AC says "persists then returns it", the check asserts it's absent). It is NOT "the code and the check disagree," and NOT "the check might be wrong."

**When the AC is silent on the disputed detail** (the AC says "returns the full name" but not the JSON key; the check guessed `name`, the code returns `fullName`), the arbiter **cannot** route check-wrong — because "re-author from the AC" has no content on a detail the AC doesn't specify, so the only reference left would be the code, and conforming the check to the code is the exact code-as-oracle bug the feature exists to delete. So an AC-silent dispute defaults to **code-wrong** → loop implement → (the code can't satisfy a guess the AC doesn't pin down) → the gate-round counter escalates → **a human resolves the underspecified AC.** Fails closed (escalate an ambiguous AC), never a false-green.

## 5. The check-wrong re-author — AC-driven AND RED-first-validated (the oracle)

When the arbiter routes check-wrong, the re-author is a pipeline, not a single agent turn:
1. **Author from the AC — a fresh capability-isolated authoring dispatch** (the M2b `checks:dispatch` author, scoped to this one AC), with **no code and no arbiter reasoning in its context** — so code-blindness is a capability boundary, not a prompt hope. (It must read repo structure to write a runnable check; code-blind means "the code's output is not an input.")
2. **RED-first-validate against the FROZEN clean-HEAD sha** (still in git history; the sha is stored as `branch_head_sha` on the AC's original `ac-check-red-first` signal). Run the new check at that sha — it **must be RED** (the AC's behavior was absent on clean HEAD, so a check that truly tests it fails there). A re-authored check that is **GREEN on clean HEAD is REJECTED** — it is either vacuous (`assert True`, tautology, self-defined fixture) or asserts something already true before the change. This is exactly M2b's RED-first contract, replayed — the anti-vacuity oracle v1 wrongly discarded. (A rejected re-author → retry within the counter; repeated rejection → escalate.)
3. **Classify** the validated check (its `red_class` via the M3 prior/adjudicator).
4. **Install:** `supersedeByAc` the wrong check + insert the new active check; **write its authoring-sha signal** (the new `ac-check-red-first` at the re-author commit sha) so the §2b integrity gate **re-freezes at the new baseline** (the re-freeze is automatic *given this write* — omit it and the integrity gate throws `missing-authoring-sha`).
5. The new check **re-runs at the next gate round**: green post-implement ⇒ the code satisfies the correctly-shaped check ⇒ gate advances; still red ⇒ code-wrong ⇒ loop implement. **The code can never become the oracle** (RED-first rejects a code-conforming/vacuous re-author; §4 keeps check-wrong from firing on AC-silent details).

`red_class` (M3's clean-HEAD fact) belongs to the *new* check's own clean-HEAD classification; the blame is M5's own record (§7).

## 6. The escalate bound — a monotone per-ticket gate-round counter

Two things loop at the gate: **code-wrong** loops implement (no supersede → `reauthorRoundsForAc` doesn't move) and **check-wrong** re-authors (supersede → it does). So the supersede counter alone under-bounds a code-wrong AC implement can never satisfy. M5 bounds **total gate rounds for the ticket** via the **`verify:checks-gate` step's `attempt` count** — feasibility-confirmed monotone: `resetToPending` (used by every loopback path incl. M4's `resetTicketVerifySteps`) never touches `attempt`; only `markRunning` increments it; only the `provision` step is ever `resetAttempt`'d. So the gate step attempt survives both the gate-loopback AND the implement-loopback, is readable in the verdict via `getByKey`, and never reads the append-log.
- **Granularity is per-ticket** (one `verify:checks-gate` row per ticket) — which is the right unit: the gate runs once per round over *all* checks, so its attempt count *is* the gate-round count, and it bounds both routes (each fail round increments it regardless of route). It slightly over-counts (also counts the eventual passing run), escalating marginally early — acceptable for a bound. *(Plan must confirm the implement-loopback path resets the gate step via `resetToPending`, not `resetAttempt`; if a per-AC bound is ever wanted, that needs a dedicated column — not needed now.)*
- **No conflict with `reauthorRoundsForAc`:** that per-AC counter is read only by the *pre-implement* `applyChecksVerdict` (checks:classify), which does not run post-implement. A check-wrong supersede increments it as a side effect, but nothing post-implement reads it for escalate — M5's escalate keys **only** on the gate-round counter.
- Exceed the cap ⇒ **escalate** (`waiting` + `human_resume` — the existing terminal). **Retires M4's `isRepeatedGateLoopback`** predecessor-signature compare (the `{1}→{2}→{1}` oscillation the M4 whole-branch review named — a monotone counter can't be evaded).

## 7. The separate blame verdict record

A new open-vocab `ground_truth_signal` type `ac-check-blame` (the `signal_type` column has no CHECK — additive). It NEVER overwrites `red_class` (M3), `ac-check-post-implement` (M4), or `ac-check-gate` (M4). The `gateFeedback` carrier (already wired into the implement loopback prompt, `feedback.ts:53` / `prompt-vars.ts:126`) is extended to surface the code-wrong blame reason into the re-code feedback. M6 projects the blame to MERGE.

## 8. Structurally blind to false-greens (unchanged, R4)

M5 adjudicates persistent **red**. It does NOT close the false-*green* hole (an absence-red check that stub-greens) — no wild-side oracle exists. The AC-driven + RED-first-validated re-author (§5) keeps M5 from *adding* false-greens (a code-conforming or vacuous re-author is rejected); it doesn't remove the pre-existing residual.

## 9. Named risks / residuals

- **Arbiter mis-blame (bounded, fails closed).** code-wrong vs check-wrong is an agent judgment, but both failure directions fail *closed*: a mis-called check-wrong → the AC-driven RED-first-validated re-author either can't be validated (rejected) or, if valid, stays red against wrong code → flips to code-wrong; a mis-called code-wrong → loops implement until the gate-round counter escalates. Never a wrong *pass*. Bounded by the counter.
- **M5 fixes the false-block only for PRECISE ACs (honesty).** A vague AC → the arbiter can't route check-wrong (§4, no positive contradiction) → code-wrong → loop → escalate. That is M4 §7's false-block *converted from a silent budget-burn to a clean human escalation of an underspecified AC* — safer, but M5 does not magically fix a vague AC; it surfaces it. State plainly.
- **Re-author validity rests on RED-first-replay + §4, not the static weak-flag.** v1 leaned on M4's `weak` flag (an *agent* judgment inline in checks:classify, not deterministic static analysis, and clean-HEAD-coupled). v2's oracle is RED-first-replay on the clean-HEAD sha (ground truth). The weak-flag may still run as a secondary check but is not the guarantee.
- **The gate-fail-path restructure + verdict rewrite** (§2) disturbs the resolver `case "verify"` + the loop/verify tests (like M4's gate insert) — the plan must budget it, plus the arbiter step's tier/allowlist entries + the zero-behavioral-still-red no-op.
- **Clean-HEAD-sha checkout for RED-first-replay** (§5) is net-new machinery (a worktree/checkout at the stored sha to run the re-authored check); the sha is stored + reachable, but the run harness at an arbitrary sha must be built.

## 10. Explicitly NOT in M5

M6 (MERGE projection of dispositions + advisory sweep + the blame record).

## 11. Next

`superpowers:writing-plans` (after re-review), then subagent-driven execution. Likely task shape: (1) the arbiter contract (zod two-way blame + prompt requiring a positive AC-contradiction for check-wrong + tier/allowlist no-Bash); (2) split integrity vs behavioral on the gate-fail branch + the `checks:arbitrate` dispatch handler; (3) the check-wrong re-author pipeline — fresh code-blind authoring dispatch + **RED-first-replay against the stored clean-HEAD sha** + classify + supersede/install + the authoring-sha signal write (integrity re-freeze); (4) the gate-round counter (the `verify:checks-gate` step attempt; confirm it survives the implement-loopback) + rewrite the gate verdict to route on blame + counter-escalate (drop `isRepeatedGateLoopback`); (5) resolver placement + affected loop/verify tests + the no-op; (6) the `ac-check-blame` record + the gateFeedback blame extension.
