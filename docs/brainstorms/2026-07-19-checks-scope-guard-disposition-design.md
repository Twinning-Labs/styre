# Scope-guard file disposition — declare-or-discard (checks)

**Status:** design, revised after independent panel review (see §14)
**Date:** 2026-07-19
**Type:** bug fix / reliability (unblocks the astropy bench; ends the *reject-driven* accretion on the checks step)
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
(`styre_scratch/` sweep) → ENG-323 (co-located support files). The operator's words: *"we seem to be
discovering scenarios every run… the whole thing has become so complex that I cannot keep it in my
head."*

The root of both is one mechanism: **the guard rejects any undeclared brand-new file**, which forces the
agent to pre-sort every file into three buckets and punishes misclassification with reject → loopback →
escalate.

## 2. The insight (and its honest limits)

A stray **new untracked** file is, by construction, never an edit to tracked source. For a *tests-only*
step like `checks`, discarding it is safe *when it is genuinely throwaway* — and for a genuinely-needed
file, the RED-first re-run fails and the agent recovers **provided the failure names what was dropped**
(§6, blocker-3 fix). An out-of-scope **edit to tracked source** is different — it cannot be silently
reverted and is a real "this step touched something it must not" signal — so it stays loud.

**Where the insight does NOT reach (established by the review, §14):**

- It is **proven only for `checks`**, where the discarded artifact is a test helper and the RED-first
  run is a real arbiter. For `implement`, a discarded needed module can pass verify silently (no check
  exercises it); for `plan`/`docs` there is no observed failure at all. So discard ships **for checks
  only**; `implement`/`plan`/`docs` keep today's reject (§4).
- Discard is only *loud enough to recover from* if the ground-truth failure is **legible**. It is not
  today (a missing helper yields an opaque `selected-none`), so we add the legible feedback (§6) rather
  than assume it.
- The telemetry `note` a discard emits is **observable, not a safety net** — OSS `styre run` has no
  inbox/supervisor to consume it (those are commercial-plane). It is provenance, nothing more.

## 3. Why we are overturning a settled decision (the July-11 reversal, scoped to checks)

Reject-not-drop was an **operator-made governing decision** on 2026-07-11
(`docs/brainstorms/2026-07-11-scoped-commit-design.md` §2): steps that commit real work reject-and-retry
on any undeclared new file, because *"a brand-new file the step produces might be genuine deliverable
work; silently excluding it could drop part of a real fix."* The 2026-07-15 scratch-drawer brainstorm
inherited this and treated it as settled; when the operator floated discard again there, it was closed
by **citation**, not re-argued. That was the misstep — a second raising was a signal to reopen.

Re-examined on the merits, §2 gave two reasons to reject discard:

1. *"A genuine unplanned new file would be lost, and verify would only catch it after a wasted loop (or
   wedge)."* This concedes ground truth catches it; the objection is only that commit-time is
   earlier/louder. The SMOKE data **inverts the cost-benefit for checks**: the case reject protects (a
   dropped *needed* helper) is rare, and the case reject *causes* (a throwaway file wedging the ticket)
   is common and terminal. **But the inversion is checks-specific** — for `implement`, the review showed
   the protected case (a needed module verify never exercises) is *not* recoverable by ground truth, so
   the original reasoning still holds there. That is why the reversal is scoped to checks.
2. *"A negative list lets an un-flagged scratch file slip to review."* This targeted a different
   alternative (commit everything except declared scratch). Declare-or-discard is the opposite — commit
   only what's declared/recognized, discard the rest — so nothing un-flagged slips through. Does not
   apply.

What changed since July 11: it was a-priori then; we now have **evidence** that reject + three
prevention layers still wedges *on checks*. We are not claiming a universal principle — we are fixing the
step where the evidence is.

## 4. The design: disposition per step

Each write dispatch carries a **disposition** — `reject` (today's behavior) or `discard`. For each
change this dispatch produced (pre-existing untracked cruft is already excluded via `untrackedBefore`,
`run-dispatch.ts:117-123`):

| Change | `reject` disposition (today) | `discard` disposition (new) |
|---|---|---|
| In-scope (declared / canonical / allowed tracked edit / in-dir path) | commit | commit |
| Out-of-scope NEW file | reject whole attempt | **discard** — delete from worktree, emit `note`, continue |
| Out-of-scope TRACKED edit | reject | reject (unchanged — never silently reverted) |
| **Undeclared new file that pairs with a tracked deletion (a rename/move)** | reject (as today) | **reject** — never discard (would be silent data loss; blocker 1, §5) |

Disposition per step (**operator-approved after review**):

| Step | Disposition | Notes |
|---|---|---|
| `checks:dispatch` + re-author | **`discard`** | the fix; the live throwaway-loose failure |
| `implement` | **`reject`** (default) | flag `implementDisposition` can set `discard` (§8); default keeps today's proven behavior |
| `plan` (design) | **`reject`** (unchanged) | no observed failure; not changed |
| `docs:revise` | **`reject`** (unchanged) | no observed failure; not changed |

So the behavior change lands on **checks only**. `implement` is unchanged by default (with an opt-in
escape); `plan`/`docs` are untouched.

## 5. Mechanism

Add an optional `disposition: "reject" | "discard"` to `DispatchSpec` (default `reject` — so `plan`,
`docs`, and today's `implement`/`checks` call sites are unaffected until set). The `checks:dispatch`
handler sets `discard`; the `implement` handler sets it from `ctx.config.implementDisposition`
(runtime-config, default `reject`). This closes the plumbing gap the review found — config reaches the
handler, the handler sets the spec, `runAgentDispatch` reads the spec.

In `runAgentDispatch` (`run-dispatch.ts:190-207`), replace "any offender → `undoAttempt` + throw" with,
**in this order** (reject-first, so we never commit a partial and then revert):

1. **Out-of-scope TRACKED edits** → `undoAttempt` + `dispatch-failed` + throw a diagnosis-only message
   (INV-B), committing nothing. (For `implement`/`checks` this branch is unreachable — every tracked
   edit is in scope — but it is live for `plan`/`docs`.)
2. **Rename-safety guard** (blocker 1): if the dispatch contains any tracked **deletion** (` D ` entry),
   an undeclared new file may be the moved content — `commitWorktree`'s `git add -u` (`worktree.ts:45`)
   would commit the deletion while discard removes the new file → silent data loss. So when a tracked
   deletion is present, **reject** (do not discard) the undeclared new files. (Refinement for the plan:
   pair deletion↔new via `git diff -M --name-status` and reject only the paired file; the conservative
   "any deletion present → reject the new files" rule is the safe floor.)
3. **`disposition === "reject"`** → any out-of-scope new file → `undoAttempt` + throw (today's behavior,
   unchanged). This is what `implement`(default)/`plan`/`docs` keep.
4. **`disposition === "discard"`** → out-of-scope NEW files → delete from the worktree
   (`rmSync(path, { force: true })` per path; then prune a now-empty parent dir) and emit one
   `appendEvent` `kind:"note"`, `reason:"scope-discarded:<handlerKey>"`, `payload:{ discarded }`.
   Return the discarded list in the dispatch result so the handler can surface it (§6, blocker 3).
5. **In-scope files** → commit by name, exactly as today.

**Sweeps — keep BOTH (revised during planning).** The pre-review draft proposed removing the primary
per-dispatch sweep (`run-dispatch.ts:173`) as subsumed by discard. Planning proved that wrong:
`implement` defaults to **reject** and still routes throwaway to `styre_scratch/` (`implement.md`), and
the primary sweep is what deletes those dirs *before* the commit-scope gate. The pre-verify sweep
(`handlers.ts:1139`) sits *after* the gate, so if the primary sweep were removed an implement agent's
`styre_scratch/` files would reach `implementScope`, become undeclared-new offenders, and **reject**.
So **both sweeps stay.** Discard additionally deletes *loose* undeclared files (the live bug); the
primary sweep keeps handling `styre_scratch/` for the reject steps; the pre-verify sweep remains the
backstop for read-only-dispatch strays and gitignored byproducts (`__pycache__`).

## 6. INV-A / INV-B

- **INV-A (forward guidance).** `checks` no longer needs the `styre_scratch/` convention (discard makes
  loose scratch a non-event), so **remove that paragraph from `checks.md`**, replaced by: *"Declare
  every new file that is part of your check in `checksAuthored`/`new_files`. Any new file you don't
  declare is treated as throwaway and won't be committed — no special folder needed."* **`implement.md`
  keeps its `styre_scratch/` guidance** (implement still rejects by default, so the drawer is still its
  escape). This asymmetry is honest: only checks changes behavior.
- **INV-B (diagnosis-only feedback).** The surviving rejections (plan/docs tracked-edit; implement
  default) carry a pure diagnosis, no instructions. **Blocker-3 fix:** when a `checks` RED-first run
  returns `selected-none` / a collection error *and* the dispatch discarded files, the thrown
  postcondition message (which becomes the retry feedback verbatim, `run-dispatch.ts:106-109`) appends a
  diagnosis-only line: *"the check could not be collected; these undeclared files were discarded this
  attempt: <paths>."* This restores the recovery reject used to give ("declare them") without
  reintroducing reject — the agent learns a file it relied on was dropped, and it is a *why-it-failed*
  fact, not an instruction.

## 7. ENG-323 — staged, not dropped now

Declare-or-discard implies support files (`__init__.py`, `conftest.py`) should be declared, which would
let us delete the ENG-323 co-located admission heuristic (`check-path.ts:88-110`) and end the *support*
axis of the treadmill too. We are **not** doing that here: the discard core alone fixes the live
failure, ENG-323 just shipped and works, and dropping it depends on the RED-first failure message being
legible (the same legibility §6 now partially delivers). ENG-323 **stays**; the removal is **ENG-342**
(Styre, Backlog), gated on that legibility.

## 8. `implement` — reject by default, discard behind a flag (the recorded discussion)

**The risk (recorded per operator request).** Under discard, an `implement` agent that creates a
genuinely-needed new file but forgets to declare it has it **discarded**; if no check/test exercises it,
verify goes green and the feature is **silently missing** — and reject-not-drop *does* recover this
(reject → "declare it" → committed). The review added two more discard hazards specific to implement: a
malformed sidecar (a transport failure) would become a silent partial-commit + false `clean-success`
instead of a re-dispatch (CLAUDE.md §3a); and an undeclared rename would lose data (blocker 1).
Critically, **every observed throwaway-wedge was in checks, not implement** — implement's reject has no
observed failure.

**The decision (operator-made, revised after review).** `implement` **defaults to `reject`** — the
proven behavior stays the default. Discard is available as an opt-in via a runtime-config flag so the
option is preserved, but it is off until there is a reason and until its guards are in place:

- `implementDisposition: "reject" | "discard"`, default `"reject"`, in the **runtime-config layer**
  (`src/config/runtime-config.ts`, threaded via `HandlerContext.config` — not the probed
  `ProfileSchema`, per the config-layering rule).
- When set to `"discard"`, implement's discard path carries the **rename-safety guard (§5.2)** and a
  **sidecar guard**: a **malformed** sidecar always re-dispatches (transport failure, §3a); an
  **absent** sidecar re-dispatches **only when it caused a discard** (undeclared new files with no
  declaration — the "no-silent-drop" case). A valid sidecar that declares some files and leaves others
  as throwaway discards the throwaway (the intended behavior). This closes the correctness reviewer's
  transport-failure + silent-drop findings without turning discard back into reject. (The simplicity
  reviewer flagged the flag as YAGNI; the operator chose to keep the option. Noted, not silently dropped.)

## 9. What does NOT change

- `implement` (default), `plan`, `docs` disposition behavior — reject-not-drop, exactly as today.
- The `implement` transport-failure semantics on the **default** path (reject → re-dispatch) — preserved
  (the guard in §8 only matters if someone opts into discard).
- Canonical-check recognition (ENG-296); RED-first / coverage postconditions; verify gate; review
  taxonomy; projector; MERGE gate.
- The pre-verify defense-in-depth sweep (kept, §5).
- `checksScopeFor`'s malformed-sidecar defer (`commit-scope.ts:33`) — unchanged; a malformed checks
  sidecar still defers-then-rolls-back at the handler (`handlers.ts:583-586`), so discard never runs on
  an unparseable checks sidecar.

## 10. Alternatives considered

- **Uniform discard across all 5 write steps** (the pre-review shape). Narrowed to checks after the
  panel showed implement's discard is unproven and introduces blockers, and plan/docs have no observed
  failure. "Uniform" was aesthetic; evidence favors minimal.
- **Discard implement by default with guards.** Rejected: ships unproven behavior as default for a step
  with zero observed failures; the guards make it safe but the default should be the proven path.
- **Keep reject, only fix prompts + feedback (no mechanism change).** Rejected: the convention was
  already in the prompt and ignored (§1).
- **Reject only tracked-source edits + add a tracked-edit gate for checks/implement.** Rejected as YAGNI
  / would break legitimate `conftest.py` edits.

## 11. Testing

**Deterministic mechanism tests (no bench):**

- `checks:dispatch` (`discard`): a dispatch producing {declared new, undeclared new, loose scratch,
  tracked edit} → declared+edit committed; undeclared+scratch deleted and absent from the commit;
  `scope-discarded` note recorded; **no throw**. Canonical check committed; ENG-323 co-located support
  still committed.
- **Rename-safety:** a dispatch with a tracked deletion + an undeclared new file → **rejected** (not
  discarded); assert no data loss.
- **Blocker-3 feedback:** a `checks` dispatch that discards a helper the test imports → RED-first
  `selected-none` → the thrown/retry message names the discarded file.
- `implement` default (`reject`): undeclared new file → throws (today's behavior); malformed sidecar →
  re-dispatch, not `clean-success`. Flag `implementDisposition:"discard"` → discards, with the
  rename + malformed-sidecar guards asserted.
- `plan`/`docs`: unchanged — out-of-scope file still rejected.
- Read-only dispatch leaves a `styre_scratch/` stray → pre-verify sweep removes it before the suite run.

**Removals / reconciliations:** keep `sweepScratch` and BOTH call sites (no sweep removal). Update
`checks.md` prompt-assertion tests to the new guidance; leave `implement.md` assertions intact. Update
stale `commit-scope.ts` docstrings ("reject-and-retry, never a silent drop") to note the disposition
now decides reject-vs-discard.

**End-to-end (confirmation, not the primary loop):** one SMOKE bench run showing the astropy
throwaway-loose failure is gone.

## 12. Acceptance criteria

- [ ] `DispatchSpec` carries an optional `disposition` (default `reject`); `checks:dispatch`/re-author
      set `discard`; `implement` sets it from `ctx.config.implementDisposition` (default `reject`);
      `plan`/`docs` unchanged.
- [ ] Under `discard`, undeclared new files are deleted from the worktree, not committed, and a
      `scope-discarded` note is emitted; `checks` no longer rejects on throwaway-loose files.
- [ ] Rename-safety: a dispatch with a tracked deletion never discards an undeclared new file (rejects).
- [ ] Blocker-3: a checks collection failure after a discard names the discarded files in the feedback.
- [ ] `implement` default path unchanged (reject + re-dispatch on malformed sidecar); the flag's
      `discard` path re-dispatches on a malformed sidecar (always) and on an absent sidecar that caused
      a discard, and applies rename-safety; all these paths tested.
- [ ] Both sweeps kept (removing the primary would make implement's `styre_scratch/` files reject); no undeclared file reaches the verify run.
- [ ] `checks.md` drops the `styre_scratch/` paragraph (new declare-or-discard line); `implement.md`
      keeps its guidance.
- [ ] ENG-323 support admission unchanged (staged to ENG-342).
- [ ] Full suite green; tsc + biome clean.
- [ ] SMOKE run: astropy no longer wedges on throwaway-loose files.

## 13. Refs

- Model / current state: `docs/brainstorms/2026-07-19-checks-file-disposition-model.md`
- Root decision reversed (for checks): `docs/brainstorms/2026-07-11-scoped-commit-design.md` §2
- Lineage: ENG-296/297 (`docs/brainstorms/2026-07-15-checks-implement-prompt-hardening-design.md`), ENG-300 (`docs/brainstorms/2026-07-15-scratch-drawer-design.md`), ENG-323 (`docs/brainstorms/2026-07-16-checks-support-files-design.md`)
- Follow-up: ENG-342
- Code: `src/dispatch/commit-scope.ts`, `check-path.ts`, `run-dispatch.ts:170-220`, `worktree.ts:45,209-244`, `handlers.ts` (252/395/534/576/930/1139), `src/config/runtime-config.ts`, `prompts/checks.md`, `prompts/implement.md`

## 14. Independent review — findings folded

A 3-reviewer code-grounded panel (correctness / altitude / simplicity, 2026-07-19) reviewed the
pre-review draft. Verdicts: HAS-BLOCKERS / NEEDS-REFRAMING / TRIM-NEEDED. What changed as a result:

- **Blocker — silent data loss on undeclared rename** (`git add -u` commits the deletion, discard drops
  the new content). → §5.2 rename-safety guard; §4 rename row.
- **Blocker — malformed `implement` sidecar → silent partial-commit + false success** under discard,
  violating the transport-failure invariant. → implement defaults to reject (§8); discard path requires
  a malformed-sidecar re-dispatch guard.
- **Blocker — checks discard reintroduces the wedge for a needed helper outside ENG-323, worse (opaque
  `selected-none`, no recovery).** → §6 legible discard feedback (blocker-3 fix).
- **Regression — removing both sweeps leaves read-only strays + gitignored byproducts for verify.** →
  keep the pre-verify sweep (§5).
- **Reframing — implement discard is unproven; plan/docs have no observed failure.** → scope the change
  to checks; implement defaults to reject with an opt-in flag; plan/docs unchanged (§4).
- **Over-claims corrected** — the safety net is checks-proven not universal (§2); the telemetry note is
  provenance, not a safety net, and discard removes a wired escalation gate where it applies (§2, §8);
  the treadmill dies only on the reject axis for checks (title/§1); dropped the strained
  ground-truth-over-self-report appeal.
- **Minor** — `rmSync -f` + prune empty dir (§5); clarified the unreachable tracked-edit-reject branch
  for implement/checks (§5.1); stale `commit-scope.ts` docstrings in scope (§11).
