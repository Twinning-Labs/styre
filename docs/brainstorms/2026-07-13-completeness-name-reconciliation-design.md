# Completeness name-reconciliation — design

**Status:** proposed (brainstorm, pre-plan)
**Author:** derived from the 2026-07-11 SMOKE=2 validation dig (astropy-12907 + darkreader-7241)
**Scope of change:** `src/dispatch/completeness.ts` (`reconcileScope`) + its handler in `src/dispatch/handlers.ts`, and a design-prompt naming-stance tweak (`prompts/design-extract.md`). **No schema change. No gate removed.**

---

## 1. Problem

The deterministic completeness gate (`reconcileScope`) computes a work unit's under-delivery as an **exact-string set difference**:

```ts
under = declared.filter((f) => !cumulativeTouched.has(f))   // completeness.ts
```

`declared` is the design agent's *predicted* `files_to_touch`; `cumulativeTouched` is the **actual** ticket git diff. The gate false-flags "under-delivered" whenever the correct work lands at a path design did not predict **character-for-character** — even though the work was done. Two observed manifestations, both from repeated bench runs against a correct fix:

- **astropy-12907 (fatal).** Design declared the changelog fragment as `docs/changes/modeling/<id>.bugfix.rst` — an unresolved **placeholder**, because astropy's towncrier fragments are named by PR number, which does not exist at implement time. Implement correctly wrote `docs/changes/modeling/12907.bugfix.rst`. `"<id>…" ≠ "12907…"` → false under-delivered → the placeholder path is uncreatable → loopback can never satisfy it → **escalate → blocked**. (Verified: implement *did* write the file, correctly named; the gate simply could not recognize it.)

- **darkreader-7241 (churn).** Design declared a regression-test file `tests/generators/utils/parse.tests.ts` (an **existing** file — the idiomatic co-location choice). But `checks:dispatch` is architecturally required to author its RED-first test into a **brand-new, integrity-frozen** file (`ENG-288_ac1.tests.ts`; `check-integrity.ts` freezes the check file byte-for-byte between authoring and verify, and the added-only rule closes the "hide a false-green inside an existing test" vector). So the declared test path and the real test path **can never align**. `under = [parse.tests.ts]` → wasted loopback (recovered late; died downstream on the unrelated `merge:push` blocker).

Both are one disease: **completeness exact-matches design's *predicted* filenames against the *actual* produced files, and false-flags when correct work lands at an unpredicted path** — via a placeholder (astropy) or because a different subsystem owns and names the file (darkreader).

### Why "a different reason every time"

Across nine analysed astropy runs, the design decomposition and the one-line `separable.py` fix were **byte-identical every run** — styre *solves* the bug every time. Failures migrated between gates (env/tox → merge:push → completeness) as outer bugs were fixed; the completeness wedge is the innermost layer, exposed only once provisioning and push were repaired. It is not a family of bugs; it is one gate applying the wrong matcher.

---

## 2. Principle

Completeness is an **existence** gate: "was the declared artifact actually produced?" It is the right tool when *existence is the whole requirement* (code files, docs/changelog) and it must stay. The bug is not the gate — it is that the gate demands design **predict an exact filename it cannot know**, for artifacts whose final name is determined later (by a PR number) or by another subsystem (`checks:dispatch`).

**The fix keeps every gate and removes no capability. Two coordinated changes:**

1. **Design's *naming stance* loosens.** Design may declare a **placeholder/pattern** for artifacts it cannot name exactly, instead of pinning a fake exact path. Design still declares the artifact is needed, still declares tests/checks are needed, still accounts for the checks→AC mapping. Only the *naming* becomes honest about what design can and cannot know.

2. **Completeness's *matcher* becomes reality-aware.** Instead of pure exact-string matching, the runner resolves each declared entry against what was actually produced — using data it already holds. The gate still fires (a required artifact that is genuinely absent is still `under-delivered` → loopback); it just stops checking the *wrong* string.

This is the "design declares flexibly; completeness resolves the declaration against the artifact that was actually produced, by the appropriate authority" model.

---

## 3. Design

`reconcileScope` gains a **typed, three-mode resolution** of each declared `files_to_touch` entry against the cumulative diff. The mode is inferred from the entry (no new schema field required — the entry stays a string):

| Declared entry | Resolution mode | Satisfied when |
|---|---|---|
| Ordinary code/docs path (no placeholder token, not a test file) | **exact** (unchanged) | the exact path is in `cumulativeTouched` |
| Path containing a placeholder token (e.g. `…/<id>.bugfix.rst`) | **wildcard** | some file in `cumulativeTouched` matches the path with each `<token>` treated as a glob wildcard |
| Test file (`isTestFile(path, profile.testFilePattern)`) | **checks-registry** | the checks system authored a live test — i.e. an active `ac_check.test_path` (from `listActiveByTicket`) is present in `cumulativeTouched` |

`over` (advisory scope-diff) is computed as today, with **one addition**: `isTestFile()` paths are excluded from `over`, so a stray implement-authored test does not produce out-of-scope noise now that tests are resolved via the registry rather than by declared name. `over` remains advisory (non-blocking).

### Data grounding (verified in code, styre @ 52b5e02)

- `ac_check.test_path` holds every checks-authored test file; `listActiveByTicket(db, ticketId)` returns the active (non-superseded) set. The completeness handler already has `ctx.db` + `ctx.ticket.id`, so it can read them.
- `acceptance_criterion` and `ac_check` carry **no `work_unit_id`** — they are **ticket-level**. Resolution is therefore ticket-level: a test-typed declared entry on any unit is satisfied by the presence of the ticket's authored tests in the cumulative diff. This is deliberate — it avoids inventing a unit↔AC schema link (which would be a large, non-minimal change) and matches the existing data model.
- `commit-scope.ts` already whitelists `checksAuthored[].test_file`, and checks' tests are authored in a separate dispatch, so they do not appear in an implement unit's own-diff — they were never flagged as `over` and are not double-counted.

### Design-prompt change (`prompts/design-extract.md`)

State the naming stance explicitly: when a file's exact name cannot be known at design time (a changelog fragment named by an unborn PR number; a test file authored and named by `checks:dispatch`), declare it with a placeholder token rather than a guessed exact name. Keep the existing instruction that the changelog is soft-gated ("consider whether a significant change warrants a doc note") and that behavioral units must carry `verify_check_types: ["test"]` — those are unchanged; only the *naming* guidance is added.

---

## 4. Scoped outcomes

- **astropy (changelog = existence-artifact):** design declares `…/<id>.bugfix.rst`; completeness wildcard-matches it against the diff → `12907.bugfix.rst` satisfies it. The changelog is **still required, still gated, still shipped**. The gate stops demanding a name design could not know. (PR-quality nicety, not load-bearing: the prompt may steer toward towncrier's unnumbered `+slug.bugfix.rst` form so the agent need not guess a number at all.)

- **darkreader (test = behavioral-artifact):** completeness resolves the test-typed declared entry against `ac_check.test_path` (the real authored test), *using* the checks→AC accounting. The gate **still fires** (if checks authored no test, it flags); it just targets the artifact that actually gates behavior instead of design's guessed filename.

---

## 5. Blast radius — what stays intact

Completeness remains load-bearing for the file kinds where it is the meaningful gate:

| Declared file | Gated by | Completeness role after change |
|---|---|---|
| Code (behavioral) | completeness (early, precise loopback) **+** verify RED-first | **kept** — exact match, unchanged |
| Changelog / docs (non-behavioral) | completeness **only** (no behavioral test) | **kept** — wildcard-resolved, still required |
| Test | checks-postcondition + RED-first + component suite | resolved via checks registry — still fires, targets the real test |

Design keeps its full job (declare artifacts, tests, checks→AC). `checks:dispatch`, `verify:check`, and RED-first are **untouched**. No gate is removed; the test-completeness check is corrected to check reality rather than a phantom path.

**Honest nuance:** because the checks-postcondition already guarantees a test per AC, the test-typed completeness check will usually pass on its own — it leans redundant with checks/RED-first. It is retained (not carved out) to keep the gate structure whole and because it is **not weaker than today** (today it checks a phantom path and wedges). Removing it would leave the system in a lesser state, which is explicitly out of scope.

---

## 6. Non-goals (explicitly out of scope)

- **Not** removing completeness's gating of tests (an earlier proposal; rejected — it removes a gate and leaves the system weaker).
- **Not** the over-decomposition / duplicate-test question (design spinning a trivial fix into 3 units, or implement writing a second test alongside checks'). The duplicate is a pre-existing quality wart, unchanged by this fix (not made worse). It can be addressed separately.
- **Not** the `merge:push` / no-PR blocker (a separate root cause — forge push not landing; `IDLE_CAP=3 < OUTBOX_RETRY_BUDGET=5`).
- **Not** a design→checks filename-hint mechanism for idiomatic test naming (architecture "A"; a possible later PR-quality improvement, deliberately excluded from the MVC because it adds coupling for no correctness gain).
- **No schema change.**

---

## 7. Open questions / risks

1. **Placeholder token grammar.** What exactly marks a placeholder in a declared path — an angle-bracket token (`<id>`), a literal glob (`*`), or both? Needs a precise, testable rule so the wildcard matcher is deterministic and a broad `*` cannot over-match (e.g. scope the wildcard to a single path segment).
2. **Test-typed detection.** `isTestFile` uses the profile's test pattern (or a built-in heuristic). A declared non-test file that happens to match the heuristic would be mis-resolved. Confirm the heuristic's precision against the target repos, or require design to mark test entries explicitly.
3. **Empty checks-registry edge.** If a ticket legitimately has a behavioral unit but the checks registry is empty (checks:dispatch produced nothing), a test-typed entry resolves to unsatisfied → loopback. Confirm this is the desired signal (it should be — no authored test is a real gap the checks-postcondition already escalates).
4. **Over-exclusion of tests.** Excluding `isTestFile()` from `over` means an implement unit that wrongly rewrites an unrelated existing test would not be flagged by scope-diff. `over` is advisory only, and check-integrity independently freezes active check files, so the exposure is limited — but note it.
