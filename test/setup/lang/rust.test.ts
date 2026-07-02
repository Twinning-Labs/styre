import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rustDef } from "../../../src/setup/lang/rust.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-rust-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("rust: workspace collapses members into one rust-core component", () => {
  const root = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["src-tauri", "crates/a", "crates/b"]\n',
    "Cargo.lock": "",
    "src-tauri/Cargo.toml": '[package]\nname="app"\n',
    "crates/a/Cargo.toml": '[package]\nname="a"\n',
    "crates/b/Cargo.toml": '[package]\nname="b"\n',
  });
  const components = rustDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("rust-core");
  expect(c.kind).toBe("rust");
  expect(c.paths).toContain("Cargo.toml");
  expect(c.paths).toContain("Cargo.lock");
  expect(c.paths).toContain("src-tauri/**");
  expect(c.paths).toContain("crates/**");
  expect(c.commands.build).toBe("cargo build --workspace");
  expect(c.commands.test).toBe("cargo test --workspace");
});

test("rust: standalone Cargo.toml at repo root → one rust component", () => {
  const root = fixture({
    "Cargo.toml": '[package]\nname="standalone"\n',
  });
  const components = rustDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("rust");
  expect(c.kind).toBe("rust");
  expect(c.paths).toEqual(["**"]);
  expect(c.commands.build).toBe("cargo build");
  expect(c.commands.test).toBe("cargo test");
  expect(c.dir).toBeUndefined();
});

test("rust: standalone Cargo.toml in subdirectory → component named by dir", () => {
  const root = fixture({
    "src-tauri/Cargo.toml": '[package]\nname="app"\n',
  });
  const components = rustDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("src-tauri");
  expect(c.paths).toEqual(["src-tauri/**"]);
});

// ─── WO-9 Task 6: dir retrofit on non-root Rust components ───────────────────

test("rust: non-workspace subdir Cargo.toml → component carries dir for correct cwd", () => {
  const root = fixture({
    "crates/a/Cargo.toml": '[package]\nname="a"\n',
  });
  const components = rustDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("crates-a");
  expect(c.dir).toBe("crates/a");
});

test("rust: workspace-collapse root component carries no dir", () => {
  const root = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["crates/a"]\n',
    "crates/a/Cargo.toml": '[package]\nname="a"\n',
  });
  const components = rustDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].dir).toBeUndefined();
});

test("rust: no Cargo.toml → no components", () => {
  const root = fixture({ "README.md": "x" });
  expect(rustDef.detect(root)).toHaveLength(0);
});

// INVARIANT-2: malicious members are filtered before collapse
test("rust: workspace members with unsafe paths are filtered (INVARIANT-2)", () => {
  const root = fixture({
    // members include: glob star, path traversal, absolute path, embedded traversal, one safe one
    "Cargo.toml": '[workspace]\nmembers = ["*", "../escape", "/abs", "a/ ../b", "ok"]\n',
    "ok/Cargo.toml": '[package]\nname="ok"\n',
  });
  const components = rustDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("rust-core");
  // Only the safe "ok" member survives → collapses to "ok/**"
  expect(c.paths).toContain("Cargo.toml");
  expect(c.paths).toContain("Cargo.lock");
  expect(c.paths).toContain("ok/**");
  // Unsafe members must not appear in paths
  expect(c.paths.some((p) => p.includes("escape"))).toBe(false);
  expect(c.paths.some((p) => p.startsWith("/"))).toBe(false);
  expect(c.paths.some((p) => p.includes("*") && p !== "ok/**")).toBe(false);
});
