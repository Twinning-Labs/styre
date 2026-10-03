import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "styre-mig-cli-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

test("`styre migrate --db <path>` exits 0 and reports v8 on stderr (stdout stays empty)", async () => {
  const dbPath = join(workdir, "styre.db");
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "migrate", "--db", dbPath], {
    // Bun.spawn's default environment is the one this process started with, which lacks the test
    // state folder the preload sets: pass it, so the command's sweep (ENG-485 section 8) reads the
    // test's launch records, never the operator's ~/.local/state.
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code).toBe(0);
  // Human output → stderr (stdout is NDJSON-only across all subcommands).
  expect(err).toContain("schema v8");
  expect(out).not.toContain("schema v8");
});
