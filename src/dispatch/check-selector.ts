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
