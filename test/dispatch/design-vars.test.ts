import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { DESIGN_TEMPLATE, designVars } from "../../src/dispatch/prompt-vars.ts";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x" });

test("designVars supplies description", () => {
  const vars = designVars({ ident: "ENG-1", title: "T", description: "the body" }, profile);
  expect(vars.description).toBe("the body");
});

test("designVars tolerates a null description", () => {
  const vars = designVars({ ident: "ENG-1", title: "T", description: null }, profile);
  expect(vars.description).toBe("");
});

test("the design template's placeholders are all satisfied by designVars", () => {
  const vars = designVars({ ident: "ENG-1", title: "T", description: "b" }, profile);
  const result = renderPrompt(DESIGN_TEMPLATE, vars);
  expect(result.ok).toBe(true);
  expect(placeholders(DESIGN_TEMPLATE)).toContain("description");
});
