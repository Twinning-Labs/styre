import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_VERSION } from "../src/db/migrations/index.ts";
import { ownChild } from "./helpers/own-processes.ts";
import { makeTempDir } from "./helpers/temp.ts";

const workdir = makeTempDir("styre-mig-cli-");
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

test("`styre migrate --db <path>` exits 0 and reports the current schema version on stderr (stdout stays empty)", async () => {
  const dbPath = join(workdir, "styre.db");
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "migrate", "--db", dbPath], {
    // Bun.spawn's default environment is the one this process started with, which lacks the test
    // state folder the preload sets: pass it, so the command's sweep (ENG-485 section 8) reads the
    // test's launch records, never the operator's ~/.local/state.
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  ownChild(proc);
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  expect(code).toBe(0);
  // Human output → stderr (stdout is NDJSON-only across all subcommands).
  expect(err).toContain(`schema v${CURRENT_VERSION}`);
  expect(out).not.toContain(`schema v${CURRENT_VERSION}`);
}, 60_000);
