# Completeness name-reconciliation — design

**Status:** proposed (brainstorm, converged after independent review + ticket-kind analysis + plan-grounding)
**Author:** derived from the 2026-07-11 SMOKE=2 validation dig (astropy-12907 + darkreader-7241)
**Scope of change:** `src/dispatch/completeness.ts` (`reconcileScope`) + a design-prompt stance edit (`prompts/design-extract.md`). **No handler change, no schema change, no gate removed.**
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

Across nine analysed astropy runs the decomposition and the one-line `separable.py` fix were **byte-identical every run** — styre *solves* the bug every time. Failures migrated between gates as outer bugs were fixed; the completeness wedge is the innermost layer. It is one gate applying the wrong matcher, not a family of bugs.

---

## 2. Principle — the authorship split

Completeness is an **existence** gate: "was the declared artifact actually produced?" The bug is that it demands design **predict an exact filename it cannot know** — an artifact named later (a PR number) or by another subsystem (`checks:dispatch`).

The resolution declares in `files_to_touch` **exactly what the unit's `implement` dispatch produces, and nothing else**:

- **Implement-authored artifacts** — code, docs (e.g. changelog), and **product tests** (the *deliverable* of a coverage / test-infrastructure ticket) — belong in `files_to_touch`; completeness gates their existence.
- **The verification test** — the RED-first proof of a behavioral acceptance criterion — is authored and named by `checks:dispatch`. It is **not** an implement output and is **not** declared in `files_to_touch`. Its need is carried by `verify_check_types` + the checks→AC accounting; it is gated by the **checks-postcondition + RED-first** — the gates that always owned it. (Completeness's old name-match on a declared test path was never a working gate for it — it was the very landmine that wedged darkreader.)

Two coordinated changes, removing no capability:

1. **Design's declaration stance** (`prompts/design-extract.md`). Declare implement's outputs; use a **placeholder** for an implement artifact whose exact name is not knowable at design time (a changelog fragment). Do **not** declare the checks-owned verification test path. Design still declares tests are needed (`verify_check_types`) and still accounts checks→AC.
2. **Completeness's matcher** (`src/dispatch/completeness.ts`). Resolve each declared entry against the actual diff by **exact** match (ordinary paths) or **wildcard** match (placeholder paths), for both `under` and `over`.

---

## 3. Design

`reconcileScope` resolves each declared entry against the diff with a single matcher:

| Declared entry | Match mode | Satisfied when |
|---|---|---|
| Ordinary path (code, docs, **product test**) — no `<token>` | **exact** | the exact path is in `cumulativeTouched` |
| Placeholder path (e.g. `…/<id>.bugfix.rst`) — contains `<token>` | **wildcard** | some file in `cumulativeTouched` matches the path with each `<token>` expanded to a single path segment |

`under` = declared entries matched by no diff file; `over` = own-diff files matched by no declared entry. A token-free entry matches by exact string equality (identical to today's behavior), so all existing exact-match cases are unchanged.

**Wildcard grammar (pinned).** A placeholder token is `<...>` (angle brackets, any inner text). Each token expands to `[^/]*` — a **single path segment**, non-slash — with every other character matched **literally** (regex-escaped) and the whole path anchored (`^…$`). This resolves `docs/changes/modeling/<id>.bugfix.rst` ← `docs/changes/modeling/12907.bugfix.rst` while a token cannot match across a `/` boundary (no vacuous cross-directory satisfaction). A declared path with a literal `<` but no closing `>` has no token and is treated as an exact literal.

**`over` is resolution-aware by construction:** because `over` uses the same matcher, a wildcard-declared entry (`<id>.bugfix.rst`) recognises its own produced file (`12907.bugfix.rst`), so the changelog is never reported as spurious over-delivery. `over` remains advisory (non-blocking).

### Data grounding (verified in code, styre @ 52b5e02)

- The change is confined to `reconcileScope` in `completeness.ts` (a pure function). The completeness handler in `handlers.ts` already calls `reconcileScope(declared, cumulativeTouched, ownTouched)` and consumes `under`/`over` — **it needs no edit.**
- darkreader is fixed by change #1 alone: with the verification test no longer declared, `under` never contains it. The test's existence/validity remains gated by the checks-postcondition (design stage: a valid check per AC) + RED-first (`ac-check-gate`).
- No schema change; `files_to_touch` stays a JSON array of strings — a placeholder is just a string with `<token>` in it.

### Design-prompt change (`prompts/design-extract.md`)

State the declaration stance: `files_to_touch` lists what the unit's implement step will write — code, docs, and product tests when tests are the deliverable. When an implement artifact's exact name is not knowable at design time (a changelog fragment named by an unborn PR number), declare it with a `<token>` placeholder. Do **not** list the checks-owned verification test; the test requirement is carried by `verify_check_types` (unchanged) and authored by `checks:dispatch`. Keep the existing soft-gate changelog nudge and the behavioral/`verify_check_types` rules.

---

## 4. Scoped outcomes

- **astropy (changelog = implement-authored, un-nameable):** design declares `…/<id>.bugfix.rst`; completeness wildcard-matches `12907.bugfix.rst`. Changelog **still required, still gated, still shipped**; the gate stops demanding a name design could not know.
- **darkreader (verification test = checks-owned):** design declares only `[parse.ts]` (+ any docs), **not** a test path. `parse.ts` exact-matches → pass. The verification test (`ENG-288_ac1.tests.ts`) is authored by checks and gated by RED-first. No false under-delivered, and the duplicate implement-authored test is gone.
- **coverage ticket (product tests = implement-authored deliverable):** design declares the new test files in `files_to_touch`; implement writes them at the declared paths → exact match. Gated by completeness (existence) + verify (suite green). *(The coverage acceptance-criterion itself has no red→green behavior; that mismatch is ENG-290, not this change.)*

---

## 5. Blast radius — what stays intact

| Requirement | Gated by | Completeness role after change |
|---|---|---|
| Code (behavioral) | completeness (early, precise loopback) **+** verify RED-first | **kept** — exact match, unchanged |
| Changelog / docs (non-behavioral) | completeness **only** | **kept** — wildcard-resolved, still required |
| Product test (coverage deliverable) | completeness (existence) + verify (suite) | **kept** — exact match (implement writes it at the declared path) |
| Verification test (behavioral proof) | checks-postcondition + RED-first + component suite | not declared, not name-gated (it never was a working gate — the C1 landmine) |

Design keeps its full job. `checks:dispatch`, `verify:check`, and RED-first are **untouched**. Token-free declared paths still match exactly, so every existing exact-match case (and the existing `completeness-e2e` suite) behaves identically. No gate is removed.

---

## 6. Non-goals (explicitly out of scope)

- **Registry-existence test signal — considered and dropped.** An earlier revision added a completeness check "a behavioral unit's ticket has an authored test in the `ac_check` registry." It is **redundant** with the checks-postcondition (review I2), it would break the existing `completeness-e2e` tests (which set `verify_check_types:["test"]` without seeding an `ac_check`), and it adds a no-AC edge wedge. The authorship split fixes darkreader without it; the verification test stays gated by checks-postcondition + RED-first.
- **Not** the over-decomposition question. The authorship split removes darkreader's duplicate test as a side effect, but general decomposition sizing is separate.
- **Not** the `merge:push` / no-PR blocker (separate root cause).
- **Not** non-behavioral acceptance-criterion handling (refactor/coverage/docs AC with no red→green) — **ENG-290**.
- **Not** metric/benchmark verification (perf) — declined (ENG-290, DNC).
- **No schema change, no handler change.**

---

## 7. Open questions / residual risks

1. **Placeholder token grammar edge cases** — covered by unit tests: multiple tokens in one path; a token that must not match across `/`; a literal `<` with no closing `>` (exact literal); a placeholder that matches nothing.
2. **A declared placeholder that matches nothing** must still fail as `under-delivered` (a required-but-absent changelog is a real gap) — the wildcard resolver returns "no match" → the entry stays in `under`.
3. **Product-test vs verification-test at design time.** The stance relies on design *not* declaring the checks-owned verification test while *declaring* product tests. If design wrongly declares a bug-fix regression test as a product path, it degrades to pre-change behavior for that entry (exact-match; implement must create it) — a soft failure, not a wedge. Handled by the design-prompt wording, not code.
