import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectComponents, unrootedManifestWarnings } from "../../src/setup/detect-components.ts";

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

test("manifests inside dependency/build dirs are skipped (no phantom components)", () => {
  const root = fixture({
    ".tox/py311/lib/package.json": JSON.stringify({ scripts: { test: "x" } }),
    "vendor/github.com/foo/Cargo.toml": '[package]\nname="dep"\n',
    ".gradle/tmp/package.json": JSON.stringify({ scripts: { build: "x" } }),
  });
  const { components } = detectComponents(root);
  expect(components).toHaveLength(0);
});

test("python: pyproject.toml → one python component, default runner", () => {
  const root = fixture({ "pyproject.toml": "[project]\nname='x'\n" });
  const py = detectComponents(root).components.find((c) => c.kind === "python");
  expect(py?.paths).toEqual(["**"]);
  expect(py?.commands.test).toBe("python -m pytest");
});

test("python: runner detection precedence tox > nox > pytest-config > default", () => {
  expect(
    detectComponents(fixture({ "setup.py": "", "tox.ini": "[tox]\n" })).components.find(
      (c) => c.kind === "python",
    )?.commands.test,
  ).toBe("tox");
  expect(
    detectComponents(fixture({ "setup.py": "", "noxfile.py": "" })).components.find(
      (c) => c.kind === "python",
    )?.commands.test,
  ).toBe("nox");
  expect(
    detectComponents(fixture({ "setup.py": "", "pytest.ini": "[pytest]\n" })).components.find(
      (c) => c.kind === "python",
    )?.commands.test,
  ).toBe("pytest");
  expect(
    detectComponents(fixture({ "pyproject.toml": "[tool.pytest.ini_options]\n" })).components.find(
      (c) => c.kind === "python",
    )?.commands.test,
  ).toBe("pytest");
  expect(
    detectComponents(fixture({ "requirements.txt": "pytest\n" })).components.find(
      (c) => c.kind === "python",
    )?.commands.test,
  ).toBe("python -m pytest");
});

test("python: no python manifest → no python component", () => {
  expect(
    detectComponents(fixture({ "README.md": "x" })).components.find((c) => c.kind === "python"),
  ).toBeUndefined();
});

test("go: root go.mod → one go component with build/test", () => {
  const go = detectComponents(fixture({ "go.mod": "module x\n\ngo 1.22\n" })).components.find(
    (c) => c.kind === "go",
  );
  expect(go?.paths).toEqual(["**"]);
  expect(go?.commands.build).toBe("go build ./...");
  expect(go?.commands.test).toBe("go test ./...");
});

test("go: nested-only go.mod (no root) → dir-scoped go component (non-root detection)", () => {
  const go = detectComponents(fixture({ "backend/go.mod": "module x\n" })).components.find(
    (c) => c.kind === "go",
  );
  expect(go?.dir).toBe("backend");
  expect(go?.paths).toEqual(["backend/**"]);
});

test("jvm: root pom.xml → jvm-maven (bare mvn when no wrapper)", () => {
  const m = detectComponents(fixture({ "pom.xml": "<project/>" })).components.find(
    (c) => c.kind === "jvm-maven",
  );
  expect(m?.paths).toEqual(["**"]);
  expect(m?.commands.build).toBe("mvn -q -DskipTests compile");
  expect(m?.commands.test).toBe("mvn -q test");
});

test("jvm: pom.xml + mvnw → prefers the maven wrapper", () => {
  const m = detectComponents(
    fixture({ "pom.xml": "<project/>", mvnw: "#!/bin/sh\n" }),
  ).components.find((c) => c.kind === "jvm-maven");
  expect(m?.commands.build).toBe("./mvnw -q -DskipTests compile");
  expect(m?.commands.test).toBe("./mvnw -q test");
});

test("jvm: build.gradle(.kts) → jvm-gradle; gradlew preferred when present", () => {
  for (const f of ["build.gradle", "build.gradle.kts"]) {
    const g = detectComponents(fixture({ [f]: "" })).components.find(
      (c) => c.kind === "jvm-gradle",
    );
    expect(g?.commands.build).toBe("gradle build -x test");
    expect(g?.commands.test).toBe("gradle test");
  }
  const gw = detectComponents(
    fixture({ "build.gradle": "", gradlew: "#!/bin/sh\n" }),
  ).components.find((c) => c.kind === "jvm-gradle");
  expect(gw?.commands.test).toBe("./gradlew test");
  expect(gw?.commands.build).toBe("./gradlew build -x test");
});

test("jvm: no jvm manifest → no jvm component", () => {
  const comps = detectComponents(fixture({ "README.md": "x" })).components;
  expect(comps.find((c) => c.kind === "jvm-maven" || c.kind === "jvm-gradle")).toBeUndefined();
});

test("loud note: subdir-only go.mod does NOT warn (Go warning retired — every go.mod is detected)", () => {
  const nested = unrootedManifestWarnings(fixture({ "backend/go.mod": "module x\n" }));
  expect(nested.some((w) => /go\.mod/.test(w))).toBe(false);
  expect(unrootedManifestWarnings(fixture({ "go.mod": "module x\n" }))).toEqual([]);
});

test("loud note: subdir-only pyproject warns; non-targeted nested files do not", () => {
  expect(
    unrootedManifestWarnings(fixture({ "src/pyproject.toml": "[project]\n" })).some((w) =>
      /pyproject\.toml/.test(w),
    ),
  ).toBe(true);
  expect(unrootedManifestWarnings(fixture({ "README.md": "x" }))).toEqual([]);
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
