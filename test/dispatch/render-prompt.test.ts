import { expect, test } from "bun:test";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";

test("placeholders extracts distinct names in order", () => {
  expect(placeholders("a {{x}} b {{ y }} c {{x}}")).toEqual(["x", "y"]);
});

test("renderPrompt substitutes all placeholders when vars resolve", () => {
  const r = renderPrompt("Build {{ticket}} on {{branch}}", { ticket: "ENG-1", branch: "feat/x" });
  expect(r).toEqual({ ok: true, prompt: "Build ENG-1 on feat/x" });
});

test("renderPrompt reports missing placeholders (CL-PROFILE failure)", () => {
  const r = renderPrompt("Build {{ticket}} on {{branch}}", { ticket: "ENG-1" });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.missing).toEqual(["branch"]);
  }
});

test("renderPrompt with no placeholders returns the template unchanged", () => {
  const r = renderPrompt("static text", {});
  expect(r).toEqual({ ok: true, prompt: "static text" });
});

test("an empty-string value counts as resolved (not missing)", () => {
  const r = renderPrompt("x={{x}}", { x: "" });
  expect(r).toEqual({ ok: true, prompt: "x=" });
});
