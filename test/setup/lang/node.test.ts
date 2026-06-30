import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeDef } from "../../../src/setup/lang/node.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-node-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("node: root package.json + svelte.config.js → sveltekit frontend scoped to src/static/package.json", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { build: "vite build", check: "svelte-check" } }),
    "svelte.config.js": "export default {}",
  });
  const components = nodeDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("frontend");
  expect(c.kind).toBe("sveltekit");
  expect(c.paths).toEqual(["src/**", "static/**", "package.json"]);
  expect(c.commands.build).toBe("npm run build");
  expect(c.commands.check).toBe("npm run check");
  expect(c.commands.test).toBeUndefined();
});

test("node: root package.json + vite.config.js → sveltekit kind", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "vite.config.js": "export default {}",
  });
  const components = nodeDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].kind).toBe("sveltekit");
  expect(components[0].name).toBe("frontend");
});

test("node: root package.json without svelte/vite config → node kind named frontend", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
  });
  const components = nodeDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].name).toBe("frontend");
  expect(components[0].kind).toBe("node");
  expect(components[0].paths).toEqual(["src/**", "static/**", "package.json"]);
  expect(components[0].commands.test).toBe("npm run test");
});

test("node: non-root package.json → name from dir, kind node, paths [dir/**]", () => {
  const root = fixture({
    "pkgs/api/package.json": JSON.stringify({ scripts: { test: "jest" } }),
  });
  const components = nodeDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("pkgs-api");
  expect(c.kind).toBe("node");
  expect(c.paths).toEqual(["pkgs/api/**"]);
  expect(c.commands.test).toBe("npm run test");
  expect(c.commands.build).toBeUndefined();
});

test("node: only scripts present in package.json are added as commands", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest", check: "check" } }),
  });
  const [c] = nodeDef.detect(root);
  expect(c.commands.build).toBe("npm run build");
  expect(c.commands.test).toBe("npm run test");
  expect(c.commands.check).toBe("npm run check");
});

test("node: package.json with no scripts → empty commands", () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "pkg" }),
  });
  const [c] = nodeDef.detect(root);
  expect(c.commands).toEqual({});
});

test("node: malformed package.json → no component, no throw", () => {
  const root = fixture({
    "package.json": "{ this is not valid json {{",
  });
  expect(() => nodeDef.detect(root)).not.toThrow();
  expect(nodeDef.detect(root)).toHaveLength(0);
});

test("node: no package.json → no components", () => {
  const root = fixture({ "README.md": "x" });
  expect(nodeDef.detect(root)).toHaveLength(0);
});

test("node: multiple package.json files → one component per file", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "apps/web/package.json": JSON.stringify({ scripts: { build: "vite" } }),
    "apps/api/package.json": JSON.stringify({ scripts: { test: "jest" } }),
  });
  const components = nodeDef.detect(root);
  expect(components).toHaveLength(3);
  const names = components.map((c) => c.name).sort();
  expect(names).toContain("frontend");
  expect(names).toContain("apps-web");
  expect(names).toContain("apps-api");
});

// ─── WO-3 Task 3: prepare field ──────────────────────────────────────────────

test("node: every emitted component carries prepare: 'npm install'", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "apps/api/package.json": JSON.stringify({ scripts: { test: "jest" } }),
  });
  const components = nodeDef.detect(root);
  expect(components).toHaveLength(2);
  for (const c of components) {
    expect(c.prepare).toBe("npm install");
  }
});

test("node: prepare is set even when scripts is empty", () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "pkg" }),
  });
  const [c] = nodeDef.detect(root);
  expect(c.prepare).toBe("npm install");
});
