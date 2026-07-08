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
