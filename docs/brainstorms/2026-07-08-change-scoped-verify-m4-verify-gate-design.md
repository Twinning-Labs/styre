# Change-scoped verify M4 — the verify-gate rework (gate on the AC-check flip)

**Status:** Design (brainstorm output) — **v2, revised after two independent reviews** (code-grounded feasibility + adversarial soundness, 2026-07-08). Core shape approved by the operator through a live design dialogue; v2 folds the review findings — the **Critical check-file-integrity gate** (implement can otherwise rewrite the check it's gated by), the **M4-gate-must-co-release-with-M5** constraint, the honest false-green framing, the weak-reason escalate signature, the NULL/NULL gate assertion, and the net-new-harness reframing. Pending written-spec re-review. On branch `feat/change-scoped-verify-m4` (based on the M3 tip; rebases onto `main` after M3/PR #64 merges).
**Date:** 2026-07-08
**Scope:** M4 — the **first *gating* milestone**. M3's graded `red_class` drives **what blocks a merge**: `verify:check` is reworked so the **AC-checks are the hard gate** (assertion-red + absence-red must flip green after implement) and the **whole component suite + build become an advisory sweep**. M4 also wires the **implement-sees-checks seam**, the **check-strengthening**, and — critically — the **check-file integrity gate** without which the whole gate is bypassable.

**Builds on:** overall v2 (§2.4 gate-on-AC-checks/advisory-demote = a bias trade; §2.5 implement-sees-checks; §5 the false-green hole) · M2b (`runCheckForRed`/`buildCheckSelector`/`binaryFor` reused; the `checks:dispatch` prompt strengthened here; the RED-first signal carries `branch_head_sha` = the authoring sha) · M3/PR #64 (`ac_check.red_class` write-once clean-HEAD fact; the adjudicator strengthened here; the `checks:classify → checks:dispatch` loopback + escalate). `CLAUDE.md`: ground truth over self-report; loop-not-halt; over-verify-never-under-verify; capability isolation.

**Release/inertness + the M5 co-release constraint.** The feature is dark until a release cut after **all** Mx (operator doesn't run from `main`; no flag). **M4's gate MUST co-release with M5** (see §8): M4 alone false-*blocks* a correct ticket on a wrong-shape check; M5's arbiter is the fix. This is a *hard co-release constraint*, not a mere assumption — M4's gate must never ship in a release without M5's arbiter.

---

## 1. What M4 delivers (and defers)

**Delivers:**
- **The implement-sees-checks seam** (§2) — implement is told the authored AC-checks so it codes to make them pass.
- **The check-file integrity gate** (§2b) — the AC-check files are frozen after authoring; implement modifying one is a gate fail. *Without this, the whole gate is defeatable by implement rewriting its own check.*
- **`verify:check` reworked in place** (§3) — AC-checks = hard gate; suite + build = advisory sweep.
- **The graded gate on the post-implement flip** (§4) — re-run the AC-checks; assertion + absence must be green, else bounded loopback + escalate; environmental → advisory; a NULL/NULL row = loud error.
- **The check-strengthening** (§5) — behavioral-assertion requirement + the M3 adjudicator's **weak** flag (a code-read) → re-author.

**Defers:** M5 (the code/check/environmental arbiter that reroutes a *persistent* red to *re-author the check* instead of thrashing implement — the fix for the wrong-shape false-block; **co-releases with M4**, §8) · M6 (project the dispositions + advisory-sweep failures to the MERGE gate).

---

## 2. The implement-sees-checks seam

Implement never saw the authored checks (deferred §2.5), so it never made them green — without the seam the gate blocks every time.
- Implement's dispatch gets the ticket's AC-check `test_path`s + a "these encode the acceptance criteria; make them pass — do NOT edit the check files themselves" instruction (a new implement prompt-var, mirroring the `implementFeedback`/`{{feedback}}` carrier). The files are already in the worktree (runner-committed), so implement Reads + codes against them (TDD).
- **This seam makes check-file tampering *acute*** (it points implement at the files it can Write/Edit) — which is exactly why §2b is mandatory, not optional.

## 2b. The check-file integrity gate (Critical — the gate is worthless without it)

**Threat:** `implement:dispatch` has `Write/Edit/Bash` on the worktree; the AC-check files live there; implement can rewrite a strong check into `def test(): pass` or weaken its assertion, and the §4 re-run reads coarse-green → **gate passes, feature never built.** This is the *author of the code grading its own checks* — the CLAUDE.md self-report bug class the feature exists to kill. §5's strong-check requirement does NOT close it (a strong check *rewritten* into a stub is indistinguishable at re-run).

**Fix (mechanically cheap on the existing substrate):** before the §4 re-run, for each `ac_check`, verify its `test_path` content at verify-HEAD is **byte-identical to its content at the `checks:dispatch` authoring sha**. The authoring sha is already persisted (`branch_head_sha` on the `ac-check-red-first` signal, reachable via M3's `signalForAcCheck(acCheckId)`); `fileContentAt(sha, path, worktree)` reads both versions. Any difference (implement touched the check) ⇒ **gate fail** (block/loopback — implement must not edit the check), not a pass. Check files are added-only new files (§5.1 identity), so freezing the whole `test_path` is clean — legitimate helpers/fixtures implement adds live in *other* files. *(A per-`ac_check` `authoring_sha` column is a cleaner alternative to reading the signal; plan-time. Either way the sha is available today.)*

## 3. `verify:check` reworked in place (AC-checks gate; suite+build advisory)

Today `verify:check` (handler ~`handlers.ts:872-1134`, the real-command run loop ~`:1030-1042`) hard-gates on each component's **whole test command** (a non-pass throws → the `verify:check → implement` loopback, `failure-policy.ts:104-144`), entangled with `realImpacted`/behavioral-A1 (`:1048-1071`). M4 reworks it — a **substantial untangle**, not a reframe:
- **Hard gate = the AC-checks' post-implement flip** (§4) + the integrity gate (§2b). The *only* things that block.
- **Advisory sweep = the component suite + build** (incl. Option B's typecheck): run it, record for review, **never block**. (The advisory concept already exists at `:1074-1120` — M4 makes it the *only* fate of the whole-suite result.)
- No separate typecheck gate: a compile break on a check's path makes that check **error** (not green) → §4 blocks it (the write-once class means error≠green≠gate-pass — a real strength of the design). A compile break *elsewhere* with no AC-check on its path is the named collateral trade (§7).

## 4. The graded gate on the post-implement flip

At verify (after the integrity gate §2b passes), M4 re-runs each `ac_check` on the implemented HEAD. This is a **net-new re-run harness** (not a one-line reuse): per check it re-derives the component (`impactedComponents([test_path])`), framework (`frameworkFor`), and **interpreter/cwd pinned to the authoring run's resolution** (else an implement-created venv could error/pass for an env reason unrelated to the AC), runs the stored `selector` via `runCheckForRed`, and reads the coarse verdict. (Reuse: `runCheckForRed`/`interpretRunOutput`. Net-new: the harness + a separate post-implement result field/signal.)

Gate by the check's **frozen M3 `red_class`** (write-once clean-HEAD fact — the correct basis: it encodes *why the check was red before implement*, which is what "what does green-after mean" needs; not staled by implement):
- **`assertion` → must be green** (ground truth). Else gate fail.
- **`absence` → must be green** (with §5, a behavioral gate). Not green ⇒ the surface still isn't produced correctly ⇒ gate fail.
- **`environmental` → advisory** (a can't-run; don't chase). Report, don't block.
- **`satisfied` / `not-expressible` dispositions → don't gate** (M6 surfaces).
- **NULL `red_class` AND NULL `disposition` → LOUD ERROR, not fall-through.** M3's postcondition says this can't exist, but a crash/in-flight re-author could leave one; M4 must **assert** it (an unresolved check silently not-gating is under-verification, forbidden).

**Gate fail → bounded loopback to implement** (reuse `failure-policy.ts` `loop:"implement"`), carrying which checks are still red, bounded by escalate-on-repeat. The post-implement result is a **separate field/signal** (a new `ground_truth_signal` `signal_type` keyed by `branch_head_sha`, or a column) — distinct from `red_class`; M5 writes its own verdict too (no clobbering).

## 5. Check-strengthening (the false-green mitigation — narrowed, not closed)

A *surface-only* check (`assert status==201`) false-greens on a `201 {}` stub. Two layers:
- **Prompt (primary):** `prompts/checks.md` *requires* asserting the AC's **observable output** (returned data shape, persisted value, side-effect); *forbids* status/existence-only checks.
- **Adjudicator (a CODE-read, so it works on the absence path):** the M3 adjudicator additionally reads each check's **assertion content** (Read/Grep the check file) and flags a surface-only check **weak**. Because it reads the check *code* (not just the clean-HEAD trace), it discriminates weak-vs-strong even for a new-surface absence-red check (whose trace is just a 404). A weak check → **re-author** (a new re-author *reason*).

**Honest limit (headline demoted from "closes"):** this **closes the surface-only false-green** (the code-read catches a status-only check). It does **not** fully close the tail: the author's assertion is a **plan-blind guess of the output shape**, so a check that asserts a value a stub happens to satisfy still false-greens (rare if it asserts a specific value), and a **wrong-shape** guess false-*blocks* a correct implement (§7 → M5). So: *the dominant `201 {}` case is closed; the shape-guess tail is narrowed, not eliminated.* No wild-side oracle (the bench's `PASS_TO_PASS`, deliberately excluded) can close it fully.

**"weak" mechanics (net-new red-bucket logic, NOT a clean fold into vacuous):**
- `vacuous` is a **green**-bucket disposition; `weak` is a judgment on a **red** (absence/assertion) check — the opposite coarse bucket. The class↔coarse validation invariant (a red check ∈ {assertion,absence,environmental}) must be amended to admit the transient `weak` outcome.
- `weak` is **transient — never persisted** (the `red_class`/`disposition` CHECK constraints don't admit it); it maps to a re-author, like vacuous.
- **The escalate bound must be preserved:** M3's re-author signature is currently `(ac_ids, "vacuous")` (`checks-verdict.ts`, hard-filtered `class!=="vacuous"`). M4 must extend the collector + signature to `(ac_id, reason)` with `reason ∈ {vacuous, weak}` — else a persistently-weak check (vague AC → author keeps writing weak) re-authors **forever**, the signature never repeats, escalate never trips → budget burn. This preserves M3 §7's monotone-shrinking termination for the new reason.

## 6. Non-gating → gating

M4 is the first milestone where the AC-check verdict **blocks** — but only the *narrow, attributable* block (an AC-check the change is responsible for didn't reach green), never the whole-suite/pre-existing-red block. The advisory sweep preserves visibility without the false-block.

## 7. Named risks (honest)

- **Collateral-breakage trade (overall §5.1, unchanged).** Green your AC-checks, break 50 unrelated tests → **passes** the gate. A trade (delete the whole-suite regression catch to kill the false-block). **The advisory sweep is non-blocking at *every automated stage* (verify AND review) — regression safety rests entirely on the MERGE human + real CI until the deferred regression-guard ships.** M6 projects the sweep to the MERGE human; until then it's write-only. Stated plainly, not hidden.
- **False-green residual (§5).** Surface-only closed; the plan-blind shape-guess tail is narrowed, not zero.
- **Wrong-shape check false-blocks a correct implement.** A check asserting the wrong shape stays red post-implement → loopback → implement can't satisfy it → escalate → correct ticket **blocked** (fails *closed* to a human — survivable, not a wrong merge, but strands the ticket + burns budget). M4 has **no catch** (the weak-flag catches surface-*only*, not wrong-*shape*). **M5's arbiter** reroutes this to *re-author the check*; hence the §8 co-release constraint.
- **Check-file tampering** — closed by §2b (the integrity gate).
- **`verify:check` rework blast radius** — untangling the hard gate from `realImpacted`/behavioral-A1 + rewriting the affected verify tests is substantial.

## 8. M5 co-release constraint (hard)

M4's gate false-blocks a correct ticket whenever a check's plan-blind shape-guess is wrong (§7). M5's arbiter is the fix (it routes a persistent post-implement red to *re-author the check* rather than thrash implement). Under the release-inertness model the feature ships only after all Mx, so M5 co-ships — **but "no flag" means nothing structurally stops a release with M4's gate live and M5 absent.** Therefore: **M4's gate MUST NOT be released before M5.** State it as a hard co-release constraint in the release checklist. *(If the operator later wants a structural guard rather than a documented constraint, a config default-off on the M4 gate is the fallback — but the release-inertness model already implies co-release; this doc makes it explicit.)*

## 9. Explicitly NOT in M4

M5 (the arbiter; co-releases) · M6 (MERGE projection of dispositions + advisory-sweep). Both consume M4's outputs (the post-implement result + dispositions) without a rework.

## 10. Next

`superpowers:writing-plans` for the M4 plan (after re-review), then subagent-driven execution. Task shape: (1) strengthen `prompts/checks.md` (behavioral-assertion requirement); (2) the adjudicator `weak` flag — enum + prompt + the class↔coarse validation amendment + the `(ac_id, reason)` escalate-signature extension in `checks-verdict.ts` (preserve termination); (3) the implement seam (prompt-var + authored-check paths + "don't edit the checks"); (4) **the check-file integrity gate** (persist/read the authoring sha; `fileContentAt` byte-compare → gate fail on any change); (5) the post-implement re-run harness + the separate result field; (6) the `verify:check` rework — AC-checks = graded gate (+ the NULL/NULL assertion), suite+build = advisory sweep, the loopback on gate-fail; (7) the M5 co-release note in the release checklist; (8) the affected verify/loop tests.
