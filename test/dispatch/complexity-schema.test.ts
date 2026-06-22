import { expect, test } from "bun:test";
import { ComplexityGradeSchema } from "../../src/dispatch/complexity-schema.ts";

const grade = (over: Record<string, unknown> = {}) => ({
  dimensions: { coupling: 3, blast_radius: 2, difficulty: 4 },
  overall: 3,
  rationale: "low coupling",
  ...over,
});

test("schema parses a well-formed grade", () => {
  expect(ComplexityGradeSchema.safeParse(grade()).success).toBe(true);
});

test("schema accepts a null rationale", () => {
  expect(ComplexityGradeSchema.safeParse(grade({ rationale: null })).success).toBe(true);
});

test("schema rejects an out-of-range score", () => {
  expect(ComplexityGradeSchema.safeParse(grade({ overall: 11 })).success).toBe(false);
  expect(
    ComplexityGradeSchema.safeParse(
      grade({ dimensions: { coupling: -1, blast_radius: 2, difficulty: 4 } }),
    ).success,
  ).toBe(false);
});
