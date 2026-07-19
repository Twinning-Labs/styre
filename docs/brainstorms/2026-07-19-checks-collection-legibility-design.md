# ENG-342 — Legible collection-failure message for discarded support files

**Status:** design (brainstorm complete; independent review folded in; ready for plan)
**Ticket:** ENG-342 — *Drop the ENG-323 co-located support-file heuristic once declare-or-discard is proven*
**Date:** 2026-07-19
**Predecessors:** declare-or-discard disposition (#91, `a01b8b3`), ENG-323 co-located support-file admission (#83, `5629331`)
**Related:** ENG-343 (extend the import-error vocabulary to Go/Rust/JVM/Ruby/PHP — stays separate)

---

## 1. Problem

Declare-or-discard (#91) made `checks:dispatch` **discard** undeclared new files instead of rejecting the
whole attempt. ENG-342 removes the now-redundant ENG-323 heuristic (`isCheckSupportFile`) that used to
*auto-admit* co-located Python support files (`__init__.py`, `conftest.py`). After that removal, an
undeclared support file is discarded like any other new file. So a check that needs it can no longer
collect, and the run must **say so clearly** and recover by having the agent declare the file on retry.

Two preconditions gate ENG-342. Axis 1 (declare-or-discard removes the astropy wedge on loose scratch
files) was validated live on 2026-07-19 — astropy discarded its loose scratch files and drove clean to
`pr-ready`. Axis 2 — **the RED-first failure message is legible when a check can't collect because a
support file is missing** — is only partly met, and is what this design fixes.

### 1.1 Current-state map (verbatim code paths)

When `checks:dispatch` runs a newly-authored test RED-first (`handlers.ts:656-696`), the outcome is
classified by `interpretRunOutput` (`check-selector.ts:175`) and then inspected by the discard guard
(`handlers.ts:683-692`). The guard runs on **any non-green result** (`coarse !== "green"`), so it already
covers every relevant pytest exit code — 1 (a failed assertion or a missing fixture), 2 (a collection or
import error), and 4 (a usage error, e.g. a kept `conftest.py` that imports a discarded helper). Three
outcomes matter:

| Symptom | Classified as | Operator/agent sees |
|---|---|---|
| A collection error that **names a discarded file** | `red` → discard guard fires | *"could not run because it references files styre discarded this attempt (undeclared): X"* (legible) |
| `selected-none` (pytest collected 0 items, no error) | `selected-none` | *"the selector for X matched no test"* (opaque) — **out of scope**: this is a selector or name mismatch, not a missing support file |
| A collection error that **does not name a discarded file** | `red` → guard skips → installed as a **covered** check | **nothing** — the check ships. This is the silent bad merge. |

### 1.2 The blind spot ENG-342 must close

The discard guard (`importErrorImplicatesDiscarded`, `check-selector.ts:296`) only implicates a discarded
file when the error **names** it (its module leaf, or its exact basename as a bounded token). The two
canonical support files defeat this:

- **`__init__.py`** — a missing package marker usually errors with `ModuleNotFoundError: No module named
  'pkg'`, which names the **package** (the directory), never the file `__init__.py`. The leaf/basename
  match fails. (Caveat: this is not guaranteed — see the namespace-package residual in §6.)
- **`conftest.py`** — a missing fixture file errors naming the **fixture**, never `conftest.py`, and the
  phrase `fixture 'x' not found` is not in today's indicator list at all.

So for exactly the files this ticket is about, the guard does not fire. The non-green check is installed
as covered, and it can later be graded `environmental` and shipped as a non-gating advisory — the silent
bad merge. The message is therefore not legible for the support-file case.

---

## 2. Scope

**Half A (mechanical, per the ticket's IN list):**
- Delete `isCheckSupportFile` + `CHECK_SUPPORT_CAP` from `src/dispatch/check-path.ts`, **and** the two
  helpers used only by it — `dirname` (`check-path.ts:65`) and `finalExt` (`check-path.ts:72`) —
  otherwise `noUnusedLocals` fails the typecheck.
- Remove its clause in `checksScopeFor` (`src/dispatch/commit-scope.ts:50`), **and** drop the now-orphaned
  `news` local (`:44`) and the `newPaths` parameter (`:43`), otherwise `noUnusedLocals` /
  `noUnusedParameters` fail. Retire the now-vestigial optional third argument of the `CommitScope` type
  (`commit-scope.ts:12-14`) and its one caller in `run-dispatch.ts:205-206`, whose only reader was
  `isCheckSupportFile`.
- Remove ENG-323's tests for the co-located admission.
- `checks.md` **already** tells the agent to declare support files (`prompts/checks.md:40-43`, `:66-68` —
  it names "fixture" and `conftest.py`). The only gap: it never mentions `__init__.py` or package
  markers, which an agent may not read as "a genuine test helper." So this is a one-line addition naming
  `__init__.py` alongside `conftest.py`, not a new convention.

**Half B (this design's focus):** make the collection failure legible when a discarded support file is the
cause.

**Boundaries (agreed):**
1. **Target the discard-gated collection path only.** The `selected-none` message (pytest exit 5, 0 items
   collected, no error) is a selector or name mismatch, not a missing support file — leave it alone. This
   is safe because styre selects the committed test by its exact path (`file::name`,
   `check-selector.ts:110`) and that file is always present, so a missing support file surfaces as a
   collection error (exit 1/2/4), not as silent non-collection.
2. **Python only.** `__init__.py` and `conftest.py` are Python concepts; a discarded JavaScript helper is
   already named by *"Cannot find module './helper'"* and caught by the existing tier. Extending the
   import-error vocabulary to other stacks stays **ENG-343**.
3. **Discard-gated, conservative (option A).** The legible path fires only when a collection error occurs
   *and* a discarded file is named or matched by shape. A legitimate test that fails first with no
   matched discard is untouched — no wrong rejections. See §6 for the residual this deliberately leaves.

---

## 3. Mechanism

A surgical extension of the guard that already exists. Nothing reclassifies exit codes; we widen *which
discarded files the guard implicates*, and enrich the message. Pure functions in `check-selector.ts`; one
message change in `handlers.ts`. **No schema, config, or detector change.**

### 3.1 Matching a discarded support file by its shape (new, `check-selector.ts`)

Classify a discarded path as `package-init` (`__init__.py`), `conftest` (`conftest.py`), or neither, and
match by shape. These are added as extra tiers inside `importErrorImplicatesDiscarded`; the existing
named-directly and exact-basename tiers stay for the general case.

- **`package-init`:** derive the full dotted package from the *directory*, not the name —
  `pkg/__init__.py` → `pkg`; `a/b/__init__.py` → `a.b`. Implicate when a `No module named '<mod>'` phrase
  names a module `M` where **`M === pkg` or `M.startsWith(pkg + ".")`** — a dotted prefix rooted at the
  package. This is the corrected rule (the earlier "any path segment" version both wrongly rejected a
  legitimate test importing a bare interior name like `b`, and missed `No module named 'pkg.sub'`; a
  rooted prefix fixes both). **Compare against the raw captured dotted module from `IMPORT_ERROR_NAMING`,
  not the leaf-reduced `named` set** — reducing `pkg.sub` to `sub` would make the prefix test meaningless.
- **`conftest`:** implicate a discarded `conftest.py` when any collection or fixture error phrase is
  present (shape-gated, no directory matching). The earlier "the conftest's directory must appear in the
  output" rule is dropped: it relied on the removed conftest still printing its own directory (it does
  not), broke on a root-level conftest (its directory prefixes every path), and a miss here drops the
  check straight into the silent bad merge — worse than the cost of a wrongly-matched discard, which is
  just one extra retry. This requires adding **`fixture .* not found`** (and, for completeness,
  `import file mismatch` / `error importing test module`) to `IMPORT_ERROR_INDICATORS` — the fixture
  phrase is in none of them today, so without it the conftest tier could never fire.

### 3.2 Collection-error excerpt (new, `check-selector.ts`)

`collectionErrorExcerpt(rawOutput): string | undefined` — return the one line that states the cause. Prefer
pytest's short-test-summary line (`ERROR path::node - ModuleNotFoundError: ...`, which pytest prints last
and is authoritative); otherwise the last line matching the indicators, not the first (the first match is
often a re-raised error deep in a third-party traceback). Single line and length-bounded so it can't
balloon. Preserve the original casing — the indicators are matched in lowercase, but the returned excerpt
must be the real text. This is the raw stderr currently thrown into `ground_truth_signal.detail_json`.

### 3.3 Richer message (`handlers.ts:683-692`)

The guard composes the summary plus the real error line (Q3 choice B):

> *AC {seq}: the check could not be collected (import or collection error) — this attempt discarded
> `pkg/__init__.py` (undeclared). Framework said: `ModuleNotFoundError: No module named 'pkg'`.*

Same `missReason` → postcondition throw (`handlers.ts:710-722`) → **retry prefix the re-dispatched checks
agent reads** (confirmed wiring: `error_json` → `rejectionFrom` → `RETRY_FEEDBACK_PREFIX`,
`run-dispatch.ts:118-121`). **Diagnosis-only (INV-B):** it states the cause, the file, and the real error;
it teaches no convention. Note that the excerpt is the first *dynamic* text placed into a gate message —
`run-dispatch.ts:76-79` documents that these are normally static styre text. This is a deliberate,
bounded relaxation and it is safe because the excerpt comes from the check's own imports (the agent's own
output reflected back to the agent), not from any third party.

### 3.4 Why this also stops the silent bad merge — for the shapes it recognizes

Today a discarded `__init__.py` yields no name match, so the guard skips and the collection error is
installed as a covered check. Once the shape tier implicates it, the guard fires → `continue` → the AC is
uncovered → postcondition → retry. Reviewer 2 confirmed there is no path from an implicated file to
`covered.add`. So the same change that makes the failure legible also stops the poisoned check from
shipping — but only for the shapes the matcher recognizes. See §6 for what it does not catch.

---

## 4. Testing

The matcher and the excerpt are pure functions, so most of this is unit tests in the existing
`check-selector` surface:

- **`package-init` match:** `pkg/__init__.py` + `No module named 'pkg'` → implicated; nested
  `a/b/__init__.py` + `No module named 'a.b'` → implicated; `pkg/__init__.py` + `No module named
  'pkg.sub'` → implicated (the deeper import). **Must NOT implicate:** `a/b/__init__.py` + `No module
  named 'b'` (a legitimate test importing an unrelated top-level module — the wrong-rejection case that
  the earlier segment rule failed); and `pkg/__init__.py` + `No module named 'unrelated_feature'`.
- **`conftest` match:** `tests/conftest.py` + `fixture 'db' not found` → implicated; `tests/conftest.py` +
  a plain assertion failure with no collection or fixture phrase → NOT implicated.
- **`collectionErrorExcerpt`:** returns pytest's summary line from a multi-line traceback, preserves
  casing, bounded length; returns nothing when no indicator is present.
- **Regression:** the general-case tiers (a directly-named discarded `helper.py`) still implicate.
- **One handler-level test** (checks:dispatch or scope-disposition-smoke surface): an authored test
  importing a package whose `__init__.py` was discarded → the postcondition throws with the cause, the
  file, and the excerpt, **and the poisoned check is not persisted** (covered stays empty for that AC).
- **Final gate (manual):** the ticket's SMOKE acceptance — a check that needs a support file still
  resolves once declared — run live via the styre-bench `ONLY=<id>` option (single instance, cheap).

---

## 5. Ordering & the INV-A / INV-B split

**One PR (one ticket).** The message change (§3) and the deletion (§2 Half A) must land together, because
the handler-level test needs both at once — the deletion so the `__init__.py` is discarded, and the shape
matcher so it is implicated. Edit order within the branch is dev hygiene, not a correctness property (it
ships as one squash merge, so production never sees an intermediate state); doing the message first just
keeps each commit self-consistent.

The convention split is the load-bearing invariant:
- **`checks.md` tells the agent to declare its support files** — a forward prompt → **INV-A** (conventions
  live in forward prompts, uniform across steps).
- **The failure message only names the cause** — **INV-B** (failure feedback is diagnosis only; it never
  carries an instruction or a convention). The agent learns *how* to recover from `checks.md`, not from
  the message.

**Property check after deletion:** a genuinely needed `__init__.py`, if undeclared, is discarded → the
guard fires → the agent reads the legible message → declares it on retry → it is kept. If declared up
front → kept, check green. Support files still work, through declaration instead of auto-admission.

---

## 6. What does not change, and the residual this leaves

Unchanged: the `interpretRunOutput` exit-code buckets; the `selected-none` path and message; non-Python
frameworks (ENG-343); schema, runtime config, detectors, and `styre setup`.

**Known residual (deliberately not closed by ENG-342, option A).** The guard only implicates a discarded
file when the error names it or matches a support-file shape. Some Python collection failures still slip
through as a covered check and can be graded `environmental` and shipped as a non-gating advisory — the
same silent bad merge, narrowed but not eliminated:
- **Namespace packages (PEP 420):** with a parent `__init__.py` present, `import a.b` can succeed even
  with `a/b/__init__.py` gone, or fail much later naming a submodule the shape rule does not tie back to
  the discard. Not fixable by this heuristic.
- **Unrecognized phrasings:** any collection or import error whose wording is not in the indicator list.

This residual is accepted on purpose. The alternative — reject whenever any file was discarded and any
import error is present, without matching a specific file — would wrongly reject the common case of a test
that legitimately fails first by importing a module the implement step has not built yet. Hardening the
grading path (so a collection error can never be graded `environmental`) is a separate concern, not part
of ENG-342.

---

## 7. Review trail

Three independent, code-grounded reviewers (Opus) reviewed this design against the actual `checks:dispatch`
code. Resolutions, folded above:

- **Confirmed sound:** the message reaches the re-dispatched agent (`error_json` → retry prefix — the fix
  is not inert); an implicated file has no path to `covered.add` (the silent bad merge really is stopped
  for recognized shapes); nothing outside `checksScopeFor` uses `isCheckSupportFile`.
- **Critical, fixed:** the `package-init` "any path segment" match both wrongly rejected a legitimate test
  and missed `No module named 'pkg.sub'`. Replaced with a dotted prefix rooted at the package, compared
  against the raw captured module (§3.1).
- **Important, fixed:** the delete list broke the typecheck (orphaned `dirname`/`finalExt`/`news`/
  `newPaths`) — now enumerated (§2). The `checks.md` premise was wrong — the convention already exists;
  the real gap is `__init__.py` naming (§2). The conftest rule could not fire (`fixture ... not found`
  absent from the indicators) and its directory-matching was unreliable — switched to the simpler
  shape-gated rule plus the new indicator phrase (§3.1). The design oversold "closes the masquerade" — the
  residual is now stated honestly (§6, option A).
- **Minor, fixed:** gate the new tiers on any non-green result, not "exit-2 red" (§1.1); prefer pytest's
  summary line and preserve casing in the excerpt (§3.2); note the INV-B relaxation for the dynamic
  excerpt (§3.3); reframe the ordering as dev hygiene (§5); tighten the exit-5 justification (§2).
