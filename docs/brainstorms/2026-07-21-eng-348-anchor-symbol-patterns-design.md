# ENG-348 — Anchor the Rust/Ruby/PHP symbol patterns

**Status:** design agreed (2026-07-21).
**Ticket:** ENG-348 · **Branch:** `rajatgoyal/eng-348-anchor-the-rustrubyphp-symbol-patterns-so-a-tests-own-error`
**Follows:** ENG-343 (`docs/brainstorms/2026-07-20-checks-discard-poison-matcher-langs-design.md`),
which built the symbol tier and recorded this as §5 residual 7. This ticket closes that residual.

---

## 1. Problem

The discard-poison guard's **symbol tier** (`importErrorImplicatesDiscarded`,
`src/dispatch/check-selector.ts`) pulls a missing symbol name out of a check's output and implicates a
file this attempt *discarded* that **defined** it. On **Rust, Ruby and PHP** the `symbolNaming` patterns
in `src/dispatch/check-rules.ts` are **unanchored**, so text a *test itself* prints — an expected-error
assertion, a `raise_error("…")` string — is read as though the toolchain had emitted it. This is the
ENG-343 §2 failure class ("ordinary program text mistaken for a diagnostic") reappearing *within* a
single language, where the per-language registry cannot help.

Reproduced by execution on all three stacks (ENG-343 §4.5 / §5 residual 7):

| output | discarded file's contents | result |
| -- | -- | -- |
| `assertion failed: cannot find "widget" in the registry` (cargo) | `pub fn widget()` | wrongly implicated |
| `expect { boom }.to raise_error("uninitialized constant Helper")` (rspec) | `class Helper` | wrongly implicated |
| `Failed asserting that 'Class "Helper" not found' equals 'ok'` (phpunit) | `class Helper` | wrongly implicated |

ENG-343 already closed this for the other two stacks: Go's symbol patterns require the compiler's
`file.go:LINE:COL:` gutter; JVM captures only type-kind symbols. Rust, Ruby and PHP got no equivalent.
Rust's is the loosest, since its kind class is `[a-z, ]*?` and `cannot find "x"` is ordinary English.

**Cost when it misfires is a burned retry attempt, never a bad merge** — the guard's failure direction is
to decline to record a check as proof, not to accept one it should not. It also tends to self-heal: the
scratch file that supplied the definition is gone on the next attempt. That is why ENG-343 recorded it as
a residual rather than patching it after the branch's final review.

## 2. Two mechanics that constrain the fix

- **Patterns run over the whole output, not per line.** Each `symbolNaming` pattern is `exec`'d against
  the entire `rawOutput` (`check-selector.ts:281`). An anchor therefore has to be expressed as a required
  token — a line-anchored prefix (`^…/m`) or a required leading/trailing token — not as a per-line
  assumption.
- **The same patterns feed the retry excerpt.** `collectionErrorExcerpt`
  (`check-selector.ts:342`) folds `symbolNaming` into its probe set so a symbol-only red still yields a
  real compiler/runtime line in the retry feedback. So every anchor must keep matching the *real* forms,
  or the excerpt for that language goes empty.

Captures stay single-line (`\w+` / `[\w:]+` / `[\w\\]+`), so the existing line-break guard block
(`check-selector.test.ts:754`) stays green.

## 3. Decision — one runtime-structural anchor per stack

Require, per stack, a token the **runtime** emits that a test's own prose does not — exactly the shape of
the Go-gutter and JVM type-kind anchors ENG-343 already shipped. This is the minimal behaviour change; it
keeps every ENG-343 positive and rejects every pinned negative (validated by execution, §5).

Alternatives weighed and rejected:

- **Enumerate genuine rustc kind words** (replace Rust's `[a-z, ]*?` with `function|struct|variant|…`).
  More faithful to "cannot find `<kind>`", but brittle — it must chase rustc's compound wordings across
  versions and silently drops any new kind phrasing. Does not apply to Ruby/PHP.
- **Require *both* markers per stack** (e.g. PHP `Uncaught Error:` prefix **and** trailing `in path:line`).
  Tightest, but over-fits the pinned positives: a phpunit-rendered fatal prints `Error:` (no `Uncaught`)
  with the location on a separate line, so a two-marker rule would drop legitimate variants.

## 4. The three anchors

**Rust** — prepend the error-code prefix, line-anchored (`^…/gim`):

```ts
symbolNaming: [
  /^error\[e\d+\]:[^\n]*?cannot find [a-z, ]*?['"`](\w+)['"`]/gim,
  /^error\[e\d+\]:[^\n]*?use of (?:undeclared|unresolved)[\w ]*?['"`](\w+)['"`]/gim,
],
```

Keeps E0425 `cannot find function`, the compound `cannot find struct, variant or union type`, and E0433
`use of undeclared type`. Rejects `assertion failed: cannot find "widget" in the registry` — no
`error[E…]` line prefix. rustc prints the `error[EXXXX]:` code at column 0 on the primary diagnostic
line, the same structural gutter the Go patterns rely on.

**Ruby** — require the trailing `(NameError)` exception annotation:

```ts
symbolNaming: [/uninitialized constant[^\S\r\n]+([\w:]+)[^\S\r\n]*\(NameError\)/gi],
```

Keeps `… uninitialized constant Helper (NameError)` (and nested `Foo::Bar`, reduced to `Bar` by
`symbolLeaf`). Rejects `raise_error("uninitialized constant Helper")` — the constant is followed by `")`,
not ` (NameError)`. The parenthesised exception class is emitted by Ruby's unhandled-exception printer;
test prose does not append it.

**PHP** — require the trailing `in <path>:<line>` fatal location:

```ts
symbolNaming: [/Class[^\S\r\n]+["']([\w\\]+)["'][^\S\r\n]+not found[^\S\r\n]+in[^\S\r\n]+\S+:\d+/gi],
```

Keeps `Class "App\Helper" not found in /app/tests/ATest.php:9` (namespace reduced to `Helper`). Rejects
`Failed asserting that 'Class "Helper" not found' equals 'ok'` — `not found` is followed by `' equals`,
with no source location. The `in <path>:<line>` tail is the PHP fatal's location, the direct analogue of
Go's gutter.

## 5. Validation

Each anchor was run against every pinned positive and negative before adoption; all pass (positives
capture the symbol, negatives implicate nothing):

- **Rust** — E0425 / E0422 compound / E0433 → captured; assertion-prose negative → rejected.
- **Ruby** — rspec `(NameError)` and nested `Foo::Bar` → captured; `raise_error("…")` negative → rejected.
- **PHP** — namespaced and lowercase fatal → captured; phpunit assertion negative → rejected.

## 6. Tests

Per stack, in `test/dispatch/check-selector.test.ts` (symbol-tier describe block):

1. **A negative** using the exact §1-table output plus a discarded file that *defines* the named symbol,
   asserting `importErrorImplicatesDiscarded(...) → []`.
2. **A mutation guard** that swaps `CHECK_RULES.<fw>.symbolNaming` back to the old unanchored pattern,
   asserts the collision *reappears* (the discarded file is implicated), restores, and asserts it is gone
   — the shape of the committed Go/JVM leaf-tie guards (`check-selector.test.ts:954`) and the symbol
   contrast guard (`:1266`).

Regression bar (ENG-348 acceptance): every ENG-343 symbol-tier positive still passes — all three real
rustc forms included — and the **full suite is green**.

## 7. Doc updates

`docs/brainstorms/2026-07-20-checks-discard-poison-matcher-langs-design.md`:

- **§4.5** — the "two mitigations … cover only two of the five stacks" paragraph and the reproduction
  table: record that Rust/Ruby/PHP are now anchored, so the class is closed on all five stacks.
- **§5 residual 7** — mark closed (Rust/Ruby/PHP anchored under ENG-348), keeping the append-only history
  intact.

## 8. Scope

**IN** — the three `symbolNaming` patterns in `src/dispatch/check-rules.ts`
(`rustRules`/`rubyRules`/`phpRules`); the negatives + mutation guards above; the two doc edits.

**OUT** — the Go and JVM symbol patterns (already anchored); the name-based tiers (shape, leaf,
bounded-basename) and any other rule field; `interpretRunOutput`, `post-implement-rerun.ts`,
`classify-prior.ts`.

## 9. Residuals (safe direction preserved)

- Ruby's `(NameError)` suffix is the rspec/CLI unhandled-exception form; a minitest-rendered `NameError:`
  *prefix* form would not match — degrades to a no-tie (a retry), never a wrong verdict.
- A contrived test asserting a string that *embeds* the full anchor (e.g. `"… (NameError)"`) would still
  fool it — same bounded retry cost. Out of scope.
