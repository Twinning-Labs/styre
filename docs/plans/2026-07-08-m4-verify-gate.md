# M4 Verify-Gate (change-scoped) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD throughout: write the failing test, run it red, implement, run it green, commit.

**Goal:** Make M4 the first *gating* milestone. Rework verification so the authored **AC-checks are the hard gate** (an assertion/absence check must flip green after implement, graded by M3's frozen `red_class`; else bounded loopback-to-implement + escalate-on-repeat), while the whole component suite + build become a **non-blocking advisory sweep**. Add the **implement-sees-checks seam**, the **check-strengthening** (behavioral-assertion prompt requirement + the M3 adjudicator's `weak` flag), and — the load-bearing piece the reviews caught — the **check-file integrity gate** (freeze each check file + its `conftest.py` chain to its authoring sha; any change = gate fail), without which the whole gate is bypassable by implement rewriting its own check.

**Architecture:** Two independent loopbacks stay separate. (1) The **check re-author loopback** (`checks:classify` → `applyChecksVerdict`, `loop:"checks"`) gains the `weak` flag alongside `vacuous`. (2) A **net-new ticket-level hard gate** `verify:checks-gate` runs in the `implement` stage after all units verify: it runs the §2b integrity gate, then re-runs each authored check in the *implemented / re-provisioned* HEAD via a net-new harness, gates on the frozen `red_class`, records a post-implement result **separate** from `red_class`, and — via a new `applyAcCheckGateVerdict` on the `advance` onSucceed hook (mirroring `applyChecksVerdict`) — routes clean / loopback-to-implement / escalate. Separately, **both** the existing per-unit `verify:check` **and** the ticket-level `verify:integration` (repo-wide build+test) are **demoted to advisory** (record, never throw; routing advances once a check-type has *run* at the current sha — a `ranShasFor` gate replacing the `passingShasFor` gate). This is the literal reading of design §3/§7 ("component suite + build → advisory sweep"; "regression safety rests entirely on the MERGE human + real CI"), and demoting `verify:integration` is **mandatory-coupled with the resolver gate flip** — a handler that records an advisory `fail` with no `pass` signal at HEAD would otherwise re-emit forever against the journal replay → `MAX_TRANSITIONS` deadlock (see Task 8c). Cross-loopbacks that move HEAD after the gate passed (`codeLoopback`/`redesignLoopback`/integration-reconcile) also **reset the ticket-level verify steps** so the stale success is not replayed (Task 8d). No schema changes: the authoring sha is already on the M2b RED-first signal; the post-implement result and gate verdict are new open-vocab `ground_truth_signal.signal_type`s.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, zod (structured sidecar), `bun test`.

---

## Split assessment (one plan vs. many)

**Decision: ONE plan, 10 tasks, leaves-first.** M4 is large but the pieces share one design and must land coherently (the gate is worthless without the integrity gate; the seam makes tampering acute; the demotion and the new gate must swap atomically so the suite is never gate-less *in tests*). Splitting into separate plans would fragment the review of a single frozen spec. The `verify:check` rework (the centerpiece) **is** split — the *new gate* (Tasks 5-7) is separated from the *demotion of the old gates* (Task 8), and Task 8 itself is sub-staged (8a per-unit handler-stops-throwing · 8b per-unit routing/failure-policy/test-rewrites · 8c demote `verify:integration` · 8d reset ticket-level verify steps on cross-loopbacks) because the test churn is the dominant cost. Order guarantees each task leaves `bun test` green: the new gate is added **guarded to no-op when there are no AC-checks** (Task 7) so it is inert for every existing test, *then* the old per-unit and integration gates are demoted (Task 8) with their tests rewritten in the same sub-stage.

Task order: (1) `checks.md` behavioral-assertion strengthening · (2) the `weak` adjudicator enum + handler acceptance + prompt · (3) the re-author collector counts `weak`+`vacuous`, signature stays AC-id-set · (4) the implement-sees-checks seam · (5) the integrity-gate module · (6) the post-implement re-run harness module · (7) the `verify:checks-gate` step + resolver placement + gate verdict (loopback/escalate) + the failure-policy escalate-guard (7a) + the gate-fail re-code feedback carrier (7c) · (8) demote per-unit `verify:check` (8a/8b) AND `verify:integration` (8c) to advisory + reset ticket-level verify steps on cross-loopbacks (8d) + rewrite disturbed tests · (9) end-to-end integration tests (FakeAgentRunner) · (10) the M5 co-release note.

---

## Resolved under-specifications (plan-time decisions)

1. **No schema changes.** The authoring sha is already persisted: `signalForAcCheck(acCheckId).row.branch_head_sha` (the M2b `ac-check-red-first` signal). The post-implement result is a **new open-vocab signal_type `ac-check-post-implement`** (keyed by `branch_head_sha`); the gate verdict is `ac-check-gate`; integrity failures are `ac-check-integrity`. All three are distinct from `red_class` (M3) and leave room for M5's own record. A per-`ac_check` `authoring_sha` column is the design's named "cleaner alternative" — deferred (YAGNI: the signal read is O(1) and already exists). **No `docs/architecture/schema.sql` dual-edit needed.**
2. **`weak` is transient only.** It is added to `AdjClassEnum` (the adjudicator's zod-output enum) and accepted by the `checks:classify` handler for a **red** coarse bucket, mapped to a re-author exactly like `vacuous`. It is **never** written to `ac_check.red_class`/`disposition` — the CHECK constraints (`red_class IN ('assertion','absence','environmental')`) continue to reject it by construction (the handler never calls `classifyAcCheck` with `weak`). No schema change.
3. **Escalate signature stays reason-AGNOSTIC (the v2→v3 correction).** The re-author collector counts BOTH `weak` and `vacuous` (else a weak-only AC never enters the set → never escalates). The signature stays the sorted **AC-id set alone** — adding `reason` would let an AC oscillate `vacuous→weak→vacuous` forever (`isRepeatedChecksLoopback` is a predecessor-only compare). Verified by an explicit oscillation test (Task 3).
4. **Loop placement of the hard gate: a ticket-level `verify:checks-gate` step** in the `implement` stage, after `allUnitsVerified`, gated content-keyed on an `ac-check-gate` pass signal at the branch HEAD (mirrors `verify:integration`). AC-checks are ticket-level, not unit-level, so a ticket-level step is the natural home. It is **guarded to no-op when the ticket has zero `ac_check` rows**, keeping it inert for all existing tests.
5. **Gate verdict via the `advance` onSucceed hook, not failure-policy.** The gate handler *succeeds* (records the still-red set) and a new `applyAcCheckGateVerdict` decides clean/loopback/escalate — this reuses the exact `applyChecksVerdict` precedent and sidesteps the `failure-policy` `work_unit_id===null` branch (which does integration-reconcile — wrong for the AC gate). Loopback resets all units to pending + re-arms the gate step; escalate on a repeated still-red AC-id set. A **NULL red_class AND NULL disposition** row is a loud `throw` from the harness (an invariant violation — under-verification is forbidden), surfaced as a hard step failure.
6. **Advisory demotion scope: BOTH `verify:check` (per-unit) AND `verify:integration` (repo-wide).** The independent review's FIX 1 resolved the earlier "flagged for the lead #2" call in favor of the design's literal reading (§3 "component suite + build → advisory sweep"; §7 "regression safety rests entirely on the MERGE human + real CI"): the repo-wide integration gate is **also** demoted (Task 8c). The critical coupling the review caught: demoting `verify:integration` is **not** just "remove the throw." The resolver gates integration on a *pass* signal at HEAD (`resolver.ts:~138` `passingShasFor(…, "integration")`, filtering `result='pass'` in `ground-truth-signal.ts:85-97`). If the handler stops throwing and records an advisory `fail`, NO pass exists at HEAD → the resolver re-emits `verify:integration` → `runStep` replays the recorded success WITHOUT re-running (`step-journal.ts:74-80`) → re-emit → `advanceOneStep` hits `MAX_TRANSITIONS` (`advance.ts:18,157`) → **deadlock**. Task 8c therefore flips the integration gate from "passed at sha" to "**ran** at sha" (`ranShasFor`, introduced in Task 8b — any recorded `integration` signal at HEAD satisfies routing) in the SAME sub-stage that stops the throw. The `failure-policy.ts:148-170` integration-reconcile branch then fires only on an *infra crash* (handler threw), never a genuine test `fail`. **The AC-check gate stays content-keyed on `result='pass'`** (Task 7 / decision #4) — the `ranShasFor` relaxation is ONLY for the two demoted advisory gates, never the hard AC gate.
7. **Integrity freeze walks the `conftest.py` chain** from the check file's directory up to the repo root (closes the dominant autouse-fixture transitive-tamper vector, §7). The arbitrary shared-helper import residual is named, not closed (bounded by MERGE review) — no silent deferral.

---

## Flagged for the lead (genuinely forky)

1. **Gate loopback feedback granularity — RESOLVED (folded, review FIX 3).** The review confirmed `implementFeedback` (`feedback.ts:7-41`) is UNIT-scoped (`listByUnit(workUnitId)`) so it can NEVER see the ticket-level `ac-check-gate` signal — a tweak to it was wrong. Task 7c adds a NEW `gateFeedback(db, ticketId)` reading the latest `ac-check-gate` signal's `stillRed` acIds → the ac_check `test_path`s + AC text, threaded as a distinct `{{gate_feedback}}` implement prompt-var (separate from Task 4's `{{authored_checks}}`, which lists ALL checks). So re-code sees both the files (seam) and *which* checks are still red.
2. **Does `verify:integration` also demote to advisory? — RESOLVED (folded, review FIX 1).** Demoted (Task 8c), coupled with the `ranShasFor` resolver flip. See resolved under-spec #6.
3. **Full-pipeline e2e blast radius.** Any existing test that authors real `ac_check` rows *and* drives design→review will now hit the gate and must either see the fakes flip the checks green or be adjusted. Task 7b includes an explicit audit sub-step; grep at plan-time found no test currently does both (the gate's zero-checks no-op covers the rest), but this must be verified during execution. Related: Task 8d's cross-loopback verify-step reset makes re-verify *live* in the review-loopback path that `review-e2e.test.ts:197-200` currently bypasses by seeding `stage='review'` — audit that path too.

---

## Global Constraints

- **Single transactional SoT; only the runner writes it.** Handlers return results / persist via repos; every multi-row state change is one `db.transaction(...)()`.
- **`red_class` is the frozen M3 clean-HEAD fact** — the gate reads it, never recomputes it. The post-implement re-run writes its OWN record (`ac-check-post-implement`), never touching `red_class`/`disposition`.
- **Ground truth over self-report.** The gate verdict reads persisted signals, never an agent's word. The re-run reads the coarse verdict via `interpretRunOutput` (reused).
- **Re-run in the IMPLEMENTED / re-provisioned env**, NOT the frozen authoring env (a legit new-dependency AC would false-block otherwise). Reuse `runCheckForRed` + `binaryFor` + `frameworkFor`; the harness around them is net-new.
- **Integrity before re-run.** A tampered check is untrustworthy at re-run; the §2b byte-compare runs first and its violations join the still-red set.
- **`weak` is transient, never persisted.** The `red_class`/`disposition` CHECK constraints must still reject it.
- **Escalate signature = the sorted AC-id set, reason-agnostic** (both loopbacks). Predecessor-only repeat compare.
- **No schema changes** in M4 (see decision #1). If a task appears to need one, stop and re-check against decision #1.
- **Capability isolation unchanged.** `verify:checks-gate` is a daemon step (no agent, no tier/allowlist) — the runner runs the checks via `runCommand`, injectable as `deps.runCheckCommand` for tests. The `checks:classify` adjudicator stays Read/Grep/Glob (the `weak` flag needs no new capability — it already Reads the repo).

---

## File Structure

**New files**
- `src/dispatch/check-integrity.ts` — `checkIntegrityViolations` (§2b byte-compare of each check file + its `conftest.py` chain vs. its authoring sha).
- `src/dispatch/post-implement-rerun.ts` — `rerunAcChecks` (§4 re-run harness; gate-by-`red_class`; loud throw on NULL/NULL).
- `src/daemon/checks-gate-verdict.ts` — `applyAcCheckGateVerdict` (clean/loopback/escalate on the still-red AC-id set).
- Test files: `test/dispatch/check-integrity.test.ts`, `test/dispatch/post-implement-rerun.test.ts`, `test/daemon/checks-gate-verdict.test.ts`, `test/dispatch/verify-gate-e2e.test.ts`.

**Modified files**
- `prompts/checks.md` — behavioral-assertion requirement (assert observable output; forbid status/existence-only).
- `prompts/checks-classify.md` — the `weak` label + "Read the check file's assertions" instruction.
- `prompts/implement.md` — a `{{authored_checks}}` slot ("make these pass; do NOT edit the check files") + a distinct `{{gate_feedback}}` slot (still-red ACs on a gate loopback, Task 7c).
- `src/dispatch/adjudicate-schema.ts` — add `weak` to `AdjClassEnum`.
- `src/dispatch/handlers.ts` — `checks:classify` accepts `weak` (→ re-author, no `red_class`); `implement:dispatch` passes authored-check paths + gate feedback; register `verify:checks-gate`; demote `verify:check` (Task 8a) and `verify:integration` (Task 8c) to advisory.
- `src/dispatch/prompt-vars.ts` — `implementVars` gains `authored_checks` (Task 4) and `gate_feedback` (Task 7c).
- `src/dispatch/feedback.ts` — new `gateFeedback(db, ticketId)` (Task 7c; ticket-level, reads the `ac-check-gate` signal).
- `src/daemon/checks-verdict.ts` — collector counts `weak`+`vacuous` (renamed `currentReauthorFindings`); signature unchanged.
- `src/daemon/resolver.ts` — insert the `verify:checks-gate` step in the `implement` stage (Task 7); change `nextUnrunCheck` (Task 8b) AND the `verify:integration` gate (Task 8c) to "ran at sha".
- `src/db/repos/ground-truth-signal.ts` — new `ranShasFor` (Task 8b; mirror of `passingShasFor` without the `result='pass'` filter).
- `src/daemon/failure-policy.ts` — dead per-unit verify branch cleanup (Task 8b); a `verify:checks-gate` escalate-guard before the integration-reconcile branch (Task 7a, review FIX 2); reset ticket-level verify steps in the integration-reconcile branch (Task 8d).
- `src/daemon/review-verdict.ts` — reset ticket-level verify steps (`verify:integration` + `verify:checks-gate`) in `codeLoopback`/`redesignLoopback` (Task 8d, review FIX 4).
- `src/daemon/advance.ts` — add `verify:checks-gate` to `VERDICT_BEARING_STEPS`; branch onSucceed to `applyAcCheckGateVerdict`.
- Disturbed tests: `test/dispatch/verify-e2e.test.ts`, `test/dispatch/verify-routing.test.ts`, `test/dispatch/verify-handlers.test.ts`, `test/dispatch/verify-integration.test.ts` (Task 8c — asserts the demoted throw), `test/dispatch/feedback.test.ts`, `test/daemon/failure-policy.test.ts`, `test/daemon/resolver.test.ts`, `test/daemon/review-verdict.test.ts` (Task 8d), `test/daemon/checks-verdict.test.ts`, `test/dispatch/checks-classify-handler.test.ts`, `test/dispatch/adjudicate-schema.test.ts`.

---

## Task 1: `checks.md` — behavioral-assertion requirement (leaf, prompt-only)

Strengthen the check-authoring prompt so a surface-only check (`assert status==201`) is discouraged at the source: require asserting the AC's **observable output** (returned data shape, persisted value, side-effect); forbid status-only / existence-only checks.

**Files:** Modify `prompts/checks.md` (the "Rules" block).

- [ ] **Test first.** `test/dispatch/checks-prompt.test.ts` (new, tiny):
```ts
import { expect, test } from "bun:test";
import { CHECKS_TEMPLATE } from "../../src/dispatch/prompt-vars.ts";

test("checks prompt requires a behavioral/observable assertion, not status-only", () => {
  const t = CHECKS_TEMPLATE.toLowerCase();
  expect(t).toContain("observable"); // asserts the AC's observable output
  expect(t).toMatch(/status[- ]?(code)?[- ]?only|existence[- ]?only/); // forbids the weak shape
});
```
- [ ] Run red: `bun test test/dispatch/checks-prompt.test.ts`
- [ ] In `prompts/checks.md`, add to the `Rules` list (after "The file must contain only this criterion's check(s)"):
```
- **Assert the criterion's *observable output*, not just that the surface responded.** Check the
  returned data shape / a persisted value / a produced side-effect — the thing the AC actually
  promises. A status-code-only or existence-only assertion (e.g. `assert resp.status == 201` with no
  check of the body, or `assert hasattr(mod, "fn")`) is too weak: a stub that returns `201 {}` would
  pass it. Make the assertion one a stub cannot satisfy without doing the work.
```
- [ ] Run green. Commit: `feat(checks): behavioral-assertion requirement in the authoring prompt`.

---

## Task 2: the `weak` adjudicator flag (leaf — zod enum + handler acceptance + prompt)

`weak` is a judgment on a **red** (assertion/absence) check whose assertion is surface-only. It is a transient adjudicator output, mapped to a re-author like `vacuous`, never persisted.

**Files:** Modify `src/dispatch/adjudicate-schema.ts`, `src/dispatch/handlers.ts` (`checks:classify`), `prompts/checks-classify.md`.

- [ ] **Test first** — `test/dispatch/adjudicate-schema.test.ts`: extend to accept `weak`:
```ts
test("AdjClassEnum admits the transient weak flag", () => {
  expect(AdjClassEnum.safeParse("weak").success).toBe(true);
});
```
- [ ] **Test first** — `test/dispatch/checks-classify-handler.test.ts`: a scripted `weak` classification on a coarse-red check records a `weak` classification signal and sets **no** `red_class`:
```ts
test("a weak verdict on a red check re-authors (no red_class persisted)", async () => {
  // ...arrange one coarse-red ('red') ac_check unresolved; FakeAgentRunner returns
  // {"classifications":[{"ac_check_id":<id>,"class":"weak","reason":"status-only"}]}
  // act: run checks:classify handler
  const row = listByTicket(db, ticketId)[0];
  expect(row.red_class).toBeNull();               // never persisted
  expect(row.disposition).toBeNull();
  const sig = listSignals(db, ticketId).find(
    (s) => s.signal_type === "ac-check-classification" &&
           JSON.parse(s.detail_json!).class === "weak");
  expect(sig?.result).toBe("fail");
});
```
- [ ] Run red.
- [ ] In `adjudicate-schema.ts`, add `"weak"` to `AdjClassEnum` (after `"absence"`), and update its doc comment ("plus the transient `weak` surface-only flag, never persisted").
- [ ] In `handlers.ts` `checks:classify`, allow `weak` for a red coarse bucket and route it to re-author:
  - Add `weak` to the red-bucket acceptance: `const RED_CLASSES = new Set<AdjClass>(["assertion", "absence", "environmental", "weak"]);`
  - In the persist loop, add a branch **before** the `assertion|absence|environmental` else:
```ts
} else if (cls === "weak") {
  weak += 1; // no column set — triggers a re-author (§5); recorded as a signal for the verdict
}
```
  - Declare `let weak = 0;` beside `let vacuous = 0;` and return it: `return { classified: ..., adjudicated: pending.length, vacuous, weak };`
  - The classification signal already records `class: cls` with `result: "fail"` for non-green non-disposition classes — `weak` inherits that. Confirm the existing `result` ternary yields `"fail"` for `weak` (it does: `weak` is neither `already-satisfied` nor `not-expressible`).
- [ ] In `prompts/checks-classify.md`, under the RED-checks list add:
```
- `weak` — the target surface DOES exist and the test ran, but the assertion is surface-only
  (checks a status code / existence / truthiness, not the criterion's observable output). **Read the
  check file** (you have Read/Grep) and judge its assertions, not just the recorded trace: a check a
  trivial stub could satisfy is `weak`. A `weak` check is re-authored, like a vacuous one.
```
  and amend the opening line so the adjudicator Reads the file: change "you interpret their recorded output plus the repo" is already present — add "**Open each check's file and read its assertions** before deciding `assertion` vs `weak`."
- [ ] Run green: `bun test test/dispatch/adjudicate-schema.test.ts test/dispatch/checks-classify-handler.test.ts`. Commit: `feat(checks): weak adjudicator flag (transient, re-author like vacuous)`.

---

## Task 3: the re-author collector counts `weak`+`vacuous`; signature stays AC-id-set (leaf)

**Files:** Modify `src/daemon/checks-verdict.ts`; extend `test/daemon/checks-verdict.test.ts`.

- [ ] **Test first** — the two review-caught cases:
```ts
test("a weak-only AC triggers the re-author loopback", () => {
  // arrange: one live ac_check for acId=1; a classification signal class='weak' for it
  expect(applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }).decision).toBe("loopback");
});

test("an AC oscillating vacuous->weak->vacuous still escalates (reason-agnostic signature)", () => {
  // round 1: class='vacuous' for acId=1 -> loopback (records loop='checks' signature 'checks:1')
  applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  // simulate re-author: new live ac_check for acId=1, now classified 'weak'
  // (same AC id set -> same signature 'checks:1' even though reason differs)
  expect(applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" }).decision).toBe("escalated");
});
```
- [ ] Run red.
- [ ] In `checks-verdict.ts`: rename `currentVacuousFindings` → `currentReauthorFindings`; change the filter from `d.class !== "vacuous"` to `d.class !== "vacuous" && d.class !== "weak"` (count both). Leave `vacuousSignature` (the sorted AC-id `join`) **unchanged** — do NOT introduce `reason`. Update its comment to "keyed on ac_ids ALONE (reason-agnostic): a stuck AC repeats its signature whether stuck-vacuous, stuck-weak, or oscillating → escalate trips (§5)." Update `applyChecksVerdict`'s call site + any name references.
- [ ] Run green: `bun test test/daemon/checks-verdict.test.ts`. Commit: `feat(checks): re-author collector counts weak+vacuous; escalate signature stays AC-id-set`.

---

## Task 4: the implement-sees-checks seam (leaf — prompt-var + prompt)

Tell implement the authored AC-check `test_path`s + "make these pass; do NOT edit the check files."

**Files:** Modify `src/dispatch/prompt-vars.ts` (`implementVars`), `src/dispatch/handlers.ts` (`implement:dispatch`), `prompts/implement.md`.

- [ ] **Test first** — `test/dispatch/prompt-vars.test.ts` (extend or new):
```ts
test("implementVars renders the authored check paths + a do-not-edit instruction", () => {
  const vars = implementVars(ticket, unit, profile, "", [
    { test_path: "api/tests/styre_checks/ENG-1_ac7_test.py" },
  ]);
  expect(vars.authored_checks).toContain("ENG-1_ac7_test.py");
  expect(vars.authored_checks.toLowerCase()).toContain("do not edit");
});
test("implementVars with no authored checks renders an empty slot", () => {
  expect(implementVars(ticket, unit, profile, "", []).authored_checks).toBe("");
});
```
- [ ] Run red.
- [ ] In `prompt-vars.ts`, extend `implementVars` signature with `authoredChecks: { test_path: string | null }[] = []` and build the slot:
```ts
const paths = authoredChecks.map((c) => c.test_path).filter((p): p is string => p !== null);
const authored_checks = paths.length === 0 ? "" :
  `## Acceptance checks (make these pass — do NOT edit the check files)\n\n` +
  `These test files encode this ticket's acceptance criteria. Read them and write code so they pass. ` +
  `You MUST NOT edit, weaken, or delete them (the runner freezes them and fails the gate on any change):\n` +
  paths.map((p) => `- ${p}`).join("\n");
return { ...existing, authored_checks };
```
- [ ] In `handlers.ts` `implement:dispatch`, pass the ticket's checks:
```ts
vars: implementVars(ctx.ticket, unit, deps.profile, implementFeedback(ctx.db, unit.id),
  listAcChecks(ctx.db, ctx.ticket.id)),
```
  Add `listByTicket as listAcChecks` to the existing `../db/repos/ac-check.ts` import block. **Biome-alphabetize (FIX 5b):** it sorts between `insertAcCheck` and `listUnresolvedByTicket` (`listByTicket` < `listUnresolvedByTicket`):
```ts
import {
  classifyAcCheck,
  deleteByAc,
  deleteByTicket,
  insertAcCheck,
  listByTicket as listAcChecks,
  listUnresolvedByTicket,
} from "../db/repos/ac-check.ts";
```
- [ ] In `prompts/implement.md`, add `{{authored_checks}}` after the `{{feedback}}` line.
- [ ] Run green: `bun test test/dispatch/prompt-vars.test.ts`. Commit: `feat(implement): implement-sees-checks seam (authored-check paths + do-not-edit)`.

---

## Task 5: the check-file integrity gate module (leaf — net-new + unit tests)

**Files:** New `src/dispatch/check-integrity.ts`, `test/dispatch/check-integrity.test.ts`.

- [ ] **Test first** — a git repo fixture (mirror `verify-e2e.test.ts`'s `gitRepo()`): author a check file at commit A (authoring sha), record an `ac-check-red-first` signal with `branch_head_sha=A` and an `ac_check` row; then:
  - byte-identical at HEAD → `[]` (no violation);
  - modify the check file, commit B → one `check-file-modified` violation;
  - add a `conftest.py` in the check's dir at commit B → one `conftest-modified` violation;
  - modify an *unrelated* file (new dependency elsewhere), commit B → `[]` (no false-block);
  - an `ac_check` whose RED-first signal is missing → one `missing-authoring-sha` violation.
- [ ] Run red.
- [ ] Implement `check-integrity.ts`:
```ts
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { listByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { signalForAcCheck } from "../db/repos/ground-truth-signal.ts";
import { fileContentAt } from "./worktree.ts";

export interface IntegrityViolation {
  acId: number;
  acCheckId: number;
  path: string;
  reason: "check-file-modified" | "conftest-modified" | "missing-authoring-sha";
}

/** The conftest.py paths from the check file's directory up to (and including) the repo root.
 *  Freezing these closes the dominant autouse-fixture transitive-tamper vector (§7). A conftest that
 *  never existed (null at both shas) is not a violation; one that appeared or changed is. */
function conftestChain(testPath: string): string[] {
  const out: string[] = [];
  let dir = dirname(testPath);
  while (dir && dir !== "." && dir !== "/") {
    out.push(join(dir, "conftest.py"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  out.push("conftest.py"); // repo-root conftest
  return [...new Set(out)];
}

/** §2b integrity gate: every ac_check's test file (and any conftest.py in its dir chain) must be
 *  byte-identical between its checks:dispatch authoring sha and the verify HEAD. A difference means
 *  implement rewrote the check it is gated by. Reads both versions with `fileContentAt`
 *  (git show <sha>:<path>) — added-only check files (M2 §5.1) make a whole-file freeze clean. */
export function checkIntegrityViolations(
  db: Database,
  ticketId: number,
  worktreePath: string,
  headSha: string,
): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const check of listAcChecks(db, ticketId)) {
    if (check.test_path === null) continue;
    const authoringSha = signalForAcCheck(db, check.id)?.row.branch_head_sha ?? null;
    if (authoringSha === null) {
      violations.push({ acId: check.ac_id, acCheckId: check.id, path: check.test_path, reason: "missing-authoring-sha" });
      continue;
    }
    if (fileContentAt(authoringSha, check.test_path, worktreePath) !== fileContentAt(headSha, check.test_path, worktreePath)) {
      violations.push({ acId: check.ac_id, acCheckId: check.id, path: check.test_path, reason: "check-file-modified" });
    }
    for (const conftest of conftestChain(check.test_path)) {
      if (fileContentAt(authoringSha, conftest, worktreePath) !== fileContentAt(headSha, conftest, worktreePath)) {
        violations.push({ acId: check.ac_id, acCheckId: check.id, path: conftest, reason: "conftest-modified" });
      }
    }
  }
  return violations;
}
```
- [ ] Run green: `bun test test/dispatch/check-integrity.test.ts`. Commit: `feat(verify): check-file integrity gate (freeze check + conftest chain to authoring sha)`.

---

## Task 6: the post-implement re-run harness module (leaf — net-new + unit tests)

Re-run each authored check in the *implemented* env; gate by frozen `red_class`; record a separate result.

**Files:** New `src/dispatch/post-implement-rerun.ts`, `test/dispatch/post-implement-rerun.test.ts`.

- [ ] **Test first** (inject `run` so no real pytest needed; a scripted `CmdRunner` returns exit codes; component maps `test_path`→pytest):
  - an `assertion` check whose re-run is coarse `green` → not in `stillRed`; records an `ac-check-post-implement` signal `result:"pass"`;
  - an `assertion` check re-run coarse `red` → in `stillRed`;
  - an `absence` check re-run `red` → in `stillRed`;
  - an `environmental` check re-run `red` → in `advisory`, NOT `stillRed`;
  - a row with `disposition="satisfied"` → does not gate (not in `stillRed`/`advisory`), outcome `disposition`;
  - a row with `red_class=NULL AND disposition=NULL` → **throws** (loud NULL/NULL assertion).
- [ ] Run red.
- [ ] Implement `post-implement-rerun.ts`:
```ts
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { listByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { insertSignal } from "../db/repos/ground-truth-signal.ts";
import { type CoarseResult, binaryFor, frameworkFor } from "./check-selector.ts";
import { runCheckForRed } from "./checks-run.ts";
import { impactedComponents } from "./components.ts";
import type { Component } from "./profile.ts";
import { resolvePythonInterpreter } from "./provision.ts";
import type { CmdRunner } from "./reuse.ts";

export type GateOutcome = "green" | "gated-red" | "advisory-red" | "disposition" | "error";
export interface RerunResult {
  stillRed: number[];   // ac ids: a gated (assertion/absence) check that did NOT flip green
  advisory: number[];   // ac ids: an environmental check still red (report, don't block)
  ran: Array<{ acId: number; acCheckId: number; coarse: CoarseResult; outcome: GateOutcome }>;
}

async function rerunOne(p: RerunParams, testPath: string | null, selector: string): Promise<CoarseResult> {
  if (testPath === null) return "error";
  const comp = impactedComponents(p.components, [testPath])[0];
  const fw = comp ? frameworkFor(comp) : null;
  if (!comp || !fw) return "error";
  let interp: string | undefined;
  if (fw === "pytest") {
    try { interp = resolvePythonInterpreter(); } catch { return "error"; }
  }
  const res = await runCheckForRed({
    framework: fw, binary: binaryFor(fw, { interp }), runArgs: selector,
    cwd: join(p.worktreePath, comp.dir ?? ""), timeoutMs: p.timeoutMs, run: p.run,
  });
  // selected-none post-implement = the check no longer selects (identity lost) → NOT green.
  return res.coarse === "selected-none" ? "error" : res.coarse;
}

interface RerunParams {
  db: Database; ticketId: number; components: Component[];
  worktreePath: string; headSha: string; timeoutMs: number; run?: CmdRunner;
}

/** §4: re-run each authored check on the IMPLEMENTED HEAD (not the frozen authoring env). Gate on the
 *  frozen M3 red_class: assertion/absence must be green else gated; environmental → advisory;
 *  dispositions don't gate; NULL red_class AND NULL disposition = loud error. Records a separate
 *  `ac-check-post-implement` signal per check (distinct from red_class; M5 writes its own too). */
export async function rerunAcChecks(p: RerunParams): Promise<RerunResult> {
  const stillRed: number[] = [];
  const advisory: number[] = [];
  const ran: RerunResult["ran"] = [];
  for (const check of listAcChecks(p.db, p.ticketId)) {
    if (check.red_class === null && check.disposition === null) {
      throw new Error(
        `verify gate: ac_check ${check.id} (ac ${check.ac_id}) has neither red_class nor disposition — an unresolved check cannot gate`,
      );
    }
    if (check.disposition !== null) {
      ran.push({ acId: check.ac_id, acCheckId: check.id, coarse: "green", outcome: "disposition" });
      continue; // satisfied / not-expressible → M6 surfaces; does not gate
    }
    const coarse = await rerunOne(p, check.test_path, check.selector);
    let outcome: GateOutcome;
    if (check.red_class === "environmental") {
      outcome = "advisory-red";
      if (coarse !== "green") advisory.push(check.ac_id);
    } else if (coarse === "green") {
      outcome = "green";
    } else {
      outcome = "gated-red";
      stillRed.push(check.ac_id);
    }
    ran.push({ acId: check.ac_id, acCheckId: check.id, coarse, outcome });
    insertSignal(p.db, {
      ticketId: p.ticketId, signalType: "ac-check-post-implement",
      result: coarse === "green" ? "pass" : "fail", branchHeadSha: p.headSha,
      detail: { acCheckId: check.id, acId: check.ac_id, coarse, redClass: check.red_class, outcome },
    });
  }
  return { stillRed, advisory, ran };
}
```
- [ ] **Interpreter-on-PATH note (FIX 5c).** `rerunOne` calls `resolvePythonInterpreter()` (`provision.ts:180`), which resolves `python3`/`python` **from `$PATH`** (`Bun.which`) — exactly as `checks:dispatch` does. The re-run happens in the *implemented / re-provisioned* HEAD, so the re-provisioned interpreter (any venv/conda activation the provision step performed) MUST be on `PATH` when the gate handler runs, or `resolvePythonInterpreter` throws → `rerunOne` returns `"error"` → the check counts as still-red (a spurious gate-fail, not a false-pass — fails closed). No new resolution logic is introduced; this mirrors the existing `checks:dispatch` PATH contract. Add a one-line code comment at the `resolvePythonInterpreter()` call site noting the PATH dependency.
- [ ] Run green: `bun test test/dispatch/post-implement-rerun.test.ts`. Commit: `feat(verify): post-implement re-run harness (gate on frozen red_class, separate result)`.

---

## Task 7: the `verify:checks-gate` step + resolver placement + gate verdict (integration)

The centerpiece wiring. Handler runs integrity + re-run; resolver routes it; verdict loops/escalates. **Guarded to no-op when the ticket has zero `ac_check` rows** — inert for every existing test.

**Files:** Modify `src/dispatch/handlers.ts` (register step), `src/daemon/resolver.ts`, `src/daemon/advance.ts`; new `src/daemon/checks-gate-verdict.ts`, `test/daemon/checks-gate-verdict.test.ts`.

### 7a — the handler + resolver route (green path)

- [ ] **Test first** — `test/daemon/resolver.test.ts`: with all units verified and **zero** ac_checks, `nextStepKey` still returns `verify:integration` (gate skipped) — assert the existing test at ~line 187 is unchanged. Add a new test: with ≥1 ac_check and no `ac-check-gate` pass at HEAD, `nextStepKey` returns `step("verify:checks-gate", "verify", "verify:checks-gate", null)` (after provision).
- [ ] Run red.
- [ ] In `handlers.ts`, register `verify:checks-gate` (place after `verify:integration`):
```ts
registry.register("verify:checks-gate", async (ctx: HandlerContext) => {
  const checks = listAcChecks(ctx.db, ctx.ticket.id);
  if (checks.length === 0) return { gated: 0, stillRed: 0 }; // no AC-checks → nothing to gate
  const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
  ensureWorktree(repoPath, branch, worktreePath);
  const headSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha;
  if (!headSha) throw new Error("verify:checks-gate: no branch head sha");

  // §2b integrity FIRST — a tampered check is untrustworthy at re-run.
  const violations = checkIntegrityViolations(ctx.db, ctx.ticket.id, worktreePath, headSha);
  for (const v of violations) {
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id, signalType: "ac-check-integrity", result: "fail",
      branchHeadSha: headSha, detail: v,
    });
  }
  // §4 re-run in the implemented env (throws loud on a NULL/NULL row).
  const rerun = await rerunAcChecks({
    db: ctx.db, ticketId: ctx.ticket.id, components: deps.profile.components,
    worktreePath, headSha, timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS, run: deps.runCheckCommand,
  });
  // Gate blocks on the union of tampered ACs + not-flipped gated ACs.
  const stillRed = [...new Set([...violations.map((v) => v.acId), ...rerun.stillRed])].sort((a, b) => a - b);
  insertSignal(ctx.db, {
    ticketId: ctx.ticket.id, signalType: "ac-check-gate",
    result: stillRed.length === 0 ? "pass" : "fail", branchHeadSha: headSha,
    detail: { stillRed, tampered: violations.map((v) => v.acId), advisory: rerun.advisory },
  });
  return { gated: checks.length, stillRed: stillRed.length };
});
```
  Add imports: `checkIntegrityViolations` from `./check-integrity.ts`, `rerunAcChecks` from `./post-implement-rerun.ts` (`listAcChecks`, `getLatestForTicket`, `insertSignal` already imported).
- [ ] In `resolver.ts`, import `listByTicket as listAcChecks` from `../db/repos/ac-check.ts`. **Biome-alphabetize (FIX 5b):** import statements sort by source path, so this line goes immediately after `import type { Database } from "bun:sqlite";` and before `import { getLatestByWorkUnit, getLatestForTicket } from "../db/repos/dispatch.ts";` (`ac-check` < `dispatch`):
```ts
import type { Database } from "bun:sqlite";
import { listByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { getLatestByWorkUnit, getLatestForTicket } from "../db/repos/dispatch.ts";
```
  In the `implement` stage `allUnitsVerified` block, **before** the `verify:integration` gate:
```ts
const gateHasChecks = listAcChecks(db, ticketId).length > 0;
if (gateHasChecks) {
  const gatePassedShas = gts.passingShasFor(db, { ticketId, workUnitId: null, signalType: "ac-check-gate" });
  if (branchSha === null || !gatePassedShas.includes(branchSha)) {
    if (!done(db, ticketId, "provision")) return step("provision", "provision", "provision", null);
    return step("verify:checks-gate", "verify", "verify:checks-gate", null);
  }
}
```
  (Place `branchSha` computation so it precedes this — it is already computed at the top of the block for the integration check; hoist if needed.)

**FIX 2 — the failure-policy escalate-guard (the gate handler can THROW).** The `verify:checks-gate` handler throws on missing-branch-sha / git faults, and `rerunAcChecks` throws on a NULL/NULL row (loud, by design). A throw → the step is marked `failed` → `advanceOneStep` routes to `applyFailurePolicy`. Because the gate is `step_type:"verify"` with `work_unit_id === null`, it would land in the **integration-reconcile branch** (`failure-policy.ts:148-170`) — spawning a spurious `reconcile` work-unit and a `loop:"integration"` event, exactly the branch decision #5 designed the gate to sidestep. Add a clean escalate-guard **before** that branch.

- [ ] **Test first** — `test/daemon/failure-policy.test.ts`: a failed `verify:checks-gate` step (`step_type:"verify"`, `work_unit_id:null`) with `attempt < maxAttempts` → `applyFailurePolicy` returns `{decision:"escalated"}`, ticket `waiting`, a `human_resume` signal, and **no** `reconcile` work-unit / `loop:"integration"` event is created.
- [ ] Run red.
- [ ] In `failure-policy.ts`, add — after the `provision` escalate guard and **before** `if (step.step_type === "verify" && step.work_unit_id !== null)` — :
```ts
// A throwing verify:checks-gate is an infra/invariant fault (missing branch sha, git fault, or a
// NULL/NULL unresolved check), NOT a still-red verdict — that path SUCCEEDS and routes via
// applyAcCheckGateVerdict (advance.ts onSucceed). Escalate cleanly; never spin up an
// integration-reconcile unit for it (review FIX 2).
if (step.step_key === "verify:checks-gate") {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, {
      ticketId,
      signalType: "human_resume",
      reason: `step 'verify:checks-gate' failed: ${failureSignature(step)}`,
    });
    appendEvent(db, {
      ticketId,
      kind: "escalated",
      reason: "verify:checks-gate failed (infra/invariant fault)",
      signature: failureSignature(step),
    });
  })();
  return { decision: "escalated" };
}
```
  (`setTicketStatus`, `insertSignal`, `appendEvent`, `failureSignature` are all already imported/defined in `failure-policy.ts`.)
- [ ] Run green: `bun test test/daemon/resolver.test.ts test/daemon/failure-policy.test.ts`. Commit: `feat(verify): verify:checks-gate step + resolver routing (green path) + failure-policy escalate-guard`.

### 7b — the gate verdict (loopback / escalate)

- [ ] **Test first** — `test/daemon/checks-gate-verdict.test.ts`:
  - `stillRed=[]` (a passing `ac-check-gate` signal) → `{decision:"clean"}`;
  - `stillRed=[1,2]` first time → `{decision:"loopback"}`; all units reset to `pending`; the `verify:checks-gate` step reset to `pending`; a `loop:"implement"` event with `routeTo:"verify:checks-gate"` + signature `gate:1,2`;
  - the same `stillRed=[1,2]` as the immediately-prior gate loopback → `{decision:"escalated"}`; ticket `waiting` + a `human_resume` signal.
- [ ] Run red.
- [ ] Implement `src/daemon/checks-gate-verdict.ts`:
```ts
import type { Database } from "bun:sqlite";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { listByTicket as listSignals } from "../db/repos/ground-truth-signal.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { listByTicket as listUnits, setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { getByKey, listStepsForUnit, resetToPending } from "../db/repos/workflow-step.ts";

export interface GateVerdictResult { decision: "clean" | "loopback" | "escalated"; }

/** The still-red AC-id set of the latest `ac-check-gate` signal (empty when the gate passed). */
function latestStillRed(db: Database, ticketId: number): number[] {
  const sigs = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-gate");
  const latest = sigs[sigs.length - 1];
  if (!latest) return [];
  return ((JSON.parse(latest.detail_json ?? "{}") as { stillRed?: number[] }).stillRed ?? []).slice().sort((a, b) => a - b);
}

function gateSignature(stillRed: number[]): string {
  return `gate:${stillRed.join(",")}`;
}

/** Predecessor-only compare (§5): the prior gate-origin implement loopback carried this signature. */
function isRepeatedGateLoopback(db: Database, ticketId: number, signature: string): boolean {
  const prior = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement" && e.route_to === "verify:checks-gate",
  );
  return prior[prior.length - 1]?.signature === signature;
}

/** M4 gate verdict: a still-red gated AC-check drives a bounded loopback-to-implement (reset all units
 *  + re-arm the gate); a repeated still-red AC-id set escalates. Ground-truth over self-report —
 *  reads the persisted `ac-check-gate` signal, never an agent verdict. Mirrors applyChecksVerdict. */
export function applyAcCheckGateVerdict(
  db: Database, ticketId: number, _opts: { stepKey: string },
): GateVerdictResult {
  const stillRed = latestStillRed(db, ticketId);
  if (stillRed.length === 0) return { decision: "clean" };
  const signature = gateSignature(stillRed);
  if (isRepeatedGateLoopback(db, ticketId, signature)) {
    db.transaction(() => {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, { ticketId, signalType: "human_resume", reason: `gate: AC-check(s) ${stillRed.join(",")} still red after re-implement` });
      appendEvent(db, { ticketId, kind: "escalated", reason: "no progress: identical still-red AC-check gate", signature });
    })();
    return { decision: "escalated" };
  }
  db.transaction(() => {
    for (const u of listUnits(db, ticketId)) {
      setUnitStatus(db, u.id, "pending");
      for (const s of listStepsForUnit(db, ticketId, u.id)) resetToPending(db, s.id);
    }
    const gate = getByKey(db, ticketId, "verify:checks-gate");
    if (gate) resetToPending(db, gate.id);
    appendEvent(db, {
      ticketId, kind: "loopback", loop: "implement", routeTo: "verify:checks-gate",
      signature, payload: { acIds: stillRed },
    });
  })();
  return { decision: "loopback" };
}
```
- [ ] In `advance.ts`: add `"verify:checks-gate"` to `VERDICT_BEARING_STEPS`; in the `onSucceed` branch, extend the ternary:
```ts
verdictBox.value =
  d.stepKey === "checks:classify" ? applyChecksVerdict(db, ticketId, { stepKey: d.stepKey })
  : d.stepKey === "verify:checks-gate" ? applyAcCheckGateVerdict(db, ticketId, { stepKey: d.stepKey })
  : applyReviewVerdict(db, ticketId, cfg, { stepKey: d.stepKey });
```
  (`verdictBox` typed as the union of `ReviewVerdictResult | ChecksVerdictResult | GateVerdictResult | null`; all share `{decision}`.) Import `applyAcCheckGateVerdict`.
- [ ] **Audit sub-step (flag #3):** grep `test/` for any test that authors `ac_check` rows and drives to the `review`/`merge` stage; ensure either the gate no-ops (no checks) or the fakes flip the checks green. Fix any that break.
- [ ] Run green: `bun test test/daemon/checks-gate-verdict.test.ts test/daemon/advance.test.ts test/daemon/resolver.test.ts`. Commit: `feat(verify): AC-check gate verdict (loopback-to-implement + escalate-on-repeat)`.

### 7c — the gate-fail re-code feedback carrier (review FIX 3)

On a gate-fail loopback, re-code sees the check *files* (the Task-4 `{{authored_checks}}` seam) but not *which* checks are still red. That still-red set is **ticket-level** — it lives on the `ac-check-gate` signal's `detail.stillRed` at `work_unit_id = null`. `implementFeedback` (`feedback.ts:7-41`) is **unit-scoped** (`listByUnit(workUnitId)`) so it can NEVER read it — a tweak to `implementFeedback` (the earlier plan idea) is structurally wrong. Add a NET-NEW ticket-level `gateFeedback` and thread it as a DISTINCT prompt-var (not folded into `{{authored_checks}}`, which lists ALL checks regardless of status).

**Files:** Modify `src/dispatch/feedback.ts`, `src/dispatch/prompt-vars.ts` (`implementVars`), `src/dispatch/handlers.ts` (`implement:dispatch`), `prompts/implement.md`; extend `test/dispatch/feedback.test.ts`.

- [ ] **Test first** — `test/dispatch/feedback.test.ts`:
```ts
test("gateFeedback lists the still-red ACs + their check paths from the ac-check-gate signal", () => {
  // arrange: an ac_check row (ac_id=7, test_path='api/tests/styre_checks/ENG-1_ac7_test.py'),
  // an acceptance_criterion (id=7, text='returns the created record'), and an ac-check-gate signal
  // with detail {"stillRed":[7]} at work_unit_id=null.
  const fb = gateFeedback(db, ticketId);
  expect(fb).toContain("AC 7");
  expect(fb).toContain("ENG-1_ac7_test.py");
  expect(fb.toLowerCase()).toContain("do not edit");
});
test("gateFeedback is empty when the latest gate passed (stillRed=[])", () => {
  // arrange: an ac-check-gate signal with detail {"stillRed":[]}
  expect(gateFeedback(db, ticketId)).toBe("");
});
test("gateFeedback is empty when no gate signal exists", () => {
  expect(gateFeedback(db, ticketId)).toBe("");
});
```
- [ ] Run red.
- [ ] In `feedback.ts`, add the imports and the function (the existing file already imports `Database` and `listByUnit as ground-truth`; add the two ticket-level lists, biome-alphabetized by source: `../db/repos/ac-check.ts` < `../db/repos/acceptance-criterion.ts` < `../db/repos/ground-truth-signal.ts`):
```ts
import { listByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { listByTicket as listAcs } from "../db/repos/acceptance-criterion.ts";
import { listByTicket as listSignals } from "../db/repos/ground-truth-signal.ts";

/** Corrective feedback for a gate-fail loopback: WHICH acceptance-checks are still red. UNLIKE
 *  implementFeedback (unit-scoped, reads per-unit verify signals), this reads the TICKET-level
 *  `ac-check-gate` signal — the only place the still-red AC-id set lives (§4). Empty string when the
 *  gate never ran or passed (stillRed empty). Reason-agnostic: the still-red set drives re-code. */
export function gateFeedback(db: Database, ticketId: number): string {
  const gateSigs = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-gate");
  const latest = gateSigs[gateSigs.length - 1];
  if (!latest) return "";
  const stillRed =
    (JSON.parse(latest.detail_json ?? "{}") as { stillRed?: number[] }).stillRed ?? [];
  if (stillRed.length === 0) return "";
  const acText = new Map(listAcs(db, ticketId).map((a) => [a.id, a.text]));
  const pathsByAc = new Map<number, string[]>();
  for (const c of listAcChecks(db, ticketId)) {
    if (c.test_path === null) continue;
    const arr = pathsByAc.get(c.ac_id) ?? [];
    arr.push(c.test_path);
    pathsByAc.set(c.ac_id, arr);
  }
  const lines = stillRed.map((acId) => {
    const paths = pathsByAc.get(acId) ?? [];
    const where = paths.length > 0 ? paths.join(", ") : "(check file unknown)";
    const text = acText.get(acId) ?? "";
    return `- AC ${acId}${text ? `: ${text}` : ""} — still-red check(s): ${where}. Make the code satisfy it.`;
  });
  return (
    `The acceptance-check gate failed: these acceptance criteria are not yet satisfied by your code. ` +
    `Do NOT edit, weaken, or delete the check files (the runner freezes them and re-fails the gate on any change) — fix the CODE so they pass:\n` +
    lines.join("\n")
  );
}
```
- [ ] In `prompt-vars.ts`, extend `implementVars` with a trailing `gateFeedbackText = ""` param (after Task 4's `authoredChecks`) and return `gate_feedback: gateFeedbackText`:
```ts
export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: WorkUnitRow,
  profile: Profile,
  feedback = "",
  authoredChecks: { test_path: string | null }[] = [],
  gateFeedbackText = "",
): Record<string, string> {
  // ...existing body (incl. Task 4's authored_checks build)...
  return { /* ...existing... */, authored_checks, gate_feedback: gateFeedbackText };
}
```
- [ ] In `handlers.ts`, add `gateFeedback` to the `./feedback.ts` import (biome: `gateFeedback` < `implementFeedback`) → `import { gateFeedback, implementFeedback } from "./feedback.ts";`, and pass it in `implement:dispatch`:
```ts
vars: implementVars(ctx.ticket, unit, deps.profile, implementFeedback(ctx.db, unit.id),
  listAcChecks(ctx.db, ctx.ticket.id), gateFeedback(ctx.db, ctx.ticket.id)),
```
- [ ] In `prompts/implement.md`, add `{{gate_feedback}}` on its own line AFTER `{{authored_checks}}` (distinct slot; empty except on a gate loopback).
- [ ] Run green: `bun test test/dispatch/feedback.test.ts test/dispatch/prompt-vars.test.ts`. Commit: `feat(verify): gate-fail feedback carrier (still-red AC text to re-code, ticket-level)`.

---

## Task 8: demote the per-unit `verify:check` AND `verify:integration` to advisory (the "rework in place")

Stop `verify:check` (per-unit) AND `verify:integration` (repo-wide) from hard-gating: record the real result as an advisory signal, **never throw**, and advance routing once a check-type has *run* at the current sha. The AC-check gate (Task 7) is now the only per-change hard gate. **This is the biggest test-churn task** — sub-staged 8a (per-unit handler) · 8b (per-unit routing + `ranShasFor` + failure-policy cleanup + test rewrites) · 8c (demote `verify:integration`, review FIX 1) · 8d (reset ticket-level verify steps on cross-loopbacks, review FIX 4).

**Files:** Modify `src/dispatch/handlers.ts` (`verify:check`, `verify:integration`), `src/daemon/resolver.ts` (`nextUnrunCheck` + the integration gate), `src/db/repos/ground-truth-signal.ts` (new `ranShasFor`), `src/daemon/failure-policy.ts` (dead verify branch + integration-reconcile reset), `src/daemon/review-verdict.ts` (loopback resets); rewrite `test/dispatch/verify-e2e.test.ts`, `test/dispatch/verify-routing.test.ts`, `test/dispatch/verify-handlers.test.ts`, `test/dispatch/verify-integration.test.ts` (FIX 5a — asserts the demoted throw), `test/dispatch/feedback.test.ts`, `test/daemon/failure-policy.test.ts`, `test/daemon/resolver.test.ts`, `test/daemon/review-verdict.test.ts`.

### 8a — the handler stops throwing (advisory)

- [ ] **Test first** — rewrite `verify-handlers.test.ts`: a failing component test command now records the check-type signal as **advisory** and the handler **returns** (no throw). Keep the empty-diff / no-components / behavioral-no-code **hard errors** (these are still real preconditions, not the suite verdict). Add: a suite failure records `result:"fail"` in the check-type signal but the step still succeeds (routing advances).
- [ ] Run red.
- [ ] In `verify:check`, change the terminal gate: replace the final `if (result !== "pass") throw ...` with recording the (possibly-fail) result as an advisory signal and returning normally. Keep `result` in the recorded signal for observability; add `advisory: true` to its `detail`. Do the same for the behavioral-A1 block (record a `fail` detail, do not set a throwing `result`). The `realImpacted` run loop and the sweep stay — only their throwing fate changes. Keep the empty-diff / no-components / behavioral-no-code / check-absent guards throwing (real preconditions).
- [ ] Run green for the handler tests. Commit: `feat(verify): demote per-unit verify:check component-suite to advisory (no throw)`.

### 8b — routing "ran at sha" + failure-policy cleanup + test rewrites

- [ ] **Test first** — `resolver.test.ts`: after `verify:check` records ANY result (pass OR fail) at the unit's current sha, `nextUnrunCheck` returns the *next* check-type (or `null` → mark-verified). A per-unit suite failure no longer wedges the unit.
- [ ] Run red.
- [ ] Introduce `ranShasFor` beside `passingShasFor` in `ground-truth-signal.ts` (mirror it, DROP the `result='pass'` clause — any recorded signal at the sha counts). This is reused by 8c for the integration gate:
```ts
/** Like passingShasFor but result-agnostic: the shas at which a signal of this type was RECORDED
 *  (any result). Used to route advisory gates (verify:check, verify:integration) on "ran at sha",
 *  so a recorded advisory `fail` still advances instead of re-emitting forever (M4 demotion). The
 *  HARD AC-check gate keeps using passingShasFor (`result='pass'`) — do NOT swap it here. */
export function ranShasFor(
  db: Database,
  args: { ticketId: number; workUnitId: number | null; signalType: string },
): string[] {
  const rows = db
    .query<{ branch_head_sha: string | null }, [number, number | null, string]>(
      `SELECT branch_head_sha FROM ground_truth_signal
       WHERE ticket_id = ? AND work_unit_id IS ? AND signal_type = ?
         AND branch_head_sha IS NOT NULL`,
    )
    .all(args.ticketId, args.workUnitId, args.signalType);
  return rows.map((r) => r.branch_head_sha).filter((s): s is string => s !== null);
}
```
- [ ] In `resolver.ts` `nextUnrunCheck`, change the "passed at sha" test to "**ran** at sha": swap `gts.passingShasFor` → `gts.ranShasFor` (rename the local `passedShas` → `ranShas` for clarity). A check-type is satisfied once a `ground_truth_signal` of that `signal_type` exists at the current sha (any result). **Note:** the AC-check gate remains content-keyed on `result='pass'` (Task 7) — do NOT relax that.
- [ ] In `failure-policy.ts`, the `verify` + `work_unit_id !== null` branch is now only reachable on an *infra crash* (the handler no longer throws on a suite verdict). Keep the `latestVerifyResult === "error" → retry` path; the "genuine failure → loopback" path is effectively dead for `verify:check` but keep it for any other unit-scoped verify step. Update `failure-policy.test.ts` accordingly (the verify-loopback-on-fail test becomes a gate-verdict test in Task 7's suite; delete or repoint it).
- [ ] Rewrite `verify-e2e.test.ts` / `verify-routing.test.ts` / `feedback.test.ts`: a red component suite no longer loops implement via `verify:check`; the unit reaches `verified` and the advisory signal is present. `implementFeedback` no longer receives the suite failure as a gating item (it already filters `scope_diff`/`ran-all-unowned`; add the advisory suite signal to the same non-feeding set if it would otherwise mislead re-code).
- [ ] Run green: `bun test test/dispatch/ test/daemon/`. Commit: `feat(verify): route on check-ran-at-sha; prune the dead verify hard-gate path`.

### 8c — demote `verify:integration` to advisory (review FIX 1)

The repo-wide integration gate is demoted to match the design (§3/§7). **The throw removal is coupled with the resolver gate flip — remove the throw ALONE and you deadlock:** the resolver gates integration on a *pass* at HEAD (`resolver.ts:~138`, `passingShasFor(…, "integration")`). A handler that records an advisory `fail` leaves no pass at HEAD → the resolver re-emits `verify:integration` → `runStep` replays the recorded success without re-running (`step-journal.ts:74-80`) → re-emit → `advanceOneStep` hits `MAX_TRANSITIONS` (`advance.ts:18,157`). So swap the gate to `ranShasFor` (from 8b) in the same sub-stage.

- [ ] **Test first — rewrite `verify-integration.test.ts` (FIX 5a).** The existing "verify:integration fails when one component's test command fails" test (`:110`) currently asserts `outcome.kind ∈ {retry,loopback,escalated}` (i.e. the throw routed through failure-policy). Rewrite it: the integration signal still records `result:"fail"`, but the step now **succeeds** (`outcome.kind === "stepped"`) and routing **advances past integration** (a second `advanceOneStep` reaches `docs:revise`/review, not a re-emitted `verify:integration`). Keep the "nothing to run" precondition test throwing (that guard stays). Assert the recorded signal carries `detail.advisory === true`.
- [ ] Run red.
- [ ] In `handlers.ts` `verify:integration`, replace the terminal `if (result !== "pass") throw new Error(\`verify:integration: ${result}\`);` with a normal `return { integration: result };` — the `integration` signal is already inserted just above with the real `result`; add `advisory: true` to its `detail` (alongside `ran`). Keep the precondition throw (`"verify:integration: nothing to run"`) and the no-branch-sha handling unchanged (real preconditions, not the suite verdict).
- [ ] In `resolver.ts`, in the `allUnitsVerified` block, change the integration gate from `gts.passingShasFor` to `gts.ranShasFor` (rename `integrationPassedShas` → `integrationRanShas`): the step is satisfied once an `integration` signal (any result) exists at HEAD, so an advisory `fail` advances instead of re-emitting.
```ts
const integrationRanShas = gts.ranShasFor(db, {
  ticketId,
  workUnitId: null,
  signalType: "integration",
});
if (branchSha === null || !integrationRanShas.includes(branchSha)) {
  if (!done(db, ticketId, "provision")) {
    return step("provision", "provision", "provision", null);
  }
  return step("verify:integration", "verify", "verify:integration", null);
}
```
- [ ] **Failure-policy note (FIX 1d):** the `failure-policy.ts:148-170` integration-reconcile branch (`step.step_type === "verify" && step.work_unit_id === null`) now fires ONLY on an infra crash (the handler threw before/without recording a verdict — e.g. "nothing to run", a git fault), never on a genuine test `fail` (that path now SUCCEEDS + advises). No code change to the branch body here (its reset is extended in 8d); just confirm no test asserts a genuine-fail integration-reconcile — repoint any that does to the advisory-advance behavior.
- [ ] Rewrite any other test asserting the integration hard-gate (grep `test/` for `signal_type = 'integration'` + a loopback/escalate assertion). The advisory sweep to the PR body (`renderPrBody`, already reads `ran-all-unowned`) is unaffected; integration advisory failures are surfaced to the MERGE human by M6 (out of scope here).
- [ ] Run green: `bun test test/dispatch/verify-integration.test.ts test/daemon/resolver.test.ts test/daemon/failure-policy.test.ts`. Commit: `feat(verify): demote verify:integration to advisory (ran-at-sha gate)`.

### 8d — reset ticket-level verify steps on cross-loopbacks (review FIX 4)

After the gate (and integration) succeed, a later loopback that MOVES HEAD but does **not** reset the ticket-level verify steps replays the stale success: `runStep` returns the recorded `verify:checks-gate`/`verify:integration` success (`step-journal.ts:74-80`) → the resolver's content-keyed gate re-emits (no pass/ran signal at the NEW HEAD) → `MAX_TRANSITIONS`. Three cross-loopbacks move HEAD without resetting these steps today: `review-verdict.ts` `codeLoopback` (`:55-88`) and `redesignLoopback` (`:107-124`), and the `failure-policy.ts:148-170` integration-reconcile branch. (Pre-existing and identical for `verify:integration`; currently untested because `review-e2e.test.ts:197-200` seeds `stage='review'` to bypass re-verify — M4 makes re-verify live.)

- [ ] **Test first** — `test/daemon/review-verdict.test.ts`: seed a ticket with a **succeeded** `verify:checks-gate` (and `verify:integration`) step, then drive a code-review `codeLoopback`. Assert both ticket-level verify steps are reset to `pending` (`getByKey(...).status === "pending"`), so the next resolver pass re-verifies rather than replaying the stale success. Add the parallel case for `redesignLoopback` (design-defect route) and for the integration-reconcile branch in `failure-policy.test.ts`.
- [ ] Run red.
- [ ] In `review-verdict.ts`, add a tiny shared helper and call it inside the transaction of BOTH `codeLoopback` and `redesignLoopback` (after the existing per-unit / design-step resets, before `appendEvent`):
```ts
/** Ticket-level verify steps re-arm on any HEAD-moving loopback: their recorded success is content-
 *  keyed to the OLD head, so leaving them 'succeeded' replays a stale gate pass at the new HEAD →
 *  resolver re-emit → MAX_TRANSITIONS. Reset is a no-op when a step doesn't exist (getByKey null). */
function resetTicketVerifySteps(db: Database, ticketId: number): void {
  for (const key of ["verify:integration", "verify:checks-gate"]) {
    const s = getByKey(db, ticketId, key);
    if (s) resetToPending(db, s.id);
  }
}
```
  `getByKey` and `resetToPending` are already imported in `review-verdict.ts`. Call `resetTicketVerifySteps(db, ticketId);` inside each loopback's `db.transaction(() => { ... })`.
- [ ] In `failure-policy.ts`, in the integration-reconcile branch (`step.step_type === "verify" && step.work_unit_id === null`), the branch already `resetToPending(db, step.id)`s the integration step itself; ALSO reset the sibling `verify:checks-gate` (a reconcile unit moves HEAD, so the passed gate must re-run):
```ts
const gate = getByKey(db, ticketId, "verify:checks-gate");
if (gate) resetToPending(db, gate.id);
```
  (`getByKey` is imported in `failure-policy.ts`? — it imports `resetToPending, listStepsForUnit`; add `getByKey` to that `../db/repos/workflow-step.ts` import, biome-alphabetized: `getByKey` < `listStepsForUnit` < `resetToPending`.)
- [ ] **Audit (flag #3):** confirm the review-loopback path in `review-e2e.test.ts:197-200` still passes — it re-seeds `stage='review'` + units `verified` AFTER the loopback, so the newly-reset verify steps sit in the skipped `implement` stage; no assertion should break. Fix if it does.
- [ ] Run green: `bun test test/daemon/review-verdict.test.ts test/daemon/failure-policy.test.ts test/dispatch/review-e2e.test.ts`. Commit: `feat(verify): reset ticket-level verify steps on cross-loopbacks (re-verify after HEAD moves)`.

---

## Task 9: end-to-end integration tests (FakeAgentRunner)

**Files:** New `test/dispatch/verify-gate-e2e.test.ts`. Drive the loop with `advanceOneStep` + a git-repo fixture + a scripted `runCheckCommand` (the injectable RED-first executor) so no real framework runs.

- [ ] **The gate blocks a not-green assertion check.** Arrange: an `ac_check` with `red_class='assertion'`, authoring sha = a commit A; the fake implement leaves the check red (scripted runner returns exit 1). Tick to the gate: assert `ac-check-gate` signal `result:"fail"`, verdict decision `loopback`, all units reset to `pending`. Second identical round → `escalated`, ticket `waiting`.
- [ ] **The integrity gate fails on a tampered check.** Arrange: an `ac_check` authored at A whose `test_path` content differs at HEAD (implement rewrote it). Assert an `ac-check-integrity` violation signal, the AC in `stillRed`, decision `loopback` — even though the scripted re-run would read green.
- [ ] **The advisory sweep does not block (per-unit AND repo-wide).** Arrange: a passing AC-check gate (assertion flips green) but BOTH a failing component whole-suite (`verify:check` records advisory `fail`) and a failing repo-wide `verify:integration` (records advisory `fail`). Assert the ticket advances implement→review (both failures recorded, neither gates; routing is "ran at sha" for each — no `MAX_TRANSITIONS`).
- [ ] **A code-loopback re-verifies (FIX 4 end-to-end).** Arrange: a ticket whose gate passed and reached `review`, then a blocking code-review finding drives `codeLoopback`. Assert the ticket re-runs `verify:checks-gate` (its step was reset to `pending`) after re-implement — not a replay of the stale success — and does not hit `MAX_TRANSITIONS`.
- [ ] **The weak-flag re-author + escalate** (may live in `checks-reauthor-e2e.test.ts`): a `weak` classification drives a `loop:"checks"` re-author; a repeated AC-id set escalates.
- [ ] Run green: `bun test test/dispatch/verify-gate-e2e.test.ts`. Commit: `test(verify): M4 gate e2e — blocking, integrity, advisory, weak-reauthor`.

---

## Task 10: the M5 co-release note

M4's gate false-blocks a correct ticket on a wrong-shape check (§7); M5's arbiter is the fix. Record the hard constraint so a release cut never ships M4's gate without M5.

**Files:** Modify the release checklist doc (grep `docs/` for the release-cut checklist; if none, add to `brainstorm.md` §11 changelog per CLAUDE.md append-only rule).

- [ ] Add: "**M4 gate co-release (hard):** the change-scoped AC-check gate must not reach a release without M5's arbiter (re-authors a persistent wrong-shape red instead of thrashing implement) and M6's MERGE projection. Satisfied by the operator's not-release-until-M6 commitment (2026-07-08)."
- [ ] Commit: `docs(m4): record the M5/M6 gate co-release constraint`.

---

## Final verification

- [ ] `bun test` — full suite green.
- [ ] `bunx tsc --noEmit` (or the repo's typecheck) — clean.
- [ ] Manual trace: confirm three distinct records exist for a gated check after a run — the M3 `ac-check-red-first` (clean-HEAD), the M4 `ac-check-post-implement` (flip), and room for M5's own — with `red_class` never overwritten.
- [ ] Confirm no schema file changed (decision #1).
- [ ] Open a PR into `main` (no auto-merge; operator merges).
