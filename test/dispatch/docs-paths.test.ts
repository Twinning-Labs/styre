import { expect, test } from "bun:test";
import { DOC_PATHS_HINT, isDocPath, isPlanPath } from "../../src/dispatch/docs-paths.ts";

test("accepts repo-root docs/ tree and root doc-family (case-insensitive)", () => {
  for (const p of [
    "docs/x.rst",
    "docs/a/b.md",
    "README.md",
    "README.rst",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "mkdocs.yml",
    "Docs/x.md",
  ]) {
    expect(isDocPath(p)).toBe(true);
  }
});

test("rejects source/tests and nested docs (fail-closed)", () => {
  for (const p of [
    "src/foo.py",
    "test/foo_test.py",
    "src/README.md",
    "src/docs/Component.tsx",
    "pkg/docs/gen.go",
    "docsource/x.md",
    "app/mkdocs.yml",
    "docs/../src/foo.ts",
    "docs/../../etc/passwd",
  ]) {
    expect(isDocPath(p)).toBe(false);
  }
});

test("normalizes ./ prefix and backslashes", () => {
  expect(isDocPath("./docs/x.md")).toBe(true);
  expect(isDocPath("docs\\x.md")).toBe(true);
  expect(isDocPath("./src/foo.py")).toBe(false);
});

test("DOC_PATHS_HINT is a non-empty human-readable string", () => {
  expect(DOC_PATHS_HINT.length).toBeGreaterThan(0);
});

test("isPlanPath: docs/plans/ only", () => {
  expect(isPlanPath("docs/plans/ENG-1.md")).toBe(true);
  expect(isPlanPath("./docs/plans/x.md")).toBe(true);
  expect(isPlanPath("docs/design/x.md")).toBe(false);
  expect(isPlanPath("src/plans/x.py")).toBe(false);
  expect(isPlanPath("docs/plans/../../src/x.py")).toBe(false);
});
