# Checks are a reported fact, not a gate (OSS `styre run`)

**Status:** design, approved 2026-07-18 — awaiting spec review, then plan
**Ticket:** (to be filed) · supersedes: ENG-337 (wait budget), ENG-340 part 2 (quiescence) · keeps: ENG-340 part 1 / PR #84 (verdict correctness)
**Date:** 2026-07-18
**Branch:** `feat/checks-report-not-gate`

> **Grassroots reframe.** The whole "checks" family of tickets (ENG-337 wait budget, ENG-340
> part 2 quiescence, ENG-338 message quality) has thrashed because it kept the *gate* and tried to
> make it correct/bounded/well-messaged. This design deletes the gate from the OSS run instead. The
> ephemeral one-shot `styre run` never blocks on, waits for, or loops back on remote CI. It exits
> PR-ready on **local** ground truth and leaves CI as a *reported fact*. All the machinery built to
> make an unbounded external wait behave — is deleted, not fixed.

---

## 1. The problem — two ground-truth points, and the second one is the wrong shape

Styre already checks correctness against ground truth **twice**:

1. **Local verify (S4)** — the runner runs the project's build/test/lint commands *in the worktree*,
   before anything is pushed. This is the primary correctness gate and it is hermetic to the machine
   the run executes on.
2. **`merge:await-checks` (S8)** — after the branch is pushed and the PR opened, the run *parks on an
   `external_checks` signal* and polls the remote checks system until green, then exits PR-ready. Red
   → loop back (atlas P1); flaky → re-run (P2); unreachable / budget-exhausted → escalate (P3);
   none configured → skip.

The second point is where every thrash lives. It makes an **ephemeral, one-shot** process — the
CI/fleet primitive — block on a **remote, slow, flaky, sometimes-recursive, sometimes-permissioned**
external actor *after* the PR is already open. The pathologies are all real and all documented from
ground truth in the superseded designs:

- **The ephemeral runner idles on a poll loop**, burning a compute lease (k8s Job / Fargate task).
- **Recursion / third-party CI.** When `styre run` *is* a CI job (the GitHub Action ships as a
  distribution target), it opens a PR and then waits for *another* CI run — which may be queued, need
  first-contributor approval, not start until the PR opens, or re-invoke Styre.
- **Flakiness.** CI is the flakiest ground-truth signal there is; atlas rows P2/P3 exist *only* to
  cope with it.
- **The registration blind window** (ENG-340 part 2, measured on `PostHog/posthog` PR #71707): the
  Checks API is blind for up to 8m15s after a PR opens while the Actions API already shows all runs.
  A "wait until quiet" rule declares green ~7.5 min too early. Closing this required an entire second
  design.
- **Redundancy in the common case.** When CI just re-runs the same test/build/lint that local verify
  already ran, CI-green is 100% predictable from verify-green — all that latency and flakiness bought
  zero new information.

## 2. The insight — CI adds information, but that does not make it a gate

What remote CI can tell you that local verify cannot is a real, finite delta:

1. **Environment divergence** — CI runs on the project's canonical env; "works on my machine" clashes
   (OS/arch, toolchain versions, case-sensitivity, dirty-vs-committed tree) are structurally
   invisible to a local run.
2. **CI-only checks** — proprietary scanners, coverage thresholds, integration tests needing secrets,
   third-party SaaS checks. CI is the project's *own* definition of acceptable, often a superset of
   the commands Styre knows to run.
3. **The merge arbiter** — branch protection may *require* a check green before the merge button
   works. But that bites only at the merge boundary, **which in OSS is the human's, not Styre's.**

That delta is **information**, not a **gate**. The design already fences the *human-merge wait (S9)*
out to the commercial plane with an explicit rule: the ephemeral OSS run does **not** block
indefinitely on a slow external actor. The same logic applies to CI — it is a reach-out-and-wait on
an external actor after the PR is open. The only reason S8 was OSS-core and S9 was not is that CI was
treated as a *correctness oracle* and the human as an *authority*. That distinction is real, but it
only justifies gating **to the degree CI is a *different* correctness oracle than local verify** — and
even then only as a fact to *record*, because acting on it (loop back, re-push, re-review) is exactly
the unbounded external loop the OSS boundary refuses for the human merge.

**So: report the delta, don't gate on it. Exit on local ground truth. Hand CI to whoever owns the
outer loop (the human on GitHub, or later the commercial plane).**

## 3. Decisions (operator-approved 2026-07-18)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **CI is never a gate in OSS.** The run exits PR-ready on **verify-green + review-clean + PR open**. CI is not in the terminal condition. | Makes the OSS boundary internally consistent: the ephemeral run never blocks on an external actor — CI *or* human. |
| D2 | **Zero-wait t+0 snapshot.** After the PR opens, take **one** non-blocking best-effort read of current CI state. Never re-poll, never wait, never budget. | The read is usually `not-reported-yet` (the 5s–8min registration window), and that is fine — it is informational, not load-bearing. Deletes all waiting/quiescence/budget machinery. |
| D3 | **Telemetry handoff only.** Emit one telemetry event: PR ref + head SHA + checks-system type + the t+0 read. **Post nothing to the PR.** | The plane (when built) picks up CI watching from the telemetry seed; solo OSS users read CI natively on GitHub, like any PR. No PR noise, no t+0 "no checks yet" comment that reads as broken. |
| D4 | **Hard-drop ENG-337 + ENG-340 part 2.** Remove the wait budget and quiescence/Actions-polling-for-gating entirely. Do **not** relocate them into a fenced OSS design now. | There is no wait to bound and no gate to make quiescent. The commercial plane's CI-watch + reconcile loop stays *undesigned* until it is actually built — carrying speculative machinery is the thrash we are ending (YAGNI). |
| D5 | **Keep PR #84 (ENG-340 part 1).** It merges independently. | Verdict correctness + the `on:` probe sharpen the t+0 read and the checks-system detection the handoff uses. No longer a prerequisite for anything, but finished, correct, and harmless. |

## 4. Design

### 4.1 The merge stage, after

`merge:push` (`handlers.ts:1688-1702`) and `merge:pr-ensure` (`handlers.ts:1704-1717`) are
**unchanged**. There is **no `merge:await-checks` handler** to replace — the gate is a pure *resolver*
decision. The change is subtractive plus one small emit:

- **Delete the resolver park** at `resolver.ts:238-240`:
  ```ts
  if (!hasDelivered(db, ticketId, "external_checks")) {
    return { kind: "wait", signalType: "external_checks" };
  }
  ```
  With it gone, the `merge` resolver goes push → pr-ensure → (t+0 read) → `human_merge_approval`
  wait / `advance merge→released` with no CI park in between.

- **Move the PR-ready terminal forward.** Today `driveToTerminal` returns `pr-ready` only once the
  ticket parks on `human_merge_approval` (`run-ticket.ts:75-76`), which is reachable *only after* the
  `external_checks` park clears. After this change, PR-ready fires on **merge-stage + PR opened**
  (the `external_pr_result` for `pr-ensure` has been delivered), independent of any CI signal.

- **The t+0 read** is a single call to the existing `githubChecks(...).status({ref})` verdict
  (`github-checks.ts:29-69`) against the pushed head SHA, wrapped so it never throws and never blocks:
  on any error or `checksSystem !== "github"` it yields `not-reported` / `skipped` and the run
  continues. It runs once, at PR-open, on the path to the PR-ready terminal.

### 4.2 The telemetry handoff event

A new member on the `TelemetryEvent` discriminated union (`events.ts:85`), following the existing
`signal` (ground_truth_signal) shape. Adding a union member is **additive** — consumers ignore
unknown `type`s — so `SCHEMA_VERSION` does **not** bump:

```jsonc
{ "type": "ci_handoff", "schemaVersion": 1, "ticket": "STYRE-1",
  "pr": { "number": 42, "url": "https://github.com/…/pull/42" },
  "headSha": "abc123…", "checksSystem": "github",
  "read": "not-reported",            // one of: passing | failing | pending | not-reported | skipped
  "at": "2026-07-18T12:00:00Z" }
```

Emitted through the sink already threaded into `driveToTerminal` (`run-ticket.ts:45`,
`createTelemetryEmitter(opts.emit ?? noopSink)`). It rides the NDJSON stdout stream — the wire form of
the §5.3 export contract — so it is container-native and needs no schema table (telemetry is derived,
not stored). **This is a data point, not a consumer**: nothing in OSS reads it back. It is the seam a
future commercial CI-watch loop would subscribe to (fenced by absence, like S9).

The read + emit are **best-effort and not journaled as a `workflow_step`**. On a crash-resume the
run may re-take the read and re-emit the event; per the telemetry contract (brainstorm §5.3 —
"forensic telemetry lost on a mid-run crash is acceptable; `metric_event` is not control flow") a
duplicate or a dropped `ci_handoff` is acceptable and never affects control flow or the exit
disposition.

### 4.3 What gets deleted (hard-drop)

| Surface | File / lines | Action |
|---|---|---|
| `external_checks` resolver park | `resolver.ts:238-240` | delete |
| The checks poller | `src/daemon/poll-checks.ts` (whole module, `pollChecks` L31-61) | delete |
| Poller call in the tick loop | `loop.ts:51-53` | delete |
| Dead wait-budget columns | `schema.sql:210-215` (`attempts`/`max_attempts`/`first_attempt_at`/`last_attempt_at`, "external_signal_budget") | delete (unused scaffolding) |
| `external_checks` signal type | `schema.sql:207` comment + any references | remove |
| ENG-337 branch + its brainstorm; the untracked quiescence brainstorm (`2026-07-17-checks-quiescence-design.md`) | git | abandon / do not merge |
| Atlas rows **P1** (loopback on red), **P2** (flaky→re-run), **P3** (unreachable→escalate) | `control-loop.md:657-660` | delete from the OSS run path |

**Kept / reused:** `githubChecks().status()` (the t+0 read); `ChecksPort` / `selectChecks`
(`checks.ts:5-23`) and the `ports.ts:38-51` wiring; the telemetry emitter/events
(`events.ts`, `emitter.ts`); checks-system detection at setup (`detect.ts:40-49`, `probe.ts`,
`profile.ts:122` — still needed to label the handoff's `checksSystem`).

### 4.4 What the commercial plane inherits (fenced, undesigned)

CI-watch + reconcile-on-red is the plane's **outer loop**, alongside the S9 human-merge wait it
already owns. Per D4 we do **not** design it here. The design docs note the seam — the `ci_handoff`
telemetry event is what a future plane loop would consume — exactly as S9's indefinite wait and
`[CL-STALE]` are recorded-but-fenced today. No fenced pseudo-code, no reserved columns, no config
keys.

### 4.5 Doc changes

- **`control-loop.md`** — rewrite the S8 section to describe a one-shot report rather than a gate
  (in code the read lives on the merge-stage path to the PR-ready terminal, not a new dispatched
  step); delete atlas rows P1/P2/P3; update the §11 worked example (steps 14–16 collapse: OSS exits
  PR-ready right after the PR opens, no checks-green step); adjust the OSS boundary note.
- **`minimal-loop.md`** — remove the `POLL_INTERVAL = 60s` note (nothing polls).
- **`brainstorm.md`** — add a §11 changelog entry; correct A1's "CI green (required check = merge
  arbiter)" line to scope it to the commercial plane, not the OSS run.
- **`execution-model.md` / `README.md` / `glossary.md`** — reconcile the "checks green arrive as
  signals" wording: in OSS, checks are *observed once and reported*, not awaited as a control signal.

## 5. Non-goals (named, not hidden)

- **The commercial plane's CI-watch + reconcile loop** — out of scope; undesigned until built (D4).
- **Any PR-facing CI comment** — telemetry only (D3).
- **Required-context / branch-protection detection** — not needed when nothing gates.
- **Non-Actions CI accuracy** (CircleCI/Buildkite/Jenkins) — the t+0 read degrades to whatever the
  adapter returns; since it is informational, a poor read is low-stakes.
- **Changing local verify (S4) or the AC-check gate** — untouched; those are the real correctness
  gates and they stay.

## 6. Scope

**IN** — delete the `external_checks` resolver park; delete the poller + its tick-loop call; move the
PR-ready terminal to fire on merge-stage + PR-opened; add the one-shot t+0 read; add the `ci_handoff`
telemetry event; remove dead wait-budget columns; update the design docs (control-loop, minimal-loop,
brainstorm, execution-model/README/glossary); rewrite the affected tests.

**OUT** — everything under §5.

## 7. Acceptance criteria

- [ ] `styre run` on a repo with `checksSystem: "github"` exits **PR-ready** immediately after the PR
      is opened and verify/review are clean, **without** waiting for any CI run to start or finish.
- [ ] No `external_checks` signal is ever inserted; the ticket never enters `waiting` on checks.
- [ ] A run that opens a PR emits a `ci_handoff` telemetry event carrying PR ref + head SHA +
      `checksSystem` + the t+0 read; nothing is posted to the PR. (A run that never reaches merge
      emits none. Best-effort: a resume may duplicate it — acceptable per §4.2.)
- [ ] The t+0 read never blocks and never fails the run: a throwing/timed-out/unreachable checks port
      yields a `not-reported` read and the run still exits PR-ready.
- [ ] `checksSystem: "none"` behaves identically (read = `skipped`), with no signal machinery.
- [ ] The poller module, its `loop.ts` call, the resolver park, and the dead wait-budget columns are
      gone; `grep` finds no live `external_checks` / `pollChecks` references.
- [ ] Atlas rows P1/P2/P3 and the `POLL_INTERVAL` note are removed from the docs; the §11 worked
      example reflects the new terminal.
- [ ] Full suite green; rewritten tests cover: PR-ready-on-PR-opened, no external_checks signal, the
      `ci_handoff` event shape, and the fail-safe t+0 read.

## 8. Refs

- **Superseded designs (kept as evidence, not re-derived):** `docs/brainstorms/2026-07-16-checks-wait-budget-design.md` (ENG-337, on branch `feat/eng-337-checks-wait-budget`); `docs/brainstorms/2026-07-17-checks-quiescence-design.md` (ENG-340 part 2, untracked). Both keep the gate; this design removes it.
- **Kept:** PR #84 (`feat/eng-340-checks-verdict`, ENG-340 part 1) — verdict correctness + `on:` probe.
- **Code (delete/change surface):** `src/daemon/resolver.ts:231-245`; `src/daemon/poll-checks.ts`; `src/daemon/loop.ts:51-53`; `src/daemon/run-ticket.ts:70-79` (pr-ready terminal); `src/dispatch/handlers.ts:1688-1717` (push/pr-ensure, unchanged); `src/engine/signals.ts:8-21`; `src/db/schema.sql:207,210-215,510-518`; `src/integrations/adapters/github-checks.ts:29-69`; `src/integrations/checks.ts:5-23`; `src/daemon/ports.ts:38-51`; `src/setup/detect.ts:40-49`; `src/telemetry/events.ts:85`, `src/telemetry/emitter.ts:112-143`, `src/telemetry/emit.ts`.
- **Tests to rewrite:** `test/daemon/poll-checks.test.ts`; `test/daemon/resolver.test.ts:466-470`; `test/daemon/advance.test.ts:127-130`; `test/dispatch/merge-e2e.test.ts:51-103`; `test/dispatch/merge-complete-e2e.test.ts:59-130`; `test/daemon/run-ticket.test.ts:56-91`; `test/cli/run-e2e.test.ts`; `test/telemetry/events.test.ts` + `test/telemetry/emitter.test.ts` (new `ci_handoff` case).
- **Design invariants honored:** the OSS PR-ready terminal (control-loop §S9 boundary note); loop-not-halt (nothing new halts; a gate + its escalations are *removed*); ground-truth-over-self-report (local verify stays the correctness gate; CI is reported truth, not self-report); single-writer / one-way projection (the handoff is an outbound telemetry fact, never read for control flow).
