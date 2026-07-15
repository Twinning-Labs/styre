# checks:dispatch path-divergence — Design

**Ticket:** ENG-296 — checks:dispatch path-divergence — self-healing feedback (primary) + runner-derived RED-first test path (structural)
**Scope:** styre core (`src/dispatch/*`, `prompts/checks.md`). No schema change; no gate removed.
**Date:** 2026-07-15
**Related:** ENG-297 (prompt hardening — curb scratch spree at the source), ENG-290 (non-behavioral-AC gap), ENG-295 (merge/CI blocker — done).

## Problem

To verify a fix, styre dispatches an agent to author a RED-first check test (fails before the fix, passes after). The agent does two independent things: (1) **writes** the test file into the worktree, and (2) **declares** its path in the structured sidecar (`checksAuthored[].test_file`, `src/dispatch/checks-schema.ts:7-27`). Everything downstream trusts the *declared* path. When the two diverge, the run hard-fails and re-dispatches with no actionable feedback, then escalates.

**Ground truth (2026-07-13 SMOKE=2, styre @ `9cc6c53`):** astropy ENG-294 blocked at `stage=design`, escalated `"step 'checks:dispatch' failed"` (3 dispatch-failed). The agent **wrote** `astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py` (correct per the prompt's naming) but **declared** `astropy/modeling/tests/ENG-294_ac1_test.py` — dropped the `styre_checks/` segment. It also left ~8 scratch/debug files. darkreader ENG-293 passed only because its agent happened to write == declare. This is **nondeterministic LLM path-transcription luck**, not a regression from the completeness fix (#78) — the scope guard is pre-existing and never consulted `files_to_touch`.

### The two failure surfaces (both keyed on the declared path)

1. **Main path — the scope guard.** `checksScope` (`src/dispatch/commit-scope.ts:24-32`) builds a `declared` set = `checksAuthored[].test_file ∪ new_files` (normalized: slash + leading `./` only, **not** path-resolved), and rejects any *new* committed file not in that set. The real written file (under `styre_checks/`) isn't declared → out-of-scope → `run-dispatch.ts:176-196` reverts the worktree (`undoAttempt`), marks the dispatch `dispatch-failed`, and throws — **before** identity even runs. The scratch files are rejected here too.
2. **Re-author path — the identity check.** `reauthorCheckWrong` (`handlers.ts:256-262`) does `addedFilesAt(reauthorSha, worktree).has(authored.test_file)`; the declared path isn't among the git-added files → `return "rejected"` — **silent, persists nothing**, and its dispatch site (`handlers.ts:243-252`) passes empty feedback (`""`) to `checksVars`.
   (`addedFilesAt` = `git diff-tree --diff-filter=A`, `src/dispatch/worktree.ts:91-97` — only status-`A` files; the real written file is in this set under its true path.)

### Why re-dispatch is (effectively) blind → escalate

- The main-path throw message *is* persisted to `workflow_step.error_json` and re-surfaced on retry via the generic `rejectionFrom` → `RETRY_FEEDBACK` channel (`run-dispatch.ts:65-108`) — the same mechanism the design-over-decomposition fix used (`validateExtraction`, `handlers.ts:414-416`). But the message is a generic *"out-of-scope files (declare them): …"*, not divergence-specific, and it also lists the scratch files.
- The **re-author path persists nothing** and passes `""` feedback — genuinely blind.
- `checksFeedback` (`src/dispatch/checks-feedback.ts:12-22`) only surfaces *vacuous-verdict* findings (`event_log` rows `kind="loopback" ∧ loop="checks"`); path-divergence writes no such finding, so `{{checks_feedback}}` renders empty.
- Repeated identical failure trips the no-progress rule (`src/daemon/failure-policy.ts:147-158`) / the 3-attempt budget (`:25`) → escalate.

## Chosen approach

**Trust what was actually saved (the structural layer) + plain-English self-correction (the feedback layer).** Approved 2026-07-15 over the alternative "runner computes and injects the full canonical path" (which requires modeling a per-component test-root directory that styre does not track today, plus a framework→extension helper, and a ~20-site source-of-truth switch).

### Canonical filename convention (the anchor)

A check test is named `{ident}_ac{acId}_test.{ext}` (prompt `prompts/checks.md:14-16,51`). The **filename** (ident + criterion id + `_test`, any extension) uniquely ties a file to one AC. We anchor the structural fix on this filename, matched against the files the agent actually committed — **not** on the agent's declared string, and **not** on a runner-computed directory.

New helper (small, pure), e.g. `src/dispatch/check-path.ts`:
- `canonicalCheckBase(ident, acId): string` → `` `${ident}_ac${acId}_test` `` (the extension-less basename).
- `matchAuthoredTest(addedPaths: string[], ident, acId): string | null` → the single added path whose basename is `` `${ident}_ac${acId}_test.${ext}` `` for some non-empty `ext` (regex `^<escaped base>\.[^./]+$` on `basename(path)`); returns the path on **exactly one** match, else `null` (zero or ambiguous → no reconcile, fall through to feedback).

### Component 1 — reconcile the authored test path from the committed file

At both author sites, resolve the authoritative test path with a **three-way rule** (canonical-match is the override for divergence; the declared path stays a fallback so nothing that passes today regresses):

```
added = addedFilesAt(sha, wt)
real  = matchAuthoredTest(added, ident, acId)          // canonical file actually written, any dir
if real !== null:            testPath = real            // (a) divergence-proof override
else if declared_is_added:   testPath = authored.test_file   // (b) backward-compat: declared == written (any name)
else:                        → uncovered → Component 3 specific-message throw   // (c)
// identity unchanged: fileContentAt(sha, testPath, wt) must include the sidecar's test_name, else (c)
```

- **Why the fallback (b) is essential (review I1):** today's identity (`handlers.ts:595-599`) imposes **no** filename convention — any *added + declared* file containing `test_name` is accepted. Making the canonical basename the *sole* key would regress every currently-passing check whose file isn't canonically named — notably Go/Rust, which `prompts/checks.md:15-16` tells to use their own package/module dir (and `ENG-296_ac1_test.rs` isn't even a legal Rust module name). Branch (b) keeps that path working. Branch (b) is only ever reached when `declared == written` (`added.has(authored.test_file)`), which is by definition **not** a divergence — so it reintroduces no bug.
- **Main path (`handlers.ts:595-644`):** apply the rule per in-scope AC; feed `testPath` to identity, `impactedComponents([testPath])`, selector, and `ac_check.test_path` (`insertAcCheck`, `handlers.ts:673-680`). Sidecar `ac_id` + `test_name` still consumed; `test_file` is now hint/fallback.
- **Re-author path — these are EDIT sites, not "free" (review I2):** `reauthorCheckWrong` reads the sidecar path directly at `handlers.ts:260,261,269,281,291,295,304` (identity, `fileContentAt`, the **replay-overlay `testFile` at :269**, selector, `impactedComponents`, adjudicate, `insertAcCheck`). Apply the same three-way rule and thread the resolved `testPath` through all of them (and `branchHeadSha = reauthorSha` for the freeze baseline). This makes the re-author path **divergence-proof structurally**. **Keep its `return "rejected"` contract as-is (do NOT convert to a throw):** unlike the main path, this return is a *designed fail-closed disposition* — the `checks:reauthor` step (`handlers.ts:1565-1604`) records each `reauthorCheckWrong` outcome as an `ac-check-reauthor` signal and the gate-attempt escalate counter drives giving-up. Throwing here would corrupt that counter. After the reconcile, a genuine path/name divergence no longer causes a rejection; a still-unresolvable case (fully misnamed) stays fail-closed exactly as today.

Because `ac_check.test_path` is set correctly at author time, the **pure DB readers are fixed for free** — integrity freeze (`check-integrity.ts:43,55,65`, gate at `handlers.ts:1431-1436`), post-implement re-run (`post-implement-rerun.ts:82`), selectors, implement-feedback (`feedback.ts:67-69`, `prompt-vars.ts:107,117`), classify (`handlers.ts:751`), arbitrate (`handlers.ts:1503,1509`). The **main-path replay** overlays from `ac_check.test_path` (free); the **re-author replay** (`replay-harness.ts` via `handlers.ts:269`) takes the path as a *parameter* sourced from the sidecar — that is one of the re-author edit sites above, **not** free. No framework→ext guessing anywhere (we accept whatever extension the real file has).

### Component 2 — the scope guard accepts a correctly-named test file

`checksScope` must stop rejecting the real test file. It needs the ticket ident + the in-scope AC ids, which it does not have today (it is a pure `(output) => (path,isNew) => boolean`). Convert it to a factory:

- `checksScopeFor(ident: string, acIds: number[]): CommitScope` — the returned predicate allows a *new* file if **either** its normalized path is in the declared set (today's rule) **or** its basename matches `` `${ident}_ac${acId}_test.${ext}` `` for some `acId ∈ acIds` (the convention). Non-test, undeclared files (scratch) remain out-of-scope. Both `ident` (`ctx.ticket.ident`) and `acIds` are already in hand at both sites (review claim 4).
- Wire it at both dispatch sites (`handlers.ts:250,566`), passing the ident and the ACs already in hand.
- **Residual hole (review M1, low-risk, noted not fixed):** the canonical-name branch admits *any* new file with that basename at *any* path. A smuggled file is added-only (can't overwrite an existing file), must still pass identity (`content.includes(test_name)`) and RED-first replay, so a non-test payload is rejected downstream. Residual risk is only a genuinely-failing test committed at an odd location — acceptable; deterministic curbing of stray files is ENG-297.

### Component 3 — self-correcting feedback, on the retry-prefix channel (built regardless)

The reconcile silently fixes *location*. The residual slips get a **specific, re-surfaced** message rather than a blind retry. **The channel is the existing generic `error_json` → `RETRY_FEEDBACK` retry-prefix** (`run-dispatch.ts:65-108`, `rejectionFrom`) — the exact `validateExtraction` pattern (`handlers.ts:414-416`) the design-over-decomposition fix used: a `throw`n message is persisted to the `checks:dispatch` `workflow_step.error_json` and prepended verbatim to the next attempt's prompt, with no `checksVars` change.

**Why NOT the `checksFeedback`/`loop:"checks"` channel the ticket suggested (review C1/C2):**
- `loop:"checks"` is load-bearing for re-author scoping: `latestChecksReauthorAcs` (`checks-verdict.ts:59-65`) reads the *latest* `loop:"checks"` event's `payload.acIds` to decide which ACs the next dispatch re-authors (`handlers.ts:540-542`), and `checksFeedback` reads only that latest event. Appending divergence findings on that label would hijack the re-author AC set and clobber genuine vacuous-verdict findings — the exact cross-wiring `arbiter-verdict.ts:107-111` warns against.
- The scope-guard rejects (scratch files, undeclared-divergent files) `throw` **inside `runAgentDispatch` before the handler's per-AC loop runs** (`run-dispatch.ts:178-190`), so no handler-side finding can be written for them anyway — they already ride `error_json`→retry-prefix.

**Write points — the MAIN-path throw only** (the re-author path keeps its fail-closed `"rejected"`, per Component 1; it is not a blind-retry loop). The main-path per-AC "uncovered" throw (`handlers.ts:654-659`) message is made specific, keyed on why each uncovered AC missed (tracked in a per-AC `missReason` map as the loop `continue`s):
- **Misnamed / not-committed** (branch (c): `resolveAuthoredTestPath→null`): *"AC {seq}: no check test named `{ident}_ac{acId}_test.*` was committed, and your declared `test_file` wasn't created either — save the RED-first test with exactly that filename."*
- **Wrong in-file test name** (resolved file present but `content` lacks `test_name`): *"AC {seq}: `{testPath}` does not contain a test named `{test_name}`."*
- **Stray scratch files:** already surfaced by the existing generic scope-guard message *"out-of-scope files (declare them …): A, B, C"* (`run-dispatch.ts:186-190`). Left as-is (adequate once Component 2 stops flagging the real test); deterministic curbing is ENG-297. No new write.

Because the retry-prefix reads `error_json` at the start of the *next* `runAgentDispatch` regardless of `checksVars`, the main dispatch becomes informed with no `checksVars`/`checksFeedback` change. (`checksFeedback`'s vacuous-verdict behavior is untouched.)

**Deviation from AC wording (flag for operator):** ENG-296's ACs say the feedback is surfaced "via `checksFeedback` (`checksVars` wiring)." Code-grounded review shows that channel cross-wires re-author scoping (C1) and can't reach the scope-guard failures (C2); the correct channel is the generic retry-prefix. The *intent* — an informed re-dispatch that self-corrects within budget — is fully met. Also: because pure path-divergence (canonical name, wrong dir) is now fixed **silently** by Components 1–2, AC#1's literal "divergent path → feedback string" is exercised only by the *misnamed* case; the pure-divergence case is a silent success (strictly better).

## Sub-decisions (locked)

- **Scratch files → rejected with a "delete these" message, not silently discarded.** Silently dropping could mask a confused agent; deterministic scratch-stripping is ENG-297's prompt job. Here they stay rejected but now recoverable via feedback.
- **Feedback rides the existing generic retry-prefix channel** (`error_json` → `RETRY_FEEDBACK`, `run-dispatch.ts:65-108`), **not** `checksFeedback`/`{{checks_feedback}}` — see Component 3 (review C1/C2). No new prompt machinery; no `checksVars` change.

## What this does NOT touch

- Downstream freeze/replay/re-run/selectors — unchanged; they read `ac_check.test_path`, which we now set to the real path from the start.
- No framework/extension guessing and no per-component test-root modeling (the cost of the un-chosen "inject" option).
- RED-first oracle semantics, the completeness gate, the merge/CI blocker (ENG-295), the non-behavioral-AC gap (ENG-290).

## Backward compatibility

- **Canonical write == declare** (e.g. darkreader): `matchAuthoredTest` returns that path (branch a); scope guard's declared-set branch already accepts it — identical behavior.
- **Non-canonical name, declared correctly** (e.g. Go/Rust in their own module dir): `matchAuthoredTest→null` → fallback branch (b) uses the declared+added path exactly as today — no regression (this is the review-I1 fix; without branch (b) these would break).
- The only new hard-fail vs. today is the genuinely-ambiguous case: non-canonical name **and** declared path not created — which today would also fail identity, now with a specific message instead of an opaque one.

## Honest caveat on "astropy clears"

The **location mismatch** is now fixed deterministically (canonical name at the wrong dir → `matchAuthoredTest` finds it, silent success). astropy *also* failed partly on the scratch-file pile; that part becomes a self-correcting retry (the existing generic "out-of-scope files" message now surfaced + ENG-297), still dependent on agent compliance. So this ticket makes astropy **recoverable and no longer a dead-end** and fully fixes the mismatch class; it does not by itself guarantee a one-shot astropy pass.

## Data flow (author → verify)

1. Agent writes test + declares sidecar (`ac_id`, `test_file` [hint/fallback], `test_name`) + `new_files`.
2. Scope guard (`checksScopeFor(ident, acIds)`): allow declared ∪ canonical-named test files; scratch → offender → revert + `dispatch-failed` → the generic scope message (`run-dispatch.ts:190`) lands in `error_json` → retry (informed).
3. On commit, per AC: three-way rule — (a) `matchAuthoredTest` hit → `real`; (b) declared+added → declared; (c) neither → throw specific message (→ `error_json` → retry). Identity (`content` includes `test_name`) then `ac_check.test_path = testPath`.
4. Downstream (freeze / RED-first re-run / replay / selectors) read the now-correct `test_path`; the re-author replay reads the re-author-resolved `testPath` (Component 1 edit site).

## Error handling

- `matchAuthoredTest` ambiguity (≥2 matches for one AC) → treat as no-match → feedback ("you created more than one file named for ac{acId}; keep exactly one"). Prevents guessing.
- Unparseable sidecar stays a transport failure (re-dispatch), unchanged.
- The no-progress escalate (`failure-policy.ts:147`) still bounds infinite loops; the difference is retries are now informed, so they converge instead of repeating the identical signature.

## Testing

- **Unit — `matchAuthoredTest` / `canonicalCheckBase`** (new `test/dispatch/check-path.test.ts`): match under a different dir; no-match on misnamed file; ambiguity (≥2 matches) → null; extension-agnostic (`.py`/`.ts`/`.go`).
- **Unit — scope guard** (`test/dispatch/commit-scope.test.ts`, extend the `checksScope` block via `checksScopeFor`): a written canonical test file at an undeclared dir is **in-scope**; a scratch file is **out-of-scope**; declared-path happy case unchanged.
- **Integration — divergence repro** (`test/dispatch/checks-handler.test.ts`, `FakeAgentRunner` + `gitRepo`):
  - (a) agent writes `…/styre_checks/{ident}_ac1_test.py` while declaring a different path → dispatch now **succeeds**, `ac_check.test_path` == the real written path (the astropy class — silent fix).
  - (b) **backward-compat / review-I1:** agent writes a *non-canonically-named* file (`…/foo_test.go`) and declares it correctly → still **succeeds** via fallback branch (b), `ac_check.test_path` == declared path.
  - (c) misnamed **and** mis-declared → `dispatch-failed`, and the next attempt's prompt carries the specific message via `error_json`→retry-prefix.
- **Integration — re-author path** (`test/dispatch/checks-reauthor-e2e.test.ts` shape): a divergent-path re-author now **installs** (resolves + freezes/replays against the *real* path) instead of rejecting; a genuinely-unresolvable (misnamed) re-author still returns `"rejected"` (fail-closed, recorded as the `ac-check-reauthor` signal) — no throw.
- Mirror `test/dispatch/design-extract-retry-feedback.test.ts` for the `error_json`→retry-prefix "feedback-consumed-on-retry" assertion (this is the channel, not `checksFeedback`).

## Acceptance criteria (from ENG-296)

- [ ] A `checks:dispatch` whose written path differs from its declared path produces a specific corrective feedback string on the next re-dispatch (unit-tested) — **reinterpreted (see Component 3 deviation note):** pure location divergence is now a **silent success** (Components 1–2, stronger than feedback); the specific-message path is exercised by the *misnamed-and-mis-declared* case.
- [ ] The re-dispatch consumes that feedback — **Component 3** via the `error_json`→`RETRY_FEEDBACK` retry-prefix on the **main** `checks:dispatch` (**not** `checksVars`/`checksFeedback` — that channel cross-wires re-author scoping, review C1/C2). The re-author path is made correct *structurally* (reconcile) rather than via feedback, since its `"rejected"` feeds the escalate counter. Intent met: the re-dispatch is informed.
- [ ] The RED-first path used by scope guard / identity / replay / `ac_check.test_path` is runner-derived and identical to where the agent wrote; a divergent write is caught with one clear signal — **Components 1–2** (runner-derived = derived from the committed file by convention, with a declared-path fallback for non-canonical names).
- [ ] darkreader + astropy both clear `checks:dispatch` — darkreader unchanged (backward-compatible); astropy's mismatch clears deterministically, scratch part via the generic retry message (+ ENG-297). Covered by the integration repro (a)/(b).

## Revisions from independent spec review (2026-07-15)

Folded before writing the plan:
- **C1/C2 (Critical):** Component 3 re-channeled from `loop:"checks"`/`checksFeedback` (which cross-wires re-author AC scoping and can't reach scope-guard failures) to the generic `error_json`→retry-prefix. Scratch-file feedback rides the existing generic scope message.
- **I1 (Important):** added the declared-path **fallback** (three-way rule) so non-canonically-named-but-correct checks (Go/Rust) don't regress from pass to hard-fail.
- **I2 (Important):** corrected the "fixed for free" list — the re-author replay (`handlers.ts:269`) is a Component-1 edit site, not a free DB reader.
- **M1 (Minor):** noted the canonical-name scope-admission residual risk (added-only, must still pass identity + RED-first).
- **Caller-trace refinement (during plan-writing):** `reauthorCheckWrong`'s `"rejected"` is a designed fail-closed disposition feeding the `checks:reauthor` escalate counter (`handlers.ts:1565-1604`), not a blind-retry loop — so the re-author path gets the structural reconcile but keeps its `"rejected"` contract (no throw). Component 3's specific-message throw is main-path only.
