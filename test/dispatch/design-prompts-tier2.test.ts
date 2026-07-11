import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";
import {
  DESIGN_REVIEW_TEMPLATE,
  DESIGN_TEMPLATE,
  designReviewVars,
  designVars,
} from "../../src/dispatch/prompt-vars.ts";
import { renderPrompt } from "../../src/dispatch/render-prompt.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x" });

test("design.md tells the agent to inspect the repo before planning (B)", () => {
  expect(DESIGN_TEMPLATE).toContain("Before planning, read the files");
});

test("design.md structures per-unit facts as a labelled list for the extract step (2)", () => {
  expect(DESIGN_TEMPLATE).toContain("keep the surrounding reasoning as prose");
});

test("design.md requires a requirements-traceability block (A)", () => {
  expect(DESIGN_TEMPLATE).toContain("Requirements traceability");
});

test("design.md still renders with no unsatisfied placeholder (edits added no new {{token}})", () => {
  const vars = designVars({ ident: "ENG-1", title: "T", description: "b" }, profile);
  const result = renderPrompt(DESIGN_TEMPLATE, vars);
  expect(result.ok).toBe(true);
});

test("design-review.md has calibrated critical severity (C)", () => {
  expect(DESIGN_REVIEW_TEMPLATE).toContain("impossible-to-execute step");
});

test("design-review.md has the non-gated judgment checklist (D)", () => {
  expect(DESIGN_REVIEW_TEMPLATE).toContain("What to check (judgment the automated gates can't do)");
  // the anti-over-claim wording the independent review required:
  expect(DESIGN_REVIEW_TEMPLATE).toContain("non-empty analysis string");
});

test("design-review.md requires structured rationale for blocking findings (E)", () => {
  expect(DESIGN_REVIEW_TEMPLATE).toContain("Required change");
  expect(DESIGN_REVIEW_TEMPLATE).toContain("Acceptance check");
});

test("design-review.md still renders with no unsatisfied placeholder", () => {
  const vars = designReviewVars({ ident: "ENG-1", title: "T" }, profile);
  const result = renderPrompt(DESIGN_REVIEW_TEMPLATE, vars);
  expect(result.ok).toBe(true);
});
