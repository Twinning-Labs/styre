import { expect, test } from "bun:test";
import {
  type FiledFinding,
  ReviewOutputSchema,
  computeBlocksShip,
  validateReviewFindings,
} from "../../src/dispatch/review-schema.ts";

const finding = (over: Record<string, unknown> = {}): FiledFinding =>
  ({
    severity: "major",
    category: "correctness",
    location: "src/a.ts:1",
    rationale: "bug",
    factors: null,
    deferral_candidate: false,
    work_unit_seq: 1,
    ...over,
  }) as FiledFinding;

test("schema parses a well-formed findings block", () => {
  expect(ReviewOutputSchema.safeParse({ findings: [finding()] }).success).toBe(true);
});

test("schema rejects an unknown severity", () => {
  expect(
    ReviewOutputSchema.safeParse({ findings: [finding({ severity: "blocker" })] }).success,
  ).toBe(false);
});

test("schema accepts an empty findings list (a clean review)", () => {
  expect(ReviewOutputSchema.safeParse({ findings: [] }).success).toBe(true);
});

test("computeBlocksShip: critical always blocks, even if deferral_candidate", () => {
  expect(computeBlocksShip("critical", true)).toBe(1);
  expect(computeBlocksShip("critical", false)).toBe(1);
});

test("computeBlocksShip: major blocks unless deferred", () => {
  expect(computeBlocksShip("major", false)).toBe(1);
  expect(computeBlocksShip("major", true)).toBe(0);
});

test("computeBlocksShip: minor and nit never block", () => {
  expect(computeBlocksShip("minor", false)).toBe(0);
  expect(computeBlocksShip("nit", false)).toBe(0);
});

test("validateReviewFindings rejects a dangling work_unit_seq", () => {
  const errors = validateReviewFindings([finding({ work_unit_seq: 9 })], [1, 2]);
  expect(errors.some((e) => e.includes("work_unit_seq"))).toBe(true);
});

test("validateReviewFindings rejects a deferral-flagged critical", () => {
  const errors = validateReviewFindings(
    [finding({ severity: "critical", deferral_candidate: true })],
    [1],
  );
  expect(errors.some((e) => e.includes("non-deferrable"))).toBe(true);
});

test("computeBlocksShip: minor with deferral_candidate never blocks", () => {
  expect(computeBlocksShip("minor", true)).toBe(0);
});

test("computeBlocksShip: nit with deferral_candidate never blocks", () => {
  expect(computeBlocksShip("nit", true)).toBe(0);
});

test("validateReviewFindings accepts a clean set (null unit seq allowed)", () => {
  expect(validateReviewFindings([finding({ work_unit_seq: null })], [1])).toEqual([]);
});
