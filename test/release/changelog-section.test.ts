// test/release/changelog-section.test.ts
import { expect, test } from "bun:test";
import { extractSection } from "../../scripts/changelog-section.ts";

const CL =
  "# Changelog\n\nAll notable changes to this project are documented here.\n" +
  "## [0.5.0] - 2026-07-07\n\n### Features\n- New thing\n\n" +
  "## [0.4.0] - 2026-07-06\n\n### Features\n- Old thing\n";

test("extracts a middle section body without its heading", () => {
  expect(extractSection(CL, "0.5.0")).toBe("### Features\n- New thing");
});

test("extracts the last section", () => {
  expect(extractSection(CL, "v0.4.0")).toBe("### Features\n- Old thing");
});

test("returns null when the version is absent", () => {
  expect(extractSection(CL, "0.9.9")).toBeNull();
});

test("does not match a version that is a prefix of another", () => {
  const cl = "# Changelog\n\n## [0.5.0] - 2026-07-07\n\n- real\n## [0.5.01] - x\n\n- other\n";
  expect(extractSection(cl, "0.5.0")).toBe("- real");
});
