import { expect, test } from "bun:test";
import { CHECKS_TEMPLATE } from "../../src/dispatch/prompt-vars.ts";

test("checks prompt requires a behavioral/observable assertion, not status-only", () => {
  const t = CHECKS_TEMPLATE.toLowerCase();
  expect(t).toContain("observable"); // asserts the AC's observable output
  expect(t).toMatch(/status[- ]?(code)?[- ]?only|existence[- ]?only/); // forbids the weak shape
});

test("checks prompt requires the author to run its check and confirm it fails RED-first", () => {
  const t = CHECKS_TEMPLATE.toLowerCase();
  expect(t).toMatch(/run .*(check|test)/); // must instruct running it
  expect(t).toContain("fail"); // confirm it FAILS on current code
  expect(t).toContain("vacuous"); // name the failure mode it prevents
  expect(t).toContain("do not report a verdict"); // still no self-reported verdict — runner is ground truth
});

test("checks prompt forbids leftover scratch files and offers a new_files declaration escape hatch", () => {
  const t = CHECKS_TEMPLATE.toLowerCase();
  // Anti-scratch instruction (mirrors implement.md) — so a reject-and-retry can be resolved by deleting scratch.
  expect(t).toMatch(/throwaway|reproduction|scratch/);
  expect(t).toContain("reject"); // the commit is REJECTED if it contains an undeclared new file
  // Declaration escape hatch for a genuine non-test helper.
  expect(t).toContain("new_files");
});
