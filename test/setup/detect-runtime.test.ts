import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntimeContext } from "../../src/setup/detect-runtime.ts";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-rt-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("detects data via prisma schema + sets migrationTool", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ dependencies: { "@prisma/client": "5" } }),
    "prisma/schema.prisma": "datasource db {}",
  });
  const rc = detectRuntimeContext(dir);
  expect(rc.data.presence).toBe("present");
  expect(rc.data.migrationTool).toBe("prisma");
  expect(rc.data.detail).toContain("prisma");
});

test("detects caching + observability from deps", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ dependencies: { ioredis: "5", pino: "9" } }),
  });
  const rc = detectRuntimeContext(dir);
  expect(rc.caching.presence).toBe("present");
  expect(rc.observability.presence).toBe("present");
});

test("detects documentation from docs dir + changelog", () => {
  const dir = fixture({ "docs/x.md": "x", "CHANGELOG.md": "log" });
  const rc = detectRuntimeContext(dir);
  expect(rc.documentation.presence).toBe("present");
});

test("a bare repo yields all-unknown (never guesses absent)", () => {
  const dir = fixture({ "readme.txt": "hi" });
  const rc = detectRuntimeContext(dir);
  expect(rc.data.presence).toBe("unknown");
  expect(rc.caching.presence).toBe("unknown");
  expect(rc.documentation.presence).toBe("unknown");
  expect(rc.topology.type).toBe("unknown");
});

test("topology = desktop when tauri config present", () => {
  const dir = fixture({
    "src-tauri/tauri.conf.json": "{}",
  });
  const rc = detectRuntimeContext(dir);
  expect(rc.topology.type).toBe("desktop");
  expect(rc.topology.detail).toBe("tauri desktop app");
  expect(rc.releasePackaging.mechanism).toBe("installer");
});
