import { expect, test } from "bun:test";
import { classifyCodexFailure } from "../../../src/agent/providers/codex.ts";

test("rate/usage limit → session-limit", () => {
  expect(classifyCodexFailure("Error: rate limit reached", "").cause).toBe("session-limit");
  expect(classifyCodexFailure("", "429 Too Many Requests").cause).toBe("session-limit");
});

test("quota/billing → out-of-credits", () => {
  expect(classifyCodexFailure("You exceeded your current quota", "").cause).toBe("out-of-credits");
  expect(classifyCodexFailure("insufficient_quota / billing", "").cause).toBe("out-of-credits");
});

test("insufficient permissions is NOT credits (transient)", () => {
  expect(classifyCodexFailure("Error: insufficient permissions", "").cause).toBe("transient");
});

test("anything else → transient", () => {
  expect(classifyCodexFailure("connection reset", "").cause).toBe("transient");
  expect(classifyCodexFailure("", "").resetAt).toBeNull();
});
