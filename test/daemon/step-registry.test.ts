import { expect, test } from "bun:test";
import { StepRegistry } from "../../src/daemon/step-registry.ts";

test("register then resolve returns the handler", () => {
  const reg = new StepRegistry();
  const handler = () => ({ ok: true });
  reg.register("design:dispatch", handler);
  expect(reg.has("design:dispatch")).toBe(true);
  expect(reg.resolve("design:dispatch")).toBe(handler);
});

test("resolve returns undefined for an unregistered key", () => {
  const reg = new StepRegistry();
  expect(reg.resolve("nope")).toBeUndefined();
  expect(reg.has("nope")).toBe(false);
});

test("register rejects a duplicate handlerKey", () => {
  const reg = new StepRegistry();
  reg.register("review", () => null);
  expect(() => reg.register("review", () => null)).toThrow();
});
