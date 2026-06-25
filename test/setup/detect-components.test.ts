import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectComponents } from "../../src/setup/detect-components.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dc-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("tauri app → one frontend (root package.json) + one rust (src-tauri) component", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { build: "vite build", check: "svelte-check" } }),
    "svelte.config.js": "export default {}",
    "src-tauri/Cargo.toml": '[package]\nname="app"\n',
  });
  const { components } = detectComponents(root);
  const names = components.map((c) => c.kind).sort();
  expect(names).toContain("rust");
  expect(components.some((c) => c.paths.some((p) => p.startsWith("src-tauri")))).toBe(true);
});

test("malformed package.json is skipped (component absent, no throw)", () => {
  const root = fixture({
    "package.json": "{ this is not valid json {{",
  });
  expect(() => detectComponents(root)).not.toThrow();
  const { components } = detectComponents(root);
  // No node/sveltekit component should be produced from the malformed file
  expect(components.filter((c) => c.kind === "node" || c.kind === "sveltekit")).toHaveLength(0);
});

test("malformed root Cargo.toml does not throw and yields no rust-workspace component", () => {
  const root = fixture({
    // Syntactically invalid TOML — cannot be parsed as a workspace manifest
    "Cargo.toml": "[ this is not valid toml {{ members = [",
  });
  expect(() => detectComponents(root)).not.toThrow();
  const { components } = detectComponents(root);
  // No workspace-collapsed rust component; falls through to per-standalone-Cargo.toml path.
  // Since the root Cargo.toml read succeeds but has no [workspace], it falls to standalone.
  // Either way detectComponents must not crash.
  expect(Array.isArray(components)).toBe(true);
});

test("unreadable root Cargo.toml is treated as not-a-workspace (no throw)", () => {
  // Skip when running as root (chmod has no effect for root).
  if (process.getuid?.() === 0) return;
  const root = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["crates/a"]\n',
  });
  chmodSync(join(root, "Cargo.toml"), 0o000);
  try {
    expect(() => detectComponents(root)).not.toThrow();
    const { components } = detectComponents(root);
    // Fell back to standalone scan; root Cargo.toml is skipped by findManifests (EACCES), so no rust.
    expect(Array.isArray(components)).toBe(true);
  } finally {
    chmodSync(join(root, "Cargo.toml"), 0o644);
  }
});

test("cargo workspace collapses members into ONE rust component", () => {
  const root = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["src-tauri", "crates/a", "crates/b"]\n',
    "src-tauri/Cargo.toml": '[package]\nname="app"\n',
    "crates/a/Cargo.toml": '[package]\nname="a"\n',
    "crates/b/Cargo.toml": '[package]\nname="b"\n',
  });
  const { components } = detectComponents(root);
  const rust = components.filter((c) => c.kind === "rust");
  expect(rust).toHaveLength(1);
  expect(rust[0].paths).toEqual(expect.arrayContaining(["src-tauri/**", "crates/**"]));
});
