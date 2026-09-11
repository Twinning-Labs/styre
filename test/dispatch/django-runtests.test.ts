import { expect, test } from "bun:test";
import { capabilityCommandFor } from "../../src/dispatch/check-capability.ts";
import {
  binaryFor,
  buildCheckSelector,
  buildFileSelector,
  djangoLabel,
  frameworkFor,
  interpretRunOutput,
} from "../../src/dispatch/check-selector.ts";
import type { CommandResult } from "../../src/util/run-command.ts";

/**
 * ENG-427. Every expectation about run OUTPUT below was measured inside the official
 * `swebench/sweb.eval.x86_64.django_1776_django-12325` image, not inferred from documentation.
 * The literal strings are what django actually printed.
 */
const run = (over: Partial<CommandResult>): CommandResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});

test("a test file under tests/ becomes a dotted label relative to tests/", () => {
  expect(djangoLabel("tests/styre_checks/ENG-1_ac1_test.py")).toBe("styre_checks.ENG-1_ac1_test");
});

test("hyphens are LEFT ALONE — the real image loads them", () => {
  // `styre_checks.ENG-421_ac1_test` was verified to load and run in the django image. Rewriting
  // the name here would address a module that does not exist on disk.
  expect(djangoLabel("tests/styre_checks/ENG-421_ac1_test.py")).toContain("ENG-421_ac1_test");
});

test("a file outside tests/ keeps its full dotted path", () => {
  expect(djangoLabel("myapp/tests/test_x.py")).toBe("myapp.tests.test_x");
});

test("the selector is module-scoped at `file` precision, not a path", () => {
  const sel = buildCheckSelector("django-runtests", {
    testFile: "tests/styre_checks/ENG-1_ac1_test.py",
    testName: "test_thing",
  });
  expect(sel.runArgs).toContain("styre_checks.ENG-1_ac1_test");
  expect(sel.runArgs).not.toContain("/");
  // A unittest label is `module.Class.method`; the sidecar gives styre the method but never the
  // class, so the module is the honest scope. M2b's added-file identity makes it safe.
  expect(sel.precision).toBe("file");
});

test("the launcher runs from the repo root, single-process", () => {
  // Verified: `python ./tests/runtests.py --parallel 1 <label>` works from /testbed, and needs no
  // --settings (runtests defaults to test_sqlite).
  const b = binaryFor("django-runtests");
  expect(b).toContain("./tests/runtests.py");
  expect(b).toContain("--parallel 1");
  expect(b).not.toContain("--settings");
});

test("the capability probe uses --help: runtests has no --version", () => {
  expect(capabilityCommandFor("django-runtests", "python ./tests/runtests.py")).toBe(
    "python ./tests/runtests.py --help",
  );
});

// ── interpretRunOutput: the five measured cases ────────────────────────────────────────────

test("pass → green", () => {
  const out = run({ exitCode: 0, stdout: "Ran 1 test in 0.006s\n\nOK\n" });
  expect(interpretRunOutput("django-runtests", out)).toBe("green");
});

test("failure → red", () => {
  const out = run({ exitCode: 1, stdout: "Ran 1 test in 0.006s\n\nFAILED (failures=1)\n" });
  expect(interpretRunOutput("django-runtests", out)).toBe("red");
});

test("a module that matched but holds NO tests is selected-none, NOT green", () => {
  // THE FALSE-GREEN PATH. django exits **0** here. Reading the exit code alone records a check
  // that proved nothing as proof — exactly what the selects->=1 identity guard exists for.
  const out = run({ exitCode: 0, stdout: "Ran 0 tests in 0.000s\n\nOK\n" });
  expect(interpretRunOutput("django-runtests", out)).toBe("selected-none");
});

test("an unresolvable label is selected-none, NOT red", () => {
  // Exit 1, indistinguishable from a real failure by code. `unittest.loader._FailedTest` is what
  // separates them. A wrong selector is an identity reject to re-dispatch, not a failing test.
  const out = run({
    exitCode: 1,
    stdout:
      "ERROR: nope (unittest.loader._FailedTest)\nModuleNotFoundError: No module named 'styre_checks.nope'\nRan 1 test in 0.000s\n\nFAILED (errors=1)\n",
  });
  expect(interpretRunOutput("django-runtests", out)).toBe("selected-none");
});

test("an unknown METHOD on a real class is also selected-none", () => {
  const out = run({
    exitCode: 1,
    stdout:
      "ERROR: test_missing (unittest.loader._FailedTest)\nRan 1 test in 0.000s\n\nFAILED (errors=1)\n",
  });
  expect(interpretRunOutput("django-runtests", out)).toBe("selected-none");
});

test("a GENUINE import error inside a test is red, not selected-none", () => {
  // The discrimination that makes the rule above safe: a real in-test ImportError produces no
  // `_FailedTest` marker. Measured — this is a legitimate RED and must gate.
  const out = run({
    exitCode: 1,
    stdout:
      "ERROR: test_x (styre_checks.inner_test.C)\nModuleNotFoundError: No module named 'nonexistent_pkg'\nRan 1 test in 0.001s\n\nFAILED (errors=1)\n",
  });
  expect(interpretRunOutput("django-runtests", out)).toBe("red");
});

test("a timeout is error, never a verdict", () => {
  expect(interpretRunOutput("django-runtests", run({ exitCode: null, timedOut: true }))).toBe(
    "error",
  );
});

test("buildFileSelector is module-scoped too (binding proof runs the whole file)", () => {
  expect(buildFileSelector("django-runtests", "tests/styre_checks/x_test.py")).toContain(
    "styre_checks.x_test",
  );
});

test("frameworkFor prefers the resolved testAction over the pytest assumption", () => {
  const django = {
    kind: "python",
    commands: { test: "tox" },
    testAction: { framework: "django-runtests" as const, launcher: "python ./tests/runtests.py" },
  };
  expect(frameworkFor(django)).toBe("django-runtests");
  // And a python component WITHOUT one still infers pytest — the ~30% of the corpus that runs it.
  expect(frameworkFor({ kind: "python", commands: { test: "pytest" } })).toBe("pytest");
});
