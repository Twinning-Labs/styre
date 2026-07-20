# ENG-343 — A per-language rule registry for the discard poison matcher

**Status:** design agreed (2026-07-20), reworked after an independent three-reviewer panel.
**Ticket:** ENG-343 · **Branch:** `fix/checks-discard-poison-matcher-langs-eng-343`
**Supersedes:** the first draft of this document (commit `7aff853`), whose central premise the panel
falsified. Section 10 records what changed and why.

---

## 1. Problem

`checks:dispatch` discards undeclared new files before committing (declare-or-discard, PR #91). When the
checks agent's canonical test imports a helper it forgot to declare, that helper is discarded and the test
can no longer run. Left unhandled the broken test is recorded as covering the acceptance criterion, the
classifier can call it `environmental`, and `post-implement-rerun.ts` downgrades it to a non-gating
advisory — so the criterion ships without having been verified. That is a bad merge nobody notices.

PR #91 closed this with `importErrorImplicatesDiscarded` (`src/dispatch/check-selector.ts`): a check that did
not go green, whose output names a file this attempt discarded, is routed to the uncovered path (loud retry,
the file named) instead of installing a permanently broken check.

**The gap.** That guard's vocabulary recognises Python and Node wording only. Go, Rust, JVM, Ruby and PHP
report the same failure with different text, so the guard stays silent and the same bad merge remains
possible there. PR #91 recorded this as a deliberate residual.

## 2. Why the obvious fix does not work

The obvious fix — append every stack's phrases to the two existing flat lists — was the first draft of this
design. An independent panel disproved it by running the proposed vocabulary against **real toolchains**
(ruby 2.6.10, php 8.5.8, rustc/cargo 1.94, go 1.24). Two problems are fatal:

**Cross-stack false rejects.** The lists are global, so every phrase applies to every run. `package X does
not exist` is ordinary English, and these were produced by the patched code:

```
"Failure: expected \"package tracking does not exist\" but got \"ok\""  + ["spec/tracking.rb"]  → implicated
"assert 'package acme.widget does not exist' in msg"                    + ["tools/widget.py"]   → implicated
```

A legitimately red check gets declared uncovered, burning a retry attempt and trending toward escalation.

**Naive leaf matching collides.** Reducing a package path to its last segment and comparing it to a file's
leaf is far too loose for package-oriented languages, whose leaves are dominated by generic nouns:

```
"no required module provides package github.com/stretchr/testify/assert" + ["internal/scratch/assert.go"] → implicated
"error: package org.junit.jupiter.api does not exist"                    + ["src/test/java/api.java"]     → implicated
```

Both are the *common* red on those stacks (a dependency missing from `go.mod` or the classpath).

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Structure | **Framework aware, via a per-language rule registry.** `importErrorImplicatesDiscarded` takes the framework and consults only that language's rules. *(Reversed from the first draft, which was framework agnostic on my incorrect claim that every phrase is distinctive to its stack.)* |
| D2 | Errors naming only a symbol (Go `undefined: X`, JVM `cannot find symbol`) | **Not tied.** Documented residuals, pinned by tests. |
| D3 | How packages tie | **By directory, not by file leaf,** for Go and JVM, where a package *is* a directory. Reuses the segment-suffix helpers written for `__init__.py`. |
| D4 | The `error` bucket hole (§8) | **Out of scope.** Documented here, tracked in its own ticket. |
| D5 | Test coverage | Unit tests per language against the registry, plus three smoke cells. |

D1 is what makes the rest safe: with the registry, a Ruby run never sees JVM phrases, so the false rejects
in §2 cannot occur. It also removes an alternation-ordering bug for free — Node's `cannot find module`
would otherwise shadow Go's `cannot find module providing package` (leftmost alternation wins, capturing the
literal word `providing`), but the two now live in different rule sets and never compete.

## 4. Mechanism

### 4.1 The registry

One entry per `CheckFramework`. Python and Node entries are populated from today's flat lists so their
behaviour is unchanged.

```ts
interface LanguageRules {
  /** Lower-cased substrings that mark this run as an import/collection failure. Used for the excerpt. */
  indicators: string[];
  /** The subset of indicators allowed to gate the bounded-basename tier. Often the same; empty where
   *  the compiler prints candidate paths that would poison it (Rust — see 4.4). */
  basenameGates: string[];
  /** Patterns whose capture group 1 is the named module, package or file path. */
  naming: RegExp[];
  /** Shape rules for marker files that carry no name of their own (`__init__.py`, `mod.rs`) and for
   *  package paths that must tie by directory (Go, JVM). */
  shapes: ShapeRule[];
}
```

The signature becomes `importErrorImplicatesDiscarded(rawOutput, discarded, framework)`. A `null` framework
returns `[]` — when no framework is detected the runner already produces empty output (`handlers.ts:643`),
so there is nothing to match anyway.

**This registry is the extension point.** New languages, new phrasings and per-language exceptions are added
here rather than by growing shared lists. Every rule sits beside the language it belongs to, which is what
makes the exceptions in 4.3 and 4.4 legible rather than special cases scattered through one function.

### 4.2 How each language ties

| Framework | Naming pattern (capture group 1) | Ties by |
|---|---|---|
| `rspec`, `minitest` | `cannot load such file --\s+([\w./-]+)` | file leaf |
| `phpunit` | `failed opening required\s+['"]?([\w./-]+)` | file leaf |
| `cargo` | ``file not found for module\s+['"`]?(\w+)`` | file leaf, plus the `mod.rs` shape (4.4) |
| `go` | `no required module provides package\s+([\w./-]+)`, `cannot find module providing package\s+…`, `cannot find package\s+["']?…` | **directory** (4.3) |
| `junit-maven`, `junit-gradle` | `error:\s+package\s+([\w.]+)\s+does not exist` | **directory** (4.3) |

The Rust pattern needs a backtick in its quote class — rustc writes `` `helper` `` and without it the capture
fails outright. The JVM pattern is anchored to javac's own `error:` gutter rather than left as bare English.

### 4.3 Packages tie by directory

A Go or JVM package is a directory, so matching a package path against a *file* leaf is a category error —
the source of both collisions in §2. Instead:

- **Go:** implicate a discarded file only when the package path's last segment equals the name of the
  directory containing that file. `example.com/m/helper` with `helper/helper.go` ties (directory `helper`);
  `github.com/stretchr/testify/assert` with `internal/scratch/assert.go` does not (directory `scratch`).
- **JVM:** implicate only when the dotted package's segments are a trailing suffix of the file's directory
  segments — the rule `packageInitImplicated` already implements for `__init__.py`, via `isSegSuffix`.
  `com.helper` with `src/test/java/com/helper/Helper.java` ties; `org.junit.jupiter.api` with
  `src/test/java/api.java` does not.

This also fixes an error in the first draft, which claimed `package com.foo does not exist` ties to
`com/foo.java`. That layout is impossible — a file at `com/foo.java` is a class in package `com`, and javac
would emit `cannot find symbol` instead.

### 4.4 Rust needs a marker shape, and no basename gate

Two findings, both verified against real cargo output:

```
error[E0583]: file not found for module `newfeature`
  = help: to create the module `newfeature`, create file "src/newfeature.rs" or "src/newfeature/mod.rs"
```

- The help line contains `mod.rs` as a bounded token. If `error[e0583]` were allowed to gate the generic
  basename tier, **any** discarded `mod.rs` would be implicated by **any** E0583, regardless of which module
  is missing. So `cargo`'s `basenameGates` is empty; its indicators serve the excerpt only.
- The idiomatic Rust test helper is `tests/common/mod.rs`, whose leaf is `mod`, not `common` — the naming
  tier can never tie it. `mod.rs` is a leafless marker exactly like `__init__.py`, so it gets the same
  directory-derived shape: implicate when a named module equals the containing directory's name.

### 4.5 Excerpt

`collectionErrorExcerpt` picks the one line stating the cause for the retry feedback. It becomes framework
aware alongside the matcher, and additionally triggers on the naming patterns so JVM yields a real compiler
line. Note this changes existing output in two untested cases — `could not import` and `unable to resolve`
are naming alternatives that were never indicators, so lines containing them now produce an excerpt where
they previously produced none. Harmless (diagnosis text only), but it must be pinned by a test rather than
left as drift.

## 5. Coverage, honestly

Verified against real toolchains. **The shapes that tie are, in several ecosystems, the minority ones.**

| Stack | Ties | Does not tie |
|---|---|---|
| **Go** | helper in a *separate* package (`no required module provides package`) | helper in the *same* package → `undefined: Helper` names the symbol; the file is already gone |
| **Rust** | `mod`-style modules (E0583), including `tests/common/mod.rs` via the marker shape | `use`-style imports (E0432) name no file at all |
| **Ruby, minitest** | explicit `require` of the discarded helper | — |
| **Ruby, rspec** | boot-time require failure only (a broken `.rspec --require`, which aborts before any summary) | the **two common shapes**: a spec-file `LoadError` is intercepted as `selected-none` before the guard runs (§6); and the standard `Dir[…].each { require f }` support loader yields `uninitialized constant Helper (NameError)`, not a `LoadError` |
| **PHP** | explicit `require`/`require_once` | composer PSR-4 autoload — the norm — yields `Class "Helper" not found` |
| **JVM** | only when the package directory suffix matches (4.3) | the common single-class discard → `cannot find symbol` |

**What this means:** ENG-343 delivers real coverage on Go (separate package), Rust (`mod`-style), minitest
and explicit-require PHP; partial coverage on JVM; and — importantly — **almost nothing on rspec**, which is
the more common Ruby framework.

**Honest cost statement.** The first draft claimed this change "does not introduce a new way to fail." That
was false. Every rule widens the surface on which a legitimately red check can be wrongly declared uncovered,
costing a retry attempt and, on exhaustion, an escalation. The registry confines that risk to one language at
a time and the directory rules remove the known collisions, but the risk is not zero. The trade is: a bounded
retry cost against preventing a criterion from shipping unverified.

## 6. The rspec wiring residual

`interpretRunOutput` (`check-selector.ts:216-218`) tests rspec output for `\b0 examples` **before** consulting
the exit code. RSpec does not abort on a spec-file load error — it reports the error and still prints
`0 examples, 0 failures`, exiting 1. So the run is bucketed `selected-none`, and `handlers.ts:670-673`
returns *above* the guard at line 684. The guard never executes and the new vocabulary is never consulted.

**This is not a safety hole.** The `selected-none` branch also declines to mark the criterion covered, so the
postcondition throws and `discardNote` (`handlers.ts:718-721`) still names the discarded files. The failure
mode is prevented — by a different door, with a less specific message.

It is, however, a **coverage claim** that must not be overstated, and the reason §5 rates rspec as it does.
Changing the bucketing to route rspec load errors to `red` is deliberately **out of scope**: it would be churn
on a path that is already safe. Instead, cell A19 (§7.2) pins the current behaviour so that if anyone ever
changes that branch, a test turns red and this decision is revisited on purpose.

## 7. Testing

### 7.1 Unit tests — `test/dispatch/check-selector.test.ts`

Existing Python and Node cases gain the framework argument; their expectations do not change (this is the
regression proof that the registry preserves current behaviour).

Per language, three cases rather than the first draft's two — because the draft's negatives were vacuous
(they passed with the whole feature deleted):

1. **Matching** — the stack's real error text plus the discarded helper returns that helper.
2. **One-variable contrast** — the *same* output, varying only the discarded path to a non-implicated file.
   This is what makes case 1 non-vacuous.
3. **Colliding leaf** — the collisions from §2 as explicit negatives: `…/testify/assert` against
   `internal/scratch/assert.go`, `org.junit.jupiter.api` against `src/test/java/api.java`, and a near-miss
   leaf for Ruby (`helpers.rb` against a `helper` require).

Plus:
- **A framework-gate pin:** JVM error text fed to a `pytest` run implicates nothing. This is the direct test
  of D1 and of the §2 false rejects.
- **Residual pins:** Go `undefined: Helper`, JVM `cannot find symbol`, Rust E0432 — each asserting the guard
  returns nothing, so an accepted gap cannot silently change.
- **An excerpt drift pin** for the `could not import` / `unable to resolve` behaviour change (4.5).

Error text in every case must be real toolchain output. The first draft used `cannot find package "…"`,
which is GOPATH-era wording modern Go does not emit; the modern form is `no required module provides
package …`.

### 7.2 Smoke cells — `test/dispatch/scope-disposition-smoke.test.ts`

Three cells, numbered **A17 to A19**, continuing after ENG-342's A14 to A16. The first draft proposed two
Ruby cells; both were infeasible (§6), so the mix is now:

- **A17 — Go, matching.** Undeclared `helper/helper.go` discarded; injected exit 1 with `no required module
  provides package example.com/m/helper`; assert uncovered, nothing committed, no check persisted, the file
  named in the message.
- **A18 — Go, contrast.** Same stack, one variable: output names a feature package, the discarded file is an
  unrelated throwaway. Assert the step succeeds and the red check *is* installed. Same-stack contrast
  isolates the guard rather than the language.
- **A19 — rspec, residual pin.** Inject the **real** rspec load-error output including `0 examples,
  0 failures`, exit 1. Assert the actual behaviour: uncovered via `selected-none`, message matching
  `/matched no test/`, and the helper **not** named. Commented as the §6 residual.

**Harness work.** Smaller than the first draft claimed, and in a different place. The framework is derived
from the profile component owning the committed test path (`handlers.ts:634-635`), **not** from the work-unit
kind — so `setupChecks`'s `kind: "python"` needs no change at all. What is needed: a `goProfile`/`rubyProfile`
helper, a `profile` option on `driveChecks`, and extension parameters on `canonicalTest`/`canonicalDeclared`.
No production code changes. `isCanonicalCheckPath`, `checksScopeFor` and the discard sweep are all already
extension agnostic, and the pytest interpreter branch is guarded on `fw === "pytest"`.

Two traps to avoid: a Ruby profile must set `commands.test` naming rspec or minitest or `frameworkFor`
returns `null`; and `git clean -fd` leaves the emptied `helper/` directory behind, so do not assert on its
absence.

## 8. Out of scope, and what is left open

- **The `error` bucket (tracked separately).** A check with `coarse === "error"` and empty output — no
  framework detected, no interpreter, or a timeout — reaches the guard with nothing to match, is marked
  covered, then `classify-prior.ts:23` stamps it `environmental` and `post-implement-rerun.ts:84-86`
  downgrades it to a non-gating advisory. The criterion ships unverified. No phrase vocabulary can close
  this. It is reachable on a new stack specifically: a Ruby component whose test command names neither rspec
  nor minitest yields `framework = null`. **Filed as its own ticket; explicitly not fixed here.**
- **The coarse bucketing** (`interpretRunOutput`), including the rspec branch (§6).
- **The downstream downgrade rule** (`post-implement-rerun.ts`).
- **`prompts/checks.md`.** The convention it states — declare the support files your check needs — is already
  language independent (INV-A keeps conventions in the forward prompt, not in failure feedback).
- **Pre-existing, unrelated:** canonical check basenames are `{ident}_ac{n}_test`, and an identifier such as
  `ENG-343_ac1_test` is not legal Java, so JVM checks cannot compile today regardless of any discard. Noted
  on the ticket; not addressed here.

## 9. Invariants held

- **INV-A** (conventions live in forward prompts): untouched, no prompt change.
- **INV-B** (failure feedback is diagnosis only): the message states the cause, the discarded file and the
  framework's own line. It carries no instruction.
- **Conservative matching**: every rule ties to a named file, module or package *directory*. Nothing fires on
  a bare basename, and no rule crosses a language boundary.
- **Ground truth over self-report**: the guard reads the framework's real output, never an agent's claim.

## 10. Review trail

Three independent code-grounded reviewers examined the first draft (commit `7aff853`). All three returned
**NEEDS REWORK**; one reproduced its findings by patching a scratch copy of the matcher and running real
toolchain output through it. Findings adopted:

| Finding | Change |
|---|---|
| `package X does not exist` is plain English; confirmed cross-stack false rejects | D1 reversed to framework aware; the pattern anchored to javac's `error:` gutter (4.2) |
| Package leaf matching collides on generic names (`assert`, `api`, `util`) | D3: Go and JVM tie by directory (4.3) |
| E0583's help note names `mod.rs`, poisoning the basename tier | `cargo` has no basename gates (4.4) |
| `tests/common/mod.rs` has leaf `mod` and can never tie by name | `mod.rs` marker shape (4.4) |
| Node's `cannot find module` shadows Go's `cannot find module providing package` | Dissolved by the registry — different rule sets (D1) |
| rspec load errors are bucketed `selected-none` before the guard | §6 written; smoke cells A17/A18 replaced with Go; A19 pins the residual |
| rspec `Dir[…].each` autoload yields `NameError`; PHP PSR-4 yields `Class not found` | §5 corrected — these are the common shapes and they do not tie |
| Rust E0432 ties nothing | Listed as a residual, pinned by a test (7.1) |
| The JVM example `com/foo.java` is an impossible layout | Corrected to `com/helper/Helper.java` (4.3) |
| Go exemplar used GOPATH-era wording | Modern module wording throughout (7.1) |
| All five proposed negatives were vacuous | Replaced with one-variable contrasts plus colliding-leaf cases (7.1) |
| Harness plan named the wrong lever (work-unit kind) | Corrected — framework comes from the profile component (7.2) |
| The `error` bucket is a guard-proof route to the same bad merge | §8, filed as a separate ticket |
| "Does not introduce a new way to fail" was false | Replaced with an explicit cost statement (§5) |
| Excerpt change affects more than JVM | Stated and pinned (4.5, 7.1) |
