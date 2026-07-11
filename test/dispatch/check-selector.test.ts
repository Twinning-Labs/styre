import { describe, expect, test } from "bun:test";
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
