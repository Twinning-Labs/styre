import { basename, dirname } from "node:path";
import type { CommandResult } from "../util/run-command.ts";

/** A concrete test framework the selector constructor + coarse run-output reader understand.
 *  Derived from a profile component's `kind` and its `test` command string. */
export type CheckFramework =
  | "pytest"
  | "jest"
  | "vitest"
  | "go"
  | "cargo"
  | "junit-maven"
  | "junit-gradle"
  | "rspec"
  | "minitest"
  | "phpunit";

/** How a check's selector is scoped (observability + risk-tier only). `precise` = an exact node/
 *  method id; `anchored` = file/package scope + an anchored name; `package` = package/crate scope +
 *  anchored name (Go/Rust — no file-level run, §5.2); `file` = the styre-authored file is the scope
 *  (safe because M2b's added-file identity guarantees it holds only this check) + a name filter. */
export type SelectorPrecision = "precise" | "anchored" | "package" | "file";

/** The coarse RED-first bucket recorded in `ac_check.red_first_result` (§5.4). */
export type CoarseResult = "green" | "red" | "error";

/** `interpretRunOutput`'s result: a coarse bucket, OR `selected-none` — the framework ran but
 *  matched ZERO tests (the "selects-≥1" identity guard, §5.1). `selected-none` is NOT a verdict;
 *  M2b treats it as a transport/identity reject (re-dispatch). */
export type CoarseOrNone = CoarseResult | "selected-none";

/** The `test` command string configured for a component, if any (mirrors `commandFor` without a
 *  Component import — this module stays dependency-light and unit-testable on plain objects). */
function testCommandOf(component: { commands: Record<string, unknown> }): string {
  const v = component.commands.test;
  return typeof v === "string" ? v : "";
}

/** Detect the test framework for a component from its `kind` and `test` command. Returns `null`
 *  when it cannot be determined (unknown kind, or a node/ruby command that names no framework) —
 *  M2b records such a check as coarse `error` rather than guessing. */
export function frameworkFor(component: {
  kind: string;
  commands: Record<string, unknown>;
}): CheckFramework | null {
  const cmd = testCommandOf(component);
  switch (component.kind) {
    case "python":
      return "pytest"; // pytest is styre's python assumption (tox/nox wrap it)
    case "node":
    case "sveltekit":
      if (/\bvitest\b/.test(cmd)) return "vitest";
      if (/\bjest\b/.test(cmd)) return "jest";
      return null; // e.g. bare `npm test` — framework unknown
    case "go":
      return "go";
    case "rust":
      return "cargo";
    case "jvm-maven":
      return "junit-maven";
    case "jvm-gradle":
      return "junit-gradle";
    case "ruby":
      if (/\brspec\b/.test(cmd)) return "rspec";
      if (/\b(minitest|rake test|rails test)\b/.test(cmd)) return "minitest";
      return null;
    case "php":
      return "phpunit";
    default:
      return null;
  }
}

export interface CheckSelector {
  runArgs: string;
  precision: SelectorPrecision;
}

/** Escape regex metacharacters so a plain test NAME can be anchored inside `^…$` (jest -t / go -run
 *  / minitest -n all take a regex). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The class name for a JVM/PHP test = the file's basename without extension (styre authors one
 *  public test class per file, named after the file). */
function classFromFile(testFile: string): string {
  return basename(testFile).replace(/\.[^.]+$/, "");
}

/** Wrap a string as one shell-safe single-quoted argument (POSIX): `'` → `'\''`. runArgs are run
 *  via `sh -c`, and free-form test names (jest/vitest/rspec titles, pytest parametrized ids) can
 *  contain quotes/spaces that would otherwise break the command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Construct the framework-native selection args that run ONLY the one authored check (§5.2). The
 *  returned `runArgs` are appended to the framework binary by M2b; `precision` records the scoping
 *  tier (precise > anchored > package > file). For file-addressable frameworks the styre-authored
 *  file is itself the scope (M2b's added-file identity guarantees it holds only this check); Go/Rust
 *  have no file-level run, so they scope to the package/crate + an anchored/exact name. */
export function buildCheckSelector(
  fw: CheckFramework,
  p: { testFile: string; testName: string },
): CheckSelector {
  const { testFile, testName } = p;
  switch (fw) {
    case "pytest":
      return { runArgs: shq(`${testFile}::${testName}`), precision: "precise" };
    case "jest":
      return {
        runArgs: `${testFile} -t ${shq(`^${escapeRegex(testName)}$`)}`,
        precision: "anchored",
      };
    case "vitest":
      return {
        runArgs: `run ${testFile} -t ${shq(`^${escapeRegex(testName)}$`)}`,
        precision: "anchored",
      };
    case "go":
      return {
        runArgs: `-run '^${escapeRegex(testName)}$' ./${dirname(testFile)}`,
        precision: "package",
      };
    case "cargo":
      // One-file-one-crate integration test (§5.2 Rust mandate): `--test <stem>` selects the crate,
      // `<name> -- --exact` the single test function.
      return {
        runArgs: `--test ${classFromFile(testFile)} ${testName} -- --exact`,
        precision: "package",
      };
    case "junit-maven":
      return {
        runArgs: `-Dtest=${classFromFile(testFile)}#${testName} test`,
        precision: "precise",
      };
    case "junit-gradle":
      return {
        runArgs: `test --tests '${classFromFile(testFile)}.${testName}'`,
        precision: "precise",
      };
    case "rspec":
      // rspec -e is a substring match; the styre-authored file is the real scope (safe by identity).
      return { runArgs: `${testFile} -e ${shq(testName)}`, precision: "file" };
    case "minitest":
      return { runArgs: `${testFile} -n '/^${escapeRegex(testName)}$/'`, precision: "file" };
    case "phpunit":
      return { runArgs: `--filter '/::${escapeRegex(testName)}$/' ${testFile}`, precision: "file" };
  }
}

/** A completed framework run — aliased to the shared CommandResult (`src/util/run-command.ts`) so
 *  M2b's `runCommand` result flows in directly and the two shapes can never drift. */
export type RunOutcome = CommandResult;

/** True iff the combined output contains any of `needles` (case-insensitive, substring). */
function outputHas(run: RunOutcome, ...needles: string[]): boolean {
  const hay = `${run.stdout}\n${run.stderr}`.toLowerCase();
  return needles.some((n) => hay.includes(n.toLowerCase()));
}

/** True iff the combined output matches `re` — used for count phrases that need a word boundary so
 *  "10 examples" / "10 runs" does not false-match a "0 examples" / "0 runs" substring. */
function outputMatches(run: RunOutcome, re: RegExp): boolean {
  return re.test(`${run.stdout}\n${run.stderr}`);
}

/** Read a COMPLETED framework run into a coarse bucket (§5.4), or `selected-none` when the framework
 *  ran but matched ZERO tests (the selects-≥1 identity guard, §5.1). Ground truth: decides purely on
 *  the process's exit state + recognizable no-match/compile phrases — never the agent's word. A
 *  timeout or a failure to launch (null exit / shell 127) is `error` for every framework. The per-
 *  framework detail is deliberately coarse; M3 subdivides `red` (assertion vs absence vs env) from
 *  the raw output stored in `ground_truth_signal.detail_json`. */
export function interpretRunOutput(fw: CheckFramework, run: RunOutcome): CoarseOrNone {
  if (run.timedOut || run.exitCode === null) return "error";
  const code = run.exitCode;
  if (code === 127) return "error"; // command not found → couldn't attempt

  switch (fw) {
    case "pytest":
      if (code === 0) return "green";
      if (code === 5) return "selected-none"; // pytest: no tests collected
      if (code === 1 || code === 2) return "red"; // 1=failures, 2=collection/import error (absence)
      return "error"; // 3=internal, 4=usage, etc.
    case "jest":
    case "vitest":
      // TODO(M3): confirm vitest loaded-but-no-match phrasing
      // "no tests found" = no file matched. "tests: 0 total" / "no tests ran" = the file loaded but
      // the anchored -t name matched ZERO tests (jest matches the CONCATENATED describe+it title, so
      // `^name$` can miss a nested test) — exits 0 with no "not found" phrase. Both are selects-none,
      // regardless of exit code. This closes the §5.1 false-green the file-substring check can't see.
      if (
        outputHas(run, "no tests found", "no test files found") ||
        outputMatches(run, /tests:\s*0 total/i) ||
        outputMatches(run, /no tests? ran/i)
      ) {
        return "selected-none";
      }
      return code === 0 ? "green" : "red";
    case "go":
      if (outputHas(run, "no tests to run")) return "selected-none";
      if (code === 0) return "green";
      return code === 1 || code === 2 ? "red" : "error"; // 1=FAIL, 2=build error (absence)
    case "cargo":
      if (outputHas(run, "running 0 tests")) return "selected-none";
      if (code === 0) return "green";
      return code === 101 ? "red" : "error"; // 101=test failure OR compile error
    case "junit-maven":
      if (outputHas(run, "no tests were executed", "there are no tests to run"))
        return "selected-none";
      return code === 0 ? "green" : "red";
    case "junit-gradle":
      if (outputHas(run, "no tests found for given includes")) return "selected-none";
      return code === 0 ? "green" : "red";
    case "rspec":
      if (outputMatches(run, /\b0 examples/i)) return "selected-none"; // \b so "10 examples" ≠ match
      return code === 0 ? "green" : "red";
    case "minitest":
      if (outputMatches(run, /\b0 runs/i)) return "selected-none"; // \b so "10 runs" ≠ match
      return code === 0 ? "green" : "red";
    case "phpunit":
      if (outputHas(run, "no tests executed", "no tests found")) return "selected-none";
      return code === 0 ? "green" : "red";
  }
}

/** Source-file extensions we strip when reducing a path/module reference to its leaf module name. A
 *  reference whose final dotted segment is one of these is a filename (extension), not a dotted-module
 *  leaf. */
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

/** The leaf module identifier for a path OR a dotted/slashed module reference, lower-cased for
 *  case-insensitive comparison. Takes the last path segment, drops a trailing source extension, then
 *  takes the last remaining dotted segment: `checks/helper.py`→`helper`, `pkg.helper`→`helper`,
 *  `./a/helper.js`→`helper`, `util`→`util`. Pure. */
function moduleLeaf(ref: string): string {
  const seg = ref.split(/[\\/]/).pop() ?? ref; // last path segment
  const parts = seg.split(".").filter((s) => s.length > 0);
  if (parts.length === 0) return seg.toLowerCase();
  if (parts.length >= 2 && SOURCE_EXTS.has((parts[parts.length - 1] ?? "").toLowerCase())) {
    parts.pop(); // strip a file extension (a real dotted module leaf is never a known ext)
  }
  return (parts[parts.length - 1] ?? seg).toLowerCase();
}

/** Import/collection/module-error indicator phrases (lower-cased substrings). Their PRESENCE gates the
 *  filename-in-traceback rule; the leaf-name rule additionally requires the module identifier to sit
 *  adjacent to one of the naming phrases below.
 *
 *  FRAMEWORK BOUNDARY (documented residual — ENG-343): this vocabulary covers Python
 *  (ModuleNotFoundError/ImportError/No module named) and Node (Cannot find module) only. On Go/Rust/JVM/
 *  Ruby/PHP a discarded imported file produces a compile/collection error whose phrasing is NOT listed
 *  here, so the discard-poison guard does not fire and the same silent-bad-merge (poisoned red →
 *  environmental → non-gating advisory) remains open on those stacks. Extending this list to the other
 *  supported frameworks is tracked in ENG-343. */
const IMPORT_ERROR_INDICATORS = [
  "modulenotfounderror",
  "importerror",
  "no module named",
  "cannot find module",
  "cannot import name",
  "error collecting",
  "errors during collection",
  "import file mismatch", // pytest prepend-import-mode mismatch (a moved/removed package marker)
  "error importing test module",
];

/** pytest's fixture-not-found line (a discarded `conftest.py` that provided the fixture). Kept out of
 *  IMPORT_ERROR_INDICATORS so the generic basename tier stays precise; used only by the conftest tier
 *  and by collectionErrorExcerpt. */
const FIXTURE_NOT_FOUND = /fixture ['"]?[\w.-]+['"]? not found/i;

/** An import/module-error phrase followed by the module identifier it names. The capture group is the
 *  identifier (a bare `helper`, a dotted `pkg.helper`, or a `./path/helper` for Node). Global +
 *  case-insensitive; a fresh instance is constructed per call so lastIndex never leaks. */
const IMPORT_ERROR_NAMING = String.raw`(?:no module named|cannot find module|could not import|unable to resolve|cannot import name\s+[^\n]*?\bfrom)\s+['"]?([\w./-]+)['"]?`;

/** A dotted, lower-cased module reference from a "No module named 'X'" capture: slashes → dots,
 *  trimmed of leading/trailing dots. `a/b` → `a.b`, `Pkg.Sub` → `pkg.sub`. Pure. */
function moduleDotted(ref: string): string {
  return ref
    .replace(/[\\/]/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

/** True iff `a`'s segments are the trailing segments of `b` (a is a suffix of b). */
function isSegSuffix(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length > b.length) return false;
  const off = b.length - a.length;
  return a.every((s, i) => s === b[off + i]);
}

/** True iff `long` starts with every segment of `short` (short is a leading prefix of long). */
function isSegPrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  return short.every((s, i) => s === long[i]);
}

/** CONSERVATIVE match tying a discarded `__init__.py` to a missing-module error (option A). Derive the
 *  package from the file's DIRECTORY, then implicate iff some named module M: (1) equals the full dotted
 *  dir; (2) strictly extends it as a prefix (a submodule import); or (3) is a >=2-segment trailing suffix
 *  of the dir (absorbs a `src/` or component prefix). A bare single-segment interior name (e.g. `b` for
 *  `a/b/__init__.py`) never matches — that is the no-false-reject guarantee. Residuals (documented, not
 *  closed): a single-segment error against a deeper dir (`pkg` vs `src/pkg/__init__.py`); PEP 420
 *  namespace packages; a deep submodule with a dir prefix. Pure. */
function packageInitImplicated(initPath: string, namedModules: string[]): boolean {
  const dirSegs = initPath
    .split("/")
    .slice(0, -1)
    .filter((s) => s.length > 0);
  if (dirSegs.length === 0) return false;
  for (const mod of namedModules) {
    const modSegs = mod.split(".").filter((s) => s.length > 0);
    if (modSegs.length === 0) continue;
    if (modSegs.length === dirSegs.length && isSegPrefix(modSegs, dirSegs)) return true; // (1) exact
    if (modSegs.length > dirSegs.length && isSegPrefix(dirSegs, modSegs)) return true; // (2) submodule
    if (modSegs.length >= 2 && isSegSuffix(modSegs, dirSegs)) return true; // (3) prefixed dir
  }
  return false;
}

/** CONSERVATIVE discard-poison matcher (silent-bad-merge guard). Given a framework's raw run output and
 *  the files THIS dispatch discarded (undeclared new files stripped before commit), return the subset of
 *  discarded files that the output implicates in an import/collection/module error — i.e. the check could
 *  not run *because* a file it references was discarded. Never fires on a bare basename appearing
 *  incidentally: a discarded file is implicated only when (1) an import/module-error phrase NAMES its
 *  module leaf, or (2) an import-error indicator is present AND the file's exact basename-with-extension
 *  appears as a bounded token (a traceback/collection line). A red whose import error names some OTHER
 *  (e.g. feature) module is left untouched, so a legitimate fail-first test is never rejected. Pure. */
export function importErrorImplicatesDiscarded(rawOutput: string, discarded: string[]): string[] {
  if (discarded.length === 0 || rawOutput.trim() === "") return [];
  const hay = rawOutput.toLowerCase();
  const hasIndicator = IMPORT_ERROR_INDICATORS.some((k) => hay.includes(k));
  const hasFixtureError = FIXTURE_NOT_FOUND.test(rawOutput);

  // module identifiers named by an import/module-error phrase: leaf-reduced (existing tier) AND raw
  // dotted (new package-init tier — the prefix/suffix test is meaningless on a leaf-reduced name).
  const named = new Set<string>();
  const namedModules: string[] = [];
  const re = new RegExp(IMPORT_ERROR_NAMING, "gi");
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical exec-loop over a /g regex.
  while ((m = re.exec(rawOutput)) !== null) {
    if (m[1]) {
      named.add(moduleLeaf(m[1]));
      namedModules.push(moduleDotted(m[1]));
    }
  }

  const matched: string[] = [];
  for (const d of discarded) {
    const base = d.split(/[\\/]/).pop() ?? d;

    // (A) support-file shapes (Python): a marker/fixture whose ABSENCE names the package/fixture, not
    // the file — the exact blind spot the general tiers below miss.
    if (base === "__init__.py" && packageInitImplicated(d, namedModules)) {
      matched.push(d);
      continue;
    }
    if (base === "conftest.py" && (hasIndicator || hasFixtureError)) {
      matched.push(d);
      continue;
    }

    // (B) general tiers (unchanged): the error NAMES the discarded file's module leaf, or its exact
    // basename appears as a bounded token while an import indicator is present.
    const leaf = moduleLeaf(d);
    if (leaf !== "" && named.has(leaf)) {
      matched.push(d);
      continue;
    }
    if (hasIndicator && base.includes(".")) {
      const bounded = new RegExp(`(?:^|[\\s"'\`/(])${escapeRegex(base)}(?:[\\s"'\`:)]|$)`, "im");
      if (bounded.test(rawOutput)) matched.push(d);
    }
  }
  return matched;
}

/** The one line that states a collection/import/fixture cause, in original casing, ≤200 chars. Prefers
 *  pytest's short-test-summary line (`ERROR path - Cause`, printed last and authoritative); else the
 *  LAST matching line (the first is often a re-raised error deep in a third-party traceback). Strips a
 *  leading pytest error gutter (`E   `) so the cause reads cleanly — `^E\s+` requires whitespace right
 *  after `E`, so it never eats an `ERROR …` summary line (whose next char is `R`). `undefined` when the
 *  output carries no collection/import/fixture indicator. Pure. */
export function collectionErrorExcerpt(rawOutput: string): string | undefined {
  let summary: string | undefined;
  let lastMatch: string | undefined;
  for (const line of rawOutput.split(/\r?\n/)) {
    const low = line.toLowerCase();
    const isMatch =
      IMPORT_ERROR_INDICATORS.some((k) => low.includes(k)) || FIXTURE_NOT_FOUND.test(line);
    if (!isMatch) continue;
    lastMatch = line;
    if (/^\s*ERROR\b/.test(line)) summary = line;
  }
  const chosen = (summary ?? lastMatch)?.trim().replace(/^E\s+/, "");
  if (chosen === undefined || chosen === "") return undefined;
  return chosen.length > 200 ? `${chosen.slice(0, 197)}...` : chosen;
}

/** Map a coarse `ac_check.red_first_result` bucket to the `ground_truth_signal.result` vocabulary
 *  (§9): the two tables' CHECK constraints differ (`ac_check` allows `red`; `ground_truth_signal`
 *  does not), so `green→pass, red→fail, error→error`. This is the ONLY place the map lives. */
export function signalResultForCoarse(coarse: CoarseResult): "pass" | "fail" | "error" {
  return coarse === "green" ? "pass" : coarse === "red" ? "fail" : "error";
}

/** The framework binary the runner prepends to `buildCheckSelector`'s `runArgs` (M2a decision 3). The
 *  go/cargo binaries carry the `test` subcommand (their runArgs omit it → `go test -run … ./pkg`);
 *  maven/gradle/vitest carry their goal/task/`run` IN the runArgs, so their binary is bare. pytest
 *  uses the resolved interpreter (`resolvePythonInterpreter`) so it runs against the provisioned env,
 *  not a bare `pytest` that may be absent. */
export function binaryFor(fw: CheckFramework, opts?: { interp?: string }): string {
  switch (fw) {
    case "pytest":
      return `${opts?.interp ?? "python3"} -m pytest`;
    case "jest":
      return "jest";
    case "vitest":
      return "vitest";
    case "go":
      return "go test";
    case "cargo":
      return "cargo test";
    case "junit-maven":
      return "mvn";
    case "junit-gradle":
      return "gradle";
    case "rspec":
      return "rspec";
    case "minitest":
      return "ruby -Itest";
    case "phpunit":
      return "phpunit";
  }
}
