import { expect, test } from "bun:test";
import { branchPrefixFor, deriveTypeLabel } from "../../src/integrations/ticket-source.ts";

test("deriveTypeLabel matches a Bug/Feature/Improvement label case-insensitively", () => {
  expect(deriveTypeLabel(["bug"])).toBe("Bug");
  expect(deriveTypeLabel(["Improvement", "p1"])).toBe("Improvement");
  expect(deriveTypeLabel(["Feature"])).toBe("Feature");
});

test("deriveTypeLabel defaults to Feature when no type label is present", () => {
  expect(deriveTypeLabel([])).toBe("Feature");
  expect(deriveTypeLabel(["p1", "frontend"])).toBe("Feature");
});

test("branchPrefixFor: Bug→fix, else feat", () => {
  expect(branchPrefixFor("Bug")).toBe("fix");
  expect(branchPrefixFor("Feature")).toBe("feat");
  expect(branchPrefixFor("Improvement")).toBe("feat");
});
