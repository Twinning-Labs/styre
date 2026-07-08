import { expect, test } from "bun:test";
import { ChecksOutputSchema } from "../../src/dispatch/checks-schema.ts";

test("accepts a well-formed checksAuthored array", () => {
  const parsed = ChecksOutputSchema.safeParse({
    checksAuthored: [{ ac_id: 1, test_file: "tests/test_api.py", test_name: "test_ok" }],
  });
  expect(parsed.success).toBe(true);
});

test("accepts an empty array (postcondition, not schema, enforces ≥1 per AC)", () => {
  expect(ChecksOutputSchema.safeParse({ checksAuthored: [] }).success).toBe(true);
});

test("rejects a non-positive ac_id, empty paths/names, and a missing field", () => {
  expect(
    ChecksOutputSchema.safeParse({ checksAuthored: [{ ac_id: 0, test_file: "a", test_name: "b" }] })
      .success,
  ).toBe(false);
  expect(
    ChecksOutputSchema.safeParse({ checksAuthored: [{ ac_id: 1, test_file: "", test_name: "b" }] })
      .success,
  ).toBe(false);
  expect(
    ChecksOutputSchema.safeParse({ checksAuthored: [{ ac_id: 1, test_file: "a", test_name: "" }] })
      .success,
  ).toBe(false);
  expect(
    ChecksOutputSchema.safeParse({ checksAuthored: [{ ac_id: 1, test_file: "a" }] }).success,
  ).toBe(false);
});

test("rejects a missing checksAuthored key", () => {
  expect(ChecksOutputSchema.safeParse({}).success).toBe(false);
});
