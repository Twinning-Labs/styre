import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { makeTempDir, trackTempEntriesMadeBy, trackTempPath } from "./temp.ts";

const repoRoot = join(import.meta.dir, "..", "..");

test("the run's temp root is a fresh per-run folder, not the system temp folder", () => {
  expect(basename(tmpdir())).toStartWith("styre-test-run-");
});

describe("a folder made inside a test", () => {
  let made = "";
  test("exists while the test runs", () => {
    made = makeTempDir("styre-scoped-");
    expect(existsSync(made)).toBe(true);
  });
  test("is gone by the next test", () => {
    expect(made).not.toBe("");
    expect(existsSync(made)).toBe(false);
  });
});

describe("a path registered inside a test", () => {
  let tracked = "";
  test("is created by the caller", () => {
    tracked = trackTempPath(join(tmpdir(), `wt-tracked-${Date.now()}`));
    mkdirSync(tracked);
    expect(existsSync(tracked)).toBe(true);
  });
  test("is gone by the next test", () => {
    expect(tracked).not.toBe("");
    expect(existsSync(tracked)).toBe(false);
  });
});

describe("a folder made outside any test", () => {
  let shared = "";
  beforeAll(() => {
    shared = makeTempDir("styre-shared-");
  });
  test("is still there for the first test", () => {
    expect(existsSync(shared)).toBe(true);
  });
  test("is still there for the second test", () => {
    expect(existsSync(shared)).toBe(true);
  });
});

describe("folders that code under test makes in the temp root and keeps", () => {
  let kept = "";
  let unrelated = "";
  test("are tracked when they match the prefix, and nothing else is", async () => {
    unrelated = mkdtempSync(join(tmpdir(), "styre-unrelated-"));
    const result = await trackTempEntriesMadeBy("styre-kept-", async () => {
      kept = mkdtempSync(join(tmpdir(), "styre-kept-"));
      return 7;
    });
    expect(result).toBe(7);
    expect(existsSync(kept)).toBe(true);
  });
  test("the matching one is gone by the next test; the other is untouched", () => {
    expect(kept).not.toBe("");
    expect(existsSync(kept)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    rmSync(unrelated, { recursive: true });
  });
});

test("folders made before a failing call are still tracked", async () => {
  let made = "";
  await expect(
    trackTempEntriesMadeBy("styre-kept-", async () => {
      made = mkdtempSync(join(tmpdir(), "styre-kept-"));
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(existsSync(made)).toBe(true);
});

/** Run one fixture file as its own `bun test` (which loads the preload from bunfig.toml) with
 *  TMPDIR pointed at an empty folder, so the folder shows what the nested run left behind. */
function runFixture(name: string): { exitCode: number; output: string; leftBehind: string[] } {
  const parent = makeTempDir("styre-guard-");
  const result = Bun.spawnSync(["bun", "test", `./test/helpers/fixtures/${name}`], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: parent },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    leftBehind: readdirSync(parent),
  };
}

describe("the leak guard", () => {
  test("fails a run that leaves a folder in its temp root, and names the folder", () => {
    const run = runFixture("leaks-a-folder.fixture.ts");
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain("styre-leak-");
    // The guard still removes the run's temp root, so a leaking run does not pile up folders.
    expect(run.leftBehind).toEqual([]);
  }, 60_000);

  test("removes a tracked folder even when its test fails", () => {
    const run = runFixture("fails-after-making-a-folder.fixture.ts");
    expect(run.output).toContain("failing on purpose");
    expect(run.output).toContain("1 pass");
    expect(run.output).toContain("1 fail");
    expect(run.output).not.toContain("left behind");
    expect(run.exitCode).not.toBe(0);
    expect(run.leftBehind).toEqual([]);
  }, 60_000);

  test("passes a run whose folders all go through the tracked helper", () => {
    const run = runFixture("cleans-up.fixture.ts");
    expect(run.output).not.toContain("left behind");
    expect(run.exitCode).toBe(0);
    expect(run.leftBehind).toEqual([]);
  }, 60_000);
});
