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

test("checks prompt pins the canonical written==declared path and routes scratch to the styre_scratch/ drawer", () => {
  const t = CHECKS_TEMPLATE.toLowerCase();
  // Canonical RED-first path is pinned (not a soft e.g.), and declared MUST equal written.
  expect(t).toContain("styre_checks/");
  expect(t).toMatch(/byte-identical|character for character/); // declared == written path
  // Scratch is redirected into the swept drawer, not parked in new_files.
  expect(t).toContain("styre_scratch/"); // scratch goes in the swept drawer, not /tmp
  expect(t).toContain("reject"); // guard still rejects undeclared new files
  expect(t).toContain("new_files"); // retained, now scoped to genuine helpers only
});
