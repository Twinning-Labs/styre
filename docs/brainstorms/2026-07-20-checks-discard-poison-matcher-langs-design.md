# ENG-343 — Extend the discard poison matcher to Go, Rust, JVM, Ruby and PHP

**Status:** design agreed (2026-07-20). Successor to ENG-342; closes a residual documented in PR #91.
**Ticket:** ENG-343 · **Branch:** `fix/checks-discard-poison-matcher-langs-eng-343`

---

## 1. Problem

`checks:dispatch` discards undeclared new files before committing (declare-or-discard, PR #91). When the
checks agent's canonical test imports a helper it forgot to declare, that helper is discarded and the test
can no longer run. Left unhandled the broken test is recorded as a real check, the downstream classifier
can call it `environmental`, and `post-implement-rerun.ts` downgrades it to a non-gating advisory — so the
acceptance criterion ships without ever having been verified. That is a bad merge nobody notices.

PR #91 closed this with a guard, `importErrorImplicatesDiscarded` (`src/dispatch/check-selector.ts`): when a
check that did not go green produces an import or collection error naming a file this attempt discarded, the
criterion is routed to the uncovered path (loud retry, the file named in the feedback) instead of installing
a permanently broken check.

**The gap.** The guard's phrase vocabulary recognises Python and Node wording only. Go, Rust, JVM, Ruby and
PHP report the same failure with entirely different text, so the guard stays silent and the identical bad
merge remains possible on those five stacks. This was recorded as a deliberate residual in PR #91, not a
newly discovered bug.

## 2. Background — how the guard decides

The matcher is a pure text function, `importErrorImplicatesDiscarded(rawOutput, discarded)`. It never sees
which framework ran. `rawOutput` is stdout and stderr combined (`checks-run.ts`), so compiler output on
stderr is available. It returns the subset of discarded files the output implicates, using two tiers:

- **Naming tier.** A phrase names an identifier; a regex captures it; `moduleLeaf` reduces the capture to a
  leaf; a discarded file whose own leaf equals it is implicated. `moduleLeaf` already strips the extensions
  `go, rs, rb, php, java, kt, scala` (plus the Python and Node ones), so the groundwork exists.
- **Basename tier.** An indicator phrase is present *and* a discarded file's exact basename appears as a
  bounded token in the output.

Above these sit two shapes added by ENG-342 for Python support files (`__init__.py`, `conftest.py`). Those
are unchanged here.

The governing rule, carried over from PR #91 and ENG-342: **a discarded file is implicated only when the
output names that file, its module, or its package path.** The guard never guesses from a bare basename,
because a wrong guess rejects a test that legitimately fails because the feature is not built yet.

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Structure | The matcher stays **framework agnostic** — one shared vocabulary, no signature change, no plumbing of the framework into the call. |
| D2 | Errors that name only a symbol (Go `undefined: X`, JVM `cannot find symbol`) | **Conservative.** Tie only errors that name a file, module or package path. Symbol wording is not added even as an indicator, because words like `undefined` occur in ordinary runtime failures on other stacks and would let the basename tier fire wrongly. The symbol cases become documented residuals. |
| D3 | How far to push JVM | **Accept JVM as mostly residual.** Add the `package X does not exist` capture and document the rest. The alternative considered and rejected was capturing the compiler's echoed `import com.foo.Helper;` line to reach the class file. |
| D4 | Test coverage | Unit tests across all five stacks **plus** three smoke cells driving the real `checks:dispatch` path for two of them. |

D1 is safe precisely because of D2: every phrase added is distinctive to its own stack, so one stack's
wording cannot realistically appear in another stack's output.

## 4. Mechanism

Two vocabulary lists grow. Nothing else about the matcher changes.

### 4.1 Indicators (`IMPORT_ERROR_INDICATORS`)

Lower-cased substrings whose presence gates the basename tier and the excerpt. Added:

| Stack | Added indicators |
|---|---|
| Go | `cannot find package`, `no required module provides package` |
| Rust | `unresolved import`, `file not found for module`, `error[e0432]`, `error[e0583]` |
| Ruby | `cannot load such file` |
| PHP | `failed opening required` |

Rust carries two error codes because `E0432` is the unresolved import and `E0583` is the missing module
file — the latter is the one that actually names the file, so both are worth surfacing in the excerpt.
JVM gets no flat indicator: its only in-scope phrase has a variable identifier in the middle and is handled
by a naming pattern instead (see 4.2).

### 4.2 Naming patterns

Today a single regex handles the shape *phrase then identifier*. JVM needs *phrase, identifier, phrase*, so
the single regex becomes a small list of patterns, each exposing the identifier as capture group 1, and the
match loop iterates the list. Behaviour for the existing patterns is unchanged.

```
1. (?:no module named|cannot find module|could not import|unable to resolve
   |cannot import name\s+[^\n]*?\bfrom
   |cannot find package|no required module provides package
   |file not found for module|cannot load such file --|failed opening required)
   \s+['"`]?([\w./-]+)['"`]?

2. package\s+([\w.]+)\s+does not exist          // JVM
```

The quote class gains a backtick so Rust's `` `helper` `` is captured. The identifier class is unchanged, so
a capture still stops cleanly at a quote, a semicolon or whitespace.

### 4.3 What each stack emits, and how it ties back

| Stack | Output when the discarded helper is imported | Capture | Leaf | Ties to |
|---|---|---|---|---|
| Ruby | ``cannot load such file -- support/helper (LoadError)`` | `support/helper` | `helper` | `spec/support/helper.rb` |
| PHP | ``Failed opening required 'helper.php'`` | `helper.php` | `helper` | `src/helper.php` |
| Rust | ``error[E0583]: file not found for module `helper` `` | `helper` | `helper` | `src/helper.rs` |
| Go | ``cannot find package "example.com/m/helper"`` | `example.com/m/helper` | `helper` | `helper/helper.go` |
| JVM | ``package com.foo does not exist`` | `com.foo` | `foo` | `com/foo.java` |

PHP additionally matches on the basename tier, since the message names `helper.php` outright — useful
redundancy, and no risk of a duplicate entry because each discarded file is pushed at most once.

### 4.4 Excerpt

`collectionErrorExcerpt` picks the one line that states the cause, for the retry feedback. Its line test
currently keys off the indicator list alone. It gains the naming patterns as an additional trigger, so JVM
(which has no flat indicator by design) still yields a real compiler line rather than nothing. This keeps
precision: naming patterns are specific, unlike a generic substring such as `does not exist`.

## 5. Coverage and residuals

**Coverage is deliberately uneven, and this is the honest summary:**

- **Strong — Ruby, PHP, Rust.** These name the missing file or its module directly. Clean ties.
- **Partial — Go.** A helper in a *separate* package produces `cannot find package …` and ties. A helper in
  the *same* package produces `undefined: Helper` — the symbol, never the file, which is already deleted.
- **Weak — JVM.** The common case of one discarded class yields `cannot find symbol`, or
  `package com.foo does not exist` whose leaf `foo` does not reach the class `Helper`. JVM therefore gets a
  phrase entry and a documented gap. The tie shown for JVM in 4.3 is the narrow case where the package leaf
  happens to equal the discarded file's leaf; it is not the common shape.

**Residuals, recorded on purpose and pinned by tests (section 6):**

1. Go, helper in the same package: `undefined: <Symbol>` is not tied.
2. JVM: `cannot find symbol` is not tied; nor is the class file in the usual case of discarding one class.
3. Compiler or interpreter wording outside the listed phrases (other versions, other locales).
4. The Python namespace-package gap from ENG-342 — pre-existing, untouched.

Each residual keeps the *old* behaviour, which is the behaviour every one of these stacks has today. This
change strictly reduces exposure; it does not introduce a new way to fail.

## 6. Testing

### 6.1 Unit tests — `test/dispatch/check-selector.test.ts`

The matcher is pure, so the unit layer carries the exhaustive matrix. For each of the five stacks:

- **A matching case** — the stack's real error text plus the discarded helper returns that helper.
- **A non-matching case** — a genuine red naming the *feature* that does not exist yet, with an unrelated
  throwaway discarded, returns nothing. This is the guarantee that the guard never wrongly rejects a test
  that is supposed to fail at this stage.

Plus two **residual pins**, asserting the guard deliberately returns nothing for Go `undefined: Helper` and
JVM `cannot find symbol`, so an accepted gap cannot silently change without a test turning red.

### 6.2 Smoke cells — `test/dispatch/scope-disposition-smoke.test.ts`

Three cells in the established style (contrast pairs, real registry, real worktree, real git), numbered
**A17, A18 and A19** to continue after ENG-342's A14 to A16. These prove the wiring through the full
`checks:dispatch` path for a stack that is not Python — the unit matrix covers the text matching, these
cover the plumbing.

- **A17 — Ruby, matching.** An undeclared `spec/support/helper.rb` is discarded; rspec reports the LoadError;
  the criterion comes back uncovered and the file is named in the message.
- **A18 — Ruby, contrast.** A legitimate red for a feature that does not exist, with an unrelated throwaway
  discarded; the criterion stays covered and the red is installed. This is what makes A17 non-vacuous.
- **A19 — Go, matching.** An undeclared helper in a separate package is discarded; `cannot find package`
  fires; uncovered, file named. Confirms the behaviour is not specific to Ruby.

**Harness work this requires.** `setupChecks` hardwires a `kind: "python"` work unit and `driveChecks`
hardwires `pythonProfile`; both gain a parameter so a Ruby or Go profile and work-unit kind can be supplied.
The check path layer already accepts any extension (`isCanonicalCheckPath` matches `{ident}_ac{n}_test.` with
any suffix), and `frameworkFor` already maps the kinds `ruby` and `go`, so no production code changes for the
smoke work. During planning, confirm the injected exit codes read as non-green through
`interpretRunOutput` for rspec and go — the guard only runs when the coarse result is not green.

## 7. Out of scope

- The coarse bucketing (`interpretRunOutput`) and the downstream rule that downgrades an `environmental`
  result to a non-gating advisory. The fix stays at the decision of whether a criterion counts as covered,
  exactly as PR #91 did.
- Making the matcher framework aware (rejected as D1).
- Any change to `prompts/checks.md`. The convention it states — declare the support files your check needs —
  is already language independent, and INV-A keeps conventions in the forward prompt rather than in failure
  feedback.

## 8. Invariants held

- **INV-A** (conventions live in forward prompts, uniform): untouched; no prompt change.
- **INV-B** (failure feedback is diagnosis only): the message continues to state the cause, the discarded
  file and the framework's own line. It carries no instruction.
- **Conservative matching**: every added phrase names a file, module or package path. No phrase fires on a
  bare basename, and no generic word is added to the indicator list.
- **Ground truth over self-report**: the guard reads the framework's real output, never an agent's claim.

## 9. Review trail

_To be completed after the independent adversarial review of this design._
