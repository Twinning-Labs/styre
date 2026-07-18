# Scope-guard file disposition — declare-or-discard

**Status:** design, pending independent review
**Date:** 2026-07-19
**Type:** bug fix / reliability + altitude correction (unblocks the astropy bench; ends the scope-guard accretion treadmill)
**Companion:** the current-state map is `docs/brainstorms/2026-07-19-checks-file-disposition-model.md` — read it first.
**Follow-up filed:** ENG-342 (drop the ENG-323 support heuristic, staged — see §7).

---

## 1. Problem

Two problems, one root.

**The live failure.** On the SMOKE=2 × (5 darkreader + 5 astropy) batch, 3 astropy runs failed at
`checks:dispatch` because the agent wrote throwaway/debug scripts **loose in the work tree** (not under
`styre_scratch/`). The commit scope guard rejected the whole attempt, the agent re-created the files on
retry, and the ticket exhausted its retry budget and escalated. This happened **even though `checks.md`
already tells the agent to use `styre_scratch/`** — the convention was in the prompt and the agent
ignored it. `__init__.py` support files, by contrast, now pass (ENG-323 works); darkreader ran 5/5.

**The treadmill.** The rule that produced that rejection is a whitelist that has needed one new clause
per legitimate file shape: ENG-296 (canonical check name) → ENG-297 (`styre_checks/` pin) → ENG-300
(`styre_scratch/` sweep) → ENG-323 (co-located support files). Every clause shipped because a real run
hit a shape the whitelist didn't cover. The operator's words: *"we seem to be discovering scenarios
every run… the whole thing has become so complex that I cannot keep it in my head."*

The root of both is one mechanism: **the guard rejects any undeclared brand-new file**, which forces the
agent to pre-sort every file into three buckets (declare / `styre_scratch/` / `styre_checks/`) and
punishes misclassification with reject → loopback → escalate.

## 2. The insight

A stray **new untracked** file is, by construction, never an edit to tracked source. It can always be
safely deleted: it is not committed history, and if it was genuinely needed, the **ground-truth run**
(RED-first check / verify) fails loudly and says so. So there is nothing to protect by *rejecting* it —
we can **discard** it and let the test run be the arbiter of whether it was needed.

An out-of-scope **edit to tracked source** is different: it cannot be silently reverted the same way,
and it is a real "this step touched something it must not" signal. That stays loud.

## 3. Why we are overturning a settled decision (the July-11 reversal)

Reject-not-drop was an **operator-made governing decision** on 2026-07-11
(`docs/brainstorms/2026-07-11-scoped-commit-design.md` §2): steps that commit real work reject-and-retry
on any undeclared new file, because *"a brand-new file the step produces might be genuine deliverable
work; silently excluding it could drop part of a real fix… this never silently drops a legitimate
file."* The 2026-07-15 scratch-drawer brainstorm inherited this and treated it as settled; when the
operator floated discard again there, it was closed by **citation** to §2, not re-argued. That was the
misstep — a second raising was a signal to reopen on the merits.

Re-examined on the merits, §2 gave two reasons to reject discard:

1. *"A genuine unplanned new file would be lost, and verify would only catch it after a wasted loop (or
   wedge)."* This already **concedes ground truth catches it** — the only objection is that catching it
   at commit-time is earlier/louder. That is a cost-benefit claim, and the SMOKE data **inverts** it:
   the case reject protects (a dropped *needed* file) is rare and recoverable one loop later; the case
   reject *causes* (a throwaway file wedging the ticket) is common and terminal. We optimized against
   the rare recoverable failure and bought the common terminal one.
2. *"A negative list lets an un-flagged scratch file slip to review."* This targeted a **different**
   alternative (commit everything except declared scratch). Declare-or-discard is the opposite — commit
   only what's declared/recognized, discard the rest — so nothing un-flagged slips through. The
   objection does not apply.

What changed since July 11: (a) it was a-priori then; we now have **evidence** that reject + three
prevention layers still wedges; (b) declare-or-discard **defeats the word doing all the work in §2 —
"silently"**: every discard emits a telemetry `note`, and a dropped *needed* file becomes a loud
ground-truth failure, so "never *silently* drop a legit file" is still honored; (c) letting the test run
decide what was needed is **ground-truth-over-self-report** (a core CLAUDE.md invariant), which the
declaration heuristic arguably violates.

## 4. The design: one uniform disposition rule

For every write dispatch, over each change **this dispatch produced** (pre-existing untracked cruft is
already excluded via `untrackedBefore`, `run-dispatch.ts:117-123`):

| Change | Outcome | vs today |
|---|---|---|
| **In-scope** — a declared new file (`new_files` / `checksAuthored`), a canonically-named check (ENG-296), a tracked edit the step allows, or a path under the step's own dir | **commit** (by name) | same |
| **Out-of-scope NEW file** — undeclared stray/throwaway | **discard** — delete from the worktree, do not stage, emit a `note` | **was: reject whole attempt → loopback → wedge** |
| **Out-of-scope TRACKED edit** — a step modifying tracked source it must not (only `plan`/`docs` gate this today) | **reject** (loud, diagnosis-only) | same |

Consequence, per step (blast radius = **all five** scope-gated write steps; operator-approved):

| Step | Scope | Under A |
|---|---|---|
| `implement` | tracked edits in scope; new file in scope iff in `new_files` | undeclared new → **discard**; never rejects (subject to §8 flag) |
| `checks:dispatch` + re-author | tracked edits in scope; new file in scope iff declared / canonical / ENG-323 support | undeclared new → **discard**; never rejects |
| `plan` (design) | only paths under `docs/plans/` | out-of-scope new → discard; out-of-scope tracked edit → **reject** |
| `docs:revise` | only paths under `docs/` | out-of-scope new → discard; out-of-scope tracked edit → **reject** |

Net: `implement` and `checks` **stop rejecting on scope grounds** (their only scope offenders were
undeclared new files); the scope-guard rejection survives only for the genuine `plan`/`docs`
tracked-edit violation. (Other throws — transport failure, unresolved prompt vars, RED-first / coverage
postconditions — are unchanged; this design touches only the scope-guard disposition.)

## 5. Mechanism

In `runAgentDispatch` (`src/dispatch/run-dispatch.ts:190-207`), replace the current "any offender →
`undoAttempt` + throw" block with a three-way split of the judged set. **Order matters — the reject
check runs first so we never commit a partial result and then revert it:**

1. **Out-of-scope TRACKED edits** → if any exist, `undoAttempt` + `dispatch-failed` + throw a
   diagnosis-only message (INV-B), committing nothing. This is the only remaining scope-guard throw.
2. Otherwise **out-of-scope NEW files** → delete from the worktree (they are untracked → `git clean -f
   <paths>` / `rmSync` per path) and emit one `appendEvent` `kind:"note"`,
   `reason:"scope-discarded:<handlerKey>"`, `payload:{ discarded }`. Non-gating; mirrors the existing
   `scratch-swept` / `scratch-ignored` note pattern.
3. **In-scope files** → commit by name, exactly as today (`commitWorktree(worktreePath, msg,
   inScopeNewPaths)`; tracked edits stage as before). (Deleting the out-of-scope new files in step 2
   before this commit guarantees they are neither staged nor left on disk.)

Deleting the out-of-scope new files from disk (step 2) is what lets us **remove the `styre_scratch/`
sweep entirely**: nothing undeclared survives the dispatch, so nothing undeclared can reach the broad
verify run — the exact hole `sweepScratch` was built to close (scratch-drawer §2.1). Remove
`sweepScratch` (`src/dispatch/worktree.ts:209-244`) and both call sites (`run-dispatch.ts:173`,
`handlers.ts:1139`). (Pre-existing untracked cruft reaching verify is a separate, pre-existing concern
the sweep never addressed — it only matched `styre_scratch/` — so removing it regresses nothing.)

## 6. INV-A / INV-B

- **INV-A — uniform forward guidance.** Delete the `styre_scratch/` paragraph from `checks.md:40-48`
  and `implement.md:24-28`. Replace with one line every write prompt carries: *"Declare every new file
  that is part of your deliverable in `new_files` (checks: via `checksAuthored`/`new_files`). Any new
  file you don't declare is treated as throwaway and won't be committed — you don't need a special
  folder for scratch."* Simpler than today and honest about what happens. (The agent may still create
  and use scratch files freely *during* the run; they are cleaned up after.)
- **INV-B — diagnosis-only feedback.** The surviving rejection (out-of-scope tracked edit) carries a
  pure diagnosis: *"this step may only modify files under `<dir>`; you edited tracked files outside that
  scope: <paths>."* No instructions, no scratch lore, no "declare or delete." Discards do **not** feed
  back to the agent as an instruction — they are a telemetry `note` only; a discarded-but-needed file is
  recovered via the next step's ground-truth failure, which is itself diagnosis-only.

## 7. ENG-323 — staged, not dropped now

Declare-or-discard implies support files (`__init__.py`, `conftest.py`) should be declared like any
other new file, which would let us delete the ENG-323 co-located admission heuristic
(`check-path.ts:88-110`) and end the treadmill's *support* axis too. We are **not** doing that here:

- The discard core alone fixes the live throwaway-loose failure; ENG-323 just shipped and works.
- Dropping it depends on the **RED-first failure message being legible** ("couldn't collect: missing
  `__init__.py`") rather than an opaque `selected-none` — currently unproven.

So in this change **ENG-323 stays**: a co-located support file remains in-scope (committed), everything
else undeclared is discarded. The removal is filed as **ENG-342** (Styre, Backlog) with the legibility
precondition as a gate.

## 8. `implement` discard-vs-recovery — the risk, the decision, the flag

**The risk (recorded per operator request).** Today under reject-not-drop, an `implement` agent that
creates a genuinely-needed new file but forgets to declare it is **rejected → retried → and recovers by
declaring it**. Under declare-or-discard it is **discarded**, and if no check/test exercises that file,
verify goes green and the feature is **silently missing**. So A gives up a recovery path that reject
*does* provide for implement. Notably, the throwaway-wedge we actually observed was in
**checks/astropy, not implement** — implement's reject behavior has no observed failure.

**Why we still put implement under A.** Coherence (one rule), and the structural net: implement is
downstream of the AC checks, which should fail if a needed module is absent — the net exists, bounded by
check quality. Every discard is observable via the `note`.

**The decision + the flag (operator-made).** Keep implement under A by **default**, but put it behind a
runtime-config flag so we can revert *implement specifically* to reject-not-drop if the residual bites
in the wild — without reverting checks (checks-under-A *is* the fix; reverting it restores the astropy
wedge) or plan/docs (barely changed). The flag is implement-scoped:

- `implementDisposition: "discard" | "reject"`, default `"discard"`, in the **runtime-config layer**
  (not the probed `ProfileSchema`, per the config-layering rule — runtime operator policy). `"reject"`
  restores today's reject-and-retry for `implement` only.

## 9. What does NOT change

- Canonical-check recognition (ENG-296, `check-path.ts`) — it identifies the deliverable, not support.
- RED-first / coverage postconditions, verify gate, review taxonomy, projector, MERGE gate.
- The read-only steps' existing log-and-continue behavior (already a form of discard).
- `checksScopeFor`'s malformed-sidecar defer, and `implementScope`'s malformed-sidecar behavior — out of
  scope for this change (noted as an existing inconsistency in the model doc; not fixed here).

## 10. Alternatives considered

- **B — discard core but keep chasing the support axis separately.** Effectively what §7 stages; folded
  in, not rejected.
- **C — keep reject, only fix prompts (INV-A) + feedback (INV-B), no mechanism change.** Rejected: the
  SMOKE data shows the convention was already in the prompt and ignored, so this bets on prompting to
  fix a compliance problem prompting already failed to fix, and keeps the whole treadmill. Its INV-A /
  INV-B improvements are absorbed into A regardless.
- **Reject only tracked-source edits AND add a new tracked-edit gate for checks/implement.** Rejected as
  scope creep / YAGNI: the current guard does not gate tracked edits for implement/checks and there is
  no observed smuggle-via-tracked-edit failure; adding that gate would also break legitimate cases (a
  checks step editing an existing `conftest.py`).

## 11. Testing

**Deterministic mechanism tests (no bench, no flakiness):**

- A dispatch producing {a declared new file, an undeclared new file, a loose scratch file, a tracked
  edit} → declared + edit committed; undeclared + scratch **deleted from the worktree and absent from
  the commit**; a `scope-discarded` `note` recorded; **no throw**.
- `checks:dispatch`: canonical check committed; undeclared new discarded; ENG-323 co-located support
  still committed (staying, §7).
- `plan` / `docs`: out-of-scope **new** file → discarded (not rejected); out-of-scope **tracked edit** →
  throws (diagnosis-only message asserted).
- The flag: `implementDisposition:"reject"` restores today's throw on an undeclared new file;
  `"discard"` (default) discards it. Both states tested.
- No undeclared file survives a dispatch (assert the worktree state a verify run would see).

**Removals / reconciliations:**

- Delete `sweepScratch` + its two call sites + its tests (`worktree.test.ts` sweep cases,
  `run-dispatch.test.ts` sweep wiring).
- Delete the `styre_scratch/` prompt-assertion cases (`checks-prompt.test.ts`, `prompt-vars.test.ts`);
  add assertions for the new uniform declare-or-discard guidance.
- Reconcile the reject-not-drop tests for implement/checks in `run-dispatch.test.ts` /
  `commit-scope.test.ts` to the discard outcome.

**End-to-end (confirmation, not the primary loop):** one SMOKE bench run showing the astropy
throwaway-loose failure is gone.

## 12. Acceptance criteria

- [ ] `runAgentDispatch` splits judged changes into commit / discard / reject per §4; undeclared new
      files are deleted from the worktree and not committed; a `scope-discarded` note is emitted.
- [ ] `implement` and `checks:dispatch` no longer reject on undeclared new files (flag at default).
- [ ] Out-of-scope tracked edits on `plan` / `docs` still reject, with a diagnosis-only message.
- [ ] `sweepScratch` and both call sites removed; no undeclared file reaches the verify run.
- [ ] `checks.md` + `implement.md` (and the plan/docs prompts) carry the uniform declare-or-discard
      line; the `styre_scratch/` paragraph is gone.
- [ ] `implementDisposition` runtime-config flag exists (default `discard`); `reject` restores today's
      implement behavior; both paths tested.
- [ ] ENG-323 support admission unchanged (staged to ENG-342).
- [ ] Full suite green; tsc + biome clean.
- [ ] SMOKE run: astropy no longer wedges on throwaway-loose files.

## 13. Refs

- Model / current state: `docs/brainstorms/2026-07-19-checks-file-disposition-model.md`
- Root decision reversed: `docs/brainstorms/2026-07-11-scoped-commit-design.md` §2 (reject-not-drop, operator-made)
- Lineage: ENG-296/297 (`docs/brainstorms/2026-07-15-checks-implement-prompt-hardening-design.md`), ENG-300 (`docs/brainstorms/2026-07-15-scratch-drawer-design.md`), ENG-323 (`docs/brainstorms/2026-07-16-checks-support-files-design.md`)
- Follow-up: ENG-342 (drop ENG-323 support heuristic, staged)
- Code: `src/dispatch/commit-scope.ts`, `src/dispatch/check-path.ts`, `src/dispatch/run-dispatch.ts:170-220`, `src/dispatch/worktree.ts:209-244`, `src/dispatch/handlers.ts` (252/395/534/576/930/1139), `prompts/checks.md`, `prompts/implement.md`
