import { expect, test } from "bun:test";
import { resolveTier } from "../../src/agent/tiers.ts";

test("design + review are the deep tier", () => {
  expect(resolveTier("design:dispatch")).toBe("deep");
  expect(resolveTier("design:review")).toBe("deep");
  expect(resolveTier("review")).toBe("deep");
});

test("implement is standard, deep on loopback", () => {
  expect(resolveTier("implement:dispatch")).toBe("standard");
  expect(resolveTier("implement:dispatch", { loopback: true })).toBe("deep");
});

test("extract/docs/pr-ensure are the cheap tier", () => {
  expect(resolveTier("design:extract")).toBe("cheap");
  expect(resolveTier("docs:revise")).toBe("cheap");
  expect(resolveTier("merge:pr-ensure")).toBe("cheap");
});

test("checks:dispatch is the standard tier (implement-class authoring)", () => {
  expect(resolveTier("checks:dispatch")).toBe("standard");
});

test("checks:classify is the standard tier (adjudication)", () => {
  expect(resolveTier("checks:classify")).toBe("standard");
});

test("an unknown handlerKey throws", () => {
  expect(() => resolveTier("verify:integration")).toThrow();
});
