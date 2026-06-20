import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "styre-mig-cli-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

test("`styre migrate --db <path>` exits 0 and reports v2", async () => {
  const dbPath = join(workdir, "styre.db");
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "migrate", "--db", dbPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(code).toBe(0);
  expect(out).toContain("schema v2");
});
