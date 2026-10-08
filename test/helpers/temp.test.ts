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

describe("folders made before a failing call", () => {
  let made = "";
  test("are tracked", async () => {
    await expect(
      trackTempEntriesMadeBy("styre-kept-", async () => {
        made = mkdtempSync(join(tmpdir(), "styre-kept-"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(made)).toBe(true);
  });
  test("are gone by the next test", () => {
    expect(made).not.toBe("");
    expect(existsSync(made)).toBe(false);
  });
});

/** Run one fixture file as its own `bun test` with TMPDIR pointed at an empty folder, so the
 *  folder shows what the nested run left behind. From the repo root (the default) the nested run
 *  loads the preload through bunfig.toml; from anywhere else it does not. */
function runFixture(
  name: string,
  cwd = repoRoot,
): { exitCode: number; output: string; leftBehind: string[]; parent: string } {
  const parent = makeTempDir("styre-guard-");
  const fixture = join(import.meta.dir, "fixtures", name);
  const result = Bun.spawnSync([process.execPath, "test", fixture], {
    cwd,
    env: { ...process.env, TMPDIR: parent },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    leftBehind: readdirSync(parent),
    parent,
  };
}

describe("the leak guard", () => {
  test("fails a run that leaves a folder in its temp root, and names the folder", () => {
    const run = runFixture("leaks-a-folder.fixture.ts");
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain("nothing removed");
    expect(run.output).toContain("styre-leak-");
    // The guard still removes the run's temp root, so a leaking run does not pile up folders.
    expect(run.leftBehind).toEqual([]);
  }, 60_000);

  test("removes a tracked folder even when its test fails", () => {
    const run = runFixture("fails-after-making-a-folder.fixture.ts");
    expect(run.output).toContain("failing on purpose");
    expect(run.output).toContain("1 pass");
    expect(run.output).toContain("1 fail");
    expect(run.output).not.toContain("left temp folders behind");
    expect(run.exitCode).not.toBe(0);
    expect(run.leftBehind).toEqual([]);
  }, 60_000);

  test("refuses to make a folder when the preload is not loaded, instead of leaking it", () => {
    // From test/ there is no bunfig.toml, so no preload: nothing would ever remove the folder.
    const run = runFixture("cleans-up.fixture.ts", join(repoRoot, "test"));
    expect(run.output).toContain("test/preload.ts");
    expect(run.exitCode).not.toBe(0);
    expect(run.leftBehind).toEqual([]);
  }, 60_000);

  test.skipIf(process.getuid?.() === 0)(
    "still names a tracked folder that cannot be removed, with the reason",
    () => {
      const run = runFixture("cannot-remove-a-folder.fixture.ts");
      // Let this test's own cleanup remove what the nested run could not.
      Bun.spawnSync(["chmod", "-R", "u+w", run.parent]);
      // The folder's own removal failure, with the reason (not just the run root's).
      expect(run.output).toMatch(/^ {2}\S*\/styre-stuck-[A-Za-z0-9]{6}: \S/m);
      // It was tracked, so it is not reported as a folder nothing removed...
      expect(run.output).not.toContain("nothing removed");
      // ...and the failure did not abort the rest of the cleanup or fail the test that made it.
      expect(run.output).toContain("1 pass");
      expect(run.exitCode).not.toBe(0);
    },
    60_000,
  );

  test("passes a run whose folders all go through the tracked helper", () => {
    const run = runFixture("cleans-up.fixture.ts");
    expect(run.output).not.toContain("left temp folders behind");
    expect(run.exitCode).toBe(0);
    expect(run.leftBehind).toEqual([]);
  }, 60_000);
});
