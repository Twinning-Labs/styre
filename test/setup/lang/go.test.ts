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

test("go: single root go.mod → one root component (unchanged)", () => {
  const root = fixture({ "go.mod": "module x\n", "main.go": "" });
  const cs = goDef.detect(root);
  expect(cs).toEqual([
    {
      name: "go",
      kind: "go",
      paths: ["**"],
      commands: { build: "go build ./...", test: "go test ./..." },
    },
  ]);
});

test("go: subdir-only monorepo → per-subdir dir-scoped components", () => {
  const root = fixture({
    "services/api/go.mod": "module api\n",
    "services/worker/go.mod": "module w\n",
  });
  const cs = goDef.detect(root).sort((a, b) => a.name.localeCompare(b.name));
  expect(cs.map((c) => [c.name, c.dir, c.paths[0]])).toEqual([
    ["services-api", "services/api", "services/api/**"],
    ["services-worker", "services/worker", "services/worker/**"],
  ]);
});

test("go: root + nested go.mod → root ['**'] AND a nested dir-scoped component", () => {
  const root = fixture({ "go.mod": "module x\n", "tools/gen/go.mod": "module gen\n" });
  const cs = goDef.detect(root);
  expect(cs.find((c) => c.dir === undefined)?.paths).toEqual(["**"]);
  expect(cs.find((c) => c.dir === "tools/gen")?.paths).toEqual(["tools/gen/**"]);
});
