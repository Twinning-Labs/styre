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
| D5 | Test coverage | Unit tests per language against the registry, plus four smoke cells. |
| D6 | Symbols the toolchain names without naming a file | **Tie them by evidence** (§4.5): capture each undeclared file's contents before discarding, and implicate one that *defined* the missing symbol. *(Added after the design review; supersedes D2's "not tied" for every case where the discarded file demonstrably defined the symbol. D2's conservatism still governs everything else — a symbol we cannot evidence is still never guessed at by name.)* |

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
   *  the toolchain prints candidate paths that would poison it (cargo, JVM — see 4.4). */
  basenameGates: string[];
  /** Patterns whose capture group 1 is the named module, package or file path. */
  naming: RegExp[];
  /** When true, a discarded file whose module leaf equals a named reference is implicated. FALSE for
   *  package-oriented languages (go, jvm), where leaf matching collides on generic nouns (4.3). */
  tiesByLeaf: boolean;
  /** Shape rules for marker files that carry no name of their own (`__init__.py`, `mod.rs`) and for
   *  package paths that must tie by directory (Go, JVM). */
  shapes: ShapeRule[];
  /** Patterns whose capture is a SYMBOL the toolchain names without naming its defining file (4.5). */
  symbolNaming?: RegExp[];
  /** Given a symbol, a pattern matching its definition in source. Paired with `symbolNaming`. */
  definesSymbol?: (symbol: string) => RegExp;
  /** This language's "fixture not found" pattern, if it has one. Per-language: a global pattern leaked
   *  across languages (Rails emits `fixture 'users' not found`). Must not carry the `g` flag. */
  fixturePattern?: RegExp;
  /** When true, a line beginning `ERROR` is preferred as the excerpt (pytest's summary line). */
  prefersErrorSummary?: boolean;
}
```

The signature becomes `importErrorImplicatesDiscarded(rawOutput, discarded, framework, sources?)` — the
fourth argument carries the discarded files' captured contents for the symbol tier (§4.5) and is optional,
so every name-based caller and test is unaffected. A `null` framework returns `[]`; when no framework is
detected the runner already produces empty output, so there is nothing to match anyway.

Note that `fixturePattern` and `prefersErrorSummary` are per-language **fields rather than globals**. Both
began as module-level constants and leaked: a global fixture pattern fired on Rails' `fixture 'users' not
found`, and a global `ERROR`-summary preference let an unrelated Maven line win the excerpt. Anything that
influences matching or the excerpt belongs in the registry — that is what "sole extension point" means.

**This registry is the extension point.** New languages, new phrasings and per-language exceptions are added
here rather than by growing shared lists. Every rule sits beside the language it belongs to, which is what
makes the exceptions in 4.3 and 4.4 legible rather than special cases scattered through one function.

### 4.2 How each language ties

Every gap between a phrase and its capture is written `[^\S\r\n]+` — horizontal whitespace only. `\s+`
would match a newline, letting a capture be lifted off the *following* line and implicate an unrelated
file; that was a measured defect, not a hypothetical. "Single-line regex" therefore means two things: the
pattern occupies one source line, **and** it cannot span an output line.

| Framework | Naming pattern (capture group 1) | Ties by |
|---|---|---|
| `rspec`, `minitest` | `cannot load such file --[^\S\r\n]+([\w./-]+)` | file leaf |
| `phpunit` | `failed opening required[^\S\r\n]+['"]?([\w./-]+)['"]?` | file leaf |
| `cargo` | ``file not found for module[^\S\r\n]+['"`]?(\w+)`` | file leaf, plus the `mod.rs` shape (4.4) |
| `go` | `no required module provides package[^\S\r\n]+([\w./-]+)`, `cannot find module providing package…`, `cannot find package…` | **directory** (4.3) |
| `junit-maven`, `junit-gradle` | `error:[^\S\r\n]+package[^\S\r\n]+([\w.]+)[^\S\r\n]+does not exist` **and** `:\[\d+,\d+\][^\S\r\n]+package[^\S\r\n]+([\w.]+)[^\S\r\n]+does not exist` | **directory** (4.3) |

The Rust pattern needs a backtick in its quote class — rustc writes `` `helper` `` and without it the capture
fails outright.

**JVM needs two patterns, because anchoring must follow the build tool's rendering, not the compiler's.**
The first draft anchored to javac's own `error:` gutter. That is correct for Gradle, which passes javac
through verbatim — but `mvn` runs javac via maven-compiler-plugin, which reformats the diagnostic and drops
the `error:` token entirely:

```
[ERROR] /repo/src/test/java/com/x/ATest.java:[3,26] package com.helper does not exist
```

With only the javac form, `junit-maven` — the framework every Maven project uses — would never tie and would
produce no excerpt either. The second pattern anchors on the `:[line,col]` bracket form instead, which is
structural rather than bare English. Note the Maven form is deliberately **not** given a matching indicator:
a `] package ` indicator let a trailing `[WARNING] [deprecation] package … does not exist anymore` line win
the excerpt's last-match rule and displace the real error.

### 4.3 Packages tie by directory

A Go or JVM package is a directory, so matching a package path against a *file* leaf is a category error —
the source of both collisions in §2. Instead:

The two rules are **mirror images**, because the two ecosystems put different halves of the path on disk:

- **Go:** the module prefix is *not* on disk, so the discarded file's **directory segments must be a trailing
  suffix of the package path's segments**. `example.com/m/helper` ties `helper/helper.go` *and*
  `helper/util.go` (directory `[helper]` is a suffix of `[example, com, m, helper]`), while
  `github.com/stretchr/testify/assert` does not tie `internal/assert/helper.go` — `[internal, assert]` is
  compared against `[testify, assert]` and fails.
- **JVM:** the source root (`src/test/java`) *is* on disk, so the relationship inverts — the **package's
  segments must be a trailing suffix of the file's directory segments**, the rule `packageInitImplicated`
  already implements for `__init__.py` via `isSegSuffix`. `com.helper` ties
  `src/test/java/com/helper/Helper.java`; `org.junit.jupiter.api` does not tie `src/test/java/api.java`.
  JVM additionally requires **≥2 package segments**, so a single generic name (`package util does not exist`)
  cannot implicate `src/test/java/util/Scratch.java`.

An earlier draft of this section described Go as comparing only the package's *last* segment to the
directory name. That is weaker than what shipped, and measurably so: it still implicated
`internal/assert/helper.go` for a missing `testify/assert`, merely relocating the collision from the file
leaf to the directory leaf.

**Residual — Go, single-segment directories.** When the discarded file's directory has exactly one segment
the suffix comparison degenerates to a leaf comparison, so a top-level `assert/`, `cmp/` or `util/` directory
*is* implicated by a missing dependency whose package leaf matches. Go cannot take JVM's ≥2-segment floor
without killing the ordinary `helper/helper.go` positive. The consequence is a spurious retry, never a wrong
verdict. Pinned by test.

**Residual — Go, missed ties.** A package at the repo root (no directory segments), a nested-module layout
where the on-disk path carries segments the import path lacks, and a directory name containing a dot all
fail to tie. All fail in the safe direction.

This section also fixes an error in the first draft, which claimed `package com.foo does not exist` ties to
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

### 4.5 The symbol definition tier

Several toolchains report a missing **symbol** rather than a missing file: the file that defined it is
already deleted, so the compiler has nothing to name. `undefined: Help` (Go, same package),
`cannot find symbol: class Helper` (JVM), `Class "Helper" not found` (PHP with Composer autoloading),
`uninitialized constant Helper` (Ruby with rspec's usual support-file loader). No amount of phrase
matching can tie these to a file, because the file's name never appears.

They can be tied by **evidence** instead of by name: read each undeclared file's contents just before
discarding it, then ask whether any of them *defined* the symbol the toolchain says is missing. If the
discarded file contains `func Help(`, the deletion is the cause. This is not a guess — it is the
strongest tie in the whole matcher, because it requires the error to name the exact symbol *and* a
discarded file to define it.

**Why Python and Node get no symbol tier, and why Ruby and PHP do.** Python's `NameError: name 'x' is not
defined` and Node's `ReferenceError: X is not defined` arrive on *runtime* failures of checks that
collected fine — and a RED-first check failing on an absent name is the normal, correct case there, so a
symbol tier would reject legitimately red checks wholesale. Ruby's `uninitialized constant` and PHP's
`Class "X" not found` are the same runtime shape, so the exclusion argument would apply to them too were
it taken alone. They are included because the *conjunction* is the real gate: the error must name the
symbol **and** a file discarded on this very attempt must define it. On Python and Node that conjunction
would additionally have to displace behaviour this change promises to leave untouched (§4.1), which is the
deciding difference. The cost of including Ruby and PHP is the residual below, not a new class of failure.

**Plumbing.** `discardPaths` deletes the files, and only the path strings survive in `discarded`. So the
contents are captured on the line immediately before that call — the sole `discardPaths` call site, so
there is no path that discards without capturing. `discarded: string[]` stays exactly as it is: it feeds
the `scope-discarded` telemetry payload, the retry note and the implement handler, none of which should
carry file contents. A separate, process-local `discardedSources: Map<path, content>` rides beside it and
is read in exactly two places — the destructure in `checks:dispatch` and the guard call. **No file
contents reach SQLite, telemetry, or any log**, and a test pins that by asserting the payload's key set.

**This plumbing fails open and quiet**, which is its main risk: if the map arrives empty the tier silently
does nothing and every name-based test still passes. Two things guard it. The map's keys must be the exact
strings in `discarded` — both come from the same array, never rebuilt or normalised — and that identity is
pinned directly. And smoke cell A20 drives the real dispatch path end to end, so emptying the map,
un-threading it, or prefixing its keys each turns it red.

Reads are bounded: 256 KB per file and 4 MB total per dispatch, so an agent emitting hundreds of generated
files cannot pin unbounded memory. Symlinks are skipped rather than followed, so a discarded link cannot
cause an arbitrary file outside the worktree to be read.

**Registry fields.** Two optional per-language entries: `symbolNaming` (patterns whose capture is the
missing symbol) and `definesSymbol` (given a symbol, a pattern matching its definition in source):

| Stack | Symbol named by | Definition matched by |
|---|---|---|
| Go | `undefined: Help` **and** `… has no field or method Help`, both anchored to the `file.go:LINE:COL:` gutter | `func`/`type`/`var`/`const Help`, with an optional receiver so methods tie |
| JVM | `symbol: class Helper` (type kinds only) | `class`/`interface`/`enum`/`record Helper` |
| PHP | `Class "App\Helper" not found` | `class`/`interface`/`trait Helper`, case-insensitively |
| Ruby | `uninitialized constant Helper` | `class`/`module Helper` |
| Rust | `cannot find <kind> \`help\`` (kinds may be compound: *"function, tuple struct or tuple variant"*) **and** E0433 `use of undeclared \`Helper\`` | `fn`/`struct`/`enum`/`trait`/`const`/`static`/`type Help` |

Qualified names are reduced to their last segment first (`App\Helper` → `Helper`, `Foo::Bar` → `Bar`).

Four of these entries are narrower or wider than they first look, and each difference was measured:

- **Go is anchored to the compiler's gutter.** Unanchored, `undefined: Config` inside a test's own
  assertion message would fire the tier — ordinary program text masquerading as a diagnostic, the §2
  failure class reappearing *within* a single language.
- **Go needs the receiver form**, or a discarded `func (r T) Help()` never ties.
- **JVM captures only type kinds.** `symbol: method helper(int)` would otherwise cross-match a file
  declaring `class helper`, since the definition side only recognises type declarations.
- **Rust needed widening twice.** rustc writes compound kinds with commas, and emits E0433 for
  `Helper::new()` — the most common way a test reaches a discarded helper. The first draft's single narrow
  pattern caught neither.

**PHP is case-insensitive on the definition side** because PHP class names are; `Class "Helper" not found`
must tie a file declaring `class helper`.

**Degradation.** When contents are unavailable — a file too large to read, an unreadable path, or a
caller that does not supply them — the tier is simply inert and the other tiers behave exactly as
before. Nothing depends on it.

**Residual, stated honestly.** The definition pattern is a text search, so a discarded file that merely
*contains* a definition of the named symbol is implicated — a comment, a string literal, a code
generator's fixture, or a **compile stub the agent wrote so its own test would build**.

It is tempting to argue the two conditions rarely co-occur. That argument is wrong on compiled stacks:
the error naming the missing symbol is not unlikely there, it is the *normal* shape of a healthy
RED-first check, because the feature genuinely does not exist yet. So the conjunction collapses to a
single condition — does any discarded file textually define the symbol — and the most likely discarded
file at checks time is exactly a stub defining it.

The concrete case: the agent writes a check referencing `Config` plus an undeclared stub
`type Config struct{}`, the stub is discarded, `undefined: Config` follows, and a good RED check is sent
back as uncovered. The precision of this tier therefore rests entirely on the definition side, not on
the conjunction.

The cost is one retry attempt, never a bad merge, and it self-heals on the next attempt because there is
no stub left to discard. The feedback is also arguably right: discarding that stub *did* break the
check, and naming it tells the agent to declare it. A persistently stubbing agent would burn the budget
toward an escalation — that is the accepted downside.

Two mitigations are applied rather than relying on the conjunction, **and they cover only two of the five
stacks**: Go's symbol patterns are anchored to the compiler's `file.go:LINE:COL:` gutter, so
`undefined: Config` appearing inside a test's own assertion message does not fire the tier; and JVM
captures only type-kind symbols, so a `symbol: method` line cannot cross-match a type declaration.

**Rust, Ruby and PHP symbol patterns are unanchored, and the failure class is reproducible on all three.**
Each of these implicates, verified by execution:

| output | discarded file's contents | result |
|---|---|---|
| `assertion failed: cannot find "widget" in the registry` (cargo) | `pub fn widget()` | implicated |
| `expect { boom }.to raise_error("uninitialized constant Helper")` (rspec) | `class Helper` | implicated |
| `Failed asserting that 'Class "Helper" not found' equals 'ok'` (phpunit) | `class Helper` | implicated |

In each case a test's own assertion text is mistaken for a diagnostic — the §2 failure class reappearing
*within* a single language, where the registry cannot help. Rust's kind class is the loosest of the three,
since `cannot find "x"` is ordinary English. The cost is the same as every other over-fire here: a spurious
retry on an already-failing check, never a bad merge. Anchoring Rust to `error[E0` (and requiring a rustc
kind word) would close most of it, and the same treatment applies to Ruby's `(NameError)` suffix and PHP's
`Uncaught Error:` prefix. **Filed as ENG-348** rather than patched here: it is a behaviour change arriving
after the branch's final review, and landing unreviewed matching logic at the end is precisely the failure
mode this ticket kept surfacing. The safe direction is already held — a misfire costs a retry, not a merge.

### 4.6 Excerpt

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
| **Go** | helper in a *separate* package (`no required module provides package`); helper in the *same* package via the symbol tier (§4.5) | a symbol whose definition the discarded file does not textually contain |
| **Rust** | `mod`-style modules (E0583), including `tests/common/mod.rs` via the marker shape; `cannot find <kind> \`x\`` and E0433 `use of undeclared …` via the symbol tier | plain `use`-style imports (E0432), which name neither a file nor a symbol in scope |
| **Ruby, minitest** | explicit `require` of the discarded helper; a missing constant via the symbol tier | a symbol whose definition the discarded file does not textually contain |
| **Ruby, rspec** | the standard `Dir[…].each { require f }` support loader, via the symbol tier (`uninitialized constant Helper` arrives as a normal red); boot-time require failure | a spec-file `LoadError`, which is intercepted as `selected-none` before the guard runs (§6) |
| **PHP** | explicit `require`/`require_once`; composer PSR-4 autoload via the symbol tier (`Class "Helper" not found`) | `Call to undefined function`, and `Interface`/`Trait "X" not found` — neither is captured |
| **JVM** | the package directory suffix (4.3); the common single-class discard via the symbol tier (`cannot find symbol`) | a package missing for reasons other than the discard |

**What this means:** with the symbol tier, ENG-343 delivers real coverage on all five stacks. The Go
same-package case, the JVM single-class case, rspec's usual support-file loader and PHP's Composer
autoloading — the four gaps that made this change nearly worthless on two of the five stacks — are all
closed by evidence rather than by name guessing.

**One wiring gap remains, and it is not a safety hole.** An rspec *spec-file* `LoadError` is bucketed
`selected-none` before the guard runs (§6), so it produces a vaguer message. The criterion still does not
merge unverified.

**Remaining residuals, recorded on purpose and pinned by tests:**

1. An rspec spec-file `LoadError`, bucketed `selected-none` before the guard (§6). Safe, vaguer message.
2. Rust `use`-style imports (E0432): they name neither a file nor an in-scope symbol.
3. A symbol whose definition the discarded file does not textually contain — generated code, a macro, a
   symbol re-exported from elsewhere. Also Go grouped `const (…)` declarations, PHP
   `Call to undefined function`, and PHP `Interface`/`Trait` not found.
4. A discarded file that textually contains a definition without being the cause — a comment, a string
   literal, a generator fixture, or an agent's own compile stub (§4.5, where the cost is spelled out).
5. Toolchain wording outside the listed phrases (other versions, other locales).
6. The `error` bucket with empty output — ENG-347, out of scope here (§8).
7. **Unanchored symbol patterns on Rust, Ruby and PHP** (§4.5): a test's own assertion text mentioning
   the symbol is mistaken for a diagnostic. Reproduced on all three. **Tracked as ENG-348.**
8. **Go's single-segment directory collision** (§4.3), and Go's missed ties: a repo-root package, a
   nested-module layout, and a directory name containing a dot.
9. **The bounded-basename tier fires on a delimiter-bounded basename**, so a file merely named in the
   build output can be implicated — Go prints the *importing* file's path on every error line. Disabled
   for `cargo` and JVM, live for the rest.
10. **Windows-rendered paths never tie.** The bounded tier's leading-delimiter class omits a backslash,
    so `require(C:\app\src\helper.php)` matches nothing. Left as-is deliberately: macOS and Linux are
    styre's first-class targets, and widening the class would loosen the tier that already over-fires
    most, newly matching inside escaped and JSON-rendered paths on platforms styre *does* support.
11. **The tiers are language-blind on the file side.** A rule set applies to every discarded path
    regardless of extension, so in a polyglot repo an rspec run can implicate a discarded `.py` file that
    happens to define the named constant. Cost is a spurious retry naming the wrong file.

**Honest cost statement.** The first draft claimed this change "does not introduce a new way to fail." That
was false. Every rule widens the surface on which a legitimately red check can be wrongly declared uncovered,
costing a retry attempt and, on exhaustion, an escalation. The registry confines that risk to one language at
a time, segment alignment removes the measured directory and leaf collisions, and the symbol tier requires
positive evidence rather than a name coincidence — but the risk is not zero. The trade is: a bounded retry
cost against preventing a criterion from shipping unverified.

## 6. The rspec wiring residual

`interpretRunOutput`'s `case "rspec"` tests its output for `\b0 examples` **before** consulting
the exit code. RSpec does not abort on a spec-file load error — it reports the error and still prints
`0 examples, 0 failures`, exiting 1. So the run is bucketed `selected-none`, and `checks:dispatch`
`continue`s the per-AC loop *above* the guard. The guard never executes and the new vocabulary is never consulted.

**This is not a safety hole.** The `selected-none` branch also declines to mark the criterion covered, so the
postcondition throws and `discardNote` still names the discarded files. The failure
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
from the profile component owning the committed test path (the `impactedComponents`/`frameworkFor` pair in `checks:dispatch`), **not** from the work-unit
kind — so `setupChecks`'s `kind: "python"` needs no change at all. What is needed: a `goProfile`/`rubyProfile`
helper, a `profile` option on `driveChecks`, and extension parameters on `canonicalTest`/`canonicalDeclared`.
No production code changes. `isCanonicalCheckPath`, `checksScopeFor` and the discard sweep are all already
extension agnostic, and the pytest interpreter branch is guarded on `fw === "pytest"`.

Two traps to avoid: a Ruby profile must set `commands.test` naming rspec or minitest or `frameworkFor`
returns `null`; and `git clean -fd` leaves the emptied `helper/` directory behind, so do not assert on its
absence.

## 8. Out of scope, and what is left open

- **The `error` bucket — tracked as ENG-347.** A check with `coarse === "error"` and empty output — no
  framework detected, no interpreter, or a timeout — reaches the guard with nothing to match, is marked
  covered, then `classify-prior.ts:23` stamps it `environmental` and `post-implement-rerun.ts:84-86`
  downgrades it to a non-gating advisory. The criterion ships unverified. No phrase vocabulary can close
  this. It is reachable on a new stack specifically: a Ruby component whose test command names neither rspec
  nor minitest yields `framework = null`. **Filed as ENG-347; explicitly not fixed here.**
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
- **Conservative matching**: every rule ties to a named file, module or package *directory*, or — in the
  symbol tier (§4.5) — to a discarded file's own *contents*. No rule crosses a language boundary.
  The bounded-basename tier *does* fire on a basename, but only as a **delimiter-bounded token** and only
  while that language's indicator is present; it is deliberately disabled for `cargo` and JVM, where the
  toolchain prints candidate paths that would poison it. An earlier draft of this line claimed "nothing
  fires on a bare basename" — two tests shipping in this branch falsify that, and the claim is withdrawn
  rather than softened.
- **Single-line matching**: a naming pattern occupies one source line *and* uses horizontal-whitespace
  classes (`[^\S\r\n]+`). `\s` matches newlines, which would let a capture be lifted from the following
  output line and implicate an unrelated file.
- **Per-language ownership**: every matching rule lives in `CHECK_RULES`, including fixture patterns and
  excerpt preferences, and each rule set owns its own arrays — sharing one array object between two fields
  lets a later append leak across a language boundary.
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
| The `error` bucket is a guard-proof route to the same bad merge | §8, filed as ENG-347 |
| "Does not introduce a new way to fail" was false | Replaced with an explicit cost statement (§5) |
| Excerpt change affects more than JVM | Stated and pinned (4.6, 7.1) |

**Amendment (2026-07-20, after the plan review).** The operator asked whether the symbol-only cases could
be resolved by searching for the helper rather than accepting them as residuals. Searching the worktree
cannot work — `discardPaths` has already deleted the file, and a symbol being absent from the tree is
equally consistent with "we discarded it" and "the feature is not built yet", which are exactly the two
cases the guard must separate. Capturing the file's contents *before* discarding does work, and is
stronger than any name matching. Added as D6 / §4.5, closing the Go same-package, JVM single-class, rspec
autoload and PHP Composer gaps that §5 previously recorded as residuals.

**Amendment (2026-07-20, after the whole-branch review).** Three claims in this document were still
false when the branch was otherwise complete, and are corrected above rather than softened: §9's "nothing
fires on a bare basename" (the bounded tier does, by design, on a delimiter-bounded token); §4.5's
mitigation paragraph, which covered only Go and JVM while presenting the failure class as handled; and
§4.1's interface block, which omitted five shipped fields and understated the signature. Four unit tests
named `residual: … ⇒ not tied` were renamed, because the symbol tier closes exactly those cases and the
names asserted the opposite of what shipped. The recurring lesson across this ticket is recorded plainly:
every one of these was a document or a test describing behaviour it did not have, and each was found by
executing or mutating the code rather than by reading it.
