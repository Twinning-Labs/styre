import type { CheckFramework } from "./check-selector.ts";

/** Source-file extensions a `tiesByLeaf` language can IMPORT. Consulted by BOTH leaf reductions —
 *  `importableLeaf` (the discarded side of `importErrorImplicatesDiscarded`'s leaf tier) and
 *  `moduleLeaf` (the output side) — but they are two DIFFERENT rules over one shared list (see TWO RULES
 *  below). Kept as one list because two would start identical and drift, not because the two sides
 *  compute the same thing.
 *
 *  This list is NOT the routing extension list (`EXTENSIONS_BY_KIND`) and must not be derived from
 *  it. It feeds only the LEAF TIER of the discard-poison guard, gated per language by
 *  `LanguageRules.tiesByLeaf` — false for `goRules` and `jvmRules`.
 *
 *  RULE FOR NEW ENTRIES: add an extension only if a check in some `tiesByLeaf` language can actually
 *  IMPORT a file with it. That is the only way a discarded file of that type reduces (via
 *  `importableLeaf`) to a stem that can be a TRUE cause; every other entry would let a non-importable
 *  path keep a stem it should have dropped, and since `discarded` is dispatch-wide while the rules
 *  object follows the CHECK's framework, that surfaces as a FALSE tie. Adding an entry is
 *  BIDIRECTIONAL — it also changes how `moduleLeaf` parses a reference ending in it — so weigh both
 *  sides. ENG-369 tracks importable extensions that arguably belong here (e.g. `.vue`).
 *
 *  TWO RULES, NOT ONE. It is tempting to state a single predicate "strip `.X` iff `.X` is importable"
 *  and say the two sides share it. They do not, and an earlier draft that claimed so was falsified:
 *   - discarded side (`importableLeaf`, a PATH): the last dotted segment IS an extension. If it is
 *     not importable the file cannot be an import cause, so the leaf is "" — which the tier skips.
 *   - output side (`moduleLeaf`, a REFERENCE): the last dotted segment may be an extension OR a
 *     submodule literally named after one — `mypkg.ts` names submodule `ts`. Keying THAT on
 *     importability is a latent wrong-verdict bug, live for every entry in this list: `mypkg.ts`
 *     reduces to `mypkg` and misses a discarded `mypkg/ts.py`. The sound output-side predicate is
 *     "is the reference path-shaped", not "is the tail importable". Tracked as ENG-368; do NOT fold
 *     the two reductions back together until it lands.
 *
 *  RESIDUAL on the discarded side (ENG-366 §4.3): `importableLeaf` is framework-BLIND while the rules
 *  object follows the check's framework, so a discarded `lib/helper.rb` still ties to a node check
 *  naming `./helper`. A future `importableLeaf(path, rules)` would close it.
 *
 *  Excluded on the membership rule, though `EXTENSIONS_BY_KIND` lists them:
 *  - `gradle`, `rake`, `gemspec` — build manifests; nothing imports them. `importableLeaf` returns
 *    "" for them regardless (their extension isn't in this list), so they can no longer tie on the
 *    discarded side; keeping them OUT documents the intent.
 *  - `kts`, `groovy` — JVM source. No `tiesByLeaf` language can import them.
 *  - `go`, `java`, `kt`, `scala` — go/JVM source (ENG-365). These four predated the membership rule
 *    and were stripped anyway, wrong in BOTH directions. On the discarded side it manufactured ties
 *    (`cmd/build.go` reduced to `build`, met a node `'../build'`); on the OUTPUT side it corrupted a
 *    real reference (`No module named 'mypkg.go'` → `mypkg`, so a discarded `mypkg/go.py` never tied
 *    and a poisoned check passed). The discarded-side residual ENG-365 had to accept — every `.go`
 *    reducing to the constant leaf `go` — is now GONE: `importableLeaf("cmd/build.go")` is "". The
 *    output-side half of the original bug survives untouched here and is ENG-368.
 *  - `pyi` — python STUBS (ENG-367). A `.pyi` is read by type checkers at analysis time and never
 *    imported at runtime (PEP 484; CPython resolves only `SOURCE_SUFFIXES == ['.py']`), and
 *    `CheckFramework` has no type-checker member, so the one shape where a stub IS causal cannot
 *    reach these rules. While `moduleLeaf` was shared its removal had a 2x2 effect space; the two
 *    effects that OUTLIVE this split are both output-side and still depend on `.pyi` being absent:
 *      (b) it GAINED a true tie — `No module named 'mypkg.pyi'` had `.pyi` popped off a genuine
 *          reference, so a discarded `mypkg/pyi.py` never tied and a poisoned check passed. This is
 *          the wrong-verdict miss that made ENG-367 worth shipping ahead of this split, which fixes
 *          only the discarded side and would have left it broken.
 *      (d) it DROPS output-side ties to stem-named non-`.pyi` discarded files — `No module named
 *          'mypkg.pyi'` no longer implicates a discarded `src/mypkg.py`. Those were FALSE ties by
 *          CPython submodule semantics (the error is raised only once `mypkg` itself resolved), so
 *          the direction is benign, but it is a real output-side removal.
 *    The DISCARDED-side effects the shared function used to have — the intra/cross-language false
 *    ties a discarded `.pyi` produced, and the constant-`pyi` residual — are now moot regardless of
 *    ENG-367: `importableLeaf("stubs/helper.pyi")` is "", because `pyi` is not in this list.
 *    Note `EXTENSIONS_BY_KIND` keeps `.pyi`: that is the file→component ROUTING map, disjoint from
 *    this list, and a `.pyi` genuinely is a python file for routing purposes.
 *
 *  CAVEAT — multi-dot stems. Both reductions pop exactly ONE extension, so `types.d.mts` reduces to
 *  `d` and `utils.test.mts` to `test`. Pre-existing (`foo.d.ts` already yields `d`), but the
 *  `.cts`/`.mts` additions widen it, and `test` is a highly collision-prone leaf given the
 *  discarded set is exactly agent-authored test files. Filed separately; see the tests. */
const SOURCE_EXTS = new Set([
  "py",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "cts",
  "mts",
  "svelte",
  "rs",
  "rb",
  "php",
]);

/** The last path segment split into non-empty dot-separated parts, e.g. `a/b.test.ts` → `[b, test,
 *  ts]`, `mod.rs` → `[mod, rs]`, `deploy` → `[deploy]`, `a/b/` → `[]`. The shared tokenizer for the
 *  two leaf reductions below, so they cannot drift on path-separator or empty-segment handling; the
 *  reductions differ only in POLICY (what to do with the parts), which is the axis they must differ
 *  on. Pure. */
function dotParts(ref: string): string[] {
  const seg = ref.split(/[\\/]/).pop() ?? ref;
  return seg.split(".").filter((s) => s.length > 0);
}

/** OUTPUT-side reduction: the leaf identifier of a module REFERENCE parsed from runner output,
 *  lower-cased. Drops a trailing source extension, then takes the last remaining dotted segment:
 *  `checks/helper.py`→`helper`, `pkg.helper`→`helper`, `./a/helper.js`→`helper`, `util`→`util`.
 *  NB: keys the extension-strip on `SOURCE_EXTS` membership, which is unsound for a reference naming
 *  a submodule after an extension (`mypkg.ts`→`mypkg`); that is ENG-368, not fixed here. Pure. */
export function moduleLeaf(ref: string): string {
  const parts = dotParts(ref);
  if (parts.length === 0) return (ref.split(/[\\/]/).pop() ?? ref).toLowerCase();
  if (parts.length >= 2 && SOURCE_EXTS.has((parts[parts.length - 1] ?? "").toLowerCase())) {
    parts.pop();
  }
  return (parts[parts.length - 1] ?? ref).toLowerCase();
}

/** DISCARDED-side reduction: the leaf identifier of a discarded FILE PATH, lower-cased, or "" when
 *  the path is not importable by any `tiesByLeaf` language. A path is importable only if it has an
 *  extension in `SOURCE_EXTS`; then the leaf is the stem before it (`src/lib/Button.svelte`→`button`,
 *  `mypkg/go.py`→`go`). Everything else — a non-source extension (`cmd/build.go`, `stubs/helper.pyi`,
 *  `data.json`) or no extension at all (`scripts/deploy`, `Makefile`) — reduces to "", which the leaf
 *  tier skips. This is the split ENG-366 introduced: a discarded path is not a module reference, so
 *  it must not borrow `moduleLeaf`'s reference semantics. Pure. */
export function importableLeaf(path: string): string {
  const parts = dotParts(path);
  if (parts.length < 2) return "";
  if (!SOURCE_EXTS.has((parts[parts.length - 1] ?? "").toLowerCase())) return "";
  parts.pop();
  return (parts[parts.length - 1] ?? "").toLowerCase();
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
   *  pattern leaked across languages (Rails emits `fixture 'users' not found`). Used with `.test()`
   *  on a single line, so it must NOT carry the `g` flag — a global regex's `lastIndex` state would
   *  make `.test()` results alternate between calls (true, false, true, false, ...) across lines. */
  fixturePattern?: RegExp;
  /** When true, a line beginning `ERROR` is preferred as the excerpt (pytest's summary line). */
  prefersErrorSummary?: boolean;
  /** Patterns whose capture group 1 is a SYMBOL the toolchain says is missing while never naming the
   *  file that defined it (`undefined: Help`, `symbol: class Helper`). */
  symbolNaming?: RegExp[];
  /** Given a symbol name, a pattern matching its DEFINITION in source. Paired with `symbolNaming`:
   *  the tier fires only when the error names the symbol AND a discarded file defines it. */
  definesSymbol?: (symbol: string) => RegExp;
}

/** Escape regex metacharacters so a captured symbol can be embedded in a definition pattern.
 *  Unreachable defence-in-depth as written: every `symbolNaming` capture class is `\w`-only after
 *  `symbolLeaf` strips separators, so `s` never contains a metacharacter for this to escape. Kept in
 *  case a future `symbolNaming` pattern captures something wider. */
function escapeSymbol(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The last segment of a qualified symbol: `App\Helper` → `Helper`, `Foo::Bar` → `Bar`, `a.b` → `b`. */
export function symbolLeaf(ref: string): string {
  const parts = ref.split(/[\\.:]+/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? ref;
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

/** A discarded Rust `mod.rs` is leafless (`importableLeaf` yields the generic `mod`), so tie it by
 *  its directory: `tests/common/mod.rs` is implicated when a named module equals `common`. Pure. */
function modMarkerImplicated(modPath: string, ctx: MatchContext): boolean {
  const dirLeaf = dirSegments(modPath).at(-1);
  return dirLeaf !== undefined && ctx.dotted.includes(dirLeaf);
}

/** A Go package IS a directory, and the module prefix is NOT on disk — so the discarded file's
 *  directory segments must be a trailing SUFFIX of the package path's segments.
 *  `example.com/m/helper` implicates `helper/helper.go` and `helper/util.go` (dir `helper`), while a
 *  missing DEPENDENCY at depth implicates nothing: `github.com/stretchr/testify/assert` against
 *  `internal/assert/helper.go` compares `[internal, assert]` to `[testify, assert]` and fails.
 *
 *  RESIDUAL: when the discarded file's directory is a SINGLE segment, the rule degenerates to a leaf
 *  comparison, so a top-level `assert/`, `cmp/` or `util/` directory IS implicated by a missing
 *  dependency whose package leaf matches. Unlike JVM this cannot take a >=2-segment floor without
 *  killing the ordinary `helper/helper.go` positive. Consequence is a spurious retry, never a wrong
 *  verdict. Pure. */
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
  /(?:no module named|cannot find module|could not import|unable to resolve|cannot import name[^\S\r\n]+[^\n]*?\bfrom)[^\S\r\n]+['"]?([\w./-]+)['"]?/gi;

const pythonRules: LanguageRules = {
  indicators: [...LEGACY_INDICATORS],
  basenameGates: [...LEGACY_INDICATORS],
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
  indicators: [...LEGACY_INDICATORS],
  basenameGates: [...LEGACY_INDICATORS],
  naming: [LEGACY_NAMING],
  tiesByLeaf: true,
  shapes: [],
};

const GO_INDICATORS = [
  "no required module provides package",
  "cannot find module providing package",
  "cannot find package",
];

const goRules: LanguageRules = {
  indicators: [...GO_INDICATORS],
  basenameGates: [...GO_INDICATORS],
  naming: [
    /no required module provides package[^\S\r\n]+([\w./-]+)/gi,
    /cannot find module providing package[^\S\r\n]+([\w./-]+)/gi,
    /cannot find package[^\S\r\n]+["']?([\w./-]+)["']?/gi,
  ],
  tiesByLeaf: false,
  shapes: [{ match: goPackageImplicated }],
  // Both patterns are ANCHORED to the compiler's `file.go:LINE:COL:` gutter. Unanchored,
  // `undefined: Config` inside a test's own assertion message would fire the tier: ordinary program
  // text masquerading as a diagnostic, the same failure class the registry exists to prevent.
  // definesSymbol allows an optional receiver so methods (`func (r T) Help()`) tie, not just functions.
  symbolNaming: [
    /^[^\s:]+\.go:\d+:\d+:[^\S\r\n]+undefined:[^\S\r\n]+([\w.]+)/gim,
    /^[^\s:]+\.go:\d+:\d+:.*has no field or method[^\S\r\n]+(\w+)/gim,
  ],
  definesSymbol: (s) =>
    new RegExp(
      `\\b(?:func[^\\S\\r\\n]+(?:\\([^)]*\\)[^\\S\\r\\n]*)?|type[^\\S\\r\\n]+|var[^\\S\\r\\n]+|const[^\\S\\r\\n]+)${escapeSymbol(s)}\\b`,
    ),
};

const jvmRules: LanguageRules = {
  // Excerpt only. `cannot find symbol` is a documented residual: it names the symbol, never the file,
  // which is already deleted. It appears here so the retry message carries a real compiler line, and
  // it cannot cause a match because basenameGates is empty and no naming pattern consumes it.
  // `error: package` rather than a bare `does not exist`, which would let an unrelated later line win
  // the excerpt's last-match rule. Maven's reformatted `[ERROR] …:[3,26] package … does not exist`
  // (which drops javac's `error:` token) is carried by the second naming pattern below, NOT by an
  // indicator: a `] package ` indicator would let a trailing `[WARNING] [deprecation] package … does
  // not exist anymore` line displace the real error in the excerpt — the very displacement this
  // comment claims to avoid.
  indicators: ["error: package", "cannot find symbol"],
  basenameGates: [],
  naming: [
    /error:[^\S\r\n]+package[^\S\r\n]+([\w.]+)[^\S\r\n]+does not exist/gi,
    /:\[\d+,\d+\][^\S\r\n]+package[^\S\r\n]+([\w.]+)[^\S\r\n]+does not exist/gi,
  ],
  tiesByLeaf: false,
  shapes: [{ match: jvmPackageImplicated }],
  // `variable` and `method` are deliberately NOT captured: definesSymbol only recognises type
  // declarations, so capturing them could only ever produce a cross-kind mismatch (a `symbol:
  // method helper(int)` wrongly tying a file that declares `class helper`).
  symbolNaming: [/symbol:[^\S\r\n]+(?:class|interface|enum|record)[^\S\r\n]+([\w.]+)/gi],
  definesSymbol: (s) =>
    new RegExp(`\\b(?:class|interface|enum|record)[^\\S\\r\\n]+${escapeSymbol(s)}\\b`),
};

const rustRules: LanguageRules = {
  indicators: ["file not found for module", "unresolved import", "error[e0432]", "error[e0583]"],
  // Deliberately empty: rustc's E0583 help line names `src/<mod>.rs` and `src/<mod>/mod.rs` as
  // CANDIDATES to create. Gating the bounded-basename tier on it would implicate ANY discarded
  // `mod.rs` on ANY E0583, regardless of which module is missing.
  basenameGates: [],
  naming: [/file not found for module[^\S\r\n]+['"`]?(\w+)/gi],
  tiesByLeaf: true,
  shapes: [{ basename: "mod.rs", match: modMarkerImplicated }],
  // Anchored to rustc's `error[E…]:` code prefix, which it prints at column 0 on the primary diagnostic
  // line — the same structural gutter the Go patterns rely on. Unanchored, `cannot find "x"` inside a
  // test's own assertion prose fires the tier (ordinary English), the §2 failure class within one
  // language. The kind class stays loose (`[a-z, ]*?`) for rustc's compound kinds ("struct, variant or
  // union type"); the second pattern covers E0433 (`use of undeclared type`), what `Helper::new()` emits.
  symbolNaming: [
    /^error\[e\d+\]:[^\n]*?cannot find [a-z, ]*?['"`](\w+)['"`]/gim,
    /^error\[e\d+\]:[^\n]*?use of (?:undeclared|unresolved)[\w ]*?['"`](\w+)['"`]/gim,
  ],
  definesSymbol: (s) =>
    new RegExp(`\\b(?:fn|struct|enum|trait|const|static|type)[^\\S\\r\\n]+${escapeSymbol(s)}\\b`),
};

const RUBY_INDICATORS = ["cannot load such file", "loaderror"];

// RESIDUAL: `loaderror` is a broad basename gate — it appears in any rescued or logged LoadError, not
// only the boot-time require failure the naming pattern targets. Consequence is a spurious retry,
// never a wrong verdict.
const rubyRules: LanguageRules = {
  indicators: [...RUBY_INDICATORS],
  basenameGates: [...RUBY_INDICATORS],
  naming: [/cannot load such file --[^\S\r\n]+([\w./-]+)/gi],
  tiesByLeaf: true,
  shapes: [],
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
  definesSymbol: (s) => new RegExp(`\\b(?:class|module)[^\\S\\r\\n]+${escapeSymbol(s)}\\b`),
};

const PHP_INDICATORS = ["failed opening required", "failed to open stream"];

const phpRules: LanguageRules = {
  indicators: [...PHP_INDICATORS],
  basenameGates: [...PHP_INDICATORS],
  naming: [/failed opening required[^\S\r\n]+['"]?([\w./-]+)['"]?/gi],
  tiesByLeaf: true,
  shapes: [],
  // Require the `Error:` exception-class token immediately before `Class "…"`. It survives BOTH PHP
  // render paths: the CLI process-fatal `… Uncaught Error: Class "X" not found in path:line` and the
  // PHPUnit-caught form `Error: Class "X" not found` (location on a separate stack-trace line, since PHP 7
  // made class-not-found `Error`s catchable). Anchoring on the trailing `in <path>:<line>` location would
  // drop the PHPUnit-caught case. Rejects `Failed asserting that 'Class "Helper" not found'` — `Class` is
  // preceded by `'`, with no `Error:` token. Case-insensitive: PHP class names are.
  symbolNaming: [/Error:[^\S\r\n]+Class[^\S\r\n]+["']([\w\\]+)["'][^\S\r\n]+not found/gi],
  definesSymbol: (s) =>
    new RegExp(`\\b(?:class|interface|trait)[^\\S\\r\\n]+${escapeSymbol(s)}\\b`, "i"),
};

/** The per-language rule registry — THE extension point for the discard poison guard. Add new
 *  languages, new toolchain phrasings and per-language exceptions HERE, never to a shared list: a
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
