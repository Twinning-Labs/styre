import { expect, test } from "bun:test";
import { AdjClassEnum, ChecksClassifyOutputSchema } from "../../src/dispatch/adjudicate-schema.ts";

test("accepts a well-formed per-check classification batch", () => {
  const parsed = ChecksClassifyOutputSchema.safeParse({
    classifications: [
      {
        ac_check_id: 1,
        class: "assertion",
        reason: "the failing assert ran against real new behavior",
      },
      {
        ac_check_id: 2,
        class: "vacuous",
        reason: "asserts True == True, does not exercise the AC",
      },
    ],
  });
  expect(parsed.success).toBe(true);
});

test("rejects an unknown class label", () => {
  const parsed = ChecksClassifyOutputSchema.safeParse({
    classifications: [{ ac_check_id: 1, class: "flaky", reason: "x" }],
  });
  expect(parsed.success).toBe(false);
});

test("rejects an empty reason", () => {
  const parsed = ChecksClassifyOutputSchema.safeParse({
    classifications: [{ ac_check_id: 1, class: "absence", reason: "" }],
  });
  expect(parsed.success).toBe(false);
});

test("AdjClassEnum admits the transient weak flag", () => {
  expect(AdjClassEnum.safeParse("weak").success).toBe(true);
});
