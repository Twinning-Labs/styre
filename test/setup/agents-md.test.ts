import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentsMd } from "../../src/setup/agents-md.ts";

function tmp(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-agents-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("readAgentsMd returns '' when there is no AGENTS.md", () => {
  expect(readAgentsMd(tmp())).toBe("");
});

test("readAgentsMd returns the file content when present", () => {
  expect(readAgentsMd(tmp({ "AGENTS.md": "# Build\nrun `make test` to test\n" }))).toContain(
    "make test",
  );
});

test("readAgentsMd truncates oversized files with a marker", () => {
  const big = "x".repeat(20_000);
  const out = readAgentsMd(tmp({ "AGENTS.md": big }));
  expect(out.length).toBeLessThan(big.length);
  expect(out).toContain("[truncated]");
});

test("readAgentsMd ignores a symlinked AGENTS.md (no host-file read)", () => {
  const secretDir = tmp({ "secret.txt": "SENSITIVE-HOST-DATA" });
  const dir = tmp();
  symlinkSync(join(secretDir, "secret.txt"), join(dir, "AGENTS.md"));
  expect(readAgentsMd(dir)).toBe("");
});
