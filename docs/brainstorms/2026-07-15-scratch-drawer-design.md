# Scratch drawer — a sanctioned, styre-swept `styre_scratch/` folder

**Status:** design, pending independent review
**Scope:** styre core
**Type:** bug fix / reliability (unblocks the astropy bench instance)
**Relationship:** revises the scratch guidance shipped in ENG-297 (#80); respects the scoped-commit governing decision (#69-era, `docs/brainstorms/2026-07-11-scoped-commit-design.md`).

## 1. Problem

The checks/implement worker creates throwaway repro/debug scripts while it works. styre's commit **scope guard** (`commitScope`/`checksScopeFor`, `src/dispatch/commit-scope.ts`) rejects any undeclared brand-new file — by deliberate design (scoped-commit §2): a new file *might* be genuine deliverable work, so styre refuses-and-retries rather than silently dropping it, and if the worker won't declare-or-delete it across 3 attempts the ticket **escalates (blocked)**.

That reject-not-drop decision is settled and correct for the real work tree. The prevention layer meant to keep rejects rare — prompt wording telling the worker not to leave scratch behind (PR #72, then ENG-297) — is **not holding for astropy**: in the 2026-07-15 SMOKE=2 run (styre @ 4d081d0) astropy's agent created `analyze_bug.py, run_simple_test.py, test_bug.py, test_separability_bug.py`, the guard rejected them, the agent re-created them each retry, and the ticket escalated at `checks:dispatch`. (The ENG-296 path-divergence bug is confirmed *fixed* — zero path-mismatch errors that run; scratch is now the sole astropy blocker. darkreader ran clean to pr-ready.)

**Why "put scratch in `/tmp`" (ENG-297's guidance) failed:** a repro script must import the code under test, and in-repo code is generally only importable **from inside the repo/module**. Scratch in `/tmp` can't resolve those imports, so it can't run — the worker drags it back into the repo, where it trips the guard. The worker keeps making an in-repo mess because that's the only place its scratch works.

## 2. Approach — a reserved folder styre owns and sweeps

Give the worker a sanctioned throwaway folder, **`styre_scratch/`**, placed *by the worker next to the code it is touching* (so imports resolve), mirroring the existing `styre_checks/` convention for authored tests. styre treats that folder name as reserved and **deletes every `styre_scratch/` directory itself**, at the moments that matter — so scratch is never an offender at commit time and never survives into a later test run.

### 2.1 Why *sweep* and not *git-ignore*

The obvious version — add `styre_scratch/` to `.git/info/exclude` so the guard can't see it — has a load-bearing hole. git-ignore hides a file from **git**, not from a **test runner**. styre's **verify stage runs the suite broadly** — a bare `pytest` / `jest` / `go test` over the component (`src/dispatch/handlers.ts` verify runner → `reuseAwareTestCommand`, `src/dispatch/reuse.ts`) — and bare `pytest` collects *every* `test_*.py` on disk regardless of git-ignore. Scratch placed inside a module (where it must live to be usable) would therefore be **collected and executed by verify**, polluting or breaking the suite. Closing *that* would need per-framework runner-ignore config (pytest `collect_ignore`, jest `testPathIgnorePatterns`, go build tags, …) — precisely the per-stack complexity we're trying to avoid.

The **sweep** sidesteps both problems with one stack-agnostic rule:

- **It answers "how does styre find the per-module drawer?"** — it doesn't map modules. It deletes *any* directory named `styre_scratch/` at any depth. The worker supplies the location; styre supplies a dumb recursive delete.
- **Stack-agnostic** — one delete works for every language; no per-runner config, no framework knowledge.
- **Closes the verify hole** — the scratch is gone before verify runs, so nothing collects it.
- **Respects reject-not-drop** — the guard is untouched. In the real work tree an undeclared new file is still rejected-and-retried. `styre_scratch/` is a worker-declared *throwaway* zone; emptying it is not "styre silently dropping real work," and the prompt says so explicitly.

git-ignore is therefore **not** used (considered and dropped as redundant given the sweep — it would not solve verify collection anyway, and two overlapping mechanisms muddy the story).

## 3. Design

### 3.1 The reserved name

`styre_scratch/` — a directory name, matched anywhere in the worktree at any depth, parallel to `styre_checks/`. It is reserved: a real project directory of that exact name would be swept. Collision risk is negligible (the same bet `styre_checks/` already makes); noted, not mitigated.

### 3.2 The sweep helper (`src/dispatch/worktree.ts`)

```ts
/** Recursively delete every directory named `styre_scratch/` under `worktreePath`
 *  (the worker's sanctioned throwaway drawer). Skips `.git`; never throws if none exist.
 *  Returns the repo-relative paths removed (for telemetry). */
export function sweepScratch(worktreePath: string): string[];
```

Implementation direction (nailed in the plan): a bounded filesystem walk from the worktree root that skips `.git` (and other obviously-huge ignored roots like `node_modules`), removing any directory whose basename is `styre_scratch` via `rm -rf`. Pure filesystem — the folders are untracked, so git does not enumerate them.

### 3.3 Where the sweep runs

Scratch is only ever created *during a dispatch* (the agent runs inside a dispatch). Every dispatch funnels through `runAgentDispatch` (`src/dispatch/run-dispatch.ts`). So:

1. **Primary — in `runAgentDispatch`, immediately after the agent returns and *before* the pending-file enumeration** that feeds the scope guard (`pendingEntries` → offender computation, per scoped-commit §3.2). Sweeping here means `styre_scratch/` is gone before the guard looks: never an offender, never staged, and — because it applies to every dispatch, write and read-only alike — gone before any later step (including verify) can see it. This single placement is sufficient for correctness.

2. **Defense-in-depth — immediately before the verify suite run** (`handlers.ts` verify runner, before `commandFor`/`runCommand`). A one-line safety sweep guaranteeing the invariant "no `styre_scratch/` reaches a broad test run" independently of dispatch-path assumptions. Cheap; keep it.

The sweep does **not** replace `undoAttempt`'s existing `git clean -fd` (that already removes a *failed* attempt's untracked scratch on reject/transport-failure/park). The primary sweep runs on the **success path too**, which `undoAttempt` never touches — that is the gap that let scratch persist into verify.

### 3.4 Observability (non-gating)

When the primary sweep removes anything, record one `event_log` row via `appendEvent` — `kind:"note"` (the only safe kind per scoped-commit §6 / `schema.sql` CHECK), `reason` the handler key, `payload: { swept }` (the removed paths). Non-gating, mirrors the existing `recordStray` pattern, and makes scratch frequency visible without reading worktrees. No new telemetry channel.

### 3.5 Prompt changes (`prompts/checks.md`, `prompts/implement.md`)

Replace the ENG-297 "do scratch in `$TMPDIR`/`/tmp`" guidance (which we now know cannot run in-repo imports) with the drawer:

- **Both prompts:** for any reproduction / debugging / throwaway scripting, create a **`styre_scratch/`** folder next to the code you are working on and put those files there. styre ignores and wipes that folder — nothing in it is committed, reviewed, or run as part of the suite. Do **not** scatter throwaway files elsewhere in the work tree; a new file outside `styre_scratch/` that you don't declare will be rejected.
- **`checks.md`:** keep the `styre_checks/` pin for the *authored* RED-first test (unchanged); `styre_scratch/` is its throwaway sibling. Make the contrast explicit — `styre_checks/` = the real test I'm keeping, `styre_scratch/` = my experiments, wiped.
- Retain the reject-backstop sentence and the `new_files` narrowing from ENG-297.

This *revises*, not reverts, ENG-297: the reserved-name discipline and narrowed `new_files` stay; only the "where does scratch go" answer changes from `/tmp` to `styre_scratch/`.

## 4. What does NOT change

- The commit scope guard and its predicates (`commit-scope.ts`), the reject-and-retry semantics, `commitWorktree` named staging — untouched.
- Verify gate semantics, the review taxonomy, the projector, MERGE gate — untouched (verify gains only a pre-run sweep call).
- The `styre_checks/` convention and `check-path.ts` resolver — untouched.
- No `.git/info/exclude` write; no per-runner ignore config.

## 5. Alternatives considered

- **git-ignore the drawer (`.git/info/exclude`)** — rejected: hides scratch from the commit guard but NOT from verify's broad test runner (§2.1); would still need per-stack runner-ignore config.
- **Per-framework runner-ignore config** (pytest `collect_ignore` etc.) — rejected: per-stack complexity, fragile, multiplies across frameworks — the exact concern that motivated the sweep.
- **Single repo-root drawer** — rejected: a root drawer isn't in every module's import context, so scratch there often can't run (the `/tmp` failure, one level in).
- **Make the guard drop undeclared scratch** — rejected upstream (scoped-commit §2): violates "never silently drop a legit file."
- **Scratch-name denylist / heuristic** — rejected upstream (scoped-commit §2): styre guessing intent from names is fragile. The drawer is different: a *reserved, worker-declared* location, not a guess.

## 6. Testing

- **`sweepScratch` (pure):** removes a nested `a/b/styre_scratch/` at any depth; removes multiple; spares everything else (including a sibling `styre_checks/`); no-op + no throw when none exist; skips `.git`.
- **`runAgentDispatch` wiring:** agent creates `pkg/styre_scratch/repro.py` *plus* a legitimate tracked edit → after the dispatch the scratch dir is gone, the real edit is committed, and the scope guard did **not** reject (scratch never surfaced as an offender). A telemetry `note` row records the sweep.
- **No survival into verify:** a `styre_scratch/test_foo.py` created during a checks/implement dispatch is absent from the worktree by the time the verify runner would collect it (assert on the swept worktree state; the primary sweep already removed it, and the pre-verify sweep is a second guard).
- **Reserved-zone semantics (documented behavior):** a file the worker puts in `styre_scratch/` is never committed — assert it does not appear in the dispatch's commit even if it looks like real code (the drawer is throwaway by construction).
- **Prompt assertions:** `checks.md` and `implement.md` name `styre_scratch/` as the scratch location; the `styre_checks/`-vs-`styre_scratch/` contrast is present in `checks.md`; `new_files` narrowing and the reject-backstop wording survive. Update the ENG-297 prompt-assertion tests (`checks-prompt.test.ts`, `prompt-vars.test.ts`) to the new stance.

## 7. Acceptance criteria

- [ ] `sweepScratch(worktreePath)` exists in `worktree.ts`, removing every `styre_scratch/` dir at any depth, skipping `.git`, non-throwing.
- [ ] `runAgentDispatch` sweeps after the agent runs and before the scope-guard enumeration; a defense-in-depth sweep runs before the verify suite.
- [ ] A removed sweep emits a non-gating `event_log` `note` row.
- [ ] `checks.md` + `implement.md` direct scratch to `styre_scratch/` (replacing the `/tmp` guidance), preserve the `styre_checks/` pin and `new_files` narrowing; assertion tests updated.
- [ ] Scratch created during a dispatch is neither committed nor present for the verify suite; the commit guard and its reject-not-drop behavior are unchanged for non-`styre_scratch/` files.
- [ ] Full suite green; tsc + biome clean.
