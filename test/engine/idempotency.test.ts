import { expect, test } from "bun:test";
import { idempotencyKey } from "../../src/engine/idempotency.ts";

test("idempotencyKey composes prefix and suffix", () => {
  expect(idempotencyKey("ENG-1-d0003", "push")).toBe("ENG-1-d0003-push");
});

test("idempotencyKey rejects empty parts", () => {
  expect(() => idempotencyKey("", "push")).toThrow();
  expect(() => idempotencyKey("ENG-1", "")).toThrow();
});
