import { expect, test } from "bun:test";
import { isTestFile } from "../../src/dispatch/test-file.ts";

test("built-in heuristic recognizes common test files", () => {
  expect(isTestFile("src/foo.test.ts")).toBe(true);
  expect(isTestFile("src/foo.spec.js")).toBe(true);
  expect(isTestFile("test/foo.ts")).toBe(true);
  expect(isTestFile("pkg/__tests__/foo.tsx")).toBe(true);
  expect(isTestFile("foo_test.go")).toBe(true);
  expect(isTestFile("tests/test_foo.py")).toBe(true);
  expect(isTestFile("src/foo.ts")).toBe(false);
  expect(isTestFile("README.md")).toBe(false);
});

test("built-in heuristic recognizes .mjs/.cjs/.mts/.cts test files", () => {
  expect(isTestFile("src/foo.test.mjs")).toBe(true);
  expect(isTestFile("src/foo.spec.cjs")).toBe(true);
  expect(isTestFile("src/foo.test.mts")).toBe(true);
  expect(isTestFile("src/foo.spec.cts")).toBe(true);
  // plain .mjs/.cjs source files must NOT match
  expect(isTestFile("src/foo.mjs")).toBe(false);
  expect(isTestFile("src/attestation.ts")).toBe(false);
});

test("an explicit pattern overrides the heuristic", () => {
  expect(isTestFile("src/foo.ts", "\\.ts$")).toBe(true);
  expect(isTestFile("src/foo.test.ts", "checks/")).toBe(false);
});
