import { expect, test } from "bun:test";
import { blockerPersists, environmentalBlocker } from "../../src/dispatch/env-blocker.ts";

/**
 * ENG-424 hole 2. `ac_check.red_class` is frozen at RED-first time, so a check adjudicated
 * `environmental` stayed advisory for the rest of the run no matter what it failed with later.
 * Once the environment recovered, a GENUINE assertion failure was still shielded by the stale
 * label and the gate passed over it.
 *
 * This module answers the one question that is actually answerable from the output: is the
 * blocker that was adjudicated still there?
 */

test("recognises the python interpreter form django-12325 actually hit", () => {
  expect(
    environmentalBlocker("/opt/miniconda3/envs/testbed/bin/python3: No module named pytest"),
  ).toBe("module:pytest");
});

test("recognises the ModuleNotFoundError form", () => {
  expect(environmentalBlocker("ModuleNotFoundError: No module named 'roman'")).toBe("module:roman");
});

test("recognises the shell not-found form ENG-399 hit on darkreader", () => {
  expect(environmentalBlocker("sh: 1: jest: not found")).toBe("command:jest");
});

test("recognises node's cannot-find-module", () => {
  expect(environmentalBlocker("Error: Cannot find module 'vitest'")).toBe("module:vitest");
});

test("a plain assertion failure names no blocker", () => {
  // THE POINT. This is what a recovered environment looks like, and it must NOT read as a
  // blocker — otherwise nothing ever changes and the shield never lifts.
  expect(
    environmentalBlocker("FAILED tests/test_x.py::test_y - AssertionError: assert 1 == 2"),
  ).toBeNull();
});

test("empty output names no blocker", () => {
  expect(environmentalBlocker("")).toBeNull();
});

test("the SAME blocker persisting keeps the frozen class", () => {
  // django's real shape: still no pytest at post-implement. Stays advisory; the evidence floor
  // is what catches this run, not the gate.
  expect(
    blockerPersists("python3: No module named pytest", "python3: No module named pytest"),
  ).toBe(true);
});

test("blocker GONE + still red → the frozen class must stop shielding it", () => {
  expect(
    blockerPersists(
      "python3: No module named pytest",
      "FAILED tests/test_x.py::test_y - AssertionError: assert 1 == 2",
    ),
  ).toBe(false);
});

test("a DIFFERENT blocker is not the adjudicated one", () => {
  // The adjudicator judged "pytest is missing". "numpy is missing" is a different failure and
  // was never adjudicated, so it does not inherit the verdict.
  expect(
    blockerPersists("No module named pytest", "ModuleNotFoundError: No module named 'numpy'"),
  ).toBe(false);
});

test("an UNRECOGNISED original blocker defers to the frozen class, never overrides it", () => {
  // "We cannot tell" must not be treated as "the adjudicator was wrong". Overriding a
  // human-equivalent judgment on no evidence is the worse error.
  expect(blockerPersists("Segmentation fault (core dumped)", "some other failure")).toBe(true);
});
