import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";
import {
  DESIGN_REVIEW_TEMPLATE,
  DESIGN_TEMPLATE,
  EXTRACT_TEMPLATE,
  IMPLEMENT_TEMPLATE,
  REVIEW_TEMPLATE,
  designReviewVars,
  designVars,
  extractVars,
  implementVars,
  reviewVars,
} from "../../src/dispatch/prompt-vars.ts";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";

const profile = parseProfile({
  slug: "demo",
  targetRepo: "/tmp/demo",
  commands: { test: "bun test" },
  promptVars: { stack: "Bun + SQLite" },
});
const ticket = { ident: "ENG-9", title: "Add widget" };
const unit = { seq: 2, kind: "backend", title: "API" };

test("designVars resolves every placeholder in the design template", () => {
  const vars = designVars(ticket, profile);
  expect(renderPrompt(DESIGN_TEMPLATE, vars).ok).toBe(true);
  for (const name of placeholders(DESIGN_TEMPLATE)) {
    expect(name in vars).toBe(true);
  }
});

test("implementVars resolves every placeholder in the implement template", () => {
  const vars = implementVars(ticket, unit, profile);
  expect(renderPrompt(IMPLEMENT_TEMPLATE, vars).ok).toBe(true);
  for (const name of placeholders(IMPLEMENT_TEMPLATE)) {
    expect(name in vars).toBe(true);
  }
});

test("extract template renders with extractVars (no missing placeholders)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", commands: {} });
  const r = renderPrompt(EXTRACT_TEMPLATE, extractVars({ ident: "ENG-1", title: "T" }, profile));
  expect(r.ok).toBe(true);
});

test("implementVars carries the feedback var (empty by default)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/r", commands: { test: "bun test" } });
  const ticket = { ident: "ENG-1", title: "T" };
  const unit = { seq: 1, kind: "backend", title: "U" };
  expect(implementVars(ticket, unit, profile).feedback).toBe("");
  expect(implementVars(ticket, unit, profile, "fix the build").feedback).toBe("fix the build");
});

test("review template renders with reviewVars (no missing placeholders)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", commands: {} });
  const r = renderPrompt(REVIEW_TEMPLATE, reviewVars({ ident: "ENG-1", title: "T" }, profile));
  expect(r.ok).toBe(true);
  for (const name of placeholders(REVIEW_TEMPLATE)) {
    expect(name in reviewVars({ ident: "ENG-1", title: "T" }, profile)).toBe(true);
  }
});

test("design-review template renders with designReviewVars (no missing placeholders)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", commands: {} });
  const r = renderPrompt(
    DESIGN_REVIEW_TEMPLATE,
    designReviewVars({ ident: "ENG-1", title: "T" }, profile),
  );
  expect(r.ok).toBe(true);
  for (const name of placeholders(DESIGN_REVIEW_TEMPLATE)) {
    expect(name in designReviewVars({ ident: "ENG-1", title: "T" }, profile)).toBe(true);
  }
});
