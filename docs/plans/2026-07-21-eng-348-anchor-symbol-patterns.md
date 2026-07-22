# ENG-348 — Anchor the Rust/Ruby/PHP symbol patterns · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor the three unanchored `symbolNaming` patterns (Rust/Ruby/PHP) in the discard-poison guard to a runtime-emitted structural token, so a test's own error text is not misread as a compiler/runtime diagnostic.

**Architecture:** Three isolated regex edits in `src/dispatch/check-rules.ts` — Rust gains a line-anchored `error[E…]` code prefix; Ruby requires the `NameError` exception-class token (CLI/rspec `(NameError)` suffix **or** minitest `NameError:` prefix); PHP requires the `Error:` token before `Class "…" not found`. Each is proven by a TDD negative (a test's own prose implicates nothing) plus a mutation guard (swapping the old unanchored pattern back in re-introduces the misfire). No matcher logic, no other rule field, and no other source file changes.

**Tech Stack:** TypeScript on Bun. Tests: `bun test`. Lint: `bun run lint`.

## Global Constraints

- **Scope is `symbolNaming` only.** Do not touch Go/JVM patterns, the name-based tiers (shape, leaf, bounded-basename), any other `LanguageRules` field, or `interpretRunOutput`/`post-implement-rerun.ts`/`classify-prior.ts`.
- **Never break a shipped positive.** Every ENG-343 symbol-tier positive must stay green — in particular all three real rustc forms (E0425, E0422 compound, E0433).
- **Failure direction is safe.** A misfire costs a retry, never a bad merge; when in doubt the tier should decline to tie.
- **Captures stay single-line** (`\w+` / `[\w:]+` / `[\w\\]+`) so the line-break guard block (`test/dispatch/check-selector.test.ts:754`) stays green.
- **Branch/PR discipline (CLAUDE.md):** work on this branch; never commit to `main`; open a PR at the end; do not merge.
- **Commit trailers:** end each commit message with the two trailers this repo uses (`Co-Authored-By:` and `Claude-Session:`), matching the existing branch commits.

## Reference — the exact current patterns (in `src/dispatch/check-rules.ts`)

```ts
// rustRules.symbolNaming — lines 291-294
symbolNaming: [
  /cannot find [a-z, ]*?['"`](\w+)['"`]/gi,
  /use of (?:undeclared|unresolved)[\w ]*?['"`](\w+)['"`]/gi,
],
// rubyRules.symbolNaming — line 310
symbolNaming: [/uninitialized constant[^\S\r\n]+([\w:]+)/gi],
// phpRules.symbolNaming — line 324
symbolNaming: [/Class[^\S\r\n]+["']([\w\\]+)["'][^\S\r\n]+not found/gi],
```

The matcher `importErrorImplicatesDiscarded(rawOutput, discarded, framework, sources?)` (`src/dispatch/check-selector.ts:248`) runs each `symbolNaming` pattern via `exec` over the **whole** output and only ties a discarded file when `sources` supplies its contents AND `definesSymbol(symbol)` matches those contents (`check-selector.ts:304`). So every negative and mutation-guard test **must pass the `sources` map** or it proves nothing. New negative/positive tests go inside the existing describe block `discard-poison: the symbol definition tier (design 4.5)` (`test/…:992`), which defines a `src` helper: `const src = (path, content) => new Map([[path, content]]);`. Mutation guards go in their own new describe blocks (matching `test/…:954` / `:1266`), inlining the `Map` and casting the rule object.

---

### Task 1: Anchor the Rust symbol pattern to the `error[E…]` code prefix

**Files:**
- Modify: `src/dispatch/check-rules.ts:291-294` (`rustRules.symbolNaming`)
- Test: `test/dispatch/check-selector.test.ts` (add a negative inside the `symbol definition tier` describe; add a new mutation-guard describe)

**Interfaces:**
- Consumes: `importErrorImplicatesDiscarded(out, discarded, framework, sources?) → string[]`, `CHECK_RULES` (both already imported at `test/…:279-282` and `:2`), the local `src` helper (`test/…:993`).
- Produces: `rustRules.symbolNaming` = two `^error\[e\d+\]:`-anchored patterns; capture group 1 is still the bare symbol name.

- [ ] **Step 1: Write the failing negative test** — inside the `describe("discard-poison: the symbol definition tier (design 4.5)", …)` block (near the existing Go gutter negative at `test/…:1184`):

```ts
test("Rust: `cannot find` inside a test's own assertion string must NOT fire (no error[E…] prefix)", () => {
  // The section-2 failure class within one language: ordinary prose, not a rustc diagnostic.
  const out = 'assertion failed: cannot find "widget" in the registry';
  expect(
    importErrorImplicatesDiscarded(
      out,
      ["src/w.rs"],
      "cargo",
      src("src/w.rs", "pub fn widget() -> u8 { 1 }\n"),
    ),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `bun test test/dispatch/check-selector.test.ts -t "assertion string must NOT fire"`
Expected: FAIL — the current unanchored `cannot find [a-z, ]*?['"`]…` pattern captures `widget`, `definesSymbol("widget")` matches `pub fn widget`, so the file is implicated: `expect [] toEqual ["src/w.rs"]` mismatch.

- [ ] **Step 3: Anchor the pattern** — replace `rustRules.symbolNaming` (`src/dispatch/check-rules.ts:291-294`):

```ts
  // Anchored to rustc's `error[E…]:` code prefix, which it prints at column 0 on the primary diagnostic
  // line — the same structural gutter the Go patterns rely on. Unanchored, `cannot find "x"` inside a
  // test's own assertion prose fires the tier (ordinary English), the §2 failure class within one
  // language. The kind class stays loose (`[a-z, ]*?`) for rustc's compound kinds ("struct, variant or
  // union type"); the second pattern covers E0433 (`use of undeclared type`), what `Helper::new()` emits.
  symbolNaming: [
    /^error\[e\d+\]:[^\n]*?cannot find [a-z, ]*?['"`](\w+)['"`]/gim,
    /^error\[e\d+\]:[^\n]*?use of (?:undeclared|unresolved)[\w ]*?['"`](\w+)['"`]/gim,
  ],
```

- [ ] **Step 4: Run the negative + all Rust/symbol-tier tests to verify they PASS**

Run: `bun test test/dispatch/check-selector.test.ts -t "Rust"`
Expected: PASS — the new negative is green, and the shipped positives (`test/…:1095` E0425, `:1137` compound E0422 + E0433, `:1107` contrast) remain green. If any shipped positive fails, the anchor dropped a real form — stop and reconcile.

- [ ] **Step 5: Add the mutation guard** — a new describe after the existing `mutation guard: the symbol tier's contrast must discriminate` block (`test/…:1266-1282`):

```ts
describe("mutation guard: the Rust symbol anchor must discriminate", () => {
  test("the unanchored `cannot find` pattern would implicate a test's assertion string", () => {
    const out = 'assertion failed: cannot find "widget" in the registry';
    const sources = new Map([["src/w.rs", "pub fn widget() -> u8 { 1 }\n"]]);
    const orig = CHECK_RULES.cargo.symbolNaming;
    try {
      (CHECK_RULES.cargo as { symbolNaming?: RegExp[] }).symbolNaming = [
        /cannot find [a-z, ]*?['"`](\w+)['"`]/gi,
      ];
      expect(importErrorImplicatesDiscarded(out, ["src/w.rs"], "cargo", sources)).toEqual([
        "src/w.rs",
      ]);
    } finally {
      (CHECK_RULES.cargo as { symbolNaming?: RegExp[] }).symbolNaming = orig;
    }
    expect(importErrorImplicatesDiscarded(out, ["src/w.rs"], "cargo", sources)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the full file green**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS (all tests). The mutation guard proves the collision reappears under the old pattern and is gone under the anchored one.

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/check-rules.ts test/dispatch/check-selector.test.ts
git commit -m "$(cat <<'EOF'
fix(checks): anchor the Rust symbol pattern to the error[E…] code prefix (ENG-348)

A test's own assertion prose (`cannot find "widget"`) no longer fires the
symbol tier; only rustc's coded diagnostics do. Negative + mutation guard added.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013F3WkH1vM5VmUh41WxqsvZ
EOF
)"
```

---

### Task 2: Anchor the Ruby symbol pattern to the `NameError` token (both frameworks)

**Files:**
- Modify: `src/dispatch/check-rules.ts:310` (`rubyRules.symbolNaming`)
- Test: `test/dispatch/check-selector.test.ts` (add a negative and a minitest positive inside the `symbol definition tier` describe; add a new mutation-guard describe)

**Interfaces:**
- Consumes: same matcher/`CHECK_RULES`/`src` helper as Task 1.
- Produces: `rubyRules.symbolNaming` = two patterns (suffix + prefix); capture group 1 is still the constant (qualified names reduced by `symbolLeaf`). `rubyRules` serves both `rspec` and `minitest` (`check-rules.ts:341-342`).

- [ ] **Step 1: Write the failing negative + the new minitest positive** — inside the `symbol definition tier` describe:

```ts
test("Ruby: an `uninitialized constant` inside a raise_error string must NOT fire (no NameError token)", () => {
  // Both rspec spellings: the message-only string, and the class passed as a separate argument
  // (`NameError` followed by a comma, not the `:` the prefix pattern requires).
  const files = ["spec/support/helper.rb"];
  const sources = src("spec/support/helper.rb", "class Helper\nend\n");
  expect(
    importErrorImplicatesDiscarded(
      'expect { boom }.to raise_error("uninitialized constant Helper")',
      files,
      "rspec",
      sources,
    ),
  ).toEqual([]);
  expect(
    importErrorImplicatesDiscarded(
      'expect { boom }.to raise_error(NameError, "uninitialized constant Helper")',
      files,
      "rspec",
      sources,
    ),
  ).toEqual([]);
});

test("Ruby: minitest's `NameError:` prefix render ties the discarded constant", () => {
  const out = "NameError: uninitialized constant Helper\n    test/foo_test.rb:5:in 'test_x'";
  expect(
    importErrorImplicatesDiscarded(
      out,
      ["test/support/helper.rb"],
      "minitest",
      src("test/support/helper.rb", "class Helper\nend\n"),
    ),
  ).toEqual(["test/support/helper.rb"]);
});
```

- [ ] **Step 2: Run to verify the negative FAILS and the minitest positive FAILS**

Run: `bun test test/dispatch/check-selector.test.ts -t "Ruby:"`
Expected: the negative FAILS (current unanchored pattern captures `Helper`, ties `spec/support/helper.rb`); the minitest positive currently PASSES under the unanchored pattern (it already captures) — that's fine, it will still pass after the change and pins that we did not regress it. The load-bearing failure is the negative.

- [ ] **Step 3: Anchor the pattern** — replace `rubyRules.symbolNaming` (`src/dispatch/check-rules.ts:310`):

```ts
  // Require the `NameError` exception-class token the runtime's printer emits: the CLI/rspec unhandled
  // form appends ` (NameError)` after the constant; minitest, catching the error inside a test, prefixes
  // `NameError:`. `rubyRules` serves both frameworks, so both patterns are needed. Unanchored,
  // `uninitialized constant Helper` inside a `raise_error("…")` string fires the tier — the §2 failure
  // class within one language. A test names the class as an argument (`raise_error(NameError, …)`), never
  // adjacent to the phrase the way the printer does.
  symbolNaming: [
    /uninitialized constant[^\S\r\n]+([\w:]+)[^\S\r\n]*\(NameError\)/gi,
    /NameError:[^\S\r\n]+uninitialized constant[^\S\r\n]+([\w:]+)/gi,
  ],
```

- [ ] **Step 4: Run to verify all Ruby tests PASS**

Run: `bun test test/dispatch/check-selector.test.ts -t "Ruby"`
Expected: PASS — the negative now ties nothing; the minitest positive still ties; the shipped rspec positive (`test/…:1032`) and contrast (`:1044`) stay green.

- [ ] **Step 5: Add the mutation guard** — a new describe alongside Task 1's:

```ts
describe("mutation guard: the Ruby symbol anchor must discriminate", () => {
  test("the unanchored `uninitialized constant` pattern would implicate a raise_error string", () => {
    const out = 'expect { boom }.to raise_error("uninitialized constant Helper")';
    const sources = new Map([["spec/support/helper.rb", "class Helper\nend\n"]]);
    const orig = CHECK_RULES.rspec.symbolNaming;
    try {
      (CHECK_RULES.rspec as { symbolNaming?: RegExp[] }).symbolNaming = [
        /uninitialized constant[^\S\r\n]+([\w:]+)/gi,
      ];
      expect(importErrorImplicatesDiscarded(out, ["spec/support/helper.rb"], "rspec", sources)).toEqual([
        "spec/support/helper.rb",
      ]);
    } finally {
      (CHECK_RULES.rspec as { symbolNaming?: RegExp[] }).symbolNaming = orig;
    }
    expect(importErrorImplicatesDiscarded(out, ["spec/support/helper.rb"], "rspec", sources)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the full file green**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/check-rules.ts test/dispatch/check-selector.test.ts
git commit -m "$(cat <<'EOF'
fix(checks): anchor the Ruby symbol pattern to the NameError token (ENG-348)

Requires the CLI/rspec `(NameError)` suffix or minitest's `NameError:` prefix,
so a `raise_error("uninitialized constant …")` string no longer fires the tier
while both frameworks' real renders still tie. Negative, minitest positive, and
mutation guard added.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013F3WkH1vM5VmUh41WxqsvZ
EOF
)"
```

---

### Task 3: Anchor the PHP symbol pattern to the `Error:` token

**Files:**
- Modify: `src/dispatch/check-rules.ts:324` (`phpRules.symbolNaming`)
- Test: `test/dispatch/check-selector.test.ts` (add a negative and a PHPUnit-caught positive inside the `symbol definition tier` describe; add a new mutation-guard describe)

**Interfaces:**
- Consumes: same matcher/`CHECK_RULES`/`src` helper as Task 1.
- Produces: `phpRules.symbolNaming` = one `Error:`-anchored pattern; capture group 1 is still the qualified class (reduced by `symbolLeaf`; `definesSymbol` stays case-insensitive). `phpRules` serves `phpunit` (`check-rules.ts:343`).

- [ ] **Step 1: Write the failing negative + the PHPUnit-caught positive** — inside the `symbol definition tier` describe:

```ts
test("PHP: a `Class \"…\" not found` inside a phpunit assertion message must NOT fire (no Error: token)", () => {
  const out = `Failed asserting that 'Class "Helper" not found' equals 'ok'`;
  expect(
    importErrorImplicatesDiscarded(
      out,
      ["src/Helper.php"],
      "phpunit",
      src("src/Helper.php", "<?php\nclass Helper {}\n"),
    ),
  ).toEqual([]);
});

test("PHP: the PHPUnit-caught render (location on a separate line) still ties the discarded class", () => {
  const out =
    '1) App\\Tests\\ATest::testThing\nError: Class "App\\Helper" not found\n\n/app/tests/ATest.php:9';
  expect(
    importErrorImplicatesDiscarded(
      out,
      ["src/Helper.php"],
      "phpunit",
      src("src/Helper.php", "<?php\nnamespace App;\nclass Helper {}\n"),
    ),
  ).toEqual(["src/Helper.php"]);
});
```

- [ ] **Step 2: Run to verify the negative FAILS**

Run: `bun test test/dispatch/check-selector.test.ts -t "PHP:"`
Expected: the negative FAILS (current unanchored `Class …["']…["'] not found` captures `Helper`, ties `src/Helper.php`). The PHPUnit-caught positive currently PASSES under the unanchored pattern; it must remain passing after the change (that's what the `Error:` anchor preserves that a trailing-location anchor would have broken).

- [ ] **Step 3: Anchor the pattern** — replace `phpRules.symbolNaming` (`src/dispatch/check-rules.ts:324`):

```ts
  // Require the `Error:` exception-class token immediately before `Class "…"`. It survives BOTH PHP
  // render paths: the CLI process-fatal `… Uncaught Error: Class "X" not found in path:line` and the
  // PHPUnit-caught form `Error: Class "X" not found` (location on a separate stack-trace line, since PHP 7
  // made class-not-found `Error`s catchable). Anchoring on the trailing `in <path>:<line>` location would
  // drop the PHPUnit-caught case. Rejects `Failed asserting that 'Class "Helper" not found'` — `Class` is
  // preceded by `'`, with no `Error:` token. Case-insensitive: PHP class names are.
  symbolNaming: [/Error:[^\S\r\n]+Class[^\S\r\n]+["']([\w\\]+)["'][^\S\r\n]+not found/gi],
```

- [ ] **Step 4: Run to verify all PHP tests PASS**

Run: `bun test test/dispatch/check-selector.test.ts -t "PHP"`
Expected: PASS — the negative ties nothing; the PHPUnit-caught positive ties; the shipped positives (`test/…:1056` namespaced, `:1069` contrast, `:1082` lowercase) stay green.

- [ ] **Step 5: Add the mutation guard** — a new describe alongside Tasks 1-2:

```ts
describe("mutation guard: the PHP symbol anchor must discriminate", () => {
  test("the unanchored `Class … not found` pattern would implicate a phpunit assertion message", () => {
    const out = `Failed asserting that 'Class "Helper" not found' equals 'ok'`;
    const sources = new Map([["src/Helper.php", "<?php\nclass Helper {}\n"]]);
    const orig = CHECK_RULES.phpunit.symbolNaming;
    try {
      (CHECK_RULES.phpunit as { symbolNaming?: RegExp[] }).symbolNaming = [
        /Class[^\S\r\n]+["']([\w\\]+)["'][^\S\r\n]+not found/gi,
      ];
      expect(importErrorImplicatesDiscarded(out, ["src/Helper.php"], "phpunit", sources)).toEqual([
        "src/Helper.php",
      ]);
    } finally {
      (CHECK_RULES.phpunit as { symbolNaming?: RegExp[] }).symbolNaming = orig;
    }
    expect(importErrorImplicatesDiscarded(out, ["src/Helper.php"], "phpunit", sources)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the full file green + lint**

Run: `bun test test/dispatch/check-selector.test.ts && bun run lint`
Expected: PASS (all tests) and lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/check-rules.ts test/dispatch/check-selector.test.ts
git commit -m "$(cat <<'EOF'
fix(checks): anchor the PHP symbol pattern to the Error: token (ENG-348)

Requires the `Error:` exception-class token before `Class "…" not found`, which
survives both the CLI fatal and the PHPUnit-caught render, so a phpunit assertion
message no longer fires the tier. Negative, phpunit-caught positive, and mutation
guard added.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013F3WkH1vM5VmUh41WxqsvZ
EOF
)"
```

---

### Task 4: Record closure in the ENG-343 design doc, and run the full suite

**Files:**
- Modify: `docs/brainstorms/2026-07-20-checks-discard-poison-matcher-langs-design.md` (§4.5 and §5 residual 7 — additive closure notes, preserving the original prose per the append-only convention)

**Interfaces:**
- Consumes: nothing. Produces: doc status only.

- [ ] **Step 1: Mark §5 residual 7 closed** — replace the residual-7 body (`…-design.md:362-363`):

Find:
```markdown
7. **Unanchored symbol patterns on Rust, Ruby and PHP** (§4.5): a test's own assertion text mentioning
   the symbol is mistaken for a diagnostic. Reproduced on all three. **Tracked as ENG-348.**
```
Replace with:
```markdown
7. **Unanchored symbol patterns on Rust, Ruby and PHP** (§4.5): a test's own assertion text mentioning
   the symbol is mistaken for a diagnostic. Reproduced on all three. **Closed by ENG-348 (2026-07-21):**
   Rust anchored to the `error[E…]` code prefix, Ruby to the `NameError` exception-class token, PHP to
   the `Error:` token — the class is now closed on all five stacks.
```

- [ ] **Step 2: Append a closure note to §4.5** — find this exact sentence, which ends the §4.5 mitigations discussion (`…-design.md:318`, just before `### 4.6 Excerpt`; it occurs once):

```markdown
The safe direction is already held — a misfire costs a retry, not a merge.
```

Insert the following as a new paragraph immediately after it (leave the found sentence in place):

```markdown
**Update (ENG-348, 2026-07-21): closed on all five stacks.** Rust, Ruby and PHP are now anchored to a
runtime-emitted structural token, the way Go and JVM already were — Rust to rustc's `error[E…]` code
prefix, Ruby to the `NameError` exception-class token (the CLI/rspec `(NameError)` suffix or minitest's
`NameError:` prefix), and PHP to the `Error:` token preceding `Class "…" not found` in both the CLI fatal
and the PHPUnit-caught render. Each of the three §4.5 negatives above now implicates nothing, proven by a
per-stack negative and mutation guard. See
`docs/brainstorms/2026-07-21-eng-348-anchor-symbol-patterns-design.md`.
```

- [ ] **Step 3: Run the full suite + lint one final time**

Run: `bun test && bun run lint`
Expected: PASS (whole suite green) and lint clean. This is the ENG-348 acceptance bar.

- [ ] **Step 4: Commit**

```bash
git add docs/brainstorms/2026-07-20-checks-discard-poison-matcher-langs-design.md
git commit -m "$(cat <<'EOF'
docs(checks): record ENG-348 closes the unanchored-symbol residual on all five stacks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013F3WkH1vM5VmUh41WxqsvZ
EOF
)"
```

- [ ] **Step 5: Push and open a draft PR**

```bash
git push -u origin HEAD
gh pr create --draft --title "fix(checks): anchor the Rust/Ruby/PHP symbol patterns (ENG-348)" --body "$(cat <<'EOF'
Closes ENG-348. Anchors the three unanchored `symbolNaming` patterns so a test's own error text is not read as a diagnostic:

- **Rust** → line-anchored `error[E…]` code prefix (keeps E0425/E0422 compound/E0433).
- **Ruby** → `NameError` token: CLI/rspec `(NameError)` suffix or minitest `NameError:` prefix.
- **PHP** → `Error:` token before `Class "…" not found` (covers CLI fatal + PHPUnit-caught render).

Per stack: a negative using the ticket's exact table output, a mutation guard proving the anchor discriminates, and (Ruby/PHP) a positive pinning the newly-covered render. §4.5 / §5 residual 7 of the ENG-343 design doc updated to record the class is closed on all five stacks. Full suite green.

Design: `docs/brainstorms/2026-07-21-eng-348-anchor-symbol-patterns-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013F3WkH1vM5VmUh41WxqsvZ
EOF
)"
```

---

## Self-Review

**Spec coverage:** §4 Rust → Task 1; §4 Ruby → Task 2; §4 PHP → Task 3; §6 negatives + mutation guards + `sources`-arg requirement → Tasks 1-3; newly-covered renders (minitest, PHPUnit-caught) → Tasks 2-3; §7 doc updates (§4.5, §5 residual 7) → Task 4; §5 validation / full-suite-green acceptance → Step 6 of each stack task + Task 4 Step 3. No spec section unmapped.

**Placeholder scan:** none — every step carries the exact regex, test code, command, and expected outcome.

**Type consistency:** all tasks call `importErrorImplicatesDiscarded(out, string[], framework, Map)` and cast the rule object as `{ symbolNaming?: RegExp[] }` (matching the existing guards' cast style at `test/…:943`). Framework keys used exactly as registered: `cargo`, `rspec`, `minitest`, `phpunit` (`check-rules.ts:338-343`). Capture-group-1 semantics unchanged across all three edits, so `symbolLeaf`/`definesSymbol` downstream are untouched.
