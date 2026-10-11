// test/dispatch/plan-frontmatter.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasTicketPlan,
  linearFromFrontmatter,
  planFrontmatterLinear,
} from "../../src/dispatch/plan-frontmatter.ts";
import { makeTempDir } from "../helpers/temp.ts";

function tmp(): string {
  return makeTempDir("styre-pf-");
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

test("linearFromFrontmatter reads only the leading frontmatter, whole value, CRLF too", () => {
  expect(linearFromFrontmatter("---\nlinear: ENG-1\n---\n\nbody\n")).toBe("ENG-1");
  expect(linearFromFrontmatter("---\r\ntitle: x\r\nlinear: ENG-1\r\n---\r\nbody\r\n")).toBe(
    "ENG-1",
  );
  expect(linearFromFrontmatter("---\nlinear: ENG-10\n---\n")).toBe("ENG-10");
  // a mention in the body, or frontmatter that does not lead the file, does not count
  expect(linearFromFrontmatter("---\ntitle: x\n---\n\nlinear: ENG-1\n")).toBeNull();
  expect(linearFromFrontmatter("# Plan\n---\nlinear: ENG-1\n---\n")).toBeNull();
  expect(linearFromFrontmatter("no frontmatter")).toBeNull();
});
