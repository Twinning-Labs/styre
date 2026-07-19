import { expect, test } from "bun:test";
import {
  ExtractOutputSchema,
  isMigrationKind,
  validateCdotImpact,
  validateExtraction,
} from "../../src/dispatch/extract-schema.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

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

test("validateExtraction rejects a unit with no files_to_touch", () => {
  const errors = validateExtraction([
    {
      seq: 1,
      kind: "backend",
      title: "t",
      description: "d",
      behavioral: false,
      test_plan: null,
      files_to_touch: [], // vacuous
      verify_check_types: [],
      depends_on: [],
    },
  ]);
  expect(errors.some((e) => e.includes("no files_to_touch"))).toBe(true);
});

// STYRE-7: a unit whose ONLY deliverable is an implement-authored test that also covers an
// acceptance criterion is a valid third shape (neither a code unit nor a "tests are the deliverable"
// coverage ticket). The actual STYRE-7 erasure was a PROMPT-level misclassification (design-extract
// nulled the file), which no unit test can cover; Fix A corrects the prompt. This test is
// defense-in-depth on the SCHEMA side only — it would catch a future purpose-based rule wrongly added
// to validateExtraction. validateExtraction never checked purpose, so it accepted this shape before
// Fix A too; the value here is pinning that it must continue to.
test("validateExtraction accepts a unit declaring only a product test (STYRE-7 third shape)", () => {
  expect(
    validateExtraction([
      unit({
        behavioral: true,
        test_plan: "assert exact iCal properties on fixed timestamps",
        files_to_touch: ["tests/Unit/IcsTest.php"],
        verify_check_types: ["test"],
      }),
    ]),
  ).toEqual([]);
});

// ─── cdotImpact schema + profile-consistency gate ────────────────────────────

const baseUnits = [
  {
    seq: 1,
    kind: "backend",
    title: "t",
    description: "d",
    behavioral: false,
    test_plan: null,
    files_to_touch: [],
    verify_check_types: [],
    depends_on: [],
  },
];

function out(o: unknown) {
  return ExtractOutputSchema.parse({ units: baseUnits, ...(o as object) });
}

// Default non-named sections to "absent" so each test isolates the rule under test
// (a defaulted "unknown" would itself trip the coverage rule). A section named in `rc`
// fully replaces its absent base.
const ABSENT_BASE = {
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
};
const profileWith = (rc: object) =>
  parseProfile({ slug: "d", targetRepo: "/t", runtimeContext: { ...ABSENT_BASE, ...rc } });

test("isMigrationKind recognizes data/migration kinds", () => {
  expect(isMigrationKind("migration")).toBe(true);
  expect(isMigrationKind("Data")).toBe(true);
  expect(isMigrationKind("db")).toBe(true);
  expect(isMigrationKind("schema")).toBe(true);
  expect(isMigrationKind("SCHEMA")).toBe(true);
  expect(isMigrationKind("frontend")).toBe(false);
});

test("coverage: a flagged section with empty analysis fails", () => {
  const profile = profileWith({ caching: { presence: "present" } });
  const errors = validateCdotImpact(
    out({ cdotImpact: { caching: { applies: false, analysis: "" } } }),
    profile,
  );
  expect(errors.some((e) => e.includes("caching"))).toBe(true);
});

test("coverage: an absent section is not forced", () => {
  const profile = profileWith({ caching: { presence: "absent" } });
  expect(validateCdotImpact(out({}), profile)).toEqual([]);
});

test("coverage: unknown is must-address (headless safety net)", () => {
  const profile = profileWith({ data: { presence: "unknown" } });
  const errors = validateCdotImpact(out({}), profile);
  expect(errors.some((e) => e.includes("data"))).toBe(true);
});

test("migration: schemaChange without a migration unit fails", () => {
  const profile = profileWith({ data: { presence: "present" } });
  const errors = validateCdotImpact(
    out({ cdotImpact: { data: { applies: true, analysis: "adds column", schemaChange: true } } }),
    profile,
  );
  expect(errors.some((e) => e.includes("migration"))).toBe(true);
});

test("migration: a migration unit ordered first passes", () => {
  const profile = profileWith({ data: { presence: "present" } });
  const units = [
    {
      seq: 1,
      kind: "migration",
      title: "m",
      description: "d",
      behavioral: false,
      test_plan: null,
      files_to_touch: [],
      verify_check_types: [],
      depends_on: [],
    },
    {
      seq: 2,
      kind: "backend",
      title: "b",
      description: "d",
      behavioral: true,
      test_plan: "t",
      files_to_touch: [],
      verify_check_types: ["test"],
      depends_on: [1],
    },
  ];
  const o = ExtractOutputSchema.parse({
    units,
    cdotImpact: { data: { applies: true, analysis: "adds column", schemaChange: true } },
  });
  expect(validateCdotImpact(o, profile)).toEqual([]);
});

test("migration: a migration unit ordered AFTER a domain unit fails", () => {
  const profile = profileWith({ data: { presence: "present" } });
  const units = [
    {
      seq: 1,
      kind: "backend",
      title: "b",
      description: "d",
      behavioral: true,
      test_plan: "t",
      files_to_touch: [],
      verify_check_types: ["test"],
      depends_on: [],
    },
    {
      seq: 2,
      kind: "migration",
      title: "m",
      description: "d",
      behavioral: false,
      test_plan: null,
      files_to_touch: [],
      verify_check_types: [],
      depends_on: [],
    },
  ];
  const o = ExtractOutputSchema.parse({
    units,
    cdotImpact: { data: { applies: true, analysis: "x", schemaChange: true } },
  });
  expect(validateCdotImpact(o, profile).some((e) => e.includes("ordered before"))).toBe(true);
});
