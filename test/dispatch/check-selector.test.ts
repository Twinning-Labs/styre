import { describe, expect, test } from "bun:test";
import { CHECK_RULES } from "../../src/dispatch/check-rules.ts";
import { frameworkFor } from "../../src/dispatch/check-selector.ts";

const comp = (kind: string, test?: string) => ({
  kind,
  commands: test === undefined ? {} : { test },
});

describe("frameworkFor", () => {
  test("python → pytest (the assumed python runner, incl. tox-wrapped)", () => {
    expect(frameworkFor(comp("python", "pytest -q"))).toBe("pytest");
    expect(frameworkFor(comp("python", "tox -e py311"))).toBe("pytest");
    expect(frameworkFor(comp("python"))).toBe("pytest");
  });

  test("node/sveltekit → jest or vitest by the command; null when ambiguous", () => {
    expect(frameworkFor(comp("node", "jest"))).toBe("jest");
    expect(frameworkFor(comp("node", "vitest run"))).toBe("vitest");
    expect(frameworkFor(comp("sveltekit", "vitest"))).toBe("vitest");
    expect(frameworkFor(comp("node", "npm test"))).toBeNull(); // no framework named
  });

  test("go → go, rust → cargo", () => {
    expect(frameworkFor(comp("go", "go test ./..."))).toBe("go");
    expect(frameworkFor(comp("rust", "cargo test"))).toBe("cargo");
  });

  test("jvm-maven → junit-maven, jvm-gradle → junit-gradle", () => {
    expect(frameworkFor(comp("jvm-maven", "mvn test"))).toBe("junit-maven");
    expect(frameworkFor(comp("jvm-gradle", "gradle test"))).toBe("junit-gradle");
  });

  test("ruby → rspec or minitest by the command; php → phpunit", () => {
    expect(frameworkFor(comp("ruby", "bundle exec rspec"))).toBe("rspec");
    expect(frameworkFor(comp("ruby", "rake test"))).toBe("minitest");
    expect(frameworkFor(comp("ruby", "bin/rails test"))).toBe("minitest");
    expect(frameworkFor(comp("ruby", "bundle exec ruby"))).toBeNull();
    expect(frameworkFor(comp("php", "phpunit"))).toBe("phpunit");
  });

  test("unknown/custom kind → null", () => {
    expect(frameworkFor(comp("app", "bun test"))).toBeNull();
    expect(frameworkFor(comp("elixir", "mix test"))).toBeNull();
  });
});

import { buildCheckSelector } from "../../src/dispatch/check-selector.ts";

describe("buildCheckSelector", () => {
  test("pytest → an exact node id (precise), shell-quoted", () => {
    expect(
      buildCheckSelector("pytest", { testFile: "tests/test_api.py", testName: "test_ok" }),
    ).toEqual({
      runArgs: "'tests/test_api.py::test_ok'",
      precision: "precise",
    });
  });

  test("jest/vitest → file scope + an anchored -t name (regex-escaped)", () => {
    expect(
      buildCheckSelector("jest", { testFile: "src/a.test.ts", testName: "returns 200" }),
    ).toEqual({
      runArgs: "src/a.test.ts -t '^returns 200$'",
      precision: "anchored",
    });
    expect(buildCheckSelector("vitest", { testFile: "src/a.test.ts", testName: "a.b" })).toEqual({
      runArgs: "run src/a.test.ts -t '^a\\.b$'",
      precision: "anchored",
    });
  });

  test("go → package (dir) scope + anchored -run (no file-level run, §5.2)", () => {
    expect(
      buildCheckSelector("go", { testFile: "pkg/api/api_test.go", testName: "TestOK" }),
    ).toEqual({
      runArgs: "-run '^TestOK$' ./pkg/api",
      precision: "package",
    });
  });

  test("cargo → crate + exact name via the file stem as the integration test (§5.2 one-file-one-crate)", () => {
    expect(
      buildCheckSelector("cargo", { testFile: "tests/api.rs", testName: "returns_ok" }),
    ).toEqual({
      runArgs: "--test api returns_ok -- --exact",
      precision: "package",
    });
  });

  test("junit maven/gradle → Class#method from the file stem (precise)", () => {
    expect(
      buildCheckSelector("junit-maven", { testFile: "src/test/java/ApiTest.java", testName: "ok" }),
    ).toEqual({
      runArgs: "-Dtest=ApiTest#ok test",
      precision: "precise",
    });
    expect(
      buildCheckSelector("junit-gradle", {
        testFile: "src/test/java/ApiTest.java",
        testName: "ok",
      }),
    ).toEqual({
      runArgs: "test --tests 'ApiTest.ok'",
      precision: "precise",
    });
  });

  test("rspec/minitest/phpunit → file scope (styre's own file) + a name filter", () => {
    expect(
      buildCheckSelector("rspec", { testFile: "spec/api_spec.rb", testName: "is ok" }),
    ).toEqual({
      runArgs: "spec/api_spec.rb -e 'is ok'",
      precision: "file",
    });
    expect(
      buildCheckSelector("minitest", { testFile: "test/api_test.rb", testName: "test_ok" }),
    ).toEqual({
      runArgs: "test/api_test.rb -n '/^test_ok$/'",
      precision: "file",
    });
    expect(
      buildCheckSelector("phpunit", { testFile: "tests/ApiTest.php", testName: "testOk" }),
    ).toEqual({
      runArgs: "--filter '/::testOk$/' tests/ApiTest.php",
      precision: "file",
    });
  });

  test("free-form test names with an apostrophe are shell-safely escaped (sh -c breakage otherwise)", () => {
    expect(
      buildCheckSelector("rspec", {
        testFile: "spec/a_spec.rb",
        testName: "works when it's valid",
      }),
    ).toEqual({
      runArgs: "spec/a_spec.rb -e 'works when it'\\''s valid'",
      precision: "file",
    });
    expect(buildCheckSelector("jest", { testFile: "a.test.ts", testName: "it's ok" }).runArgs).toBe(
      "a.test.ts -t '^it'\\''s ok$'",
    );
    expect(
      buildCheckSelector("vitest", { testFile: "a.test.ts", testName: "it's ok" }).runArgs,
    ).toBe("run a.test.ts -t '^it'\\''s ok$'");
    expect(
      buildCheckSelector("pytest", {
        testFile: "tests/test_api.py",
        testName: "test_it's_ok",
      }).runArgs,
    ).toBe("'tests/test_api.py::test_it'\\''s_ok'");
  });
});

import { interpretRunOutput, signalResultForCoarse } from "../../src/dispatch/check-selector.ts";

const run = (
  o: Partial<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>,
) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...o,
});

describe("interpretRunOutput", () => {
  test("a timeout or a failure to launch is always error (couldn't attempt)", () => {
    expect(interpretRunOutput("pytest", run({ timedOut: true, exitCode: null }))).toBe("error");
    expect(interpretRunOutput("go", run({ exitCode: null }))).toBe("error");
    expect(
      interpretRunOutput("jest", run({ exitCode: 127, stderr: "jest: command not found" })),
    ).toBe("error");
  });

  test("pytest: 0=green, 1=red (assertion), 2=red (collection/import), 5=selected-none", () => {
    expect(interpretRunOutput("pytest", run({ exitCode: 0 }))).toBe("green");
    expect(interpretRunOutput("pytest", run({ exitCode: 1 }))).toBe("red");
    expect(
      interpretRunOutput("pytest", run({ exitCode: 2, stdout: "errors during collection" })),
    ).toBe("red");
    expect(interpretRunOutput("pytest", run({ exitCode: 5 }))).toBe("selected-none");
  });

  test("jest/vitest: green, red on failure/import error, selected-none on no-match", () => {
    expect(interpretRunOutput("jest", run({ exitCode: 0 }))).toBe("green");
    expect(
      interpretRunOutput(
        "jest",
        run({ exitCode: 0, stderr: "No tests found, exiting with code 0" }),
      ),
    ).toBe("selected-none");
    // file loaded but the anchored -t matched zero tests (nested describe) → exit 0, "0 total"
    expect(interpretRunOutput("jest", run({ exitCode: 0, stdout: "Tests:       0 total" }))).toBe(
      "selected-none",
    );
    expect(
      interpretRunOutput("jest", run({ exitCode: 1, stderr: "Cannot find module '../prefs'" })),
    ).toBe("red");
    expect(interpretRunOutput("jest", run({ exitCode: 1, stdout: "1 failed" }))).toBe("red");
    expect(interpretRunOutput("vitest", run({ exitCode: 1, stderr: "No test files found" }))).toBe(
      "selected-none",
    );
  });

  test("go: green, red on FAIL or build error, selected-none on no tests to run", () => {
    expect(interpretRunOutput("go", run({ exitCode: 0, stdout: "ok  pkg/api  0.01s" }))).toBe(
      "green",
    );
    expect(
      interpretRunOutput("go", run({ exitCode: 0, stdout: "testing: warning: no tests to run" })),
    ).toBe("selected-none");
    expect(interpretRunOutput("go", run({ exitCode: 1, stdout: "--- FAIL: TestOK" }))).toBe("red");
    expect(interpretRunOutput("go", run({ exitCode: 2, stderr: "undefined: Prefs" }))).toBe("red");
  });

  test("cargo: green, red on failure/compile error, selected-none on 0 tests", () => {
    expect(
      interpretRunOutput("cargo", run({ exitCode: 0, stdout: "test result: ok. 1 passed" })),
    ).toBe("green");
    expect(interpretRunOutput("cargo", run({ exitCode: 0, stdout: "running 0 tests" }))).toBe(
      "selected-none",
    );
    expect(interpretRunOutput("cargo", run({ exitCode: 101, stdout: "test result: FAILED" }))).toBe(
      "red",
    );
  });

  test("junit maven/gradle: selected-none on no-match, red on failure/compile", () => {
    expect(interpretRunOutput("junit-maven", run({ exitCode: 0 }))).toBe("green");
    expect(
      interpretRunOutput("junit-maven", run({ exitCode: 1, stdout: "No tests were executed!" })),
    ).toBe("selected-none");
    expect(
      interpretRunOutput("junit-maven", run({ exitCode: 1, stdout: "COMPILATION ERROR" })),
    ).toBe("red");
    expect(
      interpretRunOutput(
        "junit-gradle",
        run({ exitCode: 1, stderr: "No tests found for given includes" }),
      ),
    ).toBe("selected-none");
    expect(interpretRunOutput("junit-gradle", run({ exitCode: 1, stdout: "Tests FAILED" }))).toBe(
      "red",
    );
  });

  test("rspec/minitest/phpunit: green, selected-none on 0 examples, red otherwise", () => {
    expect(interpretRunOutput("rspec", run({ exitCode: 0, stdout: "1 example, 0 failures" }))).toBe(
      "green",
    );
    expect(
      interpretRunOutput("rspec", run({ exitCode: 0, stdout: "0 examples, 0 failures" })),
    ).toBe("selected-none");
    expect(
      interpretRunOutput("rspec", run({ exitCode: 1, stdout: "10 examples, 1 failure" })),
    ).toBe("red"); // \b: not selected-none
    expect(interpretRunOutput("rspec", run({ exitCode: 1, stdout: "1 example, 1 failure" }))).toBe(
      "red",
    );
    expect(
      interpretRunOutput("minitest", run({ exitCode: 0, stdout: "0 runs, 0 assertions" })),
    ).toBe("selected-none");
    expect(interpretRunOutput("phpunit", run({ exitCode: 0, stdout: "No tests executed!" }))).toBe(
      "selected-none",
    );
    expect(interpretRunOutput("phpunit", run({ exitCode: 2, stdout: "Error" }))).toBe("red");
  });
});

describe("signalResultForCoarse", () => {
  test("maps the coarse bucket to the ground_truth_signal vocabulary (§9)", () => {
    expect(signalResultForCoarse("green")).toBe("pass");
    expect(signalResultForCoarse("red")).toBe("fail");
    expect(signalResultForCoarse("error")).toBe("error");
  });
});

import {
  collectionErrorExcerpt,
  importErrorImplicatesDiscarded,
} from "../../src/dispatch/check-selector.ts";

describe("importErrorImplicatesDiscarded (discard-poison guard: conservative import-error → discarded-file matcher)", () => {
  test("fires on `No module named '<discarded-mod>'` (pytest exit-2 collection error)", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'helper'",
        ["checks/helper.py"],
        "pytest",
      ),
    ).toEqual(["checks/helper.py"]);
    // bare `No module named 'util'` with the discarded file at a nested path (basename → module leaf)
    expect(
      importErrorImplicatesDiscarded(
        "E   ModuleNotFoundError: No module named 'util'",
        ["tests/support/util.py"],
        "pytest",
      ),
    ).toEqual(["tests/support/util.py"]);
  });

  test("fires on a dotted python module whose LEAF is a discarded file", () => {
    expect(
      importErrorImplicatesDiscarded("No module named 'pkg.helper'", ["pkg/helper.py"], "pytest"),
    ).toEqual(["pkg/helper.py"]);
  });

  test("fires on Node `Cannot find module './helper'` and on `cannot import name X from '<mod>'`", () => {
    expect(
      importErrorImplicatesDiscarded(
        "Error: Cannot find module './helper'",
        ["src/helper.js"],
        "jest",
      ),
    ).toEqual(["src/helper.js"]);
    expect(
      importErrorImplicatesDiscarded(
        "ImportError: cannot import name 'foo' from 'helper'",
        ["helper.py"],
        "pytest",
      ),
    ).toEqual(["helper.py"]);
  });

  test("does NOT fire when the import error names the FEATURE module, not the discarded file", () => {
    // true-negative core: the test legitimately fails because `newfeature` is absent; an UNRELATED
    // throwaway was discarded. The feature-absence red must remain a real, installable red.
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'newfeature'",
        ["throwaway.py"],
        "pytest",
      ),
    ).toEqual([]);
  });

  test("does NOT fire on a bare basename appearing incidentally (no import-error association)", () => {
    // discarded `test.py`; the word "test" is everywhere, but never inside an import/module error.
    expect(
      importErrorImplicatesDiscarded(
        "1 failed, 3 passed\nassert result == expected  # test the widget\nFAILED test_widget.py::test_x",
        ["test.py"],
        "pytest",
      ),
    ).toEqual([]);
    // a genuine assertion-failure red (exit 1) that mentions the discarded basename in prose but has
    // no import/module error at all.
    expect(
      importErrorImplicatesDiscarded(
        "AssertionError: helper returned False",
        ["helper.py"],
        "pytest",
      ),
    ).toEqual([]);
  });

  test("no discarded files, or empty output → never fires", () => {
    expect(importErrorImplicatesDiscarded("No module named 'helper'", [], "pytest")).toEqual([]);
    expect(importErrorImplicatesDiscarded("", ["helper.py"], "pytest")).toEqual([]);
  });

  test("returns only the implicated subset when several files were discarded", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'helper'",
        ["helper.py", "unrelated_scratch.py"],
        "pytest",
      ),
    ).toEqual(["helper.py"]);
  });

  // --- package-init (__init__.py) shape matching ---
  test("implicates a discarded __init__.py when the missing module IS its package (shallow)", () => {
    const out = "E   ModuleNotFoundError: No module named 'pkg'";
    expect(importErrorImplicatesDiscarded(out, ["pkg/__init__.py"], "pytest")).toEqual([
      "pkg/__init__.py",
    ]);
  });

  test("implicates a discarded nested __init__.py by its full dotted package", () => {
    const out = "ModuleNotFoundError: No module named 'a.b'";
    expect(importErrorImplicatesDiscarded(out, ["a/b/__init__.py"], "pytest")).toEqual([
      "a/b/__init__.py",
    ]);
  });

  test("implicates a discarded __init__.py when a SUBMODULE of its package is imported", () => {
    const out = "ModuleNotFoundError: No module named 'pkg.sub'";
    expect(importErrorImplicatesDiscarded(out, ["pkg/__init__.py"], "pytest")).toEqual([
      "pkg/__init__.py",
    ]);
  });

  test("implicates a discarded __init__.py under a src/ prefix via a >=2-seg suffix", () => {
    const out = "ModuleNotFoundError: No module named 'mypkg.sub'";
    expect(importErrorImplicatesDiscarded(out, ["src/mypkg/sub/__init__.py"], "pytest")).toEqual([
      "src/mypkg/sub/__init__.py",
    ]);
  });

  test("does NOT implicate a discarded nested __init__.py for an unrelated top-level import (no false reject)", () => {
    // a/b/__init__.py discarded, but the test legitimately fails importing an unrelated top-level `b`.
    const out = "ModuleNotFoundError: No module named 'b'";
    expect(importErrorImplicatesDiscarded(out, ["a/b/__init__.py"], "pytest")).toEqual([]);
  });

  test("does NOT implicate a discarded __init__.py for an unrelated feature module", () => {
    const out = "ModuleNotFoundError: No module named 'unrelated_feature'";
    expect(importErrorImplicatesDiscarded(out, ["pkg/__init__.py"], "pytest")).toEqual([]);
  });

  // --- conftest.py shape matching ---
  test("implicates a discarded conftest.py on a fixture-not-found error", () => {
    const out = "E       fixture 'db' not found";
    expect(importErrorImplicatesDiscarded(out, ["tests/conftest.py"], "pytest")).toEqual([
      "tests/conftest.py",
    ]);
  });

  test("does NOT implicate a discarded conftest.py on a plain assertion failure (no collection/fixture error)", () => {
    const out = "E       assert 1 == 2";
    expect(importErrorImplicatesDiscarded(out, ["tests/conftest.py"], "pytest")).toEqual([]);
  });

  // --- existing general tier still works (regression) ---
  test("still implicates a directly-named discarded helper", () => {
    const out = "ModuleNotFoundError: No module named 'helper'";
    expect(importErrorImplicatesDiscarded(out, ["tests/helper.py"], "pytest")).toEqual([
      "tests/helper.py",
    ]);
  });

  test("a null framework never implicates", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'helper'",
        ["helper.py"],
        null,
      ),
    ).toEqual([]);
  });
});

describe("CHECK_RULES registry", () => {
  test("aliased frameworks share one rule set (forward pin; bites once Tasks 2-3 give them distinct objects)", () => {
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

describe("collectionErrorExcerpt", () => {
  test("collectionErrorExcerpt prefers the pytest ERROR summary line and preserves casing", () => {
    const out = [
      "    import pkg",
      "E   ModuleNotFoundError: No module named 'pkg'",
      "=== short test summary info ===",
      "ERROR tests/x_test.py - ModuleNotFoundError: No module named 'pkg'",
    ].join("\n");
    expect(collectionErrorExcerpt(out, "pytest")).toBe(
      "ERROR tests/x_test.py - ModuleNotFoundError: No module named 'pkg'",
    );
  });

  test("collectionErrorExcerpt falls back to the last indicator line when no summary line exists", () => {
    const out = "line one\nE   ModuleNotFoundError: No module named 'pkg'\ntrailing noise";
    expect(collectionErrorExcerpt(out, "pytest")).toBe(
      "ModuleNotFoundError: No module named 'pkg'",
    );
  });

  test("collectionErrorExcerpt surfaces a fixture-not-found line", () => {
    expect(collectionErrorExcerpt("E       fixture 'db' not found", "pytest")).toBe(
      "fixture 'db' not found",
    );
  });

  test("collectionErrorExcerpt returns undefined when no collection/import indicator is present", () => {
    expect(collectionErrorExcerpt("E   assert 1 == 2", "pytest")).toBeUndefined();
  });
});

describe("collectionErrorExcerpt (framework-aware)", () => {
  test("returns undefined for a null framework", () => {
    expect(
      collectionErrorExcerpt("ModuleNotFoundError: No module named 'x'", null),
    ).toBeUndefined();
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

  test("a naming-only ERROR line cannot displace an indicator line via the summary path", () => {
    // pytest sets prefersErrorSummary, so an `ERROR ...` line is preferred — but only when that line
    // matched by INDICATOR. A naming-only ERROR line must not bypass the fallback ordering.
    const out = "ImportError: cannot import name 'X' from 'pkg'\nERROR unable to resolve foo";
    expect(collectionErrorExcerpt(out, "pytest")).toBe(
      "ImportError: cannot import name 'X' from 'pkg'",
    );
  });

  test("an indicator line beats a trailing naming-only line (no displacement)", () => {
    const out =
      "Error: Cannot find module './helper'\n  at Object.<anonymous>\nnpm ERR! unable to resolve dependency tree";
    expect(collectionErrorExcerpt(out, "jest")).toBe("Error: Cannot find module './helper'");
  });
});

import { binaryFor } from "../../src/dispatch/check-selector.ts";

describe("binaryFor (M2a decision 3: go/cargo carry the subcommand; maven/gradle/vitest carry it in runArgs)", () => {
  test("pytest uses the resolved interpreter", () => {
    expect(binaryFor("pytest", { interp: "/venv/bin/python" })).toBe("/venv/bin/python -m pytest");
    expect(binaryFor("pytest")).toBe("python3 -m pytest");
  });
  test("go/cargo binary carries the test subcommand", () => {
    expect(binaryFor("go")).toBe("go test");
    expect(binaryFor("cargo")).toBe("cargo test");
  });
  test("maven/gradle/vitest binaries are bare (the subcommand rides in runArgs)", () => {
    expect(binaryFor("junit-maven")).toBe("mvn");
    expect(binaryFor("junit-gradle")).toBe("gradle");
    expect(binaryFor("vitest")).toBe("vitest");
  });
  test("jest/rspec/phpunit are bare binaries; minitest is ruby -Itest", () => {
    expect(binaryFor("jest")).toBe("jest");
    expect(binaryFor("rspec")).toBe("rspec");
    expect(binaryFor("phpunit")).toBe("phpunit");
    expect(binaryFor("minitest")).toBe("ruby -Itest");
  });
});

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
    expect(
      importErrorImplicatesDiscarded(missingDep, ["internal/scratch/assert.go"], "go"),
    ).toEqual([]);
  });

  test("colliding DIRECTORY: a missing dependency must not implicate a throwaway in a like-named dir", () => {
    // The measured false positive that leaf-to-directory matching alone would produce: dir `assert`
    // equals the package leaf. Segment alignment rejects it — [internal, assert] ≠ [testify, assert].
    expect(importErrorImplicatesDiscarded(missingDep, ["internal/assert/helper.go"], "go")).toEqual(
      [],
    );
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

  test("a capture never spans a line break (the naming patterns are horizontal-whitespace only)", () => {
    // NOTE: deliberately not the literal `go/scratch.go` fixture from the review — that fixture's
    // discarded file also collides with the (separately documented, accepted) bounded-basename tier,
    // since its own basename is textually present on the output's second line regardless of the
    // naming-capture fix. This fixture isolates the naming/shape-tier defect alone: `helper/other.go`
    // does not appear as a basename anywhere in the output, so only the (fixed) naming capture can
    // affect the result. Confirmed by direct probe: with the old `\s+` naming regex this fixture
    // reproduces the false positive (`["helper/other.go"]`); with the fixed `[^\S\r\n]+` regex it
    // correctly returns `[]`.
    const twoLine =
      "app/x_test.go:1:1: no required module provides package\nscratch/helper:2:2: something";
    expect(importErrorImplicatesDiscarded(twoLine, ["helper/other.go"], "go")).toEqual([]);
  });

  test("the excerpt is not displaced by a trailing deprecation warning (no `] package ` indicator)", () => {
    const out =
      "[ERROR] /repo/src/test/java/com/x/ATest.java:[3,26] package com.helper does not exist\n" +
      "[INFO] --- jar:3.3.0:jar (default-jar) @ demo ---\n" +
      "[WARNING] [deprecation] package com.old does not exist anymore";
    expect(collectionErrorExcerpt(out, "junit-maven")).toBe(
      "[ERROR] /repo/src/test/java/com/x/ATest.java:[3,26] package com.helper does not exist",
    );
  });

  // DOCUMENTATION PINS (not guards): accepted residuals, recorded so they cannot drift unnoticed.
  test("residual: a single-segment directory still collides with a dependency's package leaf", () => {
    const missingDep =
      "app/x_test.go:6:2: no required module provides package github.com/stretchr/testify/assert; to add it:";
    expect(importErrorImplicatesDiscarded(missingDep, ["assert/helper.go"], "go")).toEqual([
      "assert/helper.go",
    ]);
  });

  test("residual: the basename tier can implicate a file merely named in the build output", () => {
    // Go prints the IMPORTING file's path on every build error line, so an unrelated discarded file
    // whose basename appears there is implicated by the bounded-basename tier.
    const out =
      "app/x_test.go:6:2: no required module provides package example.com/m/helper; to add it:";
    expect(importErrorImplicatesDiscarded(out, ["deep/nested/x_test.go"], "go")).toEqual([
      "deep/nested/x_test.go",
    ]);
  });
});

describe("discard-poison: JVM (ties by package/directory segment alignment)", () => {
  const missingPkg =
    "src/test/java/com/helper/ATest.java:3: error: package com.helper does not exist";

  test("implicates a discarded class in the missing package's directory", () => {
    expect(
      importErrorImplicatesDiscarded(
        missingPkg,
        ["src/test/java/com/helper/Helper.java"],
        "junit-maven",
      ),
    ).toEqual(["src/test/java/com/helper/Helper.java"]);
  });

  test("contrast: same output, a class outside that package ⇒ no match", () => {
    expect(
      importErrorImplicatesDiscarded(
        missingPkg,
        ["src/test/java/com/other/Helper.java"],
        "junit-maven",
      ),
    ).toEqual([]);
  });

  test("colliding leaf: a missing dependency must not implicate a throwaway sharing its leaf", () => {
    const out = "Foo.java:3: error: package org.junit.jupiter.api does not exist";
    expect(importErrorImplicatesDiscarded(out, ["src/test/java/api.java"], "junit-gradle")).toEqual(
      [],
    );
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

  test("Maven's reformatted javac diagnostic ties too (mvn drops the `error:` token)", () => {
    const mvn =
      "[ERROR] /repo/src/test/java/com/x/ATest.java:[3,26] package com.helper does not exist";
    expect(
      importErrorImplicatesDiscarded(mvn, ["src/test/java/com/helper/Helper.java"], "junit-maven"),
    ).toEqual(["src/test/java/com/helper/Helper.java"]);
    expect(collectionErrorExcerpt(mvn, "junit-maven")).toBe(mvn);
  });

  // DOCUMENTATION PIN (not a guard): records an accepted residual.
  test("residual: `cannot find symbol` names the symbol, never the file ⇒ not tied", () => {
    const out =
      "ATest.java:12: error: cannot find symbol\n  symbol:   class Helper\n  location: class ATest";
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

  test("legacy python/node vocabulary does not leak into the new stacks", () => {
    const out = "ImportError: boom in tests/scratch/mod.rs";
    expect(importErrorImplicatesDiscarded(out, ["tests/scratch/mod.rs"], "cargo")).toEqual([]);
    expect(importErrorImplicatesDiscarded(out, ["spec/scratch.rb"], "rspec")).toEqual([]);
  });
});

describe("single-line capture guards (a capture must never span a line break)", () => {
  // Task 2's review found only the Go site was guarded; these cover the other two, and LEGACY_NAMING
  // is the higher-blast-radius one because python and node both depend on it.
  test("LEGACY_NAMING (python/node) does not lift a capture off the next line", () => {
    const out = "ModuleNotFoundError: No module named\nsupport/helper:2: something";
    expect(importErrorImplicatesDiscarded(out, ["support/helper.py"], "pytest")).toEqual([]);
  });

  test("the JVM patterns do not lift a capture off the next line", () => {
    const out = "[ERROR] /r/ATest.java:[3,26] package\ncom.helper does not exist";
    expect(
      importErrorImplicatesDiscarded(out, ["src/test/java/com/helper/Helper.java"], "junit-maven"),
    ).toEqual([]);
  });

  test("cargo's naming pattern does not lift a capture off the next line", () => {
    const out = "error[E0583]: file not found for module\nhelper";
    expect(importErrorImplicatesDiscarded(out, ["src/helper.rs"], "cargo")).toEqual([]);
  });

  test("rspec's naming pattern does not lift a capture off the next line", () => {
    const out = "cannot load such file --\nsupport/helper (LoadError)";
    expect(importErrorImplicatesDiscarded(out, ["spec/support/helper.rb"], "rspec")).toEqual([]);
  });

  test("phpunit's naming pattern does not lift a capture off the next line", () => {
    // The bounded-basename tier would match this fixture regardless of the naming pattern, so
    // neutralise that tier for the probe — otherwise the test passes for the wrong reason.
    const out =
      "PHP Fatal error:  Uncaught Error: Failed opening required\nsrc/helper.php, giving up";
    const orig = CHECK_RULES.phpunit.basenameGates;
    try {
      (CHECK_RULES.phpunit as { basenameGates: string[] }).basenameGates = [];
      expect(importErrorImplicatesDiscarded(out, ["src/helper.php"], "phpunit")).toEqual([]);
    } finally {
      (CHECK_RULES.phpunit as { basenameGates: string[] }).basenameGates = orig;
    }
  });
});

describe("discard-poison: Rust", () => {
  // Real rustc 1.94 output. The help line names BOTH candidate paths — which is exactly why cargo's
  // basenameGates is empty.
  const e0583 =
    "error[E0583]: file not found for module `helper`\n" +
    '  = help: to create the module `helper`, create file "src/helper.rs" or "src/helper/mod.rs"';

  test("implicates a discarded module file named by E0583", () => {
    expect(importErrorImplicatesDiscarded(e0583, ["src/helper.rs"], "cargo")).toEqual([
      "src/helper.rs",
    ]);
  });

  test("implicates a discarded mod.rs via its directory (its leaf would be `mod`)", () => {
    const out = "error[E0583]: file not found for module `common`";
    expect(importErrorImplicatesDiscarded(out, ["tests/common/mod.rs"], "cargo")).toEqual([
      "tests/common/mod.rs",
    ]);
  });

  // residual/documentation: this fixture cannot discriminate between shape and tier — with
  // basenameGates empty there is no mechanism by which an unrelated discarded file could match. It
  // records that the negative holds, not that anything specifically guards it.
  test("residual/documentation: contrast: same output, unrelated discarded module ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(e0583, ["src/scratch.rs"], "cargo")).toEqual([]);
  });

  test("the mod.rs shape applies ONLY to mod.rs, not to any file in a matching directory", () => {
    const out = "error[E0583]: file not found for module `common`";
    expect(importErrorImplicatesDiscarded(out, ["tests/common/other.rs"], "cargo")).toEqual([]);
  });

  test("E0583's help note must NOT implicate an unrelated discarded mod.rs", () => {
    // The help line contains the literal token `src/newfeature/mod.rs`. If error[e0583] gated the
    // bounded-basename tier, ANY discarded mod.rs would match ANY E0583.
    const out =
      "error[E0583]: file not found for module `newfeature`\n" +
      '  = help: to create the module `newfeature`, create file "src/newfeature.rs" or "src/newfeature/mod.rs"';
    expect(importErrorImplicatesDiscarded(out, ["tests/scratch/mod.rs"], "cargo")).toEqual([]);
  });

  test("surfaces the rustc error line, not the help note", () => {
    expect(collectionErrorExcerpt(e0583, "cargo")).toBe(
      "error[E0583]: file not found for module `helper`",
    );
  });

  // DOCUMENTATION PIN (not a guard): records an accepted residual.
  test("residual: E0432 unresolved imports name no file ⇒ not tied", () => {
    const out = "error[E0432]: unresolved import `crate::helper`\n --> tests/x.rs:3:5";
    expect(importErrorImplicatesDiscarded(out, ["src/helper.rs"], "cargo")).toEqual([]);
  });
});

describe("discard-poison: Ruby", () => {
  const loadErr =
    "spec/a_spec.rb:2:in `require': cannot load such file -- support/helper (LoadError)";

  test("implicates a discarded helper named by a LoadError", () => {
    expect(importErrorImplicatesDiscarded(loadErr, ["spec/support/helper.rb"], "minitest")).toEqual(
      ["spec/support/helper.rb"],
    );
  });

  test("ties on rspec too, for the boot-time require failure design section 5 credits it with", () => {
    const boot = "cannot load such file -- ./spec/support/helper (LoadError)";
    expect(importErrorImplicatesDiscarded(boot, ["spec/support/helper.rb"], "rspec")).toEqual([
      "spec/support/helper.rb",
    ]);
  });

  test("contrast: same output, unrelated discarded file ⇒ no match", () => {
    expect(
      importErrorImplicatesDiscarded(loadErr, ["spec/support/scratch.rb"], "minitest"),
    ).toEqual([]);
  });

  test("near-miss leaf: `helpers.rb` is not `helper` ⇒ no match", () => {
    expect(
      importErrorImplicatesDiscarded(loadErr, ["spec/support/helpers.rb"], "minitest"),
    ).toEqual([]);
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

  test("implicates a discarded file whose basename appears in a failed require (basename tier)", () => {
    expect(importErrorImplicatesDiscarded(failedOpen, ["src/helper.php"], "phpunit")).toEqual([
      "src/helper.php",
    ]);
  });

  test("implicates a discarded file named by a failed require (naming tier, not basename)", () => {
    // Trailing `,` keeps `helper.php` OUT of the bounded-basename tier, so only the naming pattern +
    // leaf tier can produce this match. Verified: deleting phpRules.naming turns this red.
    const namingOnly =
      "PHP Fatal error:  Uncaught Error: Failed opening required helper.php, giving up";
    expect(importErrorImplicatesDiscarded(namingOnly, ["src/helper.php"], "phpunit")).toEqual([
      "src/helper.php",
    ]);
  });

  test("implicates via the bounded-basename tier on the `Failed to open stream` shape", () => {
    expect(importErrorImplicatesDiscarded(failedStream, ["src/helper.php"], "phpunit")).toEqual([
      "src/helper.php",
    ]);
  });

  test("contrast: same stream output, unrelated discarded file ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(failedStream, ["src/scratch.php"], "phpunit")).toEqual(
      [],
    );
  });

  test("contrast: same output, unrelated discarded file ⇒ no match", () => {
    expect(importErrorImplicatesDiscarded(failedOpen, ["src/scratch.php"], "phpunit")).toEqual([]);
  });

  // DOCUMENTATION PIN (not a guard): records an accepted residual.
  test("residual: PSR-4 autoload reports a missing CLASS, which names no file ⇒ not tied", () => {
    const out =
      'PHP Fatal error:  Uncaught Error: Class "Helper" not found in /app/tests/ATest.php:9';
    expect(importErrorImplicatesDiscarded(out, ["src/Helper.php"], "phpunit")).toEqual([]);
  });
});

describe("mutation guard: the Rust help-note negative must discriminate", () => {
  test("gating the basename tier on E0583 would implicate any discarded mod.rs", () => {
    const out =
      "error[E0583]: file not found for module `newfeature`\n" +
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

describe("mutation guards: the Go/JVM negatives above must discriminate", () => {
  // A negative that would pass under the WRONG implementation proves nothing. These mutate the real
  // rule object and assert the collision reappears — committed evidence, not a manual ritual.
  const missingDep =
    "app/x_test.go:6:2: no required module provides package github.com/stretchr/testify/assert; to add it:";

  test("leaf tying would re-introduce the Go collision", () => {
    const orig = CHECK_RULES.go.tiesByLeaf;
    try {
      (CHECK_RULES.go as { tiesByLeaf: boolean }).tiesByLeaf = true;
      expect(
        importErrorImplicatesDiscarded(missingDep, ["internal/scratch/assert.go"], "go"),
      ).toEqual(["internal/scratch/assert.go"]);
    } finally {
      (CHECK_RULES.go as { tiesByLeaf: boolean }).tiesByLeaf = orig;
    }
    expect(
      importErrorImplicatesDiscarded(missingDep, ["internal/scratch/assert.go"], "go"),
    ).toEqual([]);
  });

  test("leaf tying would re-introduce the JVM collision", () => {
    const out = "Foo.java:3: error: package org.junit.jupiter.api does not exist";
    const orig = CHECK_RULES["junit-maven"].tiesByLeaf;
    try {
      (CHECK_RULES["junit-maven"] as { tiesByLeaf: boolean }).tiesByLeaf = true;
      expect(
        importErrorImplicatesDiscarded(out, ["src/test/java/api.java"], "junit-maven"),
      ).toEqual(["src/test/java/api.java"]);
    } finally {
      (CHECK_RULES["junit-maven"] as { tiesByLeaf: boolean }).tiesByLeaf = orig;
    }
    expect(importErrorImplicatesDiscarded(out, ["src/test/java/api.java"], "junit-maven")).toEqual(
      [],
    );
  });
});
