import { expect, test } from "bun:test";
import { ExtractOutputSchema, validateExtraction } from "../../src/dispatch/extract-schema.ts";

const unit = (over: Record<string, unknown> = {}) => ({
  seq: 1,
  kind: "backend",
  title: "t",
  description: "d",
  behavioral: true,
  test_plan: "test it",
  files_to_touch: ["src/a.ts"],
  verify_check_types: ["test"],
  depends_on: [],
  ...over,
});

test("schema parses a well-formed extract block", () => {
  const r = ExtractOutputSchema.safeParse({ units: [unit()] });
  expect(r.success).toBe(true);
});

test("schema rejects a non-boolean behavioral", () => {
  const r = ExtractOutputSchema.safeParse({ units: [unit({ behavioral: "yes" })] });
  expect(r.success).toBe(false);
});

test("validateExtraction accepts a minimal valid set", () => {
  expect(validateExtraction([unit()])).toEqual([]);
});

test("validateExtraction rejects an empty unit list", () => {
  expect(validateExtraction([]).length).toBeGreaterThan(0);
});

test("validateExtraction rejects a behavioral unit with no test_plan", () => {
  expect(validateExtraction([unit({ test_plan: "" })]).length).toBeGreaterThan(0);
});

test("validateExtraction rejects a behavioral unit missing the test check-type", () => {
  expect(validateExtraction([unit({ verify_check_types: ["lint"] })]).length).toBeGreaterThan(0);
});

test("validateExtraction accepts a non-behavioral unit with no test_plan", () => {
  expect(
    validateExtraction([
      unit({ behavioral: false, test_plan: null, verify_check_types: ["lint"] }),
    ]),
  ).toEqual([]);
});

test("validateExtraction rejects non-contiguous seqs", () => {
  expect(
    validateExtraction([unit({ seq: 1 }), unit({ seq: 3, depends_on: [] })]).length,
  ).toBeGreaterThan(0);
});

test("validateExtraction rejects a forward or self dependency", () => {
  expect(validateExtraction([unit({ seq: 1, depends_on: [1] })]).length).toBeGreaterThan(0);
  expect(
    validateExtraction([unit({ seq: 1, depends_on: [] }), unit({ seq: 2, depends_on: [3] })])
      .length,
  ).toBeGreaterThan(0);
});

test("validateExtraction accepts a valid backward dependency", () => {
  expect(
    validateExtraction([unit({ seq: 1, depends_on: [] }), unit({ seq: 2, depends_on: [1] })]),
  ).toEqual([]);
});
