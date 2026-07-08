import { basename, dirname } from "node:path";

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
      return { runArgs: `${testFile}::${testName}`, precision: "precise" };
    case "jest":
      return { runArgs: `${testFile} -t '^${escapeRegex(testName)}$'`, precision: "anchored" };
    case "vitest":
      return { runArgs: `run ${testFile} -t '^${escapeRegex(testName)}$'`, precision: "anchored" };
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
      return { runArgs: `${testFile} -e '${testName}'`, precision: "file" };
    case "minitest":
      return { runArgs: `${testFile} -n '/^${escapeRegex(testName)}$/'`, precision: "file" };
    case "phpunit":
      return { runArgs: `--filter '/::${escapeRegex(testName)}$/' ${testFile}`, precision: "file" };
  }
}
