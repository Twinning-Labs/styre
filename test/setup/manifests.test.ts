import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findManifests } from "../../src/setup/manifests.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-manifests-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("findManifests skips testdata/ fixture manifests", () => {
  const root = fixture({
    "go.mod": "module x\n\ngo 1.22\n",
    "testdata/go.mod": "module fixture\n",
    "pkg/testdata/nested/go.mod": "module fixture2\n",
  });
  const found = findManifests(root, "go.mod");
  expect(found).toEqual(["go.mod"]);
  expect(found.some((p) => p.includes("testdata"))).toBe(false);
});

test("findManifests returns results in deterministic sorted order", () => {
  // Directory names chosen so raw readdir order (typically creation/insertion order on most
  // filesystems) would NOT already be sorted, forcing the sort to do real work.
  const root = fixture({
    "zeta/go.mod": "module zeta\n",
    "mu/go.mod": "module mu\n",
    "alpha/go.mod": "module alpha\n",
    "go.mod": "module root\n",
  });
  const found = findManifests(root, "go.mod");
  const sorted = [...found].sort();
  expect(found).toEqual(sorted);
  expect(found).toEqual(["alpha/go.mod", "go.mod", "mu/go.mod", "zeta/go.mod"]);
});
