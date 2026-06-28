import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goDef } from "../../../src/setup/lang/go.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-go-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("go: root go.mod → one go component with build/test", () => {
  const root = fixture({ "go.mod": "module x\n\ngo 1.22\n" });
  const components = goDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("go");
  expect(c.kind).toBe("go");
  expect(c.paths).toEqual(["**"]);
  expect(c.commands.build).toBe("go build ./...");
  expect(c.commands.test).toBe("go test ./...");
});

test("go: no go.mod → no components", () => {
  const root = fixture({ "README.md": "x" });
  expect(goDef.detect(root)).toHaveLength(0);
});

test("go: nested-only go.mod → no component (root-only detection)", () => {
  const root = fixture({ "backend/go.mod": "module x\n" });
  expect(goDef.detect(root)).toHaveLength(0);
});
