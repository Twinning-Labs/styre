import { expect, test } from "bun:test";
import { classifyFailure } from "../../../src/agent/providers/claude.ts";

test("session-limit marker is classified with the reset text", () => {
  const r = classifyFailure("You've hit your session limit · resets 11:10pm (Asia/Calcutta)", "");
  expect(r.cause).toBe("session-limit");
  expect(r.resetAt).toContain("11:10pm");
});

test("out-of-credits / billing marker is classified", () => {
  expect(classifyFailure("Error: insufficient credit balance", "").cause).toBe("out-of-credits");
  expect(classifyFailure("your credit balance is too low", "").cause).toBe("out-of-credits");
});

test("unknown stderr falls back to transient with no resetAt", () => {
  const r = classifyFailure("segfault: core dumped", "");
  expect(r.cause).toBe("transient");
  expect(r.resetAt).toBeNull();
});

test("a marker appearing on stdout (not stderr) is still classified", () => {
  expect(classifyFailure("", "…You've hit your session limit, resets soon").cause).toBe(
    "session-limit",
  );
});
