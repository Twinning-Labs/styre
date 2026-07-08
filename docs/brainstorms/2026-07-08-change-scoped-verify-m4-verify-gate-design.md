# Change-scoped verify M4 — the verify-gate rework (gate on the AC-check flip)

**Status:** Design (brainstorm output) — **v2, revised after two independent reviews** (code-grounded feasibility + adversarial soundness, 2026-07-08). Core shape approved by the operator through a live design dialogue; v2 folds the review findings — the **Critical check-file-integrity gate** (implement can otherwise rewrite the check it's gated by), the **M4-gate-must-co-release-with-M5** constraint, the honest false-green framing, the weak-reason escalate signature, the NULL/NULL gate assertion, and the net-new-harness reframing. Pending written-spec re-review. On branch `feat/change-scoped-verify-m4` (based on the M3 tip; rebases onto `main` after M3/PR #64 merges).
**Date:** 2026-07-08
**Scope:** M4 — the **first *gating* milestone**. M3's graded `red_class` drives **what blocks a merge**: `verify:check` is reworked so the **AC-checks are the hard gate** (assertion-red + absence-red must flip green after implement) and the **whole component suite + build become an advisory sweep**. M4 also wires the **implement-sees-checks seam**, the **check-strengthening**, and — critically — the **check-file integrity gate** without which the whole gate is bypassable.

**Builds on:** overall v2 (§2.4 gate-on-AC-checks/advisory-demote = a bias trade; §2.5 implement-sees-checks; §5 the false-green hole) · M2b (`runCheckForRed`/`buildCheckSelector`/`binaryFor` reused; the `checks:dispatch` prompt strengthened here; the RED-first signal carries `branch_head_sha` = the authoring sha) · M3/PR #64 (`ac_check.red_class` write-once clean-HEAD fact; the adjudicator strengthened here; the `checks:classify → checks:dispatch` loopback + escalate). `CLAUDE.md`: ground truth over self-report; loop-not-halt; over-verify-never-under-verify; capability isolation.

**Release/inertness + the M5 co-release constraint.** The feature is dark until a release cut after **all** Mx (operator doesn't run from `main`; no flag). **The operator has committed to not releasing until M6 is done** (stated 2026-07-08) — so M4's gate, M5's arbiter, and M6's projection **all co-ship by construction**. This converts the adversarial review's "unenforced release invariant" concern into an *enforced operator commitment*: M4's gate never reaches a user without M5's arbiter (and M6's MERGE projection) alongside it. §8 keeps the constraint recorded; the M5 requirements it depends on are carried in the appendix (§11) so they're not lost between now and building M5.

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

**Fix (mechanically cheap on the existing substrate):** before the §4 re-run, for each `ac_check`, verify its `test_path` content at verify-HEAD is **byte-identical to its content at the `checks:dispatch` authoring sha**. The authoring sha is already persisted (`branch_head_sha` on the `ac-check-red-first` signal, reachable via M3's `signalForAcCheck(acCheckId)`); `fileContentAt(sha, path, worktree)` reads both versions. Any difference (implement touched the check) ⇒ **gate fail** (block/loopback — implement must not edit the check), not a pass. Check files are added-only new files (**M2 §5.1** identity), so freezing the whole `test_path` is clean — it won't false-block, because implement never legitimately edits a check (it *conforms code* to the check per §2.5; a genuinely-buggy check is re-authored by M5, not edited by implement).

**Scope of the freeze — direct rewrite only (see §7 for the residual).** This closes the *direct* rewrite of a `test_path`. It does NOT by itself close **transitive tamper** — implement weakening a frozen check via a sibling `conftest.py` autouse fixture or an edited shared helper it imports (§7 works the exploit). Plan-time hardening extends the freeze to any `conftest.py` in the checks' own directory chain (closing the dominant autouse vector); the arbitrary-import residual is bounded by MERGE review, named in §7. *(A per-`ac_check` `authoring_sha` column is a cleaner alternative to reading the signal; plan-time.)*

## 3. `verify:check` reworked in place (AC-checks gate; suite+build advisory)

Today `verify:check` (handler ~`handlers.ts:872-1134`, the real-command run loop ~`:1030-1042`) hard-gates on each component's **whole test command** (a non-pass throws → the `verify:check → implement` loopback, `failure-policy.ts:104-144`), entangled with `realImpacted`/behavioral-A1 (`:1048-1071`). M4 reworks it — a **substantial untangle**, not a reframe:
- **Hard gate = the AC-checks' post-implement flip** (§4) + the integrity gate (§2b). The *only* things that block.
- **Advisory sweep = the component suite + build** (incl. Option B's typecheck): run it, record for review, **never block**. (The advisory concept already exists at `:1074-1120` — M4 makes it the *only* fate of the whole-suite result.)
- No separate typecheck gate: a compile break on a check's path makes that check **error** (not green) → §4 blocks it (the write-once class means error≠green≠gate-pass — a real strength of the design). A compile break *elsewhere* with no AC-check on its path is the named collateral trade (§7).

## 4. The graded gate on the post-implement flip

At verify (after the integrity gate §2b passes), M4 re-runs each `ac_check` on the implemented HEAD. This is a **net-new re-run harness** (not a one-line reuse): per check it re-derives the component (`impactedComponents([test_path])`), framework (`frameworkFor`), and interpreter/cwd, runs the stored `selector` via `runCheckForRed`, and reads the coarse verdict. **Env: re-run against the *implemented* HEAD's provisioning** (re-provision if the manifest changed since authoring — implement legitimately *adds* dependencies, e.g. an "add Redis caching" AC whose check does `import redis`; re-running in the frozen pre-implement env would `ModuleNotFoundError` → a spurious hard gate-fail on the frozen `assertion`/`absence` class). This does *not* reopen env-gaming: the check is behavioral (§5), and no dependency install can *fake* an asserted value — an env change that breaks the check is a real gate-fail, one that satisfies it is a real pass. (Reuse: `runCheckForRed`/`interpretRunOutput`. Net-new: the harness + a separate post-implement result field/signal.)

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
- `vacuous` is a **green**-bucket disposition; `weak` is a judgment on a **red** (absence/assertion) check — the opposite coarse bucket. The amendment to admit `weak` is to the **adjudicator's transient zod-output enum ONLY** (the handler's class↔coarse acceptance of the agent's reply). It is **NOT** a loosening of any DB constraint.
- `weak` is **transient — never persisted.** The persisted `red_class`/`disposition` CHECK constraints (`schema.sql`) must continue to **reject** `weak`; a `weak` verdict maps to a re-author (like vacuous), leaving `red_class` as the check's clean-HEAD class once re-authored.
- **The escalate bound must be preserved — and the two halves pull in OPPOSITE directions (second-round review caught this).** M3's collector hard-filters `class!=="vacuous"` and keys the signature on the AC-id set (`checks-verdict.ts`). For `weak`:
  - **Collector — reason-INCLUSIVE.** The current-round re-author collector MUST count `weak` as well as `vacuous` (else a weak-only AC is never in the set → never escalates at all). Necessary.
  - **Signature — reason-AGNOSTIC (the sorted AC-id set ALONE — do NOT add `reason`).** `isRepeatedChecksLoopback` is a *predecessor-only* compare. Keying the signature on `reason` would let a single AC oscillate `vacuous→weak→vacuous` forever — each round's signature differs from its immediate predecessor → escalate never trips → 200-tick budget burn ending in a dirty `"no-progress"`, not a clean `blocked`. Reason-keying can *only* loosen the repeat-detect; there is no case it helps. So a stuck AC repeats its `(ac_ids)` signature whether it's stuck-vacuous, stuck-weak, or oscillating → escalate trips. This is the exact monotone-termination M3 §7 established; keying on reason would *regress* it.

## 6. Non-gating → gating

M4 is the first milestone where the AC-check verdict **blocks** — but only the *narrow, attributable* block (an AC-check the change is responsible for didn't reach green), never the whole-suite/pre-existing-red block. The advisory sweep preserves visibility without the false-block.

## 7. Named risks (honest)

- **Collateral-breakage trade (overall §5 hole #5 / §2.4, unchanged).** Green your AC-checks, break 50 unrelated tests → **passes** the gate. A trade (delete the whole-suite regression catch to kill the false-block). **The advisory sweep is non-blocking at *every automated stage* (verify AND review) — regression safety rests entirely on the MERGE human + real CI until the deferred regression-guard ships.** M6 projects the sweep to the MERGE human; until then it's write-only. Stated plainly, not hidden.
- **False-green residual (§5).** Surface-only closed; the plan-blind shape-guess tail is narrowed, not zero.
- **Wrong-shape check false-blocks a correct implement.** A check asserting the wrong shape stays red post-implement → loopback → implement can't satisfy it → escalate → correct ticket **blocked** (fails *closed* to a human — survivable, not a wrong merge, but strands the ticket + burns budget). M4 has **no catch** (the weak-flag catches surface-*only*, not wrong-*shape*). **M5's arbiter** reroutes this to *re-author the check*; hence the §8 co-release constraint.
- **Check-file tampering — direct rewrite closed by §2b; transitive tamper is a NAMED RESIDUAL (not closed).** §2b freezes each check *file* byte-identical to its authoring sha, closing the direct-rewrite case. It does **not** close *transitive* tamper: implement (Write/Edit/Bash) can weaken a frozen check **without touching `test_path`** — an added autouse `conftest.py` in the checks' directory that `monkeypatch`es the target, or an edited shared `assert_*` helper the check imports. The frozen check then stubs-green → gate passes → feature unbuilt. This punches the *ground-truth* (assertion) tier, worse than the already-hedged absence false-green, and nothing automated catches it (the malicious `conftest`/helper is committed, so it greens the advisory sweep + real CI too — only a MERGE human reading the diff notices). **Plan-time hardening (closes the dominant vector):** extend the §2b freeze to any `conftest.py` in the checks' own directory chain (the checks live in a dedicated dir per M2 §5.1, so freezing its `conftest` won't false-block implement's own fixtures elsewhere). **Residual after that:** an arbitrary shared-helper import the check pulls from outside the checks dir — bounded by MERGE review, not closed (no silent deferral: named here).
- **`verify:check` rework blast radius** — untangling the hard gate from `realImpacted`/behavioral-A1 + rewriting the affected verify tests is substantial.

## 8. M5 co-release constraint (hard)

M4's gate false-blocks a correct ticket whenever a check's plan-blind shape-guess is wrong (§7). M5's arbiter is the fix (it routes a persistent post-implement red to *re-author the check* rather than thrash implement). The adversarial review flagged that "no flag" left this resting on an unenforced release discipline — **now resolved: the operator has committed to not releasing until M6 is done** (2026-07-08), so M4's gate, M5's arbiter, and M6's projection co-ship by construction. The constraint stands recorded here (M4's gate must not reach a release without M5), satisfied by that commitment; no config guard is needed. The M5 requirements this depends on are carried in §11.

## 9. Explicitly NOT in M4

M5 (the arbiter; co-releases) · M6 (MERGE projection of dispositions + advisory-sweep). Both consume M4's outputs (the post-implement result + dispositions) without a rework.

## 10. Next

`superpowers:writing-plans` for the M4 plan (after re-review), then subagent-driven execution. Task shape: (1) strengthen `prompts/checks.md` (behavioral-assertion requirement); (2) the adjudicator `weak` flag — transient zod-enum value + prompt + the handler's class↔coarse acceptance (NOT the persisted CHECK) + the `checks-verdict.ts` change: collector counts `weak`+`vacuous`, escalate **signature stays the reason-agnostic AC-id set** (§5 — do not add `reason` to the signature); (3) the implement seam (prompt-var + authored-check paths + "don't edit the checks"); (4) **the check-file integrity gate** (persist/read the authoring sha; `fileContentAt` byte-compare `test_path` **and any `conftest.py` in the checks' dir chain** → gate fail on any change); (5) the post-implement re-run harness (re-run in the implemented/re-provisioned env, §4) + the separate result field; (6) the `verify:check` rework — AC-checks = graded gate (+ the NULL/NULL assertion), suite+build = advisory sweep, the loopback on gate-fail; (7) the M5 co-release note in the release checklist; (8) the affected verify/loop tests.

---

## 11. M5 requirements — carried forward (not built in M4)

Captured here (operator asked to carry them, 2026-07-08) so building M5 doesn't re-derive them. M5 is the **arbiter on *persistent* post-implement red** — it fires when M4's gate (§4) stays red after the bounded implement-loopback would otherwise just thrash or escalate. It replaces the plain "retry implement / escalate" with **adjudicated blame** and is the fix for M4's known false-*block* (§7).

**R1 — Three-way blame on a persistent red AC-check** (overall §2.4 arbiter). A capability-isolated dispatch (Read/Grep/Glob, no Bash — judges from the trace + the persistent-red evidence + the repo, never re-runs), one adjudication per still-red gated check, structured zod output:
- **`code-wrong`** — the check is right, implement didn't satisfy it → loopback to implement (M4's current behavior) / escalate on repeat.
- **`check-wrong` (wrong-shape)** — the check asserts the *wrong* shape (the author's plan-blind guess was wrong; a *strong* check asserting a wrong value — distinct from M4's `weak` flag, which is a *structural* surface-only catch; this is *semantic*) → **re-author the check** (scoped, like M3's re-author), NOT thrash implement. **This is the fix for M4 §7's wrong-shape false-block.**
- **`environmental`** — the check can't run for an env/provision reason → advisory / provision fix, don't block.

**R2 — Separate verdict field.** M5 writes its **own** arbiter verdict — NOT `red_class` (M3's write-once clean-HEAD fact) and NOT M4's post-implement result field. Three distinct records: clean-HEAD class (M3) · post-implement flip (M4) · persistent-red blame (M5). No clobbering (schema room already confirmed: a new `ground_truth_signal` `signal_type`, or a column).

**R3 — Termination preserved.** A `check-wrong` re-author must extend the same monotone-shrinking, AC-keyed escalate signature M3 §7 / M4 §5 use — key on `(ac_id, reason)` with `reason` now also admitting the M5 blame reasons — so a persistently-wrong check re-authors a bounded number of times then escalates, never forever. Re-authoring the check un-freezes only that AC's check row (M4 §2b integrity re-freezes at the new authoring sha).

**R4 — Structurally blind to false-*greens* (unchanged, overall §2.3).** M5 adjudicates persistent *red* (blame for a check that won't go green). It does NOT close the false-*green* hole (an absence-red check that stub-greens) — no wild-side oracle exists for that; it stays the named residual (§5/§7). Don't scope M5 to "verify a green is real" — it can't.

**R5 — Consumes M4's outputs, no rework.** Inputs: `red_class` (M3), the post-implement result (M4 §4), the trace (M2b RED-first signal + the M4 re-run), the integrity-gate result (§2b — a check-file-tamper is *code-wrong-adjacent*, not check-wrong; M5 should treat a tampered check as a gate fail, not a re-author). M5 adds no new upstream dependency.

**R6 — Loop placement.** M5 sits on the *persistent-red* branch of M4's `verify:check` gate (after the bounded implement-loopback fails to green a gated check), before the escalate terminal — the arbiter decides code-wrong (keep looping implement) vs check-wrong (re-author) vs environmental (advisory), replacing M4's unconditional escalate-on-repeat with a routed decision. Reuses the M3 loopback/escalate machinery.
