# ENG-342 — Legible collection-failure message for discarded support files

**Status:** design (brainstorm complete; awaiting independent review → plan)
**Ticket:** ENG-342 — *Drop the ENG-323 co-located support-file heuristic once declare-or-discard is proven*
**Date:** 2026-07-19
**Predecessors:** declare-or-discard disposition (#91, `a01b8b3`), ENG-323 co-located support-file admission (#83, `5629331`)
**Related:** ENG-343 (extend import-error vocabulary to Go/Rust/JVM/Ruby/PHP — stays separate)

---

## 1. Problem

Declare-or-discard (#91) made `checks:dispatch` **discard** undeclared new files instead of rejecting the
whole attempt. ENG-342 removes the now-redundant ENG-323 heuristic (`isCheckSupportFile`) that used to
*auto-admit* co-located Python support files (`__init__.py`, `conftest.py`). After that removal, an
undeclared support file is discarded like any other new file — so a check that needs it can no longer
collect, and the run must **surface that legibly** and recover via declaration on retry.

Two preconditions gate ENG-342. Axis 1 (declare-or-discard kills the throwaway-loose astropy wedge) was
validated live (2026-07-19) — astropy discarded its loose scratch files and drove clean to `pr-ready`.
Axis 2 — **the RED-first failure message is legible when a check can't collect because a support file is
missing** — is only *partially* met, and is what this design fixes.

### 1.1 Current-state map (verbatim code paths)

When `checks:dispatch` runs a newly-authored test RED-first (`handlers.ts:656-696`), the outcome is
classified by `interpretRunOutput` (`check-selector.ts:175`) and then inspected by the discard-poison
guard (`handlers.ts:683-692`). Three buckets matter:

| Symptom | pytest exit | Today's classification | Operator/agent sees |
|---|---|---|---|
| Collection error **that names a discarded file** | 2 | `red` → discard-poison guard fires | *"could not run because it references files styre discarded this attempt (undeclared): X"* (legible) |
| `selected-none` (collected 0 items, no error) | 5 | `selected-none` | *"the selector for X matched no test"* (opaque) — **out of scope** (selector/name mismatch, not a missing support file) |
| Collection error **that does NOT name a discarded file** | 2 | `red` → guard skips → installed as a **covered** check | **nothing** — the check ships (the masquerade / silent-bad-merge) |

### 1.2 The blind spot ENG-342 must close

The discard-poison guard (`importErrorImplicatesDiscarded`, `check-selector.ts:296`) only implicates a
discarded file when the error **names** it (its module leaf, or its exact basename as a bounded token).
The two canonical support files defeat this:

- **`__init__.py`** — a missing package marker errors with `ModuleNotFoundError: No module named 'pkg'`,
  naming the **package** (the *directory*), never the file `__init__.py`. Leaf/basename match fails.
- **`conftest.py`** — a missing fixture file errors naming the **fixture**, never `conftest.py`.

So for exactly the files this ticket is about, the guard doesn't fire → the exit-2 red is installed as a
covered check → the masquerade. The message is therefore *not legible* for the support-file case.

---

## 2. Scope

**Half A (mechanical, per the ticket's IN list):**
- Delete `isCheckSupportFile` + `CHECK_SUPPORT_CAP` from `src/dispatch/check-path.ts`.
- Remove its clause in `checksScopeFor` (`src/dispatch/commit-scope.ts`).
- Remove ENG-323's tests for the co-located admission.
- Update `checks.md` so support files are **declared** in the sidecar (`new_files`/`checksAuthored`).

**Half B (this design's focus):** make the discard-gated collection failure legible.

**Boundaries (agreed):**
1. **Target the exit-2 discard-gated collection path only.** The exit-5 `selected-none` message
   (*"selector matched no test"*) is a *selector/name mismatch*, not a missing support file — left alone.
2. **Python shape-aware.** `__init__.py`/`conftest.py` are Python concepts; a discarded JS helper is
   already named by *"Cannot find module './helper'"* and caught by the existing tier. Extending the
   import-error vocabulary to other stacks stays **ENG-343**.
3. **Discard-gated.** The legible path fires only when a collection/import error occurs *and* files were
   discarded this attempt. A legitimate absence-RED test with no discard is untouched — no false rejects.

---

## 3. Mechanism

A surgical extension of the existing guard. Nothing reclassifies exit codes; we widen *which discarded
files the guard implicates*, and enrich the message. Pure functions in `check-selector.ts`; one message
swap in `handlers.ts`. **No schema, config, or detector change.**

### 3.1 Python support-file recognizer (new, `check-selector.ts`)

Classify a discarded path as `package-init` (`__init__.py`), `conftest` (`conftest.py`), or neither, and
match by shape — added as extra tiers inside `importErrorImplicatesDiscarded` (the existing
named-directly / exact-basename tiers stay for the general case):

- **`package-init`:** derive the package from the *directory*, not the name — `pkg/__init__.py` → `pkg`;
  `a/b/__init__.py` → `a.b` (plus segments `a`, `b`). Implicate when a `No module named '<mod>'` /
  import-error phrase names a module **equal to, or a segment of,** that package path. Ties the missing-
  module error to the discarded package marker; will not fire on an unrelated feature-module import error.
- **`conftest`:** implicate a discarded `conftest.py` when a fixture-not-found or collection-error phrase
  is present **and** that conftest's *directory* is referenced in the erroring output — so a conftest is
  never blamed for a collection error in a different directory.

### 3.2 Collection-error excerpt (new, `check-selector.ts`)

`collectionErrorExcerpt(rawOutput): string | undefined` — pulls the first line matching the existing
import/collection indicators (e.g. `ModuleNotFoundError: No module named 'pkg'`), single-line and length-
bounded so it can't balloon. This is the raw stderr currently swallowed into `ground_truth_signal.detail_json`.

### 3.3 Richer message (`handlers.ts:683-692`)

The guard composes (Q3 choice B — synthesized summary + real error line):

> *AC {seq}: the check could not be collected (import/collection error) — this attempt discarded
> `pkg/__init__.py` (undeclared). Framework said: `ModuleNotFoundError: No module named 'pkg'`.*

Same `missReason` → postcondition throw (`handlers.ts:710-722`) → **retry prefix the re-dispatched checks
agent reads** (ENG-296). **Diagnosis-only (INV-B):** states the cause + the file + the real error, teaches
no convention.

### 3.4 Why this also kills the masquerade for free

Today a discarded `__init__.py` yields no name match → guard skips → the exit-2 red is installed as a
covered check (the silent-bad-merge). Once the shape-aware tier implicates it, the guard fires →
`continue` → uncovered → postcondition → retry. The same change that makes the failure *legible* also
stops the poisoned check from shipping — no separate reclassification needed.

---

## 4. Testing

Matcher and excerpt are pure functions — the bulk is unit tests in the existing `check-selector` surface:

- **`__init__.py` shape match:** `pkg/__init__.py` + `No module named 'pkg'` → implicated (the blind-spot
  regression); nested `a/b/__init__.py` + `No module named 'a.b'` → implicated; **`pkg/__init__.py` +
  `No module named 'unrelated_feature'` → NOT implicated** (the critical no-false-reject case).
- **`conftest.py` shape match:** `tests/conftest.py` + fixture-not-found referencing `tests/` →
  implicated; same discard + a collection error in a *different* dir → NOT implicated.
- **`collectionErrorExcerpt`:** extracts the `ModuleNotFoundError` line from a multi-line traceback,
  bounded; returns nothing when no indicator is present.
- **Regression:** the general-case tiers (a directly-named discarded `helper.py`) still implicate.
- **One handler-level test** (checks:dispatch / scope-disposition-smoke surface): an authored test
  importing a package whose `__init__.py` was discarded → the postcondition throws with cause + file +
  excerpt, **and the poisoned check is not persisted** (covered stays empty for that AC). End-to-end
  "legible *and* masquerade-prevented" proof.
- **Final gate (manual):** the ticket's SMOKE acceptance — support-file checks still resolve via
  declaration — run live via the new styre-bench `ONLY=<id>` option (single instance, cheap).

---

## 5. Ordering & the INV-A / INV-B split

**One PR (one ticket).** Internal sequence: land the **message-legibility mechanism first** (§3), *then*
the **deletion** (§2 Half A). Deleting first would briefly reintroduce the opaque wedge, since the
deletion is what starts discarding support files.

The convention split is the load-bearing invariant:
- **`checks.md` teaches "declare your support files"** — a forward prompt → **INV-A** (conventions in
  forward prompts, uniform).
- **The failure message only names the cause** — **INV-B** (failure feedback is diagnosis-only, never
  carries instructions/conventions).

**Post-deletion property check:** a genuinely-needed `__init__.py`, if undeclared, is discarded → guard
fires → agent sees the legible message → declares it on retry → kept. If declared up front → kept, check
green. "Support files still work," via declaration instead of auto-admission.

---

## 6. What does NOT change

- `interpretRunOutput` exit-code buckets (`red`/`selected-none`/`green`) — unchanged.
- The `selected-none` message and the exit-5 path — unchanged (out of scope).
- Non-Python frameworks' import-error vocabulary — unchanged (ENG-343).
- Schema, runtime config, detectors, `styre setup` — untouched.

---

## 7. Open items for the independent review

- Is the `conftest.py` dir-referenced matching worth its complexity, or should conftest fall back to a
  simpler shape-gated rule (discarded `conftest.py` + any collection error → implicate)? The design keeps
  the precise version; a reviewer may argue the simpler rule is safe enough given the discard gate.
- Confirm the `package-init` "segment of the dotted path" match can't be widened into a false-reject by a
  pathological package layout.
