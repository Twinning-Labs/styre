import { expect, test } from "bun:test";
import { BlameEnum, ChecksArbitrateOutputSchema } from "../../src/dispatch/arbitrate-schema.ts";

test("BlameEnum admits exactly the two blame routes, no environmental", () => {
  expect(BlameEnum.safeParse("code-wrong").success).toBe(true);
  expect(BlameEnum.safeParse("check-wrong").success).toBe(true);
  expect(BlameEnum.safeParse("environmental").success).toBe(false);
});

test("ChecksArbitrateOutputSchema parses a per-check arbitration array", () => {
  const parsed = ChecksArbitrateOutputSchema.safeParse({
    arbitrations: [
      { ac_check_id: 7, blame: "check-wrong", reason: "AC says 201; check asserts 200" },
    ],
  });
  expect(parsed.success).toBe(true);
});

test("an empty reason is rejected (transport-level integrity)", () => {
  const parsed = ChecksArbitrateOutputSchema.safeParse({
    arbitrations: [{ ac_check_id: 7, blame: "code-wrong", reason: "" }],
  });
  expect(parsed.success).toBe(false);
});
