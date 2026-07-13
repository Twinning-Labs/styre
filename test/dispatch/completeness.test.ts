import { describe, expect, test } from "bun:test";
import {
  classifyDisposition,
  declaredMatches,
  reconcileScope,
} from "../../src/dispatch/completeness.ts";

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

describe("declaredMatches", () => {
  test("token-free entry matches by exact equality", () => {
    expect(declaredMatches("src/parse.ts", "src/parse.ts")).toBe(true);
    expect(declaredMatches("src/parse.ts", "src/other.ts")).toBe(false);
  });

  test("a <token> matches a single path segment", () => {
    const decl = "docs/changes/modeling/<id>.bugfix.rst";
    expect(declaredMatches(decl, "docs/changes/modeling/12907.bugfix.rst")).toBe(true);
    expect(declaredMatches(decl, "docs/changes/modeling/pr-4242.bugfix.rst")).toBe(true);
  });

  test("a <token> does NOT match across a / boundary", () => {
    const decl = "docs/changes/modeling/<id>.bugfix.rst";
    expect(declaredMatches(decl, "docs/changes/modeling/sub/12907.bugfix.rst")).toBe(false);
  });

  test("wrong literal around a token does not match", () => {
    const decl = "docs/changes/modeling/<id>.bugfix.rst";
    expect(declaredMatches(decl, "docs/changes/modeling/12907.feature.rst")).toBe(false);
  });

  test("multiple tokens in one path", () => {
    expect(declaredMatches("a/<x>/b/<y>.ts", "a/1/b/2.ts")).toBe(true);
    expect(declaredMatches("a/<x>/b/<y>.ts", "a/1/2/b/3.ts")).toBe(false);
  });

  test("a literal < with no closing > is an exact literal", () => {
    expect(declaredMatches("a<b.ts", "a<b.ts")).toBe(true);
    expect(declaredMatches("a<b.ts", "axb.ts")).toBe(false);
  });
});

describe("reconcileScope wildcard", () => {
  test("a placeholder entry is satisfied by its produced file (not under-delivered)", () => {
    const r = reconcileScope(
      ["docs/changes/modeling/<id>.bugfix.rst"],
      ["docs/changes/modeling/12907.bugfix.rst"],
      [],
    );
    expect(r.under).toEqual([]);
  });

  test("a placeholder that matches nothing stays under-delivered", () => {
    const r = reconcileScope(["docs/changes/modeling/<id>.bugfix.rst"], ["src/other.ts"], []);
    expect(r.under).toEqual(["docs/changes/modeling/<id>.bugfix.rst"]);
  });

  test("over is resolution-aware: the produced file of a placeholder is not over-delivery", () => {
    const r = reconcileScope(["<id>.bugfix.rst"], ["12907.bugfix.rst"], ["12907.bugfix.rst"]);
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
