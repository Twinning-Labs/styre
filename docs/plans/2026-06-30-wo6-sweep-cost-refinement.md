# WO-6: advisory-sweep cost refinement — Implementation Plan (v2, post independent review)

> **For agentic workers:** REQUIRED SUB-SKILL — **superpowers:subagent-driven-development**. Steps use checkbox (`- [ ]`). TDD: failing test → see it fail → implement → see it pass → lint + typecheck + full suite → commit. Suite green after each task.

**Goal:** make the WO-5 advisory run-all sweep cheaper and **measurable**, without weakening safety. WO-5 shipped the *mechanism* (any unowned non-docs file → an advisory sweep of untouched stacks, surfaced via `ran-all-unowned`, non-wedging). The open risk (freeze §13 #1 / T1): that sweep is frequent and **un-costed**. This WO ships the two safe, non-speculative pieces: (1) a **conservative inert-file skip** so clearly-non-build-affecting files don't sweep, and (2) **cost instrumentation** so the open risk becomes data. The cost **bound** (over-budget branch) is **deferred to a calibrated fast-follow** — see below.

## Scope (operator decision, post-review): measure-first

The freeze (§13 #1) says **"measure run-all before this is truly settled."** No sweep-cost data exists yet, so any budget default would be a guess. Per operator decision:
- **In this WO:** Task 1 (inert-skip) + Task 2 (instrumentation).
- **Deferred — calibrated fast-follow (post-measurement):** the over-budget branch that *bounds* the sweep. Until it lands, the sweep is interim-bounded by the existing **B3 wall-clock ceiling** (the runaway catcher) — i.e. the *current* state, no regression.

## What WO-6 is NOT (done by WO-5, subsumed, or deferred)

- **The "unowned → run all" mechanism** — shipped as the WO-5 sweep. ✅
- **"Gates + triggers" model** — already implicit and literal in code: `owned = changed.filter(c => matchesComponent(c,f))` = triggers, `commandFor(c, checkType)` = gates (`handlers.ts:408-410`). No refactor.
- **Explicit global-file set** (lockfiles/CI/Dockerfile → run all) — **subsumed**: those are non-inert → already swept by WO-5, and Task 1 deliberately keeps them swept. **Nuance to record:** they reach the **advisory** sweep (non-wedging), not a *hard* gate — "run-more-when-unsure" is advisory by design (WO-5). The work-order "global-file set" item is therefore fulfilled at advisory strength; a future hard-gate-for-globals decision is not settled here.
- **The over-budget *bound* (former Task 3)** — **deferred to a calibrated fast-follow** (operator decision). When built it must: bound on a **deterministic count** (cumulative `stacksSwept` / sweep-runs), not noisy wall-clock; use a **backstop-level default** tuned to Task 2's measured data (never an active optimizer that bites a legitimate ticket on day one); bound **only the advisory sweep** (never the hard gates); and **surface** a `sweep-skipped-over-budget` signal (a `renderPrBody` branch + an `implementFeedback` exclusion) — "defer the expensive tier to the gap-surfaced merge, never silently narrow." **It is NOT the freeze's full §9.3 branch:** that branch is *tiered* (run the cheap tier, defer the *expensive* tier) and names **content-hash skip** as a prerequisite — both remain the real §9.3 deliverable, deferred until there's data.
- **Content-hash sweep dedup** — perf, not safety; deferred until Task 2 data shows repeated-sweep dominates.

**Tech Stack:** TypeScript, Bun, Biome. `bun test` · `bun run lint` · `bun run typecheck`.

---

### Task 1 — conservative inert-file skip (generalize `isDocsFile` → `isInertFile`)

The sweep triggers on "unowned **non-docs**". Generalize "docs" to "**inert**" (clearly non-build-affecting) so a `LICENSE` edit no longer sweeps every stack. **Safety subtlety (review):** `isDocsFile` also feeds the **pure-docs PASS path** that returns `pass` with **zero gates run** for a non-behavioral unit (`handlers.ts:414-440`). So a file in `INERT_BASENAMES`, if it's the *entire* diff of a non-behavioral unit, yields a pass with nothing executed. **The set must therefore contain only files that can never flip *any* stack's gate** — and the predicate cannot be split (the `behavioral-no-code` guard lives inside the pure-path block, so a split would let a behavioral inert-only unit bypass it). Keep one predicate; make membership strict.

**Files:** `src/dispatch/components.ts` (add `INERT_BASENAMES`; add `isInertFile`, keep `isDocsFile`/`DOCS_EXTS` exported and used inside it; **add `basename` to the `node:path` import** — currently only `extname`). `src/dispatch/handlers.ts` (partition `unownedNonDocs` → `unownedNonInert` via `isInertFile` at all 4 sites + comment: `:407` comment, `:410`, `:414`, `:548`, `:567`). Test: `test/dispatch/components.test.ts` + `test/dispatch/verify-routing.test.ts`.

**Interface:** `export function isInertFile(file): boolean` = `isDocsFile(file) || INERT_BASENAMES.has(basename(file))`. **`INERT_BASENAMES` (strict, tunable):** `LICENSE`, `LICENSE.txt`, `NOTICE`, `AUTHORS`, `COPYING`, `.mailmap`. *(Deliberately EXCLUDED, per review: `.editorconfig` (a format/lint-gate input), `.gitignore` (file-discovery/packaging), `.gitattributes`/`.gitmodules`, and ALL `.json/.yaml/.toml/.lock/.mod` — build-affecting → stay swept.)*

- [ ] **Step 1: Failing tests.**
  - `components.test.ts`: `isInertFile` → true for `LICENSE`, `docs/x.md`, `dir/NOTICE`; **false** for `.editorconfig`, `.gitignore`, `config.yaml`, `Cargo.lock`, `src/a.py`.
  - `verify-routing.test.ts`: a non-behavioral unit with diff `["LICENSE"]` (unowned, inert) on a multi-stack profile → **no sweep** (no `ran-all-unowned`), passes via the pure-inert path; a **behavioral** unit with diff `["LICENSE"]` → **`behavioral-no-code` fail** (the widening must not create a zero-gate pass for a behavioral unit); a diff `["other/cfg.yaml"]` still sweeps.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Add `INERT_BASENAMES` + `isInertFile` (uses `basename`). In `handlers.ts`, rename the local `unownedNonDocs` → `unownedNonInert` (use `isInertFile`); update the pure-path reason to `inert-only` (or keep `docs-only` — pin whichever in the test). Keep the `behavioral-no-code` fail + the non-behavioral pass exactly.
- [ ] **Step 4: PASS** + full suite + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(verify): skip clearly-inert unowned files from the advisory sweep (WO-6)`

### Task 2 — sweep cost instrumentation (a `sweep-cost` signal)

Make the T1 cost **observable** (the freeze's "measure run-all") with no behavior change and no new plumbing — record each sweep's size + wall-clock as a ground-truth signal (the channel WO-5 already uses; `result:"pass"` → already excluded from `implementFeedback` by its `result !== "pass"` filter).

**Files:** `src/dispatch/handlers.ts` (instrument the sweep block). Test: `test/dispatch/verify-routing.test.ts`.

- [ ] **Step 1: Failing tests.**
  - A diff with an unowned non-inert file on a 2-stack profile → a `sweep-cost` signal exists with `detail` carrying `stacksSwept` (count of untouched stacks **actually run** — command present), `wallClockMs` (≥ 0), and `unownedTriggers` (count).
  - **Positive-trace case (closes the freeze v4 gap):** `unownedNonInert = ["config.yaml"]` but all untouched stacks lack the check-type command → the `sweep-cost` signal **still fires** with `stacksSwept: 0` (a recorded trace that an unowned file was present even when the sweep ran nothing).
  - When `unownedNonInert` is empty → **no** `sweep-cost` signal.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Wrap the sweep loop (`handlers.ts` ~`if (unownedNonInert.length > 0)`): capture `Date.now()` before/after; count `stacksSwept` (commands actually run). After the loop, emit — **literal call, mirroring every sibling** (the snippet below is abbreviated; pass the real first arg + ids):
  ```ts
  insertSignal(ctx.db, {
    ticketId: ctx.ticket.id, workUnitId: ctx.workUnitId, branchHeadSha: latestSha,
    signalType: "sweep-cost", result: "pass",
    detail: { checkType, stacksSwept, wallClockMs, unownedTriggers: unownedNonInert.length },
  });
  ```
- [ ] **Step 4: PASS** + full suite + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(verify): record sweep cost as a sweep-cost signal (WO-6 measurement)`

---

## Self-review notes

- **Safety preserved (review-confirmed):** the two WO-6 changes touch only the partition predicate and the advisory sweep block (`handlers.ts:544-572`), which is physically **downstream** of the owned-stack hard gates (`:450-542`) and their throw (`:603`). The cardinal-sin kill, the three-way resolve, and the A1 behavioral gate are untouched.
- **Inert set is strict** (review fix): only license/git-metadata files that can never flip a gate — `.editorconfig`/`.gitignore` removed (they'd be a silent under-verify on the zero-gate pure path). Behavioral inert-only diffs still fail `behavioral-no-code` (tested).
- **Honest sizing:** the `isDocsFile → isInertFile` rename is the load-bearing cleanup; the inert *set* is a marginal cost win (agent ticket-diffs rarely touch these files). The real cost driver — lockfile/config sweeps — stays swept (safe).
- **Measurement-first:** Task 2 records the data needed to calibrate the deferred over-budget bound. The bound, the tiered cheap/expensive branch, and content-hash dedup are deferred §9.3 work (see "What WO-6 is NOT").
- **`implementFeedback`:** `sweep-cost` is `result:"pass"` → already excluded. (The deferred `sweep-skipped-over-budget` will need an explicit exclusion when built, like `ran-all-unowned`.)
- **Interim bound:** until the over-budget fast-follow lands, a runaway sweep is caught by the existing B3 wall-clock ceiling — the current state, no regression.
