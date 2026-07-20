# Per-language rule registry for the discard poison matcher (ENG-343) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the discard poison guard framework aware, backed by a per-language rule registry, so a discarded imported helper is caught on Go, Rust, JVM, Ruby and PHP without the cross-language false rejects a shared vocabulary produces.

**Architecture:** A new module `src/dispatch/check-rules.ts` owns one `LanguageRules` entry per `CheckFramework` (indicators, basename gates, naming patterns, shape rules) plus the pure path helpers the shapes need. `importErrorImplicatesDiscarded` and `collectionErrorExcerpt` in `check-selector.ts` take the framework and consult only that language's entry. Package-oriented languages (Go, JVM) tie a discarded file by its **directory**, never by file leaf, because a package is a directory and leaf matching collides on generic names.

**Tech Stack:** TypeScript, Bun test runner, Biome. No new dependencies.

**Design:** `docs/brainstorms/2026-07-20-checks-discard-poison-matcher-langs-design.md`

## Global Constraints

- **The registry is the extension point.** New languages, phrasings and per-language exceptions are added to `CHECK_RULES` in `check-rules.ts`, never to shared cross-language lists.
- **Conservative matching.** Every rule ties to a named file, module, or package *directory*. Nothing fires on a bare basename, and no rule may apply across a language boundary.
- **Never wrongly reject.** A check that legitimately fails because the feature does not exist yet must never be implicated. Every positive test needs a same-output contrast negative.
- **Real toolchain text only.** Error strings in tests must be text a real toolchain emits. Go uses `no required module provides package …` (module era), not `cannot find package "…"` (GOPATH era).
- **INV-B — feedback is diagnosis only.** Messages state the cause, the discarded file and the framework's own line. They never carry an instruction.
- **Out of scope, do not touch:** `interpretRunOutput` (including the rspec `selected-none` branch), `post-implement-rerun.ts`, `classify-prior.ts`, `prompts/checks.md`.
- **Regexes are single-line.** Never transcribe a pattern across multiple source lines — the newline and indentation become literal atoms and the alternative silently stops matching.
- **A naming pattern used with `.test()` must have its `g` flag stripped**, or `lastIndex` state makes results alternate between calls.
- Verification gate for every task: `bun run typecheck` clean, `bun run lint` clean, `bun test` green.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/dispatch/check-rules.ts` (**new**) | The `CHECK_RULES` registry, the `LanguageRules`/`ShapeRule`/`MatchContext` types, and the pure path helpers (`moduleLeaf`, `moduleDotted`, `dirSegments`, `isSegPrefix`, `isSegSuffix`) plus the shape predicates. |
| `src/dispatch/check-selector.ts` (modify) | `importErrorImplicatesDiscarded` and `collectionErrorExcerpt` become framework aware and consume the registry. The path helpers and `SOURCE_EXTS` move out to `check-rules.ts`. |
| `src/dispatch/handlers.ts` (modify) | Pass `fw` to both calls. Two lines. |
| `test/dispatch/check-selector.test.ts` (modify) | All matcher and excerpt tests, per language, through the public API. |
| `test/dispatch/scope-disposition-smoke.test.ts` (modify) | Harness generalized to a non-Python profile; cells A17–A19. |

`check-rules.ts` imports `CheckFramework` from `check-selector.ts` with `import type`, which is erased at compile time — there is no runtime import cycle.

---

### Task 1: The registry, and a framework-aware matcher that preserves current behaviour

**Files:**
- Create: `src/dispatch/check-rules.ts`
- Modify: `src/dispatch/check-selector.ts` (remove `SOURCE_EXTS`, `moduleLeaf`, `moduleDotted`, `isSegSuffix`, `isSegPrefix`, `packageInitImplicated`, `IMPORT_ERROR_INDICATORS`, `IMPORT_ERROR_NAMING`; rewrite `importErrorImplicatesDiscarded` and `collectionErrorExcerpt`)
- Modify: `src/dispatch/handlers.ts` (the two call sites, around lines 685 and 687)
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces:**
- Consumes: `CheckFramework` from `./check-selector.ts` (type only).
- Produces, from `src/dispatch/check-rules.ts`:
  - `interface MatchContext { dotted: string[]; hasIndicator: boolean; hasFixtureError: boolean }`
  - `interface ShapeRule { basename?: string; match: (discardedPath: string, ctx: MatchContext) => boolean }`
  - `interface LanguageRules { indicators: string[]; basenameGates: string[]; naming: RegExp[]; tiesByLeaf: boolean; shapes: ShapeRule[] }`
  - `const CHECK_RULES: Record<CheckFramework, LanguageRules>`
  - `function moduleLeaf(ref: string): string`
  - `function moduleDotted(ref: string): string`
  - `function dirSegments(path: string): string[]`
  - `function isSegPrefix(short: string[], long: string[]): boolean`
  - `function isSegSuffix(a: string[], b: string[]): boolean`
  - `const FIXTURE_NOT_FOUND: RegExp`
- Produces, from `src/dispatch/check-selector.ts` (changed signatures):
  - `importErrorImplicatesDiscarded(rawOutput: string, discarded: string[], framework: CheckFramework | null): string[]`
  - `collectionErrorExcerpt(rawOutput: string, framework: CheckFramework | null): string | undefined`

- [ ] **Step 1: Add the framework argument to every existing matcher/excerpt test**

In `test/dispatch/check-selector.test.ts`, every existing call to `importErrorImplicatesDiscarded` and `collectionErrorExcerpt` gains a third (respectively second) argument. Use `"pytest"` for every existing case **except** the Node one, which becomes `"jest"`. The Node assertion currently reads:

```ts
    expect(
      importErrorImplicatesDiscarded("Error: Cannot find module './helper'", ["src/helper.js"]),
    ).toEqual(["src/helper.js"]);
```

and becomes:

```ts
    expect(
      importErrorImplicatesDiscarded("Error: Cannot find module './helper'", ["src/helper.js"], "jest"),
    ).toEqual(["src/helper.js"]);
```

Every other existing case in that describe block takes `"pytest"` as the final argument, e.g.:

```ts
    expect(
      importErrorImplicatesDiscarded("ModuleNotFoundError: No module named 'helper'", [
        "checks/helper.py",
      ], "pytest"),
    ).toEqual(["checks/helper.py"]);
```

Do not change any expected value. These tests passing unchanged is the regression proof that the registry preserves today's behaviour.

- [ ] **Step 2: Add the null-framework and excerpt-drift tests**

Append inside the same describe block:

```ts
  test("a null framework never implicates (no framework detected ⇒ no output to match anyway)", () => {
    expect(
      importErrorImplicatesDiscarded("ModuleNotFoundError: No module named 'helper'", ["helper.py"], null),
    ).toEqual([]);
  });
```

And a new describe for the excerpt, pinning the behaviour change called out in design §4.5 (`could not import` and `unable to resolve` are naming alternatives that were never indicators, so lines containing them now yield an excerpt where they previously yielded none):

```ts
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

  test("naming patterns now trigger the excerpt (drift pin, design 4.5)", () => {
    // `unable to resolve` is a node naming alternative that was never an indicator: before this change
    // the excerpt was undefined for such a line. Pinned so the drift is deliberate, not accidental.
    expect(collectionErrorExcerpt("npm ERR! unable to resolve dependency tree", "jest")).toBe(
      "npm ERR! unable to resolve dependency tree",
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: FAIL — TypeScript/runtime errors about the extra argument, and `collectionErrorExcerpt` not accepting a second parameter.

- [ ] **Step 4: Create the registry module**

Create `src/dispatch/check-rules.ts` with exactly this content:

```ts
import type { CheckFramework } from "./check-selector.ts";

/** Source-file extensions stripped when reducing a path or module reference to its leaf name. A
 *  reference whose final dotted segment is one of these is a filename extension, not a module leaf. */
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
 *  last path segment, drops a trailing source extension, then takes the last remaining dotted segment:
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

/** A dotted, lower-cased reference: slashes → dots, trimmed of leading/trailing dots.
 *  `a/b` → `a.b`, `Pkg.Sub` → `pkg.sub`, `example.com/m/helper` → `example.com.m.helper`. Pure. */
export function moduleDotted(ref: string): string {
  return ref
    .replace(/[\\/]/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

/** The lower-cased path segments of a path's DIRECTORY (the last segment, the filename, is dropped). */
export function dirSegments(path: string): string[] {
  return path
    .split(/[\\/]/)
    .slice(0, -1)
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

/** True iff `long` starts with every segment of `short`. */
export function isSegPrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  return short.every((s, i) => s === long[i]);
}

/** True iff `a`'s segments are the trailing segments of `b`. */
export function isSegSuffix(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length > b.length) return false;
  const off = b.length - a.length;
  return a.every((s, i) => s === b[off + i]);
}

/** pytest's fixture-not-found line (a discarded `conftest.py` that provided the fixture). */
export const FIXTURE_NOT_FOUND = /fixture ['"]?[\w.-]+['"]? not found/i;

/** What a shape rule may consult about the run, besides the discarded path itself. */
export interface MatchContext {
  /** Raw dotted references captured by this language's naming patterns (lower-cased). */
  dotted: string[];
  /** True when any of this language's indicator phrases appear in the output. */
  hasIndicator: boolean;
  /** True when the output contains a pytest fixture-not-found line. */
  hasFixtureError: boolean;
}

/** A rule that ties a discarded file to the failure by its DIRECTORY or by being a known marker
 *  filename — for the cases where the file's own name never appears in the output. */
export interface ShapeRule {
  /** Restrict to discarded files with this exact (lower-cased) basename; undefined = any file. */
  basename?: string;
  match: (discardedPath: string, ctx: MatchContext) => boolean;
}

export interface LanguageRules {
  /** Lower-cased substrings marking an import/collection failure. Drive the excerpt. */
  indicators: string[];
  /** The subset of indicators permitted to gate the bounded-basename tier. Empty where the toolchain
   *  prints candidate paths that would poison it (cargo — see the E0583 help note). */
  basenameGates: string[];
  /** Patterns whose capture group 1 is a named module, package or file reference. Single-line only. */
  naming: RegExp[];
  /** When true, a discarded file whose module leaf equals a named reference is implicated. FALSE for
   *  package-oriented languages (go, jvm) where a package is a DIRECTORY and leaf matching collides
   *  on generic names (`util`, `assert`, `api`). */
  tiesByLeaf: boolean;
  shapes: ShapeRule[];
}

/** CONSERVATIVE match tying a discarded `__init__.py` to a missing-module error. Derive the package
 *  from the file's DIRECTORY, then implicate iff some named module M: (1) equals the full dotted dir;
 *  (2) strictly extends it as a prefix (a submodule import); or (3) is a >=2-segment trailing suffix
 *  of the dir (absorbs a `src/` or component prefix). A bare single-segment interior name never
 *  matches — that is the guarantee against wrongly rejecting a legitimate red. Pure. */
function packageInitImplicated(initPath: string, ctx: MatchContext): boolean {
  const dirSegs = dirSegments(initPath);
  if (dirSegs.length === 0) return false;
  for (const mod of ctx.dotted) {
    const modSegs = mod.split(".").filter((s) => s.length > 0);
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

/** A Go package IS a directory. Implicate a discarded file only when a named package path's LAST
 *  segment equals the name of the directory containing that file. `example.com/m/helper` implicates
 *  `helper/helper.go` and `helper/util.go` (directory `helper`) but never
 *  `internal/scratch/assert.go` for `github.com/stretchr/testify/assert` (directory `scratch`). Pure. */
function goPackageImplicated(path: string, ctx: MatchContext): boolean {
  const dirLeaf = dirSegments(path).at(-1);
  if (dirLeaf === undefined) return false;
  return ctx.dotted.some((m) => m.split(".").filter((s) => s.length > 0).at(-1) === dirLeaf);
}

/** A JVM package IS a directory. Implicate only when the dotted package's segments are a trailing
 *  suffix of the file's directory segments: `com.helper` implicates
 *  `src/test/java/com/helper/Helper.java`, while `org.junit.jupiter.api` (a missing dependency, the
 *  common JVM red) implicates nothing under `src/test/java`. Pure. */
function jvmPackageImplicated(path: string, ctx: MatchContext): boolean {
  const dirSegs = dirSegments(path);
  if (dirSegs.length === 0) return false;
  return ctx.dotted.some((m) => isSegSuffix(m.split(".").filter((s) => s.length > 0), dirSegs));
}

const PYTHON_INDICATORS = [
  "modulenotfounderror",
  "importerror",
  "no module named",
  "cannot import name",
  "error collecting",
  "errors during collection",
  "import file mismatch",
  "error importing test module",
];

const NODE_INDICATORS = [
  "cannot find module",
  "cannot find package",
  "err_module_not_found",
  "unable to resolve",
];

const pythonRules: LanguageRules = {
  indicators: PYTHON_INDICATORS,
  basenameGates: PYTHON_INDICATORS,
  naming: [
    /(?:no module named|could not import|cannot import name\s+[^\n]*?\bfrom)\s+['"]?([\w./-]+)['"]?/gi,
  ],
  tiesByLeaf: true,
  shapes: [
    { basename: "__init__.py", match: packageInitImplicated },
    {
      basename: "conftest.py",
      match: (_p, ctx) => ctx.hasIndicator || ctx.hasFixtureError,
    },
  ],
};

const nodeRules: LanguageRules = {
  indicators: NODE_INDICATORS,
  basenameGates: NODE_INDICATORS,
  naming: [
    /(?:cannot find module|cannot find package|could not import|unable to resolve)\s+['"]?([\w./-]+)['"]?/gi,
  ],
  tiesByLeaf: true,
  shapes: [],
};

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

const jvmRules: LanguageRules = {
  // Excerpt only. `cannot find symbol` is a documented residual: it names the symbol, never the file,
  // which is already deleted. It appears here so the retry message carries a real compiler line, and
  // it cannot cause a match because basenameGates is empty and no naming pattern consumes it.
  indicators: ["does not exist", "cannot find symbol"],
  basenameGates: [],
  naming: [/error:\s+package\s+([\w.]+)\s+does not exist/gi],
  tiesByLeaf: false,
  shapes: [{ match: jvmPackageImplicated }],
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

/** The per-language rule registry — THE extension point for the discard poison guard. Add new
 *  languages, new toolchain phrasings and per-language exceptions here, never to a shared list: a
 *  shared list applies every phrase to every run, which produced confirmed cross-language false
 *  rejects (`package X does not exist` is ordinary English). See the ENG-343 design, section 2. */
export const CHECK_RULES: Record<CheckFramework, LanguageRules> = {
  pytest: pythonRules,
  jest: nodeRules,
  vitest: nodeRules,
  go: goRules,
  cargo: rustRules,
  "junit-maven": jvmRules,
  "junit-gradle": jvmRules,
  rspec: rubyRules,
  minitest: rubyRules,
  phpunit: phpRules,
};
```

- [ ] **Step 5: Rewrite the matcher and excerpt in `check-selector.ts`**

Delete from `src/dispatch/check-selector.ts`: the `SOURCE_EXTS` const, `moduleLeaf`, `IMPORT_ERROR_INDICATORS`, `FIXTURE_NOT_FOUND`, `IMPORT_ERROR_NAMING`, `moduleDotted`, `isSegSuffix`, `isSegPrefix`, and `packageInitImplicated` — all of these now live in `check-rules.ts`. Add the import at the top of the file, next to the existing imports:

```ts
import {
  CHECK_RULES,
  FIXTURE_NOT_FOUND,
  type MatchContext,
  moduleDotted,
  moduleLeaf,
} from "./check-rules.ts";
```

Then replace the bodies of `importErrorImplicatesDiscarded` and `collectionErrorExcerpt` with:

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
  const hasFixtureError = FIXTURE_NOT_FOUND.test(rawOutput);

  const leaves = new Set<string>();
  const dotted: string[] = [];
  for (const pattern of rules.naming) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
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
 *  Prefers pytest's short-test-summary line (`ERROR path - Cause`, printed last and authoritative);
 *  else the LAST matching line (the first is often a re-raised error deep in a third-party
 *  traceback). Strips a leading pytest error gutter (`E   `) — `^E\s+` requires whitespace right
 *  after `E`, so it never eats an `ERROR …` summary line (whose next char is `R`). Considers this
 *  framework's naming patterns as well as its indicators, so a language with no flat indicator (JVM)
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
      FIXTURE_NOT_FOUND.test(line) ||
      probes.some((p) => p.test(line));
    if (!isMatch) continue;
    lastMatch = line;
    if (/^\s*ERROR\b/.test(line)) summary = line;
  }
  const chosen = (summary ?? lastMatch)?.trim().replace(/^E\s+/, "");
  if (chosen === undefined || chosen === "") return undefined;
  return chosen.length > 200 ? `${chosen.slice(0, 197)}...` : chosen;
}
```

Note `escapeRegex` already exists in `check-selector.ts` (around line 81) — keep it there and reuse it.

- [ ] **Step 6: Update the two call sites in `handlers.ts`**

At roughly line 685, change:

```ts
          const implicated = importErrorImplicatesDiscarded(rawOutput, discarded);
```

to:

```ts
          const implicated = importErrorImplicatesDiscarded(rawOutput, discarded, fw);
```

and at roughly line 687, change:

```ts
            const excerpt = collectionErrorExcerpt(rawOutput);
```

to:

```ts
            const excerpt = collectionErrorExcerpt(rawOutput, fw);
```

`fw` is already in scope at both points (it is used at the `records.push` below, as `framework: fw`).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS, including every pre-existing assertion unchanged.

- [ ] **Step 8: Run the full gate**

Run: `bun run typecheck && bun run lint && bun test`
Expected: all clean/green. If Biome reformats the new module, accept its formatting.

- [ ] **Step 9: Commit**

```bash
git add src/dispatch/check-rules.ts src/dispatch/check-selector.ts src/dispatch/handlers.ts test/dispatch/check-selector.test.ts
git commit -m "refactor(checks): per-language rule registry for the discard poison guard (ENG-343)"
```

---

### Task 2: Go and JVM — tie by directory

**Files:**
- Modify: `src/dispatch/check-rules.ts` (only if Task 1's entries need correction; the rules themselves ship in Task 1)
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces:**
- Consumes: `importErrorImplicatesDiscarded(rawOutput, discarded, framework)` and `CHECK_RULES` from Task 1.
- Produces: nothing new. This task is the proof that Task 1's `goRules` and `jvmRules` behave correctly.

The rules were written in Task 1; this task exists because a reviewer must be able to reject the directory-tying semantics independently of the registry refactor. If any test here fails, the fix belongs in `goPackageImplicated` / `jvmPackageImplicated` in `check-rules.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/dispatch/check-selector.test.ts`:

```ts
describe("discard-poison: Go (ties by package directory)", () => {
  // Real go1.24 module-mode text. The GOPATH-era `cannot find package "…"` is kept in the vocabulary
  // as a legacy phrase but is NOT what a modern toolchain emits.
  const missingHelper =
    "app/x_test.go:6:2: no required module provides package example.com/m/helper; to add it:";

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

  test("colliding leaf: a missing DEPENDENCY must not implicate a throwaway sharing its leaf", () => {
    // The common Go red: a package absent from go.mod. Leaf matching would wrongly tie `assert.go`.
    const out =
      "app/x_test.go:6:2: no required module provides package github.com/stretchr/testify/assert; to add it:";
    expect(importErrorImplicatesDiscarded(out, ["internal/scratch/assert.go"], "go")).toEqual([]);
  });

  test("residual: a helper in the SAME package names only the symbol ⇒ not tied", () => {
    // Documented residual. `undefined:` names the symbol; the file that defined it is already gone.
    expect(
      importErrorImplicatesDiscarded("app/y_test.go:5:30: undefined: Help", ["helper.go"], "go"),
    ).toEqual([]);
  });
});

describe("discard-poison: JVM (ties by package directory)", () => {
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

  test("colliding leaf: a missing DEPENDENCY must not implicate a throwaway sharing its leaf", () => {
    const out = "Foo.java:3: error: package org.junit.jupiter.api does not exist";
    expect(importErrorImplicatesDiscarded(out, ["src/test/java/api.java"], "junit-gradle")).toEqual([]);
  });

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
```

- [ ] **Step 2: Run the tests**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS. Task 1 already shipped the Go and JVM rules, so these should pass immediately. If any fails, fix `goPackageImplicated` or `jvmPackageImplicated` in `src/dispatch/check-rules.ts` — do NOT weaken an assertion to force a pass. Each negative here encodes a confirmed false reject from the design review.

- [ ] **Step 3: Verify the negatives are not vacuous**

Temporarily set `tiesByLeaf: true` on `goRules` in `src/dispatch/check-rules.ts` and re-run. Expected: the two "colliding leaf" tests FAIL (leaf matching re-introduces exactly the collisions the directory rule removes). Restore `tiesByLeaf: false` and confirm green again. This is a manual check — do not commit the mutation.

- [ ] **Step 4: Run the full gate**

Run: `bun run typecheck && bun run lint && bun test`
Expected: all clean/green.

- [ ] **Step 5: Commit**

```bash
git add test/dispatch/check-selector.test.ts src/dispatch/check-rules.ts
git commit -m "test(checks): pin Go/JVM directory tying and the framework gate (ENG-343)"
```

---

### Task 3: Rust, Ruby and PHP — leaf tying plus the `mod.rs` marker

**Files:**
- Modify: `src/dispatch/check-rules.ts` (only if a test reveals a defect in the Task 1 entries)
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces:**
- Consumes: `importErrorImplicatesDiscarded(rawOutput, discarded, framework)` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `test/dispatch/check-selector.test.ts`:

```ts
describe("discard-poison: Rust", () => {
  // Real rustc 1.94 output. Note the help line names BOTH candidate paths — which is exactly why
  // cargo's basenameGates is empty (see check-rules.ts).
  const e0583 =
    'error[E0583]: file not found for module `helper`\n' +
    '  = help: to create the module `helper`, create file "src/helper.rs" or "src/helper/mod.rs"';

  test("implicates a discarded module file named by E0583", () => {
    expect(importErrorImplicatesDiscarded(e0583, ["src/helper.rs"], "cargo")).toEqual([
      "src/helper.rs",
    ]);
  });

  test("implicates a discarded mod.rs via its directory (leaf would be `mod`)", () => {
    const out = 'error[E0583]: file not found for module `common`';
    expect(importErrorImplicatesDiscarded(out, ["tests/common/mod.rs"], "cargo")).toEqual([
      "tests/common/mod.rs",
    ]);
  });

  test("contrast: same output, an unrelated discarded module ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(e0583, ["src/scratch.rs"], "cargo")).toEqual([]);
  });

  test("E0583's help note must NOT implicate an unrelated discarded mod.rs", () => {
    // The help line contains the literal token `src/helper/mod.rs`. If error[e0583] gated the
    // bounded-basename tier, ANY discarded mod.rs would match ANY E0583. basenameGates is empty.
    const out =
      'error[E0583]: file not found for module `newfeature`\n' +
      '  = help: to create the module `newfeature`, create file "src/newfeature.rs" or "src/newfeature/mod.rs"';
    expect(importErrorImplicatesDiscarded(out, ["tests/scratch/mod.rs"], "cargo")).toEqual([]);
  });

  test("residual: E0432 unresolved imports name no file ⇒ not tied", () => {
    const out = "error[E0432]: unresolved import `crate::helper`\n --> tests/x.rs:3:5";
    expect(importErrorImplicatesDiscarded(out, ["src/helper.rs"], "cargo")).toEqual([]);
  });
});

describe("discard-poison: Ruby", () => {
  const loadErr =
    "spec/a_spec.rb:2:in `require': cannot load such file -- support/helper (LoadError)";

  test("implicates a discarded helper named by a LoadError", () => {
    expect(importErrorImplicatesDiscarded(loadErr, ["spec/support/helper.rb"], "minitest")).toEqual([
      "spec/support/helper.rb",
    ]);
  });

  test("contrast: same output, unrelated discarded file ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(loadErr, ["spec/support/scratch.rb"], "minitest")).toEqual(
      [],
    );
  });

  test("near-miss leaf: `helpers.rb` is not `helper` ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(loadErr, ["spec/support/helpers.rb"], "minitest")).toEqual(
      [],
    );
  });

  test("residual: the Dir[].each autoload shape raises NameError, which names no file ⇒ not tied", () => {
    const out = "spec/c_spec.rb:2:in `<main>': uninitialized constant Helper (NameError)";
    expect(importErrorImplicatesDiscarded(out, ["spec/support/helper.rb"], "rspec")).toEqual([]);
  });
});

describe("discard-poison: PHP", () => {
  const failedOpen =
    "PHP Fatal error:  Uncaught Error: Failed opening required 'helper.php' (include_path='.:/usr/share/php')";

  test("implicates a discarded file named by a failed require", () => {
    expect(importErrorImplicatesDiscarded(failedOpen, ["src/helper.php"], "phpunit")).toEqual([
      "src/helper.php",
    ]);
  });

  test("contrast: same output, unrelated discarded file ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(failedOpen, ["src/scratch.php"], "phpunit")).toEqual([]);
  });

  test("residual: PSR-4 autoload reports a missing CLASS, which names no file ⇒ not tied", () => {
    const out = 'PHP Fatal error:  Uncaught Error: Class "Helper" not found in /app/tests/ATest.php:9';
    expect(importErrorImplicatesDiscarded(out, ["src/Helper.php"], "phpunit")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS. If the Rust `mod.rs` case fails, check `modMarkerImplicated`; if the E0583 help-note case fails, confirm `rustRules.basenameGates` is `[]`.

- [ ] **Step 3: Verify the E0583 negative is not vacuous**

Temporarily set `basenameGates: ["error[e0583]"]` on `rustRules` in `src/dispatch/check-rules.ts` and re-run. Expected: the "help note must NOT implicate an unrelated discarded mod.rs" test FAILS. Restore `basenameGates: []` and confirm green. Manual check — do not commit the mutation.

- [ ] **Step 4: Run the full gate**

Run: `bun run typecheck && bun run lint && bun test`
Expected: all clean/green.

- [ ] **Step 5: Commit**

```bash
git add test/dispatch/check-selector.test.ts src/dispatch/check-rules.ts
git commit -m "test(checks): pin Rust/Ruby/PHP tying and their documented residuals (ENG-343)"
```

---

### Task 4: Smoke cells A17–A19 through the real `checks:dispatch` path

**Files:**
- Modify: `test/dispatch/scope-disposition-smoke.test.ts`

**Interfaces:**
- Consumes: the existing harness helpers `setupChecks`, `checksRunner`, `driveChecks`, `listAcChecks`, `committedAtHead`, `headHas`, `gitRepo`, `parseProfile`.
- Produces: nothing consumed by later tasks.

**Context an implementer needs:** the framework is derived from the profile component that owns the committed test path (`handlers.ts:634-635`), **not** from the work-unit kind — so `setupChecks`'s `insertWorkUnit({ kind: "python" })` needs no change. Only the profile and the check file's extension vary.

Two traps: a Ruby profile MUST set `commands.test` naming rspec or minitest, or `frameworkFor` returns `null` and the cell fails misleadingly; and `git clean -fd` leaves the emptied `helper/` directory behind, so never assert on that directory's absence.

- [ ] **Step 1: Add the language profiles and parameterize the harness**

In `test/dispatch/scope-disposition-smoke.test.ts`, next to the existing `pythonProfile` / `nodeProfile` helpers (around line 83), add:

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

Then give `driveChecks` an optional profile. Change its signature and the `buildDispatchRegistry` call:

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
Expected: PASS — all existing cells still green (the profile defaults to `pythonProfile`).

- [ ] **Step 3: Write the three cells**

Insert at the end of `test/dispatch/scope-disposition-smoke.test.ts`:

```ts
// --- A17 ⚔ (ENG-343: a discarded Go helper package → guard fires through the REAL dispatch path) ---
// The canonical check imports package `example.com/m/helper`; the agent wrote helper/helper.go but did
// NOT declare it → discarded → `go test` cannot resolve the package. Proves the guard is reached and
// the file surfaced on a stack that is not Python. Contrast: A18.
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
});

// --- A18 ⚔ (ENG-343 contrast for A17: same stack, one variable — the error names a FEATURE package) -
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
// "could not be collected" message is never produced. Pinned so that if anyone changes the rspec
// branch of interpretRunOutput, this turns red and the ENG-343 decision is revisited deliberately.
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

If A19's final assertion fails because the discarded path is not present in the message, read the actual `message` value and adjust the assertion to the real `discardNote` text — but do NOT delete the assertion, and do NOT change production code to satisfy it. If A17 or A18 behaves differently from its assertions, STOP and report: that is a real signal about the guard, not a test to weaken.

- [ ] **Step 5: Run the full gate**

Run: `bun run typecheck && bun run lint && bun test`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add test/dispatch/scope-disposition-smoke.test.ts
git commit -m "test(checks): smoke cells for Go discard poison and the rspec residual (ENG-343)"
```

---

## Self-Review

**1. Spec coverage.**

| Design section | Task |
|---|---|
| §4.1 registry + framework-aware signatures | Task 1 |
| §4.2 naming patterns per language | Task 1 (all entries), pinned in Tasks 2–3 |
| §4.3 packages tie by directory (Go, JVM) | Task 1 implements, Task 2 pins |
| §4.4 Rust `mod.rs` shape + no basename gate | Task 1 implements, Task 3 pins |
| §4.5 framework-aware excerpt + drift pin | Task 1 |
| §5 coverage and residuals | Residual pins in Tasks 2 (Go `undefined:`, JVM symbol) and 3 (Rust E0432, Ruby NameError, PHP PSR-4) |
| §6 rspec wiring residual | Task 4, cell A19 |
| §7.1 unit matrix (matching + contrast + colliding leaf) | Tasks 2–3 |
| §7.2 smoke cells A17–A19 + harness | Task 4 |
| §8 out of scope | No task touches `interpretRunOutput`, `post-implement-rerun.ts`, `classify-prior.ts` or `prompts/checks.md` |

No gaps.

**2. Placeholder scan.** No TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries complete code. The one pre-existing `TODO(M3)` comment inside `interpretRunOutput` is untouched code that this plan does not modify.

**3. Type consistency.** `LanguageRules`, `ShapeRule`, `MatchContext`, `CHECK_RULES`, `moduleLeaf`, `moduleDotted`, `dirSegments`, `isSegPrefix`, `isSegSuffix`, `FIXTURE_NOT_FOUND` are defined once in Task 1 and used with identical names and signatures in Tasks 2–4. `importErrorImplicatesDiscarded(rawOutput, discarded, framework)` and `collectionErrorExcerpt(rawOutput, framework)` are used with that exact arity everywhere after Task 1. Framework keys used in tests (`pytest`, `jest`, `go`, `cargo`, `junit-maven`, `junit-gradle`, `rspec`, `minitest`, `phpunit`) all exist in the `CheckFramework` union.

**Note on task shape.** Tasks 2 and 3 are test-only: Task 1 ships the complete registry because splitting a `Record<CheckFramework, LanguageRules>` across commits would leave the type incomplete and the build red. Tasks 2 and 3 remain separate because a reviewer must be able to reject the directory-tying semantics or the Rust marker shape independently of the refactor, and each carries a mutation check proving its negatives discriminate.
