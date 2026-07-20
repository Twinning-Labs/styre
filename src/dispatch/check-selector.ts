import { basename, dirname } from "node:path";
import type { CommandResult } from "../util/run-command.ts";
import {
  CHECK_RULES,
  type MatchContext,
  moduleDotted,
  moduleLeaf,
  symbolLeaf,
} from "./check-rules.ts";

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

/** CONSERVATIVE discard-poison matcher (guards against a bad merge nobody notices). Given a run's raw
 *  output, the files THIS dispatch discarded, and the framework that produced the output, return the
 *  subset of discarded files the output implicates in an import/collection/module error — i.e. the
 *  check could not run *because* a file it references was discarded.
 *
 *  Rules are looked up per framework in CHECK_RULES so one language's phrasing can never fire on
 *  another's output. Four tiers per discarded file: (1) shape rules (directory- or marker-based, for
 *  files whose own name never appears); (2) the symbol tier, where the output names a symbol and a
 *  discarded file's captured contents define it (requires `sources`; silently inert without them); (3)
 *  the leaf tier, where a naming phrase names the file's module leaf — disabled for package-oriented
 *  languages; (4) the bounded-basename tier, gated on an indicator. A red whose error names some OTHER
 *  (e.g. feature) module is left untouched, so a test that legitimately fails because the feature is
 *  absent is never rejected. Pure. */
export function importErrorImplicatesDiscarded(
  rawOutput: string,
  discarded: string[],
  framework: CheckFramework | null,
  sources?: Map<string, string>,
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
    if (!hit && symbols.length > 0 && rules.definesSymbol !== undefined) {
      const content = sources?.get(d);
      if (content !== undefined) {
        const defines = rules.definesSymbol;
        if (symbols.some((s) => defines(s).test(content))) hit = true;
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
 *  where this language declares that preference; else the LAST indicator/fixture-pattern line (the
 *  first is often a re-raised error deep in a third-party traceback). Naming patterns are a strict
 *  FALLBACK, used only when no indicator or fixture-pattern line matched anywhere in the output — a
 *  trailing naming-only line (e.g. a package-manager summary that happens to name a path) must never
 *  displace a real indicator line that appeared earlier. The naming probes also include this
 *  language's `symbolNaming` patterns (a symbol-only red still needs a real compiler line in the
 *  excerpt; smoke cell A20 depends on this). Strips a leading pytest error gutter
 *  (`E   `) — `^E\s+` requires whitespace right after `E`, so it never eats an `ERROR …` summary
 *  line. `undefined` when nothing matches. Pure. */
export function collectionErrorExcerpt(
  rawOutput: string,
  framework: CheckFramework | null,
): string | undefined {
  if (framework === null) return undefined;
  const rules = CHECK_RULES[framework];
  // `.test()` on a /g regex advances lastIndex between calls, so strip `g` for these probes.
  const probes = [...rules.naming, ...(rules.symbolNaming ?? [])].map(
    (p) => new RegExp(p.source, p.flags.replace("g", "")),
  );
  let summary: string | undefined;
  let lastIndicator: string | undefined;
  let lastNaming: string | undefined;
  for (const line of rawOutput.split(/\r?\n/)) {
    const low = line.toLowerCase();
    const byIndicator =
      rules.indicators.some((k) => low.includes(k)) || (rules.fixturePattern?.test(line) ?? false);
    const byNaming = byIndicator ? false : probes.some((p) => p.test(line));
    if (!byIndicator && !byNaming) continue;
    if (byIndicator) lastIndicator = line;
    else lastNaming = line;
    // `byIndicator &&`: a naming-only line must never win via the summary path either, or it would
    // bypass the fallback ordering established two lines above.
    if (byIndicator && rules.prefersErrorSummary === true && /^\s*ERROR\b/.test(line))
      summary = line;
  }
  const chosen = (summary ?? lastIndicator ?? lastNaming)?.trim().replace(/^E\s+/, "");
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
