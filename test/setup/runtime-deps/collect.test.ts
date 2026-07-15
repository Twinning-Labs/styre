import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectManifestDeps,
  renderManifestDeps,
} from "../../../src/setup/runtime-deps/collect.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-rtdeps-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("collect: polyglot repo → per-language deduped lists", () => {
  const root = fixture({
    "package.json": JSON.stringify({ dependencies: { prisma: "^5" } }),
    "backend/pyproject.toml": '[project]\ndependencies = ["sqlalchemy>=2"]\n',
    "backend/requirements.txt": "sqlalchemy\nfastapi\n",
  });
  const map = collectManifestDeps(root);
  expect(map.node).toEqual(["prisma"]);
  expect(map.python?.sort()).toEqual(["fastapi", "sqlalchemy"]); // deduped across two manifests
});

test("collect: gradle catalog under gradle/ is found and parsed", () => {
  const root = fixture({
    "build.gradle": 'implementation "org.springframework:spring-web:6.0"',
    "gradle/libs.versions.toml": '[libraries]\nhib = { module = "org.hibernate:hibernate-core" }\n',
  });
  expect(collectManifestDeps(root).jvm?.sort()).toEqual(
    ["org.hibernate:hibernate-core", "org.springframework:spring-web"].sort(),
  );
});

test("collect: missing directory → {} (fail-soft, no throw)", () => {
  expect(collectManifestDeps("/nonexistent/repo/path/xyz")).toEqual({});
});

test("collect: repo with no manifests → {}", () => {
  expect(collectManifestDeps(fixture({ "README.md": "hi" }))).toEqual({});
});

test("render: empty map → placeholder; populated → one line per language", () => {
  expect(renderManifestDeps({})).toBe("(no dependency manifests detected)");
  expect(renderManifestDeps({ python: ["fastapi", "sqlalchemy"], node: ["react"] })).toBe(
    "- node: react\n- python: fastapi, sqlalchemy",
  );
});
