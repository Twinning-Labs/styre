import { expect, test } from "bun:test";
import {
  canonicalCheckBase,
  isCanonicalCheckPath,
  matchAuthoredTest,
  resolveAuthoredTestPath,
} from "../../src/dispatch/check-path.ts";

test("canonicalCheckBase composes ident + acId", () => {
  expect(canonicalCheckBase("ENG-294", 1)).toBe("ENG-294_ac1_test");
});

test("matchAuthoredTest finds the canonical file under any directory, extension-agnostic", () => {
  const added = ["astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py", "astropy/other.py"];
  expect(matchAuthoredTest(added, "ENG-294", 1)).toBe(
    "astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py",
  );
  // multi-dot extension (darkreader shape)
  expect(matchAuthoredTest(["a/b/ENG-293_ac1_test.tests.ts"], "ENG-293", 1)).toBe(
    "a/b/ENG-293_ac1_test.tests.ts",
  );
});

test("matchAuthoredTest returns null when absent, and does not confuse ac1 with ac10", () => {
  expect(matchAuthoredTest(["tests/foo_test.py"], "ENG-294", 1)).toBeNull();
  expect(matchAuthoredTest(["t/ENG-1_ac10_test.py"], "ENG-1", 1)).toBeNull();
});

test("matchAuthoredTest returns null on ambiguity (two canonical matches)", () => {
  const added = ["a/ENG-1_ac1_test.py", "b/ENG-1_ac1_test.py"];
  expect(matchAuthoredTest(added, "ENG-1", 1)).toBeNull();
});

test("isCanonicalCheckPath matches for any acId in the set, else false", () => {
  expect(isCanonicalCheckPath("x/ENG-1_ac2_test.go", "ENG-1", [1, 2])).toBe(true);
  expect(isCanonicalCheckPath("x/ENG-1_ac3_test.go", "ENG-1", [1, 2])).toBe(false);
  expect(isCanonicalCheckPath("x/random.go", "ENG-1", [1, 2])).toBe(false);
});

test("resolveAuthoredTestPath: (a) canonical override wins over a wrong declared path", () => {
  const added = ["tests/styre_checks/ENG-294_ac1_test.py"];
  expect(resolveAuthoredTestPath(added, "ENG-294", 1, "tests/ENG-294_ac1_test.py")).toBe(
    "tests/styre_checks/ENG-294_ac1_test.py",
  );
});

test("resolveAuthoredTestPath: (b) falls back to a correctly-declared non-canonical file", () => {
  const added = ["pkg/separable_test.go"];
  expect(resolveAuthoredTestPath(added, "ENG-1", 1, "pkg/separable_test.go")).toBe(
    "pkg/separable_test.go",
  );
});

test("resolveAuthoredTestPath: (c) null when neither canonical nor declared-added", () => {
  const added = ["pkg/unrelated.go"];
  expect(resolveAuthoredTestPath(added, "ENG-1", 1, "pkg/missing_test.go")).toBeNull();
});
