import { describe, expect, test } from "bun:test";
import { classifyDisposition, reconcileScope } from "../../src/dispatch/completeness.ts";

describe("reconcileScope", () => {
  test("under = declared not in cumulative; over = own not in declared", () => {
    const r = reconcileScope(["a.ts", "b.ts"], ["a.ts", "c.ts"], ["c.ts"]);
    expect(r.under).toEqual(["b.ts"]); // b declared, touched by no one
    expect(r.over).toEqual(["c.ts"]); // c touched by this unit, not declared
  });

  test("declared file touched by a sibling only ⇒ not under-delivered", () => {
    // this unit's own diff is empty, but a sibling touched the declared file
    const r = reconcileScope(["parse.ts"], ["parse.ts", "other.ts"], []);
    expect(r.under).toEqual([]);
    expect(r.over).toEqual([]);
  });
});

describe("classifyDisposition", () => {
  test("any under ⇒ under-delivered", () => {
    expect(classifyDisposition(["x.ts"], ["y.ts"])).toBe("under-delivered");
  });
  test("no under + empty own diff ⇒ covered-by-sibling", () => {
    expect(classifyDisposition([], [])).toBe("covered-by-sibling");
  });
  test("no under + non-empty own diff ⇒ completed-by-self", () => {
    expect(classifyDisposition([], ["a.ts"])).toBe("completed-by-self");
  });
});
