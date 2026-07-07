// test/dispatch/plan-frontmatter.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFrontmatterLinear, hasTicketPlan } from "../../src/dispatch/plan-frontmatter.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "styre-pf-"));
}

test("planFrontmatterLinear reads linear: from leading frontmatter", () => {
  const d = tmp();
  const p = join(d, "ENG-1-slug.md");
  writeFileSync(p, "---\nlinear: ENG-1\n---\n# Plan\nbody\n");
  expect(planFrontmatterLinear(p)).toBe("ENG-1");
});

test("planFrontmatterLinear returns null without frontmatter", () => {
  const d = tmp();
  const p = join(d, "x.md");
  writeFileSync(p, "# Plan\nlinear: ENG-1 (in body, not frontmatter)\n");
  expect(planFrontmatterLinear(p)).toBeNull();
});

test("planFrontmatterLinear returns null for a missing file", () => {
  expect(planFrontmatterLinear(join(tmp(), "nope.md"))).toBeNull();
});

test("hasTicketPlan matches only this ticket's plan", () => {
  const plans = join(tmp(), "docs", "plans");
  mkdirSync(plans, { recursive: true });
  writeFileSync(join(plans, "ENG-1.md"), "---\nlinear: ENG-1\n---\n");
  writeFileSync(join(plans, "ENG-2.md"), "---\nlinear: ENG-2\n---\n");
  expect(hasTicketPlan(plans, "ENG-1")).toBe(true);
  expect(hasTicketPlan(plans, "ENG-3")).toBe(false); // only a stale/other-ticket plan present
});

test("hasTicketPlan is false when the plans dir is absent", () => {
  expect(hasTicketPlan(join(tmp(), "docs", "plans"), "ENG-1")).toBe(false);
});
