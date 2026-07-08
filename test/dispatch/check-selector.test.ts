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
  test("pytest → an exact node id (precise)", () => {
    expect(
      buildCheckSelector("pytest", { testFile: "tests/test_api.py", testName: "test_ok" }),
    ).toEqual({
      runArgs: "tests/test_api.py::test_ok",
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
});
