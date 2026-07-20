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
   *  pattern leaked across languages (Rails emits `fixture 'users' not found`). Used with `.test()`
   *  on a single line, so it must NOT carry the `g` flag — a global regex's `lastIndex` state would
   *  make `.test()` results alternate between calls (true, false, true, false, ...) across lines. */
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

/** No rules — a deliberate, TEMPORARY narrowing, not parity with before ENG-343. The old matcher was
 *  framework-blind, so the legacy Python/Node vocabulary incidentally fired on these stacks too
 *  (`go: cannot find module providing package …` hit the legacy `cannot find module` indicator).
 *  Replaced per language with real rules, which restore that coverage more precisely. */
const noRules: LanguageRules = {
  indicators: [],
  basenameGates: [],
  naming: [],
  tiesByLeaf: false,
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
  cargo: noRules,
  "junit-maven": jvmRules,
  "junit-gradle": jvmRules,
  rspec: noRules,
  minitest: noRules,
  phpunit: noRules,
};
