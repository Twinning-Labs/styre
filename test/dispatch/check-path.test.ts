import { expect, test } from "bun:test";
import {
  canonicalCheckBase,
  isCanonicalCheckPath,
  isCheckSupportFile,
  matchAuthoredTest,
  normPath,
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

test("normPath strips a leading ./ and normalizes backslashes", () => {
  expect(normPath("./a/b.py")).toBe("a/b.py");
  expect(normPath("a\\b\\c.py")).toBe("a/b/c.py");
  expect(normPath("a/b.py")).toBe("a/b.py");
});

test("resolveAuthoredTestPath: (b') normalizes the declared path before the fallback and returns the git-form added path", () => {
  const added = ["pkg/separable_test.go"];
  // agent declared a leading ./ — git's added form has none; must still resolve, to the added form
  expect(resolveAuthoredTestPath(added, "ENG-1", 1, "./pkg/separable_test.go")).toBe(
    "pkg/separable_test.go",
  );
});

test("isCheckSupportFile: admits a co-located same-ext marker in a styre_checks/ dir (Python __init__.py)", () => {
  const added = ["a/b/styre_checks/ENG-1_ac1_test.py", "a/b/styre_checks/__init__.py"];
  expect(isCheckSupportFile("a/b/styre_checks/__init__.py", added, "ENG-1", [1])).toBe(true);
});

test("isCheckSupportFile: admits a second support file (conftest.py) within the cap", () => {
  const added = [
    "t/styre_checks/ENG-1_ac1_test.py",
    "t/styre_checks/__init__.py",
    "t/styre_checks/conftest.py",
  ];
  expect(isCheckSupportFile("t/styre_checks/__init__.py", added, "ENG-1", [1])).toBe(true);
  expect(isCheckSupportFile("t/styre_checks/conftest.py", added, "ENG-1", [1])).toBe(true);
});

test("isCheckSupportFile: rejects when the styre_checks/ dir has no canonical check this dispatch", () => {
  const added = ["t/styre_checks/__init__.py"]; // no canonical test added in this dir
  expect(isCheckSupportFile("t/styre_checks/__init__.py", added, "ENG-1", [1])).toBe(false);
});

test("isCheckSupportFile: rejects a wrong-extension sibling (.md)", () => {
  const added = ["t/styre_checks/ENG-1_ac1_test.py", "t/styre_checks/NOTES.md"];
  expect(isCheckSupportFile("t/styre_checks/NOTES.md", added, "ENG-1", [1])).toBe(false);
});

test("isCheckSupportFile: rejects a marker NOT inside a styre_checks/ dir", () => {
  const added = ["pkg/ENG-1_ac1_test.py", "pkg/__init__.py"]; // flat, not under styre_checks/
  expect(isCheckSupportFile("pkg/__init__.py", added, "ENG-1", [1])).toBe(false);
});

test("isCheckSupportFile: rejects the 3rd same-ext support file (per-dir cap of 2, stable tie-break)", () => {
  const added = [
    "t/styre_checks/ENG-1_ac1_test.py",
    "t/styre_checks/a_helper.py",
    "t/styre_checks/b_helper.py",
    "t/styre_checks/c_helper.py",
  ];
  expect(isCheckSupportFile("t/styre_checks/a_helper.py", added, "ENG-1", [1])).toBe(true);
  expect(isCheckSupportFile("t/styre_checks/b_helper.py", added, "ENG-1", [1])).toBe(true);
  expect(isCheckSupportFile("t/styre_checks/c_helper.py", added, "ENG-1", [1])).toBe(false); // over cap
});

test("isCheckSupportFile: matches a multi-dot canonical extension (.tests.ts)", () => {
  const added = ["g/styre_checks/ENG-2_ac1_test.tests.ts", "g/styre_checks/helper.ts"];
  expect(isCheckSupportFile("g/styre_checks/helper.ts", added, "ENG-2", [1])).toBe(true);
});
