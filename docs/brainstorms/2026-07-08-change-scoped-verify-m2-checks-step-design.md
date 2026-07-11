# Change-scoped verify M2 — the plan-blind `checks:dispatch` step (detailed design)

**Status:** Design (brainstorm output) — **v2, revised after two independent reviews** (code-grounded feasibility + adversarial soundness, 2026-07-08). Core shape approved by the operator through a live design dialogue; v2 folds in the review findings (identity=added-only, the coarse-bucket semantics, resume-dedup, provision-reset preservation, the non-universal file floor, drop agent Bash, and the honesty corrections that several "re-sequence" items are net-new). Pending written-spec re-review. On branch `feat/change-scoped-verify-m2` (based on the M1 tip; rebases onto `main` after M1/PR #59 merges).
**Date:** 2026-07-08
**Scope:** the detailed design of **M2** — the plan-blind step that **authors native checks from the AC rows, provisions, runs them RED-first on clean `HEAD`, and records a coarse verdict + selector.** Nothing gates yet.

**Builds on:**
- `docs/brainstorms/2026-07-07-change-scoped-verify-ac-checks-design.md` (v2, overall) — §2.1 (plan-blind step), §2.2 (native tests, in-suite), §2.3 (RED-first; M2 does the *coarse* rung, M3 the graded taxonomy), §5 (named holes).
- `docs/plans/2026-07-08-m1-ac-identity-check-registry.md` — the M1–M6 decomposition and the M1 schema (`acceptance_criterion`, `ac_check`) + `deriveAndPersistAcs` this milestone consumes.
- `docs/architecture/control-loop.md` — the resolver's stage sub-step chain (the resolver is **pure/non-mutating** — it only emits step descriptors), dispatch handlers, the structured-output interface (§3a), CL-COMMIT, capability isolation.
- `CLAUDE.md` invariants: single-writer SoT (only the runner writes; agents return results); ground truth over self-report; capability isolation; structured agent output through a validated (zod) interface.

**Release/inertness note (no feature flag).** These milestones accumulate on `main` but the feature is **not live until a release is cut** after all Mx are done and validated. The operator does not run from `main` (v0.5.0 was released before any of this landed). So an intermediate `main` carrying a half-built path is fine — no flag, no quarantine, no seam pull-forward. The only per-milestone obligation is a green test suite (existing loop tests updated for the new step). **Consequence used throughout this doc:** because M2 gates nothing and never runs live alone, the failure axis that matters is not "wrong live outcome" but "does M2 bake a scoping/recording decision that corrupts data or forces an M3/M4 rework." The v2 fixes target exactly that.

---

## 1. What M2 delivers (and what it explicitly defers)

**Delivers:**
- A new plan-blind dispatch step `checks:dispatch` in the resolver's `design → … → implement` path.
- `provision` **hoisted** to run once before `checks` and reused by implement (§2).
- `deriveAndPersistAcs` (M1) **called at the start of the `checks:dispatch` handler** (not from the resolver — §2).
- The step: authors **one new native test file per AC** (§7), returns a structured `{ac_id, test_file, test_name}` per check, the runner verifies identity (added-file + selects-≥1), builds the per-stack selector, runs each check **in-suite on clean `HEAD`**, and records a **coarse** `red`/`green`/`error` (§5.4 semantics) + the selector into `ac_check`, plus a `ground_truth_signal` row with full raw output.

**Defers (named, not silent):**
- **M3** — the graded RED taxonomy (`assertion`/`absence`/`environmental` → `ac_check.red_class`) obtained by **subdividing** M2's `red` bucket from the raw output; the green-on-`HEAD` adjudication (vacuous / already-satisfied / not-expressible); the bounded re-author loop. M2 records the coarse outcome and takes **no corrective action**.
- **M4** — the verify-gate rework (advisory-demote). M2 does not change `verify:check`.
- **The implement seam** (implement *sees* the checks as a TDD contract) — later. M2's authored checks carry **guessed interfaces** and are **not reconciled until M3's re-author loop**; M2 commits them as provisional artifacts (§11).

---

## 2. Resolver change — hoist `provision`, insert `checks` (resolver stays pure)

Today `provision` is gated inside the implement stage (`resolver.ts:113,133`, firing at verify time). M2 re-sequences the resolver's step emission to:

```
design:dispatch → design:extract → design:size → design:review
   → provision            (hoisted; runs once at design-HEAD)
   → checks:dispatch       (NEW)
   → advance to implement
```

- **`deriveAndPersistAcs` is NOT a resolver chain element.** The resolver is pure (it only emits `step`/`advance` descriptors, never mutates). `deriveAndPersistAcs` writes rows, so it runs **inside the `checks:dispatch` handler, first thing** (idempotent — M1's guard early-returns; safe on resume), before building prompt vars.
- **Provision runs once and is reused, but the reset path is preserved.** Implement's existing provision gates (`resolver.ts:113,133`) are **not removed** — once provision is `done`, they find it succeeded and skip. Crucially, `resetProvisionIfManifestTouched` (`provision.ts:211-243`) is **kept**: a ticket whose implement diff adds a dependency manifest legitimately **re-arms** provision so the new deps install. So the correct statement is *"no **redundant** re-provision,"* not *"no re-provision."* (Provisioning at design-HEAD is well-defined: `design:dispatch` already created + committed the plan into the per-ticket worktree; the Python editable install links the source dir, so implement's later source edits are picked up live — only *new external deps* need the reset path, which is preserved.)
- Adds **no new `ticket.stage` value** (DS-2) — sub-steps within the existing `design→implement` boundary, gated by `done()` like the others (`if (!done("provision")) return step("provision",…)` then `if (!done("checks:dispatch")) return step("checks:dispatch",…)` before the `advance`).

## 3. The `checks:dispatch` step

- **Suggested key:** `checks:dispatch`. Registered in the dispatch registry + a mandatory `tool-allowlists.ts` entry (`allowlistFor` **throws** on an unknown handler).
- **Input (prompt vars):** the ticket's **AC rows** (id + text + source, from M1's `acceptance_criterion`) and the **project profile** (stacks, components, test commands, layout). **NOT** the implementation plan.
- **Capability isolation — authoring only, no execution.** Allowlist = `Read, Grep, Glob, Write, Edit`. **No `Bash`.** The agent *authors* checks (Read/Grep/Glob to understand the code well enough to write a valid failing test; Write/Edit to create the test file); it does **not** run anything — the **runner** executes checks for the ground-truth verdict (§5). Dropping `Bash` (a) removes the need for net-new per-handler Bash-scoping in `allowlistFor` (which today special-cases `implement:dispatch` only), and (b) closes the leak where an agent self-run mutates the shared provisioned env (site-packages / DB / migrations, which live *outside* the worktree) that the runner then trusts — a self-report path into ground truth. No `gh`/Linear/branch tools; the runner commits (CL-COMMIT), never the agent.
- **Prompt (`prompts/checks.md`, new):** builder-of-checks posture — "For each acceptance criterion below, author a **new** test file in this repo's own framework whose test(s) FAIL on the current code because the criterion is not yet met, and would pass once it is. Read the repo to write a valid test; you are given the criteria and the project's stacks/test-commands — not the implementation plan. Create a new file per criterion; do not edit existing test files. Return, per check, the acceptance-criterion id, the new test file path, and the test function name." (Full prompt is a plan-time artifact.)

## 4. The agent output contract (structured, zod-validated)

Mirrors the existing sidecar pattern (`extractSidecar` over a ```` ```styre-sidecar ```` fence, distinguishing absent-vs-malformed — `sidecar.ts`, `extract-schema.ts`). The agent returns:

```
checksAuthored: Array<{
  ac_id:     number   // which acceptance_criterion this check targets (intent)
  test_file: string   // repo-relative path of the NEW test file it wrote
  test_name: string   // the test function/case name it wrote
}>
```

An absent/malformed payload is a **transport failure** (re-dispatch), not "no checks." The agent reports only **facts it knows because it wrote them** — never a selector string (runner's job, §5) and never a verdict (ground truth, §5).

## 5. The runner's role — verify, construct selector, execute (ground truth)

This is the **largest net-new build in M2** — there is no per-test selection or selector-append in the codebase today (`commandFor` returns the raw component command; `reuseAwareTestCommand` swaps, doesn't append). Not a re-sequence.

### 5.1 Verify identity against the committed diff (added-file only)

After the dispatch commits (CL-COMMIT gives a `sha`; `changedFilesAt(sha)` gives the changed paths, and reading the committed file gives content), the runner confirms per check:
- `test_file` is **git-status `A` (newly added)** in this dispatch's diff — **not `M` (modified).** An `Edit` to a pre-existing test file is rejected. *This is load-bearing:* the file-path selector (§5.2) is scoped **only because the authored file contains nothing but styre's checks**; allowing a modified file would run the pre-existing tests in it and re-import the pre-existing red this feature exists to eliminate.
- `test_name` appears on an **added (`+`) line** of that file (requires reading the committed content — `changedFilesAt` returns filenames only).
- **the constructed selector actually selects ≥1 test** (a collect/dry-run count ≥ 1) — not merely that the name is a textual substring. This closes the false-green where a reported name is a substring of the real one and an anchored selector matches nothing (Go/jest `--passWithNoTests` → exit 0 → wrongly `green`).

A check failing any of these → the payload is rejected → re-dispatch (transport-class). Zero authored checks is caught by the postcondition (§8), not identity.

### 5.2 Construct the per-stack selector (all stacks, up front) — with an honest floor

- **Precise tier (preferred):** pytest `path::test_name`; JUnit `-Dtest=Class#method`.
- **Anchored-name + file/package scope:** jest `path -t '^name$'`; go `pkg -run '^name$'`.
- **Floor — and it is NOT universal:** for **pytest / jest** the floor is the **authored file** (`pytest path`, `jest path`) — runnable and scoped because it's styre's own file. But **`go test` operates on packages, not files**, and **`cargo test` on the crate + a name filter** — there is *no* "run just this file." So for **Go/Rust the floor is the package/crate (wider)**, which would re-admit sibling pre-existing tests. Mitigation, required by this design: for Go/Rust the authored check is placed in **its own package/module** (one styre-checks file = one package dir), so "run this package" is again scoped to only styre's check; where that's impractical, a precise `-run '^name$'` selector is mandatory (accepting the name-anchoring the precise tier already uses). The doc does **not** claim file-path universality.

### 5.3 Execute in-suite, on clean `HEAD`

Run the selector via the profile's component test command **within the suite's setup context** (session fixtures/conftest/migrations active — not naked-isolated, per overall §2.2), on the clean `HEAD` after the checks-commit and before implement.

### 5.4 Record a coarse verdict — semantics pinned so M3 *subdivides*, not reclassifies

The coarse bucket is defined by **whether the check executed and how**, not by a naive exit code:
- **`green`** — the check ran to completion and **passed** (behavior present).
- **`red`** — the check **ran and did not pass**: the test process produced a negative result about the code path under test. **This includes an assertion failure AND an absence signal** (the new module `ImportError`/`NameError`, a 404, a collection error on the check's own import). Absence-red therefore lands in `red` — aligning with overall §2.3, which calls import/404 an *absence-RED* — **not** in `error`.
- **`error`** — the check **could not be attempted at all**: the harness/env failed before any check result (provision failure, the test command couldn't launch, timeout before a test ran).

The runner stores **full raw output** in the `ground_truth_signal.detail_json`. **M3 subdivides `red`** (assertion vs absence vs environmental-that-still-ran) by reading that raw output — so M2→M3 is a clean *subdivide*, not a *reclassify*. (Honest limit: at the coarse level M2 cannot separate an absence-red caused by the *feature* being absent from one caused by a *broken base on the check's path* (overall §5.3 / H-A) — both are `red`; M3's raw-output read separates them. M2 deliberately does not try.)

## 6. Wiring `deriveAndPersistAcs`

Called at the start of the `checks:dispatch` handler (not the resolver — §2), so the AC rows exist for prompt vars and for tagging authored checks. Idempotent (M1) — safe on resume.

## 7. Authored-test location & naming (one *new* file per AC)

The agent writes **one new test file per AC**, placed where the target component's test command discovers it, named to (a) not collide and (b) contain *only* this AC's checks — which is what makes the added-file selector scoped (§5.1/§5.2). Convention (exact form plan-time): a stable, ticket+AC-tagged path under the component's test root, framework-appropriate suffix, e.g. `…/styre_checks/<ticket-ident>_ac<seq>_test.<ext>` — and, for Go/Rust, its own package/module dir. The deterministic path means a **re-authored file on resume overwrites** (no orphan files). A cross-cutting AC still gets its own new file; what that file *exercises* can span the system.

## 8. Postcondition & failure handling (minimal in M2)

- **Postcondition:** the step produced **≥1 authored check per AC**, each with verified identity (§5.1) and a recorded coarse verdict. A step that authored nothing for some AC fails its postcondition (mirrors `design:dispatch`) → existing bounded-retry / escalate.
- **No corrective action on green/error in M2.** A `green`-on-`HEAD` (vacuous or already-satisfied) or `error` is **recorded as-is**; adjudication + re-author is **M3**.
- **Qualitative-AC caveat (test-corpus guidance).** For an AC with no natural red state ("improve the error message"), the agent will either emit a vacuous check that records `green` (noise) or emit nothing and **fail the postcondition → escalate the ticket**. Which branch fires is agent behavior, not design; the *not-expressible* route that fixes it is **M3**. Release-inertness means no real ticket is stranded, but **M2's own test/bench corpus must steer away from qualitative ACs** (they'd be flaky) until M3 lands.

## 9. What gets recorded (M1 columns + a net-new writer + resume-dedup)

- `ac_check` (M1): one row per authored check — `ac_id`, `selector`, `test_path`, `red_first_result` (coarse `red`/`green`/`error`). `red_class` stays NULL (M3). **Net-new writer:** M1 shipped `insertAcCheck` only; `selector` is `NOT NULL`, so M2 inserts the row **with** its selector + coarse result at record time (an insert-with-result, not a later update).
- **Resume idempotency (data-bug fix):** `ac_check` has **no uniqueness** and `checks:dispatch` is effectful (a crashed step re-runs from scratch), so a naive re-insert on resume would **duplicate rows**. M2 persists checks by **deleting this ticket's existing `ac_check` rows then inserting fresh, inside the same transaction that marks the step succeeded** (needs a `deleteByTicket`/`deleteByAc` on the repo). Authored *files* are already resume-safe (deterministic path overwrites, §7); this makes the *rows* safe too.
- `ground_truth_signal` (existing): one verdict row per check run — `signal_type` = e.g. `ac-check-red-first`, `branch_head_sha` = clean-`HEAD` sha, `detail_json` = raw output + the `ac_check` id. **Vocabulary map (the two tables differ):** `ground_truth_signal.result ∈ {pass,fail,error}` while `ac_check.red_first_result ∈ {red,green,error}` — the runner writes the signal as `green→pass, red→fail, error→error` (writing `'red'` into `ground_truth_signal` would violate its CHECK).

No net-new *table* in M2 (M1 added the columns); the net-new code is the insert-with-result + delete-then-insert writers and the selector constructor.

## 10. Explicitly NOT in M2

Graded RED taxonomy + green-on-`HEAD` adjudication + re-author loop (M3) · verify-gate rework (M4) · the implement-sees-checks seam · dispositions (M6) · any feature flag (release-gated inertness).

## 11. Named risks (carried from overall §5 + M2-specific)

- **Provisional, unreconciled checks.** M2's committed checks carry the agent's **guessed interface** (it can't see the plan, and the implement-sees-checks seam + arbiter re-author are both post-M2). A check guessing `/preferences` while implement builds `/api/v1/prefs` can never green — but M2 never runs it post-implement, so it produces no wrong M2 record; it's a provisional artifact reconciled in M3. (Overall §2.5 interface churn.)
- **Contaminated AC↔check mapping.** `ac_id` is agent intent, not runner-verifiable; bounded by RED-first + review; affects labeling, not any M2 gate (there is none). Overall §5.7.
- **Name-selector fragility / non-universal file floor** (§5.2) — Go/Rust have no file-level run; mitigated by one-file-one-package or mandatory precise selectors there.
- **Provision dependency-staleness** — mitigated by preserving `resetProvisionIfManifestTouched` (§2); a dependency-adding ticket re-arms provision.
- **Identity is textual + selects-≥1, not semantic** — confirms the test exists and is selectable, not that it's meaningful; meaningfulness is RED-first (coarse here, graded M3).

## 12. Next

`superpowers:writing-plans` for the M2 plan (after this doc's re-review), then subagent-driven execution. Task shape (sized honestly for the net-new work):
1. Resolver re-sequence: hoist `provision` before a new `checks:dispatch` step; preserve the manifest-touch reset; update affected loop tests.
2. **The per-stack selector constructor (all stacks) + in-suite selector-append + selects-≥1 verification** — the largest build.
3. The `checks:dispatch` handler: `deriveAndPersistAcs` at start, prompt (`prompts/checks.md`) + `prompt-vars` + allowlist (no Bash) + the zod sidecar contract + added-file identity verification.
4. Coarse RED-first execution + the `red/green/error` mapping (§5.4).
5. `ac_check` writer (insert-with-result) + `deleteByTicket` resume-dedup + `ground_truth_signal` row with the vocabulary map.
