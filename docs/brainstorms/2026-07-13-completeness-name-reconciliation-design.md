# Completeness name-reconciliation — design

**Status:** proposed (brainstorm, converged after independent review + ticket-kind analysis)
**Author:** derived from the 2026-07-11 SMOKE=2 validation dig (astropy-12907 + darkreader-7241)
**Scope of change:** `src/dispatch/completeness.ts` (`reconcileScope`) + its handler in `src/dispatch/handlers.ts`, and a design-prompt stance tweak (`prompts/design-extract.md`). **No schema change. No gate removed.**
**Scope of applicability:** behavior-change tickets + product-test tickets. Non-behavioral acceptance-criterion handling (refactor/coverage AC → `not-expressible`) is out of scope — see **ENG-290**.

---

## 1. Problem

The deterministic completeness gate (`reconcileScope`) computes a work unit's under-delivery as an **exact-string set difference**:

```ts
under = declared.filter((f) => !cumulativeTouched.has(f))   // completeness.ts
```

`declared` is the design agent's *predicted* `files_to_touch`; `cumulativeTouched` is the **actual** ticket git diff. The gate false-flags "under-delivered" whenever correct work lands at a path design did not predict **character-for-character** — even though the work was done. Two observed manifestations, both against a correct fix:

- **astropy-12907 (fatal).** Design declared the changelog fragment as `docs/changes/modeling/<id>.bugfix.rst` — an unresolved **placeholder** (towncrier fragments are named by PR number, which does not exist at implement time). Implement correctly wrote `docs/changes/modeling/12907.bugfix.rst`. `"<id>…" ≠ "12907…"` → false under-delivered → the placeholder path is uncreatable → loopback can never satisfy it → **escalate → blocked**. (Verified: implement *did* write the file, correctly named.)

- **darkreader-7241 (churn).** Design declared a regression-test file `tests/generators/utils/parse.tests.ts` (an **existing** file — the idiomatic co-location choice). But `checks:dispatch` is architecturally required to author its RED-first test into a **brand-new, integrity-frozen** file (`ENG-288_ac1.tests.ts`; `check-integrity.ts` freezes the check file byte-for-byte between authoring and verify, and the added-only rule closes the "hide a false-green inside an existing test" vector). So the declared test path and the real test path **can never align** → false `under-delivered` → wasted loopback (recovered late; died downstream on the unrelated `merge:push` blocker), plus a duplicate implement-authored test.

Both are one disease: **completeness exact-matches design's *predicted* filenames against the *actual* produced files, and false-flags when correct work lands at an unpredicted path** — via a placeholder (astropy) or because a different subsystem owns and names the file (darkreader).

### Why "a different reason every time"

Across nine analysed astropy runs the decomposition and the one-line `separable.py` fix were **byte-identical every run** — styre *solves* the bug every time. Failures migrated between gates (env/tox → merge:push → completeness) as outer bugs were fixed; the completeness wedge is the innermost layer. It is not a family of bugs; it is one gate applying the wrong matcher.

---

## 2. Principle — the authorship split

Completeness is an **existence** gate: "was the declared artifact actually produced?" It is the right tool for artifacts whose requirement is existence, and it must stay. The bug is that the gate demands design **predict an exact filename it cannot know** — for an artifact named later (by a PR number) or by another subsystem (`checks:dispatch`).

The resolution is to declare in `files_to_touch` **exactly what the unit's `implement` dispatch produces, and nothing else**:

- **Implement-authored artifacts** — code, docs (e.g. changelog), and **product tests** (the *deliverable* of a coverage / test-infrastructure ticket). These belong in `files_to_touch`; completeness gates their existence.
- **The verification test** — the RED-first proof of a behavioral acceptance criterion — is authored and named by `checks:dispatch`. It is **not** an implement output and is **not** declared in `files_to_touch`. Its need is carried by `verify_check_types` + the checks→AC accounting, and it is gated by the checks-postcondition + RED-first — which are stronger than any filename match.

Two coordinated changes, removing no capability:

1. **Design's declaration stance.** Declare implement's outputs; use a **placeholder** for an implement artifact whose exact name is not knowable at design time (a changelog fragment). Do **not** declare the checks-owned verification test path. Design still declares tests are needed (`verify_check_types`) and still accounts checks→AC.
2. **Completeness's matcher.** Resolve declared entries against reality (exact / wildcard), and carry a test-existence signal from the checks registry rather than from a phantom declared path.

---

## 3. Design

`reconcileScope` and its handler resolve each unit's requirement in three ways:

| Requirement | Source | Satisfied when |
|---|---|---|
| Ordinary declared path (code, docs, **product test**) | `files_to_touch` entry, no placeholder token | the exact path is in `cumulativeTouched` |
| Placeholder declared path (e.g. `…/<id>.bugfix.rst`) | `files_to_touch` entry containing a `<token>` | some file in `cumulativeTouched` matches the path with each `<token>` expanded to a single-segment wildcard |
| Test-existence (behavioral unit) | `unit.verify_check_types` includes `"test"` | an **active** `ac_check` row for the ticket has a **non-null** `test_path` (registry existence — `listActiveByTicket`) |

**Wildcard grammar (pinned).** A placeholder token is `<...>` (angle brackets). Each token expands to `[^/]*` — a **single path segment**, non-slash — with all other characters matched literally and the whole path anchored. This resolves `docs/changes/modeling/<id>.bugfix.rst` ← `docs/changes/modeling/12907.bugfix.rst` while preventing a broad `*`-style token from vacuously satisfying a required file across directories.

**`over` (advisory scope-diff)** is made resolution-aware: a wildcard-resolved path is not reported as over-delivery (otherwise `12907.bugfix.rst` would surface as spurious `over` against the declared `<id>.bugfix.rst`). `over` remains advisory (non-blocking).

**Test-existence is C1-safe and detection-safe.** It is queried as **existence** in the `ac_check` registry, not membership in `cumulativeTouched` — because `checks:dispatch` commits its test in the **design stage** (`resolver.ts`), which is an ancestor of the cumulative diff base (`cumulativeBase = minSeqUnit.base_sha`, set lazily on first `implement:dispatch`), so the authored test is **never** in `cumulativeTouched`. Detection keys off `unit.verify_check_types`, **not** `isTestFile` on a path — so a required non-test artifact under a `tests/` directory (a fixture, golden data) is a normal declared entry, exact-matched, never vacuously satisfied. NULL `test_path` rows are skipped.

### Data grounding (verified in code, styre @ 52b5e02)

- `ac_check.test_path` holds every checks-authored test file; `listActiveByTicket(db, ticketId)` returns the active (non-superseded) set. The completeness handler has `ctx.db` + `ctx.ticket.id`.
- `acceptance_criterion` and `ac_check` carry **no `work_unit_id`** — they are ticket-level, so the test-existence signal is ticket-level (an authored test exists for the ticket). This avoids inventing a unit↔AC schema link and matches the existing data model.
- `checks:dispatch` runs in the design stage before `advance design→implement` (`resolver.ts`); a unit's `base_sha` is set lazily on first implement dispatch (`handlers.ts`). Hence the timing argument above.
- `commit-scope.ts` already whitelists `checksAuthored[].test_file`, and checks' tests are authored in a separate dispatch, so they never appear in an implement unit's own-diff and are not double-counted in `over`.

### Design-prompt change (`prompts/design-extract.md`)

State the declaration stance: `files_to_touch` lists what the unit's implement step will write — code, docs, and product tests when tests are the deliverable. When an implement artifact's exact name is not knowable at design time (a changelog fragment named by an unborn PR number), declare it with a `<token>` placeholder. Do **not** list the checks-owned verification test; the test requirement is carried by `verify_check_types` (unchanged) and authored by `checks:dispatch`. Keep the existing soft-gate changelog nudge and the behavioral/`verify_check_types` rules.

---

## 4. Scoped outcomes

- **astropy (changelog = implement-authored, un-nameable):** design declares `…/<id>.bugfix.rst`; completeness wildcard-matches `12907.bugfix.rst`. Changelog **still required, still gated, still shipped**; the gate stops demanding a name design could not know.
- **darkreader (verification test = checks-owned):** design declares only `[parse.ts]` (+ any docs), **not** a test path. `parse.ts` exact-matches; the test-existence signal confirms `checks:dispatch` authored a live test (`ENG-288_ac1.tests.ts`); RED-first gates its behavior. No false under-delivered, and the duplicate implement-authored test is gone.
- **coverage ticket (product tests = implement-authored deliverable):** design declares the new test files in `files_to_touch`; implement writes them at the declared paths → exact match. The tests are gated by completeness (existence) + verify (suite green). *(The coverage acceptance-criterion itself has no red→green behavior; that mismatch is ENG-290, not this change.)*

---

## 5. Blast radius — what stays intact

| Requirement | Gated by | Completeness role after change |
|---|---|---|
| Code (behavioral) | completeness (early, precise loopback) **+** verify RED-first | **kept** — exact match, unchanged |
| Changelog / docs (non-behavioral) | completeness **only** | **kept** — wildcard-resolved, still required |
| Product test (coverage deliverable) | completeness (existence) + verify (suite) | **kept** — exact match (implement writes it at the declared path) |
| Verification test (behavioral proof) | checks-postcondition + RED-first + component suite | test-existence signal from the registry; not name-gated (it never was — C1) |

Design keeps its full job (declare implement's artifacts, declare tests-needed via `verify_check_types`, account checks→AC). `checks:dispatch`, `verify:check`, and RED-first are **untouched**. No gate is removed.

**Honest nuance (per review I2):** the registry test-existence signal is largely **redundant** with the checks-postcondition (which already guarantees a test per AC). It is retained to keep completeness's gate structure whole; it is **not weaker than today** (today's name-match is an always-fail landmine that wedges). Removing it would leave the system in a lesser state, which is out of scope.

---

## 6. Non-goals (explicitly out of scope)

- **Not** removing completeness's gating of tests. Product tests stay gated by existence; the verification-test signal is retained.
- **Not** the over-decomposition question (design splitting a trivial fix into 3 units). The authorship split happens to remove darkreader's duplicate test as a side effect, but general decomposition sizing is separate.
- **Not** the `merge:push` / no-PR blocker (separate root cause: forge push not landing; `IDLE_CAP=3 < OUTBOX_RETRY_BUDGET=5`).
- **Not** non-behavioral acceptance-criterion handling (refactor/coverage/docs AC that has no red→green) — the `not-expressible` adjudication path and any ticket-kind verification taxonomy are **ENG-290**.
- **Not** metric/benchmark verification (perf) — declined (ENG-290, DNC).
- **No schema change.**

---

## 7. Open questions / residual risks

1. **Placeholder token grammar edge cases.** The pinned rule (`<...>` → `[^/]*`, single segment, literal-anchored) needs unit tests for: multiple tokens in one path, a token spanning a would-be directory boundary (must not match across `/`), and a literal `<`/`>` in a real path (unlikely; document as unsupported).
2. **A declared placeholder that matches nothing** must still fail as `under-delivered` (a required-but-absent changelog is a real gap) — confirm the wildcard resolver returns "no match" → under, not a vacuous pass.
3. **Product-test vs verification-test at design time.** The rule relies on design correctly *not* declaring the checks-owned verification test while *declaring* product tests. For a bug-fix ticket design should declare no test path; for a coverage ticket it declares the test files. If design wrongly declares a bug-fix regression test as a product path, it degrades to the pre-change behavior for that entry (exact-match; implement must create it) — a soft failure, not a wedge. Note for the design-prompt wording.
