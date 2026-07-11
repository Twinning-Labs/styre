import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { DOCS_REVISE_TEMPLATE, docsVars } from "../../src/dispatch/prompt-vars.ts";
import { renderPrompt } from "../../src/dispatch/render-prompt.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main" });

test("docsVars carries ident/title/slug + the doc_paths hint", () => {
  const v = docsVars({ ident: "ENG-1", title: "Fix bug" }, profile);
  expect(v.ident).toBe("ENG-1");
  expect(v.title).toBe("Fix bug");
  expect(v.slug).toBe("demo");
  expect(v.doc_paths.length).toBeGreaterThan(0);
});

test("the docs-revise template renders with docsVars (no missing vars)", () => {
  const r = renderPrompt(DOCS_REVISE_TEMPLATE, docsVars({ ident: "ENG-1", title: null }, profile));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.prompt).toContain("ENG-1");
});
