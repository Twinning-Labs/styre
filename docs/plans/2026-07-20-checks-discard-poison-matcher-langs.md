# Per-language rule registry for the discard poison matcher (ENG-343) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the discard poison guard framework aware, backed by a per-language rule registry, so a discarded imported helper is caught on Go, Rust, JVM, Ruby and PHP without the cross-language false rejects a shared vocabulary produces.

**Architecture:** A new module `src/dispatch/check-rules.ts` owns one `LanguageRules` entry per `CheckFramework` (indicators, basename gates, naming patterns, shape rules) plus the pure path helpers the shapes need. `importErrorImplicatesDiscarded` and `collectionErrorExcerpt` in `check-selector.ts` take the framework and consult only that language's entry. Package-oriented languages (Go, JVM) tie a discarded file by **path segment alignment between the package and the file's directory**, never by file leaf.

**Tech Stack:** TypeScript, Bun test runner, Biome. No new dependencies.

**Design:** `docs/brainstorms/2026-07-20-checks-discard-poison-matcher-langs-design.md`

## Global Constraints

- **The registry is the sole extension point.** New languages, phrasings and per-language exceptions go in `CHECK_RULES` in `check-rules.ts`. No matching rule may live outside the registry — including fixture patterns and excerpt preferences, which are per-language fields, not globals.
- **Conservative matching.** Every rule ties to a named file, module, or package path aligned with the file's directory. Nothing fires on a bare basename, and no rule may apply across a language boundary.
- **Never wrongly reject.** A check that legitimately fails because the feature does not exist yet must never be implicated. Every positive needs a same-output contrast negative.
- **Real toolchain text only.** Error strings in tests must be text a real toolchain emits. Go uses `no required module provides package …` (module era), not `cannot find package "…"` (GOPATH era).
- **INV-B — feedback is diagnosis only.** Messages state the cause, the discarded file and the framework's own line. Never an instruction.
- **Out of scope, do not touch:** `interpretRunOutput` (including the rspec `selected-none` branch), `post-implement-rerun.ts`, `classify-prior.ts`, `prompts/checks.md`.
- **Regexes are single-line.** Never wrap a pattern across source lines — the newline and indentation become literal atoms and the alternative silently stops matching. (Verified: Biome does not split these literals.)
- **A naming pattern used with `.test()` must have its `g` flag stripped**, or `lastIndex` state makes results alternate between calls.
- **Verification gate for every task:** `bun run typecheck && bun run format && bun run lint && bun test`. `bun run lint` is `biome check .`, which *reports* formatting and does not fix it — `format` must run first or every gate fails.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/dispatch/check-rules.ts` (**new**) | `CHECK_RULES`, the `LanguageRules`/`ShapeRule`/`MatchContext` types, the pure path helpers and the shape predicates. |
| `src/dispatch/check-selector.ts` (modify) | `importErrorImplicatesDiscarded` / `collectionErrorExcerpt` become framework aware. Path helpers and `SOURCE_EXTS` move out. |
| `src/dispatch/handlers.ts` (modify) | Pass `fw` to both calls. Two lines. |
| `test/dispatch/check-selector.test.ts` (modify) | Matcher and excerpt tests per language, through the public API. |
| `test/dispatch/scope-disposition-smoke.test.ts` (modify) | Harness accepts a non-Python profile; cells A17–A19. |

`check-rules.ts` imports `CheckFramework` from `check-selector.ts` with `import type`, erased at compile time — no runtime cycle.

**Task shape.** Task 1 is a pure, behaviour-preserving refactor: the five new frameworks map to an empty `noRules` entry, so the `Record` is complete, the build is green, and behaviour on those stacks is byte-identical to today. Tasks 2 and 3 then replace `noRules` with real rules **and** ship the tests that exercise them in the same commit — so each task is genuinely test-driven and a reviewer can reject one language's semantics without unpicking the refactor.

---

### Task 1: The registry, and a framework-aware matcher that preserves current behaviour

**Files:**
- Create: `src/dispatch/check-rules.ts`
- Modify: `src/dispatch/check-selector.ts` (remove `SOURCE_EXTS`, `moduleLeaf`, `moduleDotted`, `isSegSuffix`, `isSegPrefix`, `packageInitImplicated`, `IMPORT_ERROR_INDICATORS`, `FIXTURE_NOT_FOUND`, `IMPORT_ERROR_NAMING`; rewrite the two exported functions)
- Modify: `src/dispatch/handlers.ts` (two call sites, around lines 685 and 687)
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces:**
- Consumes: `CheckFramework` from `./check-selector.ts` (type only).
- Produces, from `src/dispatch/check-rules.ts`:
  - `interface MatchContext { dotted: string[]; hasIndicator: boolean; hasFixtureError: boolean }`
  - `interface ShapeRule { basename?: string; match: (discardedPath: string, ctx: MatchContext) => boolean }`
  - `interface LanguageRules { indicators: string[]; basenameGates: string[]; naming: RegExp[]; tiesByLeaf: boolean; shapes: ShapeRule[]; fixturePattern?: RegExp; prefersErrorSummary?: boolean }`
  - `const CHECK_RULES: Record<CheckFramework, LanguageRules>`
  - `function moduleLeaf(ref: string): string`
  - `function moduleDotted(ref: string): string`
- Produces, from `src/dispatch/check-selector.ts` (changed signatures):
  - `importErrorImplicatesDiscarded(rawOutput: string, discarded: string[], framework: CheckFramework | null): string[]`
  - `collectionErrorExcerpt(rawOutput: string, framework: CheckFramework | null): string | undefined`

- [ ] **Step 1: Add the framework argument to every existing matcher/excerpt test**

In `test/dispatch/check-selector.test.ts`, every existing call gains a final argument: `"pytest"` for every case **except** the Node one, which takes `"jest"`. Do not change any expected value — these passing unchanged is the regression proof.

```ts
    expect(
      importErrorImplicatesDiscarded("Error: Cannot find module './helper'", ["src/helper.js"], "jest"),
    ).toEqual(["src/helper.js"]);
```

```ts
    expect(
      importErrorImplicatesDiscarded("ModuleNotFoundError: No module named 'helper'", [
        "checks/helper.py",
      ], "pytest"),
    ).toEqual(["checks/helper.py"]);
```

- [ ] **Step 2: Add the new Task 1 tests**

Append inside the existing `importErrorImplicatesDiscarded` describe block:

```ts
  test("a null framework never implicates", () => {
    expect(
      importErrorImplicatesDiscarded("ModuleNotFoundError: No module named 'helper'", ["helper.py"], null),
    ).toEqual([]);
  });

  test("the five new frameworks are inert until their rules land (Task 1 is a pure refactor)", () => {
    // noRules: behaviour on these stacks is byte-identical to before this change.
    expect(importErrorImplicatesDiscarded("cannot load such file -- helper", ["helper.rb"], "rspec")).toEqual([]);
    expect(importErrorImplicatesDiscarded("no required module provides package m/helper", ["helper/helper.go"], "go")).toEqual([]);
  });
```

And a new describe for the registry shape and the excerpt:

```ts
describe("CHECK_RULES registry", () => {
  test("aliased frameworks share one rule set (a mis-aliased key is the failure this catches)", () => {
    expect(CHECK_RULES.vitest).toBe(CHECK_RULES.jest);
    expect(CHECK_RULES.minitest).toBe(CHECK_RULES.rspec);
    expect(CHECK_RULES["junit-gradle"]).toBe(CHECK_RULES["junit-maven"]);
  });

  test("python and node share the legacy vocabulary verbatim (design 4.1: behaviour unchanged)", () => {
    expect(CHECK_RULES.jest.indicators).toEqual(CHECK_RULES.pytest.indicators);
    // The Python marker shapes stay Python-only: an __init__.py in a jest run is not a thing.
    expect(CHECK_RULES.jest.shapes).toHaveLength(0);
    expect(CHECK_RULES.pytest.shapes).toHaveLength(2);
  });

  test("only python carries a fixture pattern and the ERROR-summary preference", () => {
    expect(CHECK_RULES.pytest.fixturePattern).toBeDefined();
    expect(CHECK_RULES.rspec.fixturePattern).toBeUndefined();
    expect(CHECK_RULES.pytest.prefersErrorSummary).toBe(true);
    expect(CHECK_RULES["junit-maven"].prefersErrorSummary).toBeUndefined();
  });
});

describe("collectionErrorExcerpt (framework-aware)", () => {
  test("returns undefined for a null framework", () => {
    expect(collectionErrorExcerpt("ModuleNotFoundError: No module named 'x'", null)).toBeUndefined();
  });

  test("returns undefined when the output carries no import/collection signal", () => {
    expect(collectionErrorExcerpt("E       assert 1 == 2", "pytest")).toBeUndefined();
  });

  test("prefers pytest's ERROR summary line and strips the E gutter", () => {
    const out = "E   ModuleNotFoundError: No module named 'helper'\nERROR checks/t.py - No module named 'helper'";
    expect(collectionErrorExcerpt(out, "pytest")).toBe("ERROR checks/t.py - No module named 'helper'");
  });

  test("a Ruby fixture error does NOT produce an excerpt (fixture patterns are python-only)", () => {
    // Rails fixtures emit this phrase; under a global pattern it leaked across languages.
    expect(
      collectionErrorExcerpt("ActiveRecord::FixtureError: fixture 'users' not found", "minitest"),
    ).toBeUndefined();
  });

  test("naming patterns trigger the excerpt (drift pin, design 4.5)", () => {
    // `unable to resolve` is a naming alternative that was never an indicator: before this change the
    // excerpt was undefined for such a line. Pinned so the drift is deliberate, not accidental.
    expect(collectionErrorExcerpt("npm ERR! unable to resolve dependency tree", "jest")).toBe(
      "npm ERR! unable to resolve dependency tree",
    );
  });
});
```

Update the import at the top of the test file to include `CHECK_RULES`:

```ts
import { CHECK_RULES } from "../../src/dispatch/check-rules.ts";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: FAIL. Note `bun test` does not typecheck and JS ignores extra arguments, so every pre-existing assertion still PASSES — the failures are the new ones: the null-framework test, the `CHECK_RULES` describe (module does not exist), and the excerpt tests taking a second argument. Do not be alarmed by green legacy tests; that is the regression baseline holding.

- [ ] **Step 4: Create the registry module**

Create `src/dispatch/check-rules.ts`:

```ts
import type { CheckFramework } from "./check-selector.ts";

/** Source-file extensions stripped when reducing a path or module reference to its leaf name. */
const SOURCE_EXTS = new Set([
  "py",
  "pyi",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "go",
  "rs",
  "rb",
  "php",
  "java",
  "kt",
  "scala",
]);

/** The leaf module identifier for a path OR a dotted/slashed module reference, lower-cased. Takes the
 *  last path segment, drops a trailing source extension, then the last remaining dotted segment:
 *  `checks/helper.py`→`helper`, `pkg.helper`→`helper`, `./a/helper.js`→`helper`, `util`→`util`. Pure. */
export function moduleLeaf(ref: string): string {
  const seg = ref.split(/[\\/]/).pop() ?? ref;
  const parts = seg.split(".").filter((s) => s.length > 0);
  if (parts.length === 0) return seg.toLowerCase();
  if (parts.length >= 2 && SOURCE_EXTS.has((parts[parts.length - 1] ?? "").toLowerCase())) {
    parts.pop();
  }
  return (parts[parts.length - 1] ?? seg).toLowerCase();
}

/** A dotted, lower-cased reference: slashes → dots, trimmed of leading/trailing dots. Pure. */
export function moduleDotted(ref: string): string {
  return ref
    .replace(/[\\/]/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

/** The lower-cased path segments of a path's DIRECTORY (the filename is dropped). */
function dirSegments(path: string): string[] {
  return path
    .split(/[\\/]/)
    .slice(0, -1)
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

/** The lower-cased dot-separated segments of a reference. */
function dotSegments(ref: string): string[] {
  return ref.split(".").filter((s) => s.length > 0);
}

/** True iff `long` starts with every segment of `short`. */
function isSegPrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  return short.every((s, i) => s === long[i]);
}

/** True iff `a`'s segments are the trailing segments of `b`. */
function isSegSuffix(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length > b.length) return false;
  const off = b.length - a.length;
  return a.every((s, i) => s === b[off + i]);
}

/** What a shape rule may consult about the run, besides the discarded path itself. */
export interface MatchContext {
  /** Raw dotted references captured by this language's naming patterns (lower-cased). */
  dotted: string[];
  /** True when any of this language's indicator phrases appear in the output. */
  hasIndicator: boolean;
  /** True when this language's fixture pattern (if any) fired. */
  hasFixtureError: boolean;
}

/** Ties a discarded file to the failure by its DIRECTORY or by being a known marker filename — for
 *  the cases where the file's own name never appears in the output. */
export interface ShapeRule {
  /** Restrict to discarded files with this exact (lower-cased) basename; undefined = any file. */
  basename?: string;
  match: (discardedPath: string, ctx: MatchContext) => boolean;
}

export interface LanguageRules {
  /** Lower-cased substrings marking an import/collection failure. Drive the excerpt. */
  indicators: string[];
  /** The subset of indicators permitted to gate the bounded-basename tier. Empty where the toolchain
   *  prints candidate paths that would poison it (cargo — the E0583 help note). */
  basenameGates: string[];
  /** Patterns whose capture group 1 is a named module, package or file reference. Single-line only. */
  naming: RegExp[];
  /** When true, a discarded file whose module leaf equals a named reference is implicated. FALSE for
   *  package-oriented languages (go, jvm), where leaf matching collides on generic nouns. */
  tiesByLeaf: boolean;
  shapes: ShapeRule[];
  /** This language's "fixture not found" pattern, if it has one. Per-language by design: a global
   *  pattern leaked across languages (Rails emits `fixture 'users' not found`). */
  fixturePattern?: RegExp;
  /** When true, a line beginning `ERROR` is preferred as the excerpt (pytest's summary line). */
  prefersErrorSummary?: boolean;
}

/** CONSERVATIVE match tying a discarded `__init__.py` to a missing-module error. Derive the package
 *  from the file's DIRECTORY, then implicate iff some named module M: (1) equals the full dotted dir;
 *  (2) strictly extends it as a prefix (a submodule import); or (3) is a >=2-segment trailing suffix
 *  of the dir. A bare single-segment interior name never matches. Pure. */
function packageInitImplicated(initPath: string, ctx: MatchContext): boolean {
  const dirSegs = dirSegments(initPath);
  if (dirSegs.length === 0) return false;
  for (const mod of ctx.dotted) {
    const modSegs = dotSegments(mod);
    if (modSegs.length === 0) continue;
    if (modSegs.length === dirSegs.length && isSegPrefix(modSegs, dirSegs)) return true;
    if (modSegs.length > dirSegs.length && isSegPrefix(dirSegs, modSegs)) return true;
    if (modSegs.length >= 2 && isSegSuffix(modSegs, dirSegs)) return true;
  }
  return false;
}

/** A discarded Rust `mod.rs` is leafless (`moduleLeaf` yields `mod`), so tie it by its directory:
 *  `tests/common/mod.rs` is implicated when a named module equals `common`. Pure. */
function modMarkerImplicated(modPath: string, ctx: MatchContext): boolean {
  const dirLeaf = dirSegments(modPath).at(-1);
  return dirLeaf !== undefined && ctx.dotted.includes(dirLeaf);
}

/** A Go package IS a directory, and the module prefix is NOT on disk — so the discarded file's
 *  directory segments must be a trailing SUFFIX of the package path's segments.
 *  `example.com/m/helper` implicates `helper/helper.go` and `helper/util.go` (dir `helper`), but a
 *  missing DEPENDENCY implicates nothing: `github.com/stretchr/testify/assert` against
 *  `internal/assert/helper.go` compares `[internal, assert]` to `[testify, assert]` and fails. Pure. */
function goPackageImplicated(path: string, ctx: MatchContext): boolean {
  const dirSegs = dirSegments(path);
  if (dirSegs.length === 0) return false;
  return ctx.dotted.some((m) => isSegSuffix(dirSegs, dotSegments(m)));
}

/** A JVM package IS a directory, and the source root (`src/test/java`) IS on disk — so the package's
 *  segments must be a trailing SUFFIX of the file's directory segments (the mirror of the Go rule).
 *  Requires >=2 segments, matching the `__init__.py` rule: a single generic segment (`util`, `api`)
 *  is exactly the collision the directory rules exist to remove. Pure. */
function jvmPackageImplicated(path: string, ctx: MatchContext): boolean {
  const dirSegs = dirSegments(path);
  if (dirSegs.length === 0) return false;
  return ctx.dotted.some((m) => {
    const segs = dotSegments(m);
    return segs.length >= 2 && isSegSuffix(segs, dirSegs);
  });
}

/** The pre-ENG-343 shared vocabulary, kept VERBATIM for python and node so their behaviour is
 *  unchanged (design 4.1). Python and node phrasings are genuinely distinctive from each other,
 *  unlike `package X does not exist`, so sharing these two carries no cross-language risk. */
const LEGACY_INDICATORS = [
  "modulenotfounderror",
  "importerror",
  "no module named",
  "cannot find module",
  "cannot import name",
  "error collecting",
  "errors during collection",
  "import file mismatch",
  "error importing test module",
];

const LEGACY_NAMING =
  /(?:no module named|cannot find module|could not import|unable to resolve|cannot import name\s+[^\n]*?\bfrom)\s+['"]?([\w./-]+)['"]?/gi;

const pythonRules: LanguageRules = {
  indicators: LEGACY_INDICATORS,
  basenameGates: LEGACY_INDICATORS,
  naming: [LEGACY_NAMING],
  tiesByLeaf: true,
  shapes: [
    { basename: "__init__.py", match: packageInitImplicated },
    { basename: "conftest.py", match: (_p, ctx) => ctx.hasIndicator || ctx.hasFixtureError },
  ],
  fixturePattern: /fixture ['"]?[\w.-]+['"]? not found/i,
  prefersErrorSummary: true,
};

const nodeRules: LanguageRules = {
  indicators: LEGACY_INDICATORS,
  basenameGates: LEGACY_INDICATORS,
  naming: [LEGACY_NAMING],
  tiesByLeaf: true,
  shapes: [],
};

/** No rules: behaviour identical to before ENG-343. Replaced per language in Tasks 2 and 3. */
const noRules: LanguageRules = {
  indicators: [],
  basenameGates: [],
  naming: [],
  tiesByLeaf: false,
  shapes: [],
};

/** The per-language rule registry — THE extension point for the discard poison guard. Add new
 *  languages, new toolchain phrasings and per-language exceptions HERE, never to a shared list: a
 *  shared list applies every phrase to every run, which produced confirmed cross-language false
 *  rejects (`package X does not exist` is ordinary English). See the ENG-343 design, section 2. */
export const CHECK_RULES: Record<CheckFramework, LanguageRules> = {
  pytest: pythonRules,
  jest: nodeRules,
  vitest: nodeRules,
  go: noRules,
  cargo: noRules,
  "junit-maven": noRules,
  "junit-gradle": noRules,
  rspec: noRules,
  minitest: noRules,
  phpunit: noRules,
};
```

- [ ] **Step 5: Rewrite the matcher and excerpt in `check-selector.ts`**

Delete from `src/dispatch/check-selector.ts`: `SOURCE_EXTS`, `moduleLeaf`, `IMPORT_ERROR_INDICATORS`, `FIXTURE_NOT_FOUND`, `IMPORT_ERROR_NAMING`, `moduleDotted`, `isSegSuffix`, `isSegPrefix`, `packageInitImplicated`. Add the import beside the existing ones:

```ts
import { CHECK_RULES, type MatchContext, moduleDotted, moduleLeaf } from "./check-rules.ts";
```

Replace both function bodies with:

```ts
/** CONSERVATIVE discard-poison matcher (guards against a bad merge nobody notices). Given a run's raw
 *  output, the files THIS dispatch discarded, and the framework that produced the output, return the
 *  subset of discarded files the output implicates in an import/collection/module error — i.e. the
 *  check could not run *because* a file it references was discarded.
 *
 *  Rules are looked up per framework in CHECK_RULES so one language's phrasing can never fire on
 *  another's output. Three tiers per discarded file: (1) shape rules (directory- or marker-based, for
 *  files whose own name never appears); (2) the leaf tier, where a naming phrase names the file's
 *  module leaf — disabled for package-oriented languages; (3) the bounded-basename tier, gated on an
 *  indicator. A red whose error names some OTHER (e.g. feature) module is left untouched, so a test
 *  that legitimately fails because the feature is absent is never rejected. Pure. */
export function importErrorImplicatesDiscarded(
  rawOutput: string,
  discarded: string[],
  framework: CheckFramework | null,
): string[] {
  if (discarded.length === 0 || rawOutput.trim() === "" || framework === null) return [];
  const rules = CHECK_RULES[framework];
  const hay = rawOutput.toLowerCase();
  const hasIndicator = rules.indicators.some((k) => hay.includes(k));
  const gatesBasename = rules.basenameGates.some((k) => hay.includes(k));
  const hasFixtureError = rules.fixturePattern?.test(rawOutput) ?? false;

  const leaves = new Set<string>();
  const dotted: string[] = [];
  for (const pattern of rules.naming) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical exec-loop over a /g regex.
    while ((m = re.exec(rawOutput)) !== null) {
      if (m[1]) {
        leaves.add(moduleLeaf(m[1]));
        dotted.push(moduleDotted(m[1]));
      }
    }
  }
  const ctx: MatchContext = { dotted, hasIndicator, hasFixtureError };

  const matched: string[] = [];
  for (const d of discarded) {
    const base = (d.split(/[\\/]/).pop() ?? d).toLowerCase();
    let hit = false;
    for (const shape of rules.shapes) {
      if (shape.basename !== undefined && shape.basename !== base) continue;
      if (shape.match(d, ctx)) {
        hit = true;
        break;
      }
    }
    if (!hit && rules.tiesByLeaf) {
      const leaf = moduleLeaf(d);
      if (leaf !== "" && leaves.has(leaf)) hit = true;
    }
    if (!hit && gatesBasename && base.includes(".")) {
      const bounded = new RegExp(`(?:^|[\\s"'\`/(])${escapeRegex(base)}(?:[\\s"'\`:)]|$)`, "im");
      if (bounded.test(rawOutput)) hit = true;
    }
    if (hit) matched.push(d);
  }
  return matched;
}

/** The one line that states a collection/import/fixture cause, in original casing, ≤200 chars.
 *  Prefers pytest's short-test-summary line (`ERROR path - Cause`, printed last and authoritative)
 *  where this language declares that preference; else the LAST matching line (the first is often a
 *  re-raised error deep in a third-party traceback). Strips a leading pytest error gutter (`E   `) —
 *  `^E\s+` requires whitespace right after `E`, so it never eats an `ERROR …` summary line. Considers
 *  this framework's naming patterns as well as its indicators, so a language with no flat indicator
 *  still yields a real compiler line. `undefined` when nothing matches. Pure. */
export function collectionErrorExcerpt(
  rawOutput: string,
  framework: CheckFramework | null,
): string | undefined {
  if (framework === null) return undefined;
  const rules = CHECK_RULES[framework];
  // `.test()` on a /g regex advances lastIndex between calls, so strip `g` for these probes.
  const probes = rules.naming.map((p) => new RegExp(p.source, p.flags.replace("g", "")));
  let summary: string | undefined;
  let lastMatch: string | undefined;
  for (const line of rawOutput.split(/\r?\n/)) {
    const low = line.toLowerCase();
    const isMatch =
      rules.indicators.some((k) => low.includes(k)) ||
      (rules.fixturePattern?.test(line) ?? false) ||
      probes.some((p) => p.test(line));
    if (!isMatch) continue;
    lastMatch = line;
    if (rules.prefersErrorSummary === true && /^\s*ERROR\b/.test(line)) summary = line;
  }
  const chosen = (summary ?? lastMatch)?.trim().replace(/^E\s+/, "");
  if (chosen === undefined || chosen === "") return undefined;
  return chosen.length > 200 ? `${chosen.slice(0, 197)}...` : chosen;
}
```

`escapeRegex` already exists in `check-selector.ts` (around line 81) — keep and reuse it.

- [ ] **Step 6: Update the two call sites in `handlers.ts`**

Around line 685: `importErrorImplicatesDiscarded(rawOutput, discarded)` → `importErrorImplicatesDiscarded(rawOutput, discarded, fw)`.
Around line 687: `collectionErrorExcerpt(rawOutput)` → `collectionErrorExcerpt(rawOutput, fw)`.

`fw` is already in scope at both points (used below as `framework: fw`).

- [ ] **Step 7: Run the tests**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS, including every pre-existing assertion unchanged.

- [ ] **Step 8: Run the full gate**

Run: `bun run typecheck && bun run format && bun run lint && bun test`
Expected: all clean/green. `format` must precede `lint` — Biome reports formatting but does not fix it.

- [ ] **Step 9: Commit**

```bash
git add src/dispatch/check-rules.ts src/dispatch/check-selector.ts src/dispatch/handlers.ts test/dispatch/check-selector.test.ts
git commit -m "refactor(checks): per-language rule registry for the discard poison guard (ENG-343)"
```

---

### Task 2: Go and JVM — tie by package/directory segment alignment

**Files:**
- Modify: `src/dispatch/check-rules.ts` (replace `noRules` for `go`, `junit-maven`, `junit-gradle`)
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces:**
- Consumes: `importErrorImplicatesDiscarded(rawOutput, discarded, framework)`, `CHECK_RULES`, and the private `goPackageImplicated` / `jvmPackageImplicated` from Task 1.
- Produces: `goRules` and `jvmRules` wired into `CHECK_RULES`.

- [ ] **Step 1: Write the failing tests**

Append to `test/dispatch/check-selector.test.ts`:

```ts
describe("discard-poison: Go (ties by package/directory segment alignment)", () => {
  // Real go1.24 module-mode text. GOPATH-era `cannot find package "…"` is kept in the vocabulary as a
  // legacy phrase but is NOT what a modern toolchain emits.
  const missingHelper =
    "app/x_test.go:6:2: no required module provides package example.com/m/helper; to add it:";
  const missingDep =
    "app/x_test.go:6:2: no required module provides package github.com/stretchr/testify/assert; to add it:";

  test("implicates a discarded file in the missing package's directory", () => {
    expect(importErrorImplicatesDiscarded(missingHelper, ["helper/helper.go"], "go")).toEqual([
      "helper/helper.go",
    ]);
  });

  test("implicates any file in that directory, not only one named after the package", () => {
    expect(importErrorImplicatesDiscarded(missingHelper, ["helper/util.go"], "go")).toEqual([
      "helper/util.go",
    ]);
  });

  test("contrast: same output, unrelated discarded file ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(missingHelper, ["scratch/scratch.go"], "go")).toEqual([]);
  });

  test("colliding LEAF: a missing dependency must not implicate a throwaway sharing its leaf", () => {
    expect(importErrorImplicatesDiscarded(missingDep, ["internal/scratch/assert.go"], "go")).toEqual([]);
  });

  test("colliding DIRECTORY: a missing dependency must not implicate a throwaway in a like-named dir", () => {
    // The measured false positive that leaf-to-directory matching alone would produce: dir `assert`
    // equals the package leaf. Segment alignment rejects it — [internal, assert] ≠ [testify, assert].
    expect(importErrorImplicatesDiscarded(missingDep, ["internal/assert/helper.go"], "go")).toEqual([]);
    const missingCmp =
      "app/x_test.go:6:2: no required module provides package github.com/google/go-cmp/cmp; to add it:";
    expect(importErrorImplicatesDiscarded(missingCmp, ["testutil/cmp/x.go"], "go")).toEqual([]);
  });

  test("returns only the implicated subset when several files were discarded", () => {
    expect(
      importErrorImplicatesDiscarded(missingHelper, ["helper/helper.go", "scratch/s.go"], "go"),
    ).toEqual(["helper/helper.go"]);
  });

  test("surfaces the compiler's own line as the excerpt", () => {
    expect(collectionErrorExcerpt(missingHelper, "go")).toBe(missingHelper);
  });

  // DOCUMENTATION PIN (not a guard): records an accepted residual. It asserts the gap exists; it does
  // not defend it — closing the gap would require a naming pattern that captures a symbol name.
  test("residual: a helper in the SAME package names only the symbol ⇒ not tied", () => {
    expect(
      importErrorImplicatesDiscarded("app/y_test.go:5:30: undefined: Help", ["helper.go"], "go"),
    ).toEqual([]);
  });
});

describe("discard-poison: JVM (ties by package/directory segment alignment)", () => {
  const missingPkg =
    "src/test/java/com/helper/ATest.java:3: error: package com.helper does not exist";

  test("implicates a discarded class in the missing package's directory", () => {
    expect(
      importErrorImplicatesDiscarded(missingPkg, ["src/test/java/com/helper/Helper.java"], "junit-maven"),
    ).toEqual(["src/test/java/com/helper/Helper.java"]);
  });

  test("contrast: same output, a class outside that package ⇒ no match", () => {
    expect(
      importErrorImplicatesDiscarded(missingPkg, ["src/test/java/com/other/Helper.java"], "junit-maven"),
    ).toEqual([]);
  });

  test("colliding leaf: a missing dependency must not implicate a throwaway sharing its leaf", () => {
    const out = "Foo.java:3: error: package org.junit.jupiter.api does not exist";
    expect(importErrorImplicatesDiscarded(out, ["src/test/java/api.java"], "junit-gradle")).toEqual([]);
  });

  test("a single-segment package never matches (the generic-noun collision floor)", () => {
    const out = "Foo.java:3: error: package util does not exist";
    expect(
      importErrorImplicatesDiscarded(out, ["src/test/java/util/Scratch.java"], "junit-maven"),
    ).toEqual([]);
  });

  test("surfaces the compiler's own line as the excerpt (the reason naming patterns feed it)", () => {
    expect(collectionErrorExcerpt(missingPkg, "junit-maven")).toBe(missingPkg);
  });

  // DOCUMENTATION PIN (not a guard): records an accepted residual.
  test("residual: `cannot find symbol` names the symbol, never the file ⇒ not tied", () => {
    const out = "ATest.java:12: error: cannot find symbol\n  symbol:   class Helper\n  location: class ATest";
    expect(
      importErrorImplicatesDiscarded(out, ["src/test/java/com/helper/Helper.java"], "junit-maven"),
    ).toEqual([]);
  });
});

describe("discard-poison: the framework gate (ENG-343 design section 2)", () => {
  // These EXACT inputs implicated wrongly under a shared vocabulary. `package X does not exist` is
  // ordinary English; gating on the framework is what makes them safe.
  test("JVM wording in a Ruby run implicates nothing", () => {
    const out = 'Failure: expected "package tracking does not exist" but got "ok"';
    expect(importErrorImplicatesDiscarded(out, ["spec/tracking.rb"], "minitest")).toEqual([]);
  });

  test("JVM wording in a pytest run implicates nothing", () => {
    const out = "AssertionError: assert 'package acme.widget does not exist' in msg";
    expect(importErrorImplicatesDiscarded(out, ["tools/widget.py"], "pytest")).toEqual([]);
  });

  test("JVM wording in a pytest run does not reach the __init__.py shape tier either", () => {
    const out = "AssertionError: assert 'package foo does not exist' in msg";
    expect(importErrorImplicatesDiscarded(out, ["foo/__init__.py"], "pytest")).toEqual([]);
  });
});

describe("mutation guards: the Go/JVM negatives above must discriminate", () => {
  // A negative that would pass under the WRONG implementation proves nothing. These mutate the real
  // rule object and assert the collision reappears — committed evidence, not a manual ritual.
  const missingDep =
    "app/x_test.go:6:2: no required module provides package github.com/stretchr/testify/assert; to add it:";

  test("leaf tying would re-introduce the Go collision", () => {
    const orig = CHECK_RULES.go.tiesByLeaf;
    try {
      (CHECK_RULES.go as { tiesByLeaf: boolean }).tiesByLeaf = true;
      expect(importErrorImplicatesDiscarded(missingDep, ["internal/scratch/assert.go"], "go")).toEqual([
        "internal/scratch/assert.go",
      ]);
    } finally {
      (CHECK_RULES.go as { tiesByLeaf: boolean }).tiesByLeaf = orig;
    }
    expect(importErrorImplicatesDiscarded(missingDep, ["internal/scratch/assert.go"], "go")).toEqual([]);
  });

  test("leaf tying would re-introduce the JVM collision", () => {
    const out = "Foo.java:3: error: package org.junit.jupiter.api does not exist";
    const orig = CHECK_RULES["junit-maven"].tiesByLeaf;
    try {
      (CHECK_RULES["junit-maven"] as { tiesByLeaf: boolean }).tiesByLeaf = true;
      expect(importErrorImplicatesDiscarded(out, ["src/test/java/api.java"], "junit-maven")).toEqual([
        "src/test/java/api.java",
      ]);
    } finally {
      (CHECK_RULES["junit-maven"] as { tiesByLeaf: boolean }).tiesByLeaf = orig;
    }
    expect(importErrorImplicatesDiscarded(out, ["src/test/java/api.java"], "junit-maven")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: FAIL — every Go and JVM assertion fails, because `go`, `junit-maven` and `junit-gradle` still map to `noRules` (the matcher returns `[]` for all of them, and `collectionErrorExcerpt` returns `undefined`).

- [ ] **Step 3: Wire the Go and JVM rules into the registry**

In `src/dispatch/check-rules.ts`, add above the `CHECK_RULES` declaration:

```ts
const GO_INDICATORS = [
  "no required module provides package",
  "cannot find module providing package",
  "cannot find package",
];

const goRules: LanguageRules = {
  indicators: GO_INDICATORS,
  basenameGates: GO_INDICATORS,
  naming: [
    /no required module provides package\s+([\w./-]+)/gi,
    /cannot find module providing package\s+([\w./-]+)/gi,
    /cannot find package\s+["']?([\w./-]+)["']?/gi,
  ],
  tiesByLeaf: false,
  shapes: [{ match: goPackageImplicated }],
};

const jvmRules: LanguageRules = {
  // Excerpt only. `cannot find symbol` is a documented residual: it names the symbol, never the file,
  // which is already deleted. It appears here so the retry message carries a real compiler line, and
  // it cannot cause a match because basenameGates is empty and no naming pattern consumes it.
  // `error: package` rather than a bare `does not exist`, which would let an unrelated later line win
  // the excerpt's last-match rule.
  indicators: ["error: package", "cannot find symbol"],
  basenameGates: [],
  naming: [/error:\s+package\s+([\w.]+)\s+does not exist/gi],
  tiesByLeaf: false,
  shapes: [{ match: jvmPackageImplicated }],
};
```

Then change the `CHECK_RULES` entries:

```ts
  go: goRules,
  "junit-maven": jvmRules,
  "junit-gradle": jvmRules,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS. If any fails, fix `goPackageImplicated` / `jvmPackageImplicated` — do NOT weaken an assertion. Each negative encodes a measured false reject.

- [ ] **Step 5: Run the full gate**

Run: `bun run typecheck && bun run format && bun run lint && bun test`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/check-rules.ts test/dispatch/check-selector.test.ts
git commit -m "feat(checks): Go and JVM discard-poison rules with directory alignment (ENG-343)"
```

---

### Task 3: Rust, Ruby and PHP

**Files:**
- Modify: `src/dispatch/check-rules.ts` (replace `noRules` for `cargo`, `rspec`, `minitest`, `phpunit`)
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces:**
- Consumes: `importErrorImplicatesDiscarded`, `collectionErrorExcerpt`, `CHECK_RULES`, and the private `modMarkerImplicated` from Task 1.
- Produces: `rustRules`, `rubyRules`, `phpRules` wired into `CHECK_RULES`.

- [ ] **Step 1: Write the failing tests**

Append to `test/dispatch/check-selector.test.ts`:

```ts
describe("discard-poison: Rust", () => {
  // Real rustc 1.94 output. The help line names BOTH candidate paths — which is exactly why cargo's
  // basenameGates is empty.
  const e0583 =
    'error[E0583]: file not found for module `helper`\n' +
    '  = help: to create the module `helper`, create file "src/helper.rs" or "src/helper/mod.rs"';

  test("implicates a discarded module file named by E0583", () => {
    expect(importErrorImplicatesDiscarded(e0583, ["src/helper.rs"], "cargo")).toEqual(["src/helper.rs"]);
  });

  test("implicates a discarded mod.rs via its directory (its leaf would be `mod`)", () => {
    const out = "error[E0583]: file not found for module `common`";
    expect(importErrorImplicatesDiscarded(out, ["tests/common/mod.rs"], "cargo")).toEqual([
      "tests/common/mod.rs",
    ]);
  });

  test("contrast: same output, an unrelated discarded module ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(e0583, ["src/scratch.rs"], "cargo")).toEqual([]);
  });

  test("E0583's help note must NOT implicate an unrelated discarded mod.rs", () => {
    // The help line contains the literal token `src/newfeature/mod.rs`. If error[e0583] gated the
    // bounded-basename tier, ANY discarded mod.rs would match ANY E0583.
    const out =
      'error[E0583]: file not found for module `newfeature`\n' +
      '  = help: to create the module `newfeature`, create file "src/newfeature.rs" or "src/newfeature/mod.rs"';
    expect(importErrorImplicatesDiscarded(out, ["tests/scratch/mod.rs"], "cargo")).toEqual([]);
  });

  test("surfaces the rustc error line, not the help note", () => {
    expect(collectionErrorExcerpt(e0583, "cargo")).toBe("error[E0583]: file not found for module `helper`");
  });

  // DOCUMENTATION PIN (not a guard): records an accepted residual.
  test("residual: E0432 unresolved imports name no file ⇒ not tied", () => {
    const out = "error[E0432]: unresolved import `crate::helper`\n --> tests/x.rs:3:5";
    expect(importErrorImplicatesDiscarded(out, ["src/helper.rs"], "cargo")).toEqual([]);
  });
});

describe("discard-poison: Ruby", () => {
  const loadErr = "spec/a_spec.rb:2:in `require': cannot load such file -- support/helper (LoadError)";

  test("implicates a discarded helper named by a LoadError", () => {
    expect(importErrorImplicatesDiscarded(loadErr, ["spec/support/helper.rb"], "minitest")).toEqual([
      "spec/support/helper.rb",
    ]);
  });

  test("ties on rspec too, for the boot-time require failure design section 5 credits it with", () => {
    const boot = "cannot load such file -- ./spec/support/helper (LoadError)";
    expect(importErrorImplicatesDiscarded(boot, ["spec/support/helper.rb"], "rspec")).toEqual([
      "spec/support/helper.rb",
    ]);
  });

  test("contrast: same output, unrelated discarded file ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(loadErr, ["spec/support/scratch.rb"], "minitest")).toEqual([]);
  });

  test("near-miss leaf: `helpers.rb` is not `helper` ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(loadErr, ["spec/support/helpers.rb"], "minitest")).toEqual([]);
  });

  // DOCUMENTATION PIN (not a guard): records an accepted residual.
  test("residual: the Dir[].each autoload shape raises NameError, which names no file ⇒ not tied", () => {
    const out = "spec/c_spec.rb:2:in `<main>': uninitialized constant Helper (NameError)";
    expect(importErrorImplicatesDiscarded(out, ["spec/support/helper.rb"], "rspec")).toEqual([]);
  });
});

describe("discard-poison: PHP", () => {
  const failedOpen =
    "PHP Fatal error:  Uncaught Error: Failed opening required 'helper.php' (include_path='.:/usr/share/php')";
  // The realistic shape: a `require` warning. It has NO naming pattern, so it can only tie through
  // the bounded-basename tier — the path most likely to over-fire, and untested otherwise.
  const failedStream =
    "PHP Warning:  require(/app/src/helper.php): Failed to open stream: No such file or directory in /app/tests/ATest.php on line 3";

  test("implicates a discarded file named by a failed require (naming tier)", () => {
    expect(importErrorImplicatesDiscarded(failedOpen, ["src/helper.php"], "phpunit")).toEqual([
      "src/helper.php",
    ]);
  });

  test("implicates via the bounded-basename tier on the `Failed to open stream` shape", () => {
    expect(importErrorImplicatesDiscarded(failedStream, ["src/helper.php"], "phpunit")).toEqual([
      "src/helper.php",
    ]);
  });

  test("contrast: same stream output, unrelated discarded file ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(failedStream, ["src/scratch.php"], "phpunit")).toEqual([]);
  });

  test("contrast: same output, unrelated discarded file ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(failedOpen, ["src/scratch.php"], "phpunit")).toEqual([]);
  });

  // DOCUMENTATION PIN (not a guard): records an accepted residual.
  test("residual: PSR-4 autoload reports a missing CLASS, which names no file ⇒ not tied", () => {
    const out = 'PHP Fatal error:  Uncaught Error: Class "Helper" not found in /app/tests/ATest.php:9';
    expect(importErrorImplicatesDiscarded(out, ["src/Helper.php"], "phpunit")).toEqual([]);
  });
});

describe("mutation guard: the Rust help-note negative must discriminate", () => {
  test("gating the basename tier on E0583 would implicate any discarded mod.rs", () => {
    const out =
      'error[E0583]: file not found for module `newfeature`\n' +
      '  = help: to create the module `newfeature`, create file "src/newfeature.rs" or "src/newfeature/mod.rs"';
    const orig = CHECK_RULES.cargo.basenameGates;
    try {
      (CHECK_RULES.cargo as { basenameGates: string[] }).basenameGates = ["error[e0583]"];
      expect(importErrorImplicatesDiscarded(out, ["tests/scratch/mod.rs"], "cargo")).toEqual([
        "tests/scratch/mod.rs",
      ]);
    } finally {
      (CHECK_RULES.cargo as { basenameGates: string[] }).basenameGates = orig;
    }
    expect(importErrorImplicatesDiscarded(out, ["tests/scratch/mod.rs"], "cargo")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: FAIL — every Rust, Ruby and PHP assertion fails, because those frameworks still map to `noRules`.

- [ ] **Step 3: Wire the Rust, Ruby and PHP rules into the registry**

In `src/dispatch/check-rules.ts`, add above the `CHECK_RULES` declaration:

```ts
const rustRules: LanguageRules = {
  indicators: ["file not found for module", "unresolved import", "error[e0432]", "error[e0583]"],
  // Deliberately empty: rustc's E0583 help line names `src/<mod>.rs` and `src/<mod>/mod.rs` as
  // CANDIDATES to create. Gating the bounded-basename tier on it would implicate ANY discarded
  // `mod.rs` on ANY E0583, regardless of which module is missing.
  basenameGates: [],
  naming: [/file not found for module\s+['"`]?(\w+)/gi],
  tiesByLeaf: true,
  shapes: [{ basename: "mod.rs", match: modMarkerImplicated }],
};

const RUBY_INDICATORS = ["cannot load such file", "loaderror"];

const rubyRules: LanguageRules = {
  indicators: RUBY_INDICATORS,
  basenameGates: RUBY_INDICATORS,
  naming: [/cannot load such file --\s+([\w./-]+)/gi],
  tiesByLeaf: true,
  shapes: [],
};

const PHP_INDICATORS = ["failed opening required", "failed to open stream"];

const phpRules: LanguageRules = {
  indicators: PHP_INDICATORS,
  basenameGates: PHP_INDICATORS,
  naming: [/failed opening required\s+['"]?([\w./-]+)['"]?/gi],
  tiesByLeaf: true,
  shapes: [],
};
```

Then change the `CHECK_RULES` entries:

```ts
  cargo: rustRules,
  rspec: rubyRules,
  minitest: rubyRules,
  phpunit: phpRules,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS. If the Rust `mod.rs` case fails, check `modMarkerImplicated`; if the help-note case fails, confirm `rustRules.basenameGates` is `[]`.

- [ ] **Step 5: Run the full gate**

Run: `bun run typecheck && bun run format && bun run lint && bun test`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/check-rules.ts test/dispatch/check-selector.test.ts
git commit -m "feat(checks): Rust, Ruby and PHP discard-poison rules (ENG-343)"
```

---

### Task 4: Smoke cells A17–A19 through the real `checks:dispatch` path

**Files:**
- Modify: `test/dispatch/scope-disposition-smoke.test.ts`

**Interfaces:**
- Consumes: existing harness helpers `setupChecks`, `checksRunner`, `driveChecks`, `listAcChecks`, `committedAtHead`, `headHas`, `gitRepo`, `parseProfile`.
- Produces: nothing consumed later.

**Context.** The framework comes from the profile component owning the committed test path (`handlers.ts:634-635`), **not** the work-unit kind — so `setupChecks`'s `insertWorkUnit({ kind: "python" })` needs no change. Only the profile and the check file's extension vary.

Trap: a Ruby profile MUST set `commands.test` naming rspec or minitest, or `frameworkFor` returns `null`, the run buckets as `error` with empty output, and the cell fails misleadingly.

- [ ] **Step 1: Add the language profiles and parameterize the harness**

Next to `pythonProfile` / `nodeProfile` (around line 83) add:

```ts
const goProfile = (repo: string) =>
  parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "svc", kind: "go", paths: ["**"], commands: { test: "go test ./..." } }],
  });

const rubyProfile = (repo: string) =>
  parseProfile({
    slug: "demo",
    targetRepo: repo,
    // `commands.test` MUST name rspec or minitest — frameworkFor returns null otherwise.
    components: [{ name: "app", kind: "ruby", paths: ["**"], commands: { test: "bundle exec rspec" } }],
  });
```

Give `driveChecks` an optional profile:

```ts
async function driveChecks(
  h: ChecksHarness,
  runner: FakeAgentRunner,
  opts?: {
    runCheck?: Cmd;
    beforeChecks?: (wt: string) => void;
    profile?: ReturnType<typeof parseProfile>;
  },
) {
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: opts?.profile ?? pythonProfile(h.repo),
    worktreeRoot: h.worktreeRoot,
    runCheckCommand: opts?.runCheck ?? redRun,
  });
```

Leave the rest of `driveChecks` unchanged.

- [ ] **Step 2: Run the suite to confirm nothing regressed**

Run: `bun test test/dispatch/scope-disposition-smoke.test.ts`
Expected: PASS — all existing cells green (the profile defaults to `pythonProfile`).

- [ ] **Step 3: Write the three cells**

Insert at the end of `test/dispatch/scope-disposition-smoke.test.ts`:

```ts
// --- A17 ⚔ (ENG-343: a discarded Go helper package → guard fires through the REAL dispatch path) ---
// The canonical check imports package `example.com/m/helper`; the agent wrote helper/helper.go but did
// NOT declare it → discarded → `go test` cannot resolve the package. Proves the guard is reached, the
// file surfaced, AND the compiler's own line carried into the message, on a stack that is not Python.
test("A17 ⚔ a discarded Go helper package → AC uncovered, file surfaced", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.go`),
        'package checks\n\nimport "example.com/m/helper"\n\nfunc TestX(t *testing.T) { _ = helper.X }\n',
      );
      const pkgDir = join(cwd, "helper");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "helper.go"), "package helper\n\nvar X = 1\n"); // undeclared → discarded
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `checks/${ident}_ac${acId}_test.go`, test_name: "TestX" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner, {
    profile: goProfile(h.repo),
    // exit 1 with no "no tests to run" ⇒ interpretRunOutput → red ⇒ the guard runs.
    runCheck: async () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "checks/ENG-1_ac1_test.go:3:8: no required module provides package example.com/m/helper; to add it:",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(existsSync(join(wt, "helper", "helper.go"))).toBe(false); // discarded
  expect(headHas(wt, "checks/ENG-1_ac1_test.go")).toBe(false); // no poisoned check committed
  expect(checks).toHaveLength(0);
  expect(message).toMatch(/import or collection error/);
  expect(message).toContain("helper/helper.go");
  // The framework-aware excerpt (design 4.5) carried a real Go compiler line into the feedback.
  expect(message).toContain("no required module provides package");
});

// --- A18 ⚔ (ENG-343 contrast for A17: a Go red that names a FEATURE package must stay covered) -----
// The check legitimately fails first because the feature package is absent. An UNRELATED throwaway was
// discarded. The guard must NOT fire: the AC stays covered and the RED is installed.
test("A18 ⚔ a Go red naming a FEATURE package + an unrelated discarded file stays COVERED", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.go`),
        'package checks\n\nimport "example.com/m/newfeature"\n\nfunc TestX(t *testing.T) { _ = newfeature.X }\n',
      );
      const scratch = join(cwd, "scratch");
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, "scratch.go"), "package scratch\n"); // undeclared, unrelated
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `checks/${ident}_ac${acId}_test.go`, test_name: "TestX" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, step, wt } = await driveChecks(h, runner, {
    profile: goProfile(h.repo),
    runCheck: async () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "checks/ENG-1_ac1_test.go:3:8: no required module provides package example.com/m/newfeature; to add it:",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(outcome.kind).toBe("stepped"); // NOT rejected
  expect(step?.status).toBe("succeeded");
  expect(existsSync(join(wt, "scratch", "scratch.go"))).toBe(false); // still discarded
  expect(committedAtHead(wt)).toContain("_ac1_test.go"); // the RED check IS committed
  expect(checks).toHaveLength(1);
  expect(checks[0]?.red_first_result).toBe("red");
});

// --- A19 (ENG-343 residual pin: rspec load errors never reach the guard) ------------------------
// RSpec does NOT abort on a spec-file load error — it reports it and still prints `0 examples`,
// exiting 1. interpretRunOutput (check-selector.ts:216-218) tests `\b0 examples` BEFORE the exit code,
// so the run is bucketed `selected-none` and handlers.ts returns ABOVE the discard-poison guard.
// This is SAFE (the AC still goes uncovered and discardNote still names the file) but the specific
// "could not be collected" message is never produced.
//
// IF THIS TEST GOES RED: someone changed the rspec branch of interpretRunOutput so load errors now
// bucket as `red`. That is an IMPROVEMENT, not a regression — update this cell and design section 6
// to the new behaviour. Do NOT revert the interpretRunOutput change to get green.
test("A19 an rspec load error is bucketed selected-none, bypassing the discard-poison guard", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "spec");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.rb`),
        "require 'support/helper'\n\nRSpec.describe 'x' do\n  it 'works' do\n    expect(Helper.x).to be true\n  end\nend\n",
      );
      const sup = join(cwd, "spec", "support");
      mkdirSync(sup, { recursive: true });
      writeFileSync(join(sup, "helper.rb"), "module Helper; def self.x; true; end; end\n");
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `spec/${ident}_ac${acId}_test.rb`, test_name: "works" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, step, message } = await driveChecks(h, runner, {
    profile: rubyProfile(h.repo),
    // REAL rspec output for a load error — including the `0 examples` summary it always prints.
    runCheck: async () => ({
      exitCode: 1,
      stdout:
        "An error occurred while loading ./spec/ENG-1_ac1_test.rb.\n" +
        "Failure/Error: require 'support/helper'\n\n" +
        "LoadError:\n  cannot load such file -- support/helper\n\n" +
        "0 examples, 0 failures\n\n1 error occurred outside of examples",
      stderr: "",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(checks).toHaveLength(0); // still safe: no poisoned check installed
  expect(message).toMatch(/matched no test/); // the selected-none reason, NOT the guard's message
  expect(message).not.toMatch(/import or collection error/); // the guard did not run
  expect(message).toContain("spec/support/helper.rb"); // discardNote still names the file
});
```

- [ ] **Step 4: Run the smoke suite**

Run: `bun test test/dispatch/scope-disposition-smoke.test.ts`
Expected: PASS, all cells including A17–A19.

If A17 or A18 behaves differently from its assertions, STOP and report — that is a real signal about the guard, not a test to weaken.

- [ ] **Step 5: Run the full gate**

Run: `bun run typecheck && bun run format && bun run lint && bun test`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add test/dispatch/scope-disposition-smoke.test.ts
git commit -m "test(checks): smoke cells for Go discard poison and the rspec residual (ENG-343)"
```

- [ ] **Step 7: Go and do Task 5 now, then come back for Steps 8 and 9**

Task 5 adds the symbol definition tier. Do it before the design correction and the PR, so both reflect
the finished state. Steps 8 and 9 below run only after Task 5 is committed.

- [ ] **Step 8: Update the design's coverage section to match what shipped**

Two claims in `docs/brainstorms/2026-07-20-checks-discard-poison-matcher-langs-design.md` are now out of date and must be corrected (a design that overstates its own guarantees is how the first draft failed review):

1. §4.3 and §5 describe the Go rule as matching the package leaf against the directory name. It is stricter: the file's directory segments must be a trailing **suffix** of the package path. Update the wording, and note this is the mirror of the JVM rule (JVM: package is a suffix of the directory, because the source root is on disk; Go: directory is a suffix of the package, because the module prefix is not).
2. §5 says a discarded `helper/util.go` does not tie for Go. Under directory alignment it **does** — any file in the missing package's directory is implicated. Correct the Go row.
3. §5's statement that "the directory rules remove the known collisions" holds only with segment alignment; say so explicitly, and record the surviving narrow residual: a top-level directory whose name equals a dependency's package leaf (e.g. a repo-root `assert/` against `github.com/stretchr/testify/assert`).
4. §9's "Conservative matching" bullet still reads "every rule ties to a named file, module or package directory". The symbol tier ties to file *contents*. Amend the bullet to name the evidence tier.
5. §7.1 still lists Go `undefined: Helper` and JVM `cannot find symbol` as residual pins, and §10's trail still records rspec `NameError` and PHP Composer as shapes that "do not tie". With Task 5 those are covered whenever contents are present. The Task 2/3 unit pins still pass (they pass no `sources`), so nothing turns red — the docs would simply misdescribe the product. Correct both.
6. §5's Rust row: state that `cannot find <kind>` and E0433 forms tie; do not claim blanket Rust symbol coverage.
7. Add the residuals Task 5's review surfaced: Go grouped `const (…)` declarations, PHP `Call to undefined function`, and PHP `Interface`/`Trait` not found.

Commit:

```bash
git add docs/brainstorms/2026-07-20-checks-discard-poison-matcher-langs-design.md
git commit -m "docs(checks): correct the design's Go coverage claims to match the shipped rule (ENG-343)"
```

- [ ] **Step 9: Push and open a draft PR**

Per CLAUDE.md the operator merges every PR personally — open it and stop. PR titles must be Conventional Commits (enforced by the pr-title CI check).

```bash
git push -u origin fix/checks-discard-poison-matcher-langs-eng-343
gh pr create --draft --title "fix(checks): per-language rule registry for the discard poison matcher (ENG-343)" --body "..."
```

Do NOT merge, do not enable auto-merge.

---

### Task 5: The symbol definition tier — tie by evidence, not by name

**Files:**
- Modify: `src/dispatch/worktree.ts` (add `readDiscardedSources`)
- Modify: `src/dispatch/run-dispatch.ts` (capture contents before discarding; carry them out)
- Modify: `src/dispatch/handlers.ts` (pass them to the guard)
- Modify: `src/dispatch/check-rules.ts` (two optional registry fields + per-language entries)
- Modify: `src/dispatch/check-selector.ts` (the new tier)
- Test: `test/dispatch/check-selector.test.ts`, `test/dispatch/scope-disposition-smoke.test.ts`

**Why this task exists.** Go same-package, JVM single-class, rspec's usual support loader and PHP Composer autoloading all report a missing **symbol** — the defining file is already deleted, so no phrase can name it. Reading the file's contents *before* discarding lets us implicate it on evidence: the discarded file literally defined the symbol the toolchain says is missing. See design §4.5.

**Interfaces:**
- Consumes: `CHECK_RULES`, `LanguageRules`, `importErrorImplicatesDiscarded(rawOutput, discarded, framework)` from Tasks 1–3.
- Produces:
  - `readDiscardedSources(worktreePath: string, paths: string[]): Map<string, string>` from `worktree.ts`
  - `discardedSources: Map<string, string>` added to `runAgentDispatch`'s return type (alongside the existing `discarded: string[]`, which is unchanged)
  - `importErrorImplicatesDiscarded(rawOutput, discarded, framework, sources?)` — a 4th **optional** parameter, so every existing call and test keeps working untouched
  - `LanguageRules.symbolNaming?: RegExp[]` and `LanguageRules.definesSymbol?: (symbol: string) => RegExp`

**Critical constraint.** `discarded: string[]` must NOT change shape. It feeds the `scope-discarded` telemetry payload (`run-dispatch.ts:246`), the retry note (`handlers.ts:720`) and the implement handler (`handlers.ts:976`, `:995`) — none of which should carry file contents. Add `discardedSources` beside it.

- [ ] **Step 1: Write the failing tests**

Append to `test/dispatch/check-selector.test.ts`:

```ts
describe("discard-poison: the symbol definition tier (design 4.5)", () => {
  const src = (path: string, content: string) => new Map([[path, content]]);

  test("Go: a same-package helper is tied when the discarded file defined the symbol", () => {
    const out = "app/y_test.go:5:30: undefined: Help";
    expect(
      importErrorImplicatesDiscarded(out, ["helper.go"], "go", src("helper.go", "package app\n\nfunc Help() int { return 1 }\n")),
    ).toEqual(["helper.go"]);
  });

  test("Go contrast: same error, a discarded file that does NOT define the symbol", () => {
    const out = "app/y_test.go:5:30: undefined: Help";
    expect(
      importErrorImplicatesDiscarded(out, ["scratch.go"], "go", src("scratch.go", "package app\n\nfunc Other() int { return 2 }\n")),
    ).toEqual([]);
  });

  test("JVM: `cannot find symbol` is tied when the discarded class defined it", () => {
    const out = "ATest.java:12: error: cannot find symbol\n  symbol:   class Helper\n  location: class ATest";
    expect(
      importErrorImplicatesDiscarded(out, ["src/test/java/com/x/Helper.java"], "junit-maven", src("src/test/java/com/x/Helper.java", "package com.x;\n\npublic class Helper {}\n")),
    ).toEqual(["src/test/java/com/x/Helper.java"]);
  });

  test("Ruby: rspec's autoload NameError is tied when the discarded file defined the constant", () => {
    const out = "spec/c_spec.rb:2:in `<main>': uninitialized constant Helper (NameError)";
    expect(
      importErrorImplicatesDiscarded(out, ["spec/support/helper.rb"], "rspec", src("spec/support/helper.rb", "module Helper\n  def self.x; true; end\nend\n")),
    ).toEqual(["spec/support/helper.rb"]);
  });

  test("PHP: a Composer autoload miss is tied, and the namespace is reduced to the class name", () => {
    const out = 'PHP Fatal error:  Uncaught Error: Class "App\\Helper" not found in /app/tests/ATest.php:9';
    expect(
      importErrorImplicatesDiscarded(out, ["src/Helper.php"], "phpunit", src("src/Helper.php", "<?php\nnamespace App;\nclass Helper {}\n")),
    ).toEqual(["src/Helper.php"]);
  });

  test("Rust: a missing item is tied when the discarded module defined it", () => {
    const out = "error[E0425]: cannot find function `help` in this scope";
    expect(
      importErrorImplicatesDiscarded(out, ["src/helper.rs"], "cargo", src("src/helper.rs", "pub fn help() -> u8 { 1 }\n")),
    ).toEqual(["src/helper.rs"]);
  });

  test("the tier is inert when no contents are supplied (degrades to the other tiers)", () => {
    const out = "app/y_test.go:5:30: undefined: Help";
    expect(importErrorImplicatesDiscarded(out, ["helper.go"], "go")).toEqual([]);
    expect(importErrorImplicatesDiscarded(out, ["helper.go"], "go", new Map())).toEqual([]);
  });

  test("a symbol named by the error but defined by NO discarded file implicates nothing", () => {
    const out = "ATest.java:12: error: cannot find symbol\n  symbol:   class Missing";
    expect(
      importErrorImplicatesDiscarded(out, ["src/test/java/com/x/Helper.java"], "junit-maven", src("src/test/java/com/x/Helper.java", "package com.x;\n\npublic class Helper {}\n")),
    ).toEqual([]);
  });

  test("Rust: rustc's compound kinds and E0433 are captured", () => {
    // Real rustc wording. `Helper::new()` produces E0433, the most common way a test reaches a helper.
    const compound = "error[E0422]: cannot find struct, variant or union type `Config` in this scope";
    expect(
      importErrorImplicatesDiscarded(compound, ["src/c.rs"], "cargo", src("src/c.rs", "pub struct Config {}\n")),
    ).toEqual(["src/c.rs"]);
    const e0433 = "error[E0433]: failed to resolve: use of undeclared type `Helper`";
    expect(
      importErrorImplicatesDiscarded(e0433, ["src/h.rs"], "cargo", src("src/h.rs", "pub struct Helper;\n")),
    ).toEqual(["src/h.rs"]);
  });

  test("Go: a method on a receiver ties, not just a bare func", () => {
    const out = "app/y_test.go:5:30: undefined: Help";
    expect(
      importErrorImplicatesDiscarded(out, ["h.go"], "go", src("h.go", "package app\n\nfunc (r T) Help() int { return 1 }\n")),
    ).toEqual(["h.go"]);
  });

  test("Go: `undefined:` inside a test's own assertion message must NOT fire (no compiler gutter)", () => {
    // Ordinary program text masquerading as a diagnostic — the section 2 failure class, within one
    // language. The gutter anchor is what rejects it.
    const out = 'x_test.go:12: want no error, got "undefined: Config"';
    expect(
      importErrorImplicatesDiscarded(out, ["scratch/dump.go"], "go", src("scratch/dump.go", "package scratch\n\ntype Config struct{}\n")),
    ).toEqual([]);
  });

  test("JVM: a `symbol: method` capture cannot cross-match a type declaration", () => {
    const out = "ATest.java:12: error: cannot find symbol\n  symbol:   method helper(int)";
    expect(
      importErrorImplicatesDiscarded(out, ["Helper.java"], "junit-maven", src("Helper.java", "class helper {}\n")),
    ).toEqual([]);
  });

  // DOCUMENTATION PINS (design section 5, residual 4): the tier is a text search, so a discarded file
  // that merely MENTIONS a definition is implicated. Recorded so the residual cannot drift unnoticed.
  test("residual: a comment mentioning the definition implicates the file", () => {
    const out = "app/y_test.go:5:30: undefined: Help";
    expect(
      importErrorImplicatesDiscarded(out, ["n.go"], "go", src("n.go", "package app\n// TODO: func Help should live here one day\n")),
    ).toEqual(["n.go"]);
  });

  test("residual: a compile stub the agent wrote for its own test is implicated", () => {
    // The realistic case: the agent stubs `type Config struct{}` so its RED-first test builds, does not
    // declare it, and the stub is discarded. Costs one retry; self-heals next attempt (no stub to
    // discard). Never a bad merge.
    const out = "checks/x_test.go:3:10: undefined: Config";
    expect(
      importErrorImplicatesDiscarded(out, ["checks/stub.go"], "go", src("checks/stub.go", "package checks\n\ntype Config struct{}\n")),
    ).toEqual(["checks/stub.go"]);
  });

  test("symbolLeaf reduces qualified names; a Go package qualifier is deliberately dropped too", () => {
    // `helper.Help` means package `helper` lacks `Help`. We reduce to `Help`, so an unrelated
    // discarded package defining `Help` is implicated. Accepted: the consequence is a retry.
    const out = "app/y_test.go:5:30: undefined: helper.Help";
    expect(
      importErrorImplicatesDiscarded(out, ["other/thing.go"], "go", src("other/thing.go", "package other\n\nfunc Help() int { return 1 }\n")),
    ).toEqual(["other/thing.go"]);
  });

  test("a symbol-tier hit yields a real compiler line in the excerpt", () => {
    expect(collectionErrorExcerpt("app/y_test.go:5:30: undefined: Help", "go")).toBe(
      "app/y_test.go:5:30: undefined: Help",
    );
    expect(
      collectionErrorExcerpt("spec/c_spec.rb:2:in `<main>': uninitialized constant Helper (NameError)", "rspec"),
    ).toContain("uninitialized constant Helper");
  });
});

describe("mutation guard: the symbol tier's contrast must discriminate", () => {
  test("a symbol-blind definition pattern would implicate an unrelated discarded file", () => {
    const out = "app/y_test.go:5:30: undefined: Help";
    const sources = new Map([["scratch.go", "package app\n\nfunc Other() int { return 2 }\n"]]);
    const orig = CHECK_RULES.go.definesSymbol;
    try {
      (CHECK_RULES.go as { definesSymbol?: (s: string) => RegExp }).definesSymbol = () => /\bfunc\s+\w+/;
      expect(importErrorImplicatesDiscarded(out, ["scratch.go"], "go", sources)).toEqual(["scratch.go"]);
    } finally {
      (CHECK_RULES.go as { definesSymbol?: (s: string) => RegExp }).definesSymbol = orig;
    }
    expect(importErrorImplicatesDiscarded(out, ["scratch.go"], "go", sources)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: FAIL — the tier does not exist, so every positive returns `[]`. (The two negative tests and the inert test already pass; that is expected.)

- [ ] **Step 3: Add the registry fields and per-language entries**

In `src/dispatch/check-rules.ts`, add to the `LanguageRules` interface:

```ts
  /** Patterns whose capture group 1 is a SYMBOL the toolchain says is missing while never naming the
   *  file that defined it (`undefined: Help`, `symbol: class Helper`). */
  symbolNaming?: RegExp[];
  /** Given a symbol name, a pattern matching its DEFINITION in source. Paired with `symbolNaming`:
   *  the tier fires only when the error names the symbol AND a discarded file defines it. */
  definesSymbol?: (symbol: string) => RegExp;
```

Add this helper beside the other pure functions:

```ts
/** Escape regex metacharacters so a captured symbol can be embedded in a definition pattern. */
function escapeSymbol(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The last segment of a qualified symbol: `App\Helper` → `Helper`, `Foo::Bar` → `Bar`, `a.b` → `b`. */
export function symbolLeaf(ref: string): string {
  const parts = ref.split(/[\\.:]+/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? ref;
}
```

Then add the fields to the language entries (leave `pythonRules` and `nodeRules` without them — Python and Node name the module, not a bare symbol, and adding a tier there would change behaviour this plan promises to preserve):

```ts
// in goRules — both patterns are ANCHORED to the compiler's `file.go:LINE:COL:` gutter. Unanchored,
// `undefined: Config` inside a test's own assertion message would fire the tier: ordinary program
// text masquerading as a diagnostic, the same failure class the registry exists to prevent.
// definesSymbol allows an optional receiver so methods (`func (r T) Help()`) tie, not just functions.
  symbolNaming: [
    /^[^\s:]+\.go:\d+:\d+:\s+undefined:\s+([\w.]+)/gim,
    /^[^\s:]+\.go:\d+:\d+:.*has no field or method\s+(\w+)/gim,
  ],
  definesSymbol: (s) =>
    new RegExp(`\\b(?:func\\s+(?:\\([^)]*\\)\\s*)?|type\\s+|var\\s+|const\\s+)${escapeSymbol(s)}\\b`),

// in jvmRules — `variable` and `method` are deliberately NOT captured: definesSymbol only recognises
// type declarations, so capturing them could only ever produce a cross-kind mismatch (a `symbol:
// method helper(int)` wrongly tying a file that declares `class helper`).
  symbolNaming: [/symbol:\s+(?:class|interface|enum|record)\s+([\w.]+)/gi],
  definesSymbol: (s) => new RegExp(`\\b(?:class|interface|enum|record)\\s+${escapeSymbol(s)}\\b`),

// in rustRules — the kind list is a loose character class because rustc writes compound kinds with
// commas ("cannot find function, tuple struct or tuple variant `Point`"). The second pattern covers
// E0433 (`use of undeclared type `Helper``), which is what rustc emits for `Helper::new()` — the most
// common way a Rust test reaches a discarded helper.
  symbolNaming: [
    /cannot find [a-z, ]*?['"`](\w+)['"`]/gi,
    /use of (?:undeclared|unresolved)[\w ]*?['"`](\w+)['"`]/gi,
  ],
  definesSymbol: (s) => new RegExp(`\\b(?:fn|struct|enum|trait|const|static|type)\\s+${escapeSymbol(s)}\\b`),

// in rubyRules
  symbolNaming: [/uninitialized constant\s+([\w:]+)/gi],
  definesSymbol: (s) => new RegExp(`\\b(?:class|module)\\s+${escapeSymbol(s)}\\b`),

// in phpRules — case-insensitive: PHP class names are, so `Class "Helper" not found` must tie a file
// declaring `class helper`.
  symbolNaming: [/Class\s+["']([\w\\]+)["']\s+not found/gi],
  definesSymbol: (s) => new RegExp(`\\b(?:class|interface|trait)\\s+${escapeSymbol(s)}\\b`, "i"),
```

Leave `pythonRules` and `nodeRules` without a symbol tier. The reason is not merely that they name modules: Python's `NameError: name 'x' is not defined` and Node's `ReferenceError: X is not defined` arrive on **runtime** failures of checks that collected fine — and a RED-first check failing on an absent name is the *normal, correct* case there. A symbol tier on those stacks would reject legitimately red checks wholesale. Omitting them is the conservative call and it also preserves Task 1's behaviour-unchanged promise.

- [ ] **Step 4: Add the tier to the matcher**

In `src/dispatch/check-selector.ts`, extend the import to include `symbolLeaf`, add the optional parameter, collect the named symbols, and run the tier immediately after the shape rules:

```ts
export function importErrorImplicatesDiscarded(
  rawOutput: string,
  discarded: string[],
  framework: CheckFramework | null,
  sources?: Map<string, string>,
): string[] {
```

Also update `collectionErrorExcerpt`'s probe list so a symbol-tier hit yields a real compiler line. Without this, the four stacks this task exists for get a retry message with no toolchain text at all — `undefined:`, `uninitialized constant`, `Class "…" not found` and `cannot find …` are in no language's `indicators`:

```ts
  const probes = [...rules.naming, ...(rules.symbolNaming ?? [])].map(
    (p) => new RegExp(p.source, p.flags.replace("g", "")),
  );
```

After the `ctx` construction, add:

```ts
  // Symbols the toolchain names without naming their defining file (design 4.5). Collected whenever
  // this language declares `symbolNaming` — NOT gated on `sources`, so the excerpt and this list stay
  // independent of whether contents happened to be supplied.
  const symbols: string[] = [];
  if (rules.symbolNaming !== undefined) {
    for (const pattern of rules.symbolNaming) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const re = new RegExp(pattern.source, flags);
      let sm: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: canonical exec-loop over a /g regex.
      while ((sm = re.exec(rawOutput)) !== null) {
        if (sm[1]) symbols.push(symbolLeaf(sm[1]));
      }
    }
  }
```

Then, inside the per-file loop, immediately after the shape-rule block and before the leaf tier:

```ts
    if (!hit && symbols.length > 0 && rules.definesSymbol !== undefined) {
      const content = sources?.get(d);
      if (content !== undefined) {
        const defines = rules.definesSymbol;
        if (symbols.some((s) => defines(s).test(content))) hit = true;
      }
    }
```

- [ ] **Step 5: Run the unit tests**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS, including every earlier task's assertions (the new parameter is optional, so nothing else changes).

- [ ] **Step 6: Capture the contents before discarding**

In `src/dispatch/worktree.ts`, extend the `node:fs` import to `{ type Dirent, existsSync, readFileSync, readdirSync, rmSync, statSync }` and add beside `discardPaths`:

```ts
/** The largest single discarded file worth holding in memory for the symbol tier. A source helper is
 *  kilobytes; anything larger is not one. */
const MAX_DISCARDED_SOURCE_BYTES = 256 * 1024;
/** Total budget across one dispatch, so an agent that emits hundreds of undeclared generated files
 *  cannot pin unbounded memory in the runner for the life of the dispatch. */
const MAX_DISCARDED_SOURCE_TOTAL = 4 * 1024 * 1024;

/** Read the about-to-be-discarded files so the discard-poison guard can later ask whether one of them
 *  DEFINED a symbol the toolchain reports as missing (design 4.5). Must be called immediately before
 *  `discardPaths`, which deletes them. Unreadable, oversized and non-regular paths are skipped, as is
 *  anything past the total budget. Binary files are read but simply never match a definition pattern.
 *  The symbol tier is best-effort — every other tier works without it. Never throws. */
export function readDiscardedSources(worktreePath: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let budget = MAX_DISCARDED_SOURCE_TOTAL;
  for (const p of paths) {
    try {
      const full = join(worktreePath, p);
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_DISCARDED_SOURCE_BYTES || st.size > budget) continue;
      out.set(p, readFileSync(full, "utf8"));
      budget -= st.size;
    } catch {
      // unreadable → skip; the guard degrades to the name-based tiers
    }
  }
  return out;
}
```

This capture also runs for `implement:dispatch` when `implementDisposition` is `"discard"` (`handlers.ts:960`). That handler does not consume the map; the cost is one bounded read per discarded file.

In `src/dispatch/run-dispatch.ts`: add `readDiscardedSources` to the import from `./worktree.ts`; add `discardedSources: Map<string, string>;` to the return type at line ~108; initialise `let discardedSources = new Map<string, string>();` beside `let discarded: string[] = [];` (line ~202); capture before the delete:

```ts
    if (disposition === "discard" && offendingNew.length > 0) {
      discardedSources = readDiscardedSources(deps.worktreePath, offendingNew);
      discardPaths(deps.worktreePath, offendingNew);
      discarded = offendingNew;
```

and return it: `return { dispatchId: did, sha, changed, output: result.stdout, discarded, discardedSources };`

Leave the `scope-discarded` event payload as `{ discarded }` — paths only, no contents in telemetry.

- [ ] **Step 7: Pass the contents to the guard**

In `src/dispatch/handlers.ts`, add `discardedSources` to the destructuring at line ~575 (alongside `discarded`), and pass it at the guard:

```ts
          const implicated = importErrorImplicatesDiscarded(rawOutput, discarded, fw, discardedSources);
```

- [ ] **Step 8: Pin the invariants the tier silently rests on**

Three properties would fail open and quiet if broken — the tier would go inert and every existing test would still pass. Pin each where it lives.

In `test/dispatch/run-dispatch.test.ts`, extend the existing discard case (the one asserting `out.discarded).toEqual(["scratch.py"])`, around line 628) with the key-identity and telemetry pins:

```ts
  // The symbol tier looks contents up by the EXACT path string in `discarded`. If these two ever
  // diverge (a `./` prefix, a separator, a normPath call slipped in between) the tier silently returns
  // nothing and no other test notices.
  expect([...out.discardedSources.keys()]).toEqual(out.discarded);
  expect(out.discardedSources.get("scratch.py")).toContain("scratch");
  // File CONTENTS must never reach telemetry — the payload carries paths only.
  expect(Object.keys(JSON.parse(notes[0]?.payload_json ?? "{}"))).toEqual(["discarded"]);
```

Adjust the `toContain` argument to whatever the existing test writes into `scratch.py`.

In `test/dispatch/worktree.test.ts`, add direct tests for the new function:

```ts
test("readDiscardedSources reads sources, skips oversized and missing paths, never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "styre-rds-"));
  writeFileSync(join(root, "small.go"), "package a\n\nfunc Help() int { return 1 }\n");
  writeFileSync(join(root, "big.go"), "x".repeat(256 * 1024 + 1));
  const out = readDiscardedSources(root, ["small.go", "big.go", "absent.go"]);
  expect([...out.keys()]).toEqual(["small.go"]);
  expect(out.get("small.go")).toContain("func Help()");
  expect(readDiscardedSources(root, []).size).toBe(0);
  rmSync(root, { recursive: true, force: true });
});
```

Add `readDiscardedSources` to that file's import from `../../src/dispatch/worktree.ts`, and `mkdtempSync`/`writeFileSync`/`rmSync`/`tmpdir`/`join` if not already imported.

- [ ] **Step 9: Add the end-to-end smoke cell**

The plumbing — contents captured at discard time surviving to the guard — is the real risk in this task, and only an end-to-end cell proves it. Append to `test/dispatch/scope-disposition-smoke.test.ts`:

```ts
// --- A20 ⚔ (ENG-343 design 4.5: a Go helper in the SAME package, tied by symbol evidence) --------
// The compiler reports `undefined: Help` — it names the FUNCTION, never the file, which is already
// deleted. No phrase can tie this. The guard implicates the discarded file because that file's
// captured contents DEFINED `Help`. This cell is the only proof that the contents survive from
// discardPaths' call site all the way to the guard.
test("A20 ⚔ a discarded same-package Go helper is tied by the symbol it defined", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.go`),
        "package checks\n\nfunc TestX(t *testing.T) { _ = Help() }\n",
      );
      // Same package, undeclared → discarded. Its NAME never appears in the compiler output.
      writeFileSync(join(dir, "helper.go"), "package checks\n\nfunc Help() int { return 1 }\n");
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `checks/${ident}_ac${acId}_test.go`, test_name: "TestX" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner, {
    profile: goProfile(h.repo),
    runCheck: async () => ({
      exitCode: 1,
      stdout: "",
      // Note: names the SYMBOL only. `helper.go` appears nowhere.
      stderr: "checks/ENG-1_ac1_test.go:3:30: undefined: Help",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(existsSync(join(wt, "checks", "helper.go"))).toBe(false); // discarded
  expect(checks).toHaveLength(0); // no poisoned check installed
  expect(message).toMatch(/import or collection error/);
  expect(message).toContain("checks/helper.go"); // tied by evidence, not by name
  expect(message).toContain("undefined: Help"); // the excerpt carried the compiler's own line
});
```

- [ ] **Step 10: Run the full gate**

Run: `bun run typecheck && bun run format && bun run lint && bun test`
Expected: all clean/green.

If A20 fails on the message assertion, check that `discardedSources` is actually threaded through the `checks:dispatch` destructuring (`handlers.ts:569-576`) — an empty map makes the tier silently inert, which is exactly the plumbing failure this cell exists to catch. Do NOT weaken the assertion.

- [ ] **Step 11: Commit**

```bash
git add src/dispatch/worktree.ts src/dispatch/run-dispatch.ts src/dispatch/handlers.ts src/dispatch/check-rules.ts src/dispatch/check-selector.ts test/dispatch/check-selector.test.ts test/dispatch/scope-disposition-smoke.test.ts
git commit -m "feat(checks): tie discarded helpers by the symbols they defined (ENG-343)"
```

Then return to **Task 4, Steps 8–9** (the design correction and the draft PR).

---

## Self-Review

**1. Spec coverage.**

| Design section | Task |
|---|---|
| §4.1 registry + framework-aware signatures | Task 1 |
| §4.2 naming patterns per language | Task 2 (Go, JVM), Task 3 (Rust, Ruby, PHP) |
| §4.3 packages tie by directory alignment | Task 2 |
| §4.4 Rust `mod.rs` shape + no basename gate | Task 3 (mutation guard proves the gate matters) |
| §4.5 framework-aware excerpt + drift pin | Task 1; per-language excerpt assertions in Tasks 2–3 |
| §5 coverage and residuals | Documentation pins in Tasks 2–3; §5 itself corrected in Task 4 Step 7 |
| §6 rspec wiring residual | Task 4, cell A19 |
| §7.1 unit matrix | Tasks 1–3 |
| §4.5 symbol definition tier (D6) | Task 5 — registry fields, the tier, the content plumbing, and cell A20 |
| §7.2 smoke cells + harness | Task 4 (A17–A19), Task 5 (A20) |
| §8 out of scope | No task touches `interpretRunOutput`, `post-implement-rerun.ts`, `classify-prior.ts` or `prompts/checks.md` |
| §9 invariants | No rule lives outside the registry (fixture pattern and ERROR preference are per-language fields) |

No gaps.

**2. Placeholder scan.** No TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries complete code. The `--body "..."` in Task 4 Step 8 is the one spot an implementer must compose prose: summarise the four commits and link the design and ENG-343.

**3. Type consistency.** `LanguageRules`, `ShapeRule`, `MatchContext`, `CHECK_RULES`, `moduleLeaf`, `moduleDotted` are defined once in Task 1 and used with identical names in Tasks 2–4. `importErrorImplicatesDiscarded(rawOutput, discarded, framework)` and `collectionErrorExcerpt(rawOutput, framework)` keep that arity everywhere after Task 1. `goPackageImplicated`, `jvmPackageImplicated`, `modMarkerImplicated`, `packageInitImplicated`, `dirSegments`, `dotSegments`, `isSegPrefix`, `isSegSuffix` are module-private in `check-rules.ts` (all are referenced internally, so `noUnusedLocals` is satisfied). All framework keys used in tests exist in the `CheckFramework` union.

**4. Honesty about residuals.** The four weak residual pins (Go `undefined:`, JVM `cannot find symbol`, Rust E0432, Ruby NameError, PHP PSR-4) are labelled in-comment as DOCUMENTATION PINS, not guards — a review found they still pass under the natural "someone tried to close this gap" mutation. They record accepted gaps; they do not defend them. The three negatives that *do* defend (Go collision, JVM collision, Rust help note) each carry a committed mutation guard proving the collision reappears when the rule is removed.
