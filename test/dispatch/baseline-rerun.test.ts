import { expect, test } from "bun:test";
import { preexistingFrom } from "../../src/dispatch/baseline-rerun.ts";

test("a baseline FAIL means the failure pre-dates the change", () => {
  expect(preexistingFrom("fail")).toBe(true);
});

test("a baseline PASS means this change introduced it", () => {
  expect(preexistingFrom("pass")).toBe(false);
});

test("an unusable baseline is UNDEFINED, never 'pre-existing'", () => {
  // Fail-closed. Reporting a failure as pre-existing when that was never shown would excuse a
  // real regression — the more dangerous of the two errors, so neither `error` nor `unknown`
  // may collapse into `true`.
  expect(preexistingFrom("error")).toBeUndefined();
  expect(preexistingFrom("unknown")).toBeUndefined();
});
