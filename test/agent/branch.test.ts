import { expect, test } from "bun:test";
import { branchNameFor } from "../../src/agent/branch.ts";

test("uses an explicit branch_name when present", () => {
  expect(
    branchNameFor({ ident: "ENG-9", branch_name: "feat/ENG-9-x", branch_prefix: "feat" }),
  ).toBe("feat/ENG-9-x");
});

test("derives from prefix + ident when branch_name is null", () => {
  expect(branchNameFor({ ident: "ENG-9", branch_name: null, branch_prefix: "fix" })).toBe(
    "fix/ENG-9",
  );
});

test("defaults the prefix to feat when both are null", () => {
  expect(branchNameFor({ ident: "ENG-9", branch_name: null, branch_prefix: null })).toBe(
    "feat/ENG-9",
  );
});
