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

test("a handler's success commit is registered with it, and only with it", () => {
  const reg = new StepRegistry();
  const commit = () => {};
  reg.register("design:extract", () => null, { commit });
  reg.register("design:size", () => null);
  expect(reg.resolveCommit("design:extract")).toBe(commit);
  expect(reg.resolveCommit("design:size")).toBeUndefined();
  expect(reg.resolveCommit("nope")).toBeUndefined();
});

test("a duplicate handlerKey is refused before its commit replaces the first one's", () => {
  const reg = new StepRegistry();
  const first = () => {};
  reg.register("review", () => null, { commit: first });
  expect(() => reg.register("review", () => null, { commit: () => {} })).toThrow(
    "already registered",
  );
  expect(reg.resolveCommit("review")).toBe(first);
});
