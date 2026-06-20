import { expect, test } from "bun:test";
import { MODELS, resolveModel } from "../../src/dispatch/models.ts";

test("design and review run on Opus", () => {
  expect(resolveModel("design:dispatch")).toBe(MODELS.opus);
  expect(resolveModel("design:review")).toBe(MODELS.opus);
  expect(resolveModel("review")).toBe(MODELS.opus);
});

test("implement runs on Sonnet, Opus on loopback", () => {
  expect(resolveModel("implement:dispatch")).toBe(MODELS.sonnet);
  expect(resolveModel("implement:dispatch", { loopback: true })).toBe(MODELS.opus);
});

test("cheap formalize/docs/pr-ensure run on Haiku", () => {
  expect(resolveModel("design:extract")).toBe(MODELS.haiku);
  expect(resolveModel("docs:revise")).toBe(MODELS.haiku);
  expect(resolveModel("merge:pr-ensure")).toBe(MODELS.haiku);
});

test("an unknown handlerKey throws", () => {
  expect(() => resolveModel("verify:integration")).toThrow();
  expect(() => resolveModel("nope")).toThrow();
});
