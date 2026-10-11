import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_VERSION } from "../src/db/migrations/index.ts";
import { copyFixture } from "./helpers/db-fixtures.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "./helpers/design-harness.ts";
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

test("`styre migrate` refuses a database older than v7 with its prefix said once, exit 65", async () => {
  const dbPath = copyFixture("v6-v0.7.0");
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "migrate", "--db", dbPath], {
    // the test state folder the preload sets (see the test above)
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
  expect(code).toBe(65);
  expect(out).toBe("");
  expect(err).toBe(
    `styre migrate: ${dbPath} is schema v6; Styre upgrades checkpoints from v7 on\nStart that run over: styre run <ticket> --fresh. For a database given to styre migrate that is no run's checkpoint: remove it, and styre migrate creates a new one.\n`,
  );
}, 60_000);

test(
  "`styre run` on a reused --db older than v7 names the subsystem after its own prefix: styre run: migrate: ...",
  async () => {
    const h = new DesignHarness("worktree");
    try {
      const dbPath = copyFixture("v6-v0.7.0");
      expect(await h.fresh({ db: dbPath })).toBe(65);
      // the harness keeps what the error boundary prints (renderError("run", ...))
      expect(h.stderr.join("")).toContain(
        `styre run: migrate: ${dbPath} is schema v6; Styre upgrades checkpoints from v7 on\n`,
      );
      expect(h.calls.prompts).toEqual([]);
    } finally {
      h.cleanup();
    }
  },
  HARNESS_TEST_TIMEOUT_MS,
);
