// ENG-485 section 7.7: on a normal exit `styre run` and `styre setup` wait for the leftover checks
// still running, then assert that no launch is still live. A leak is stopped, named, and exits 70.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, usageError } from "../../src/cli/errors.ts";
import { assertNoLeakedLaunches, guardWithExitCheck } from "../../src/cli/exit-check.ts";
import * as door from "../../src/util/process/door.ts";
import {
  __setCwdReadersForTests,
  checkLeftoversInBackground,
  pendingLeftoverChecks,
} from "../../src/util/process/leftovers.ts";
import { cleanupFixtures, folder, isRunning, marker, until } from "../helpers/leftover-fixtures.ts";

const savedExit = process.exitCode;
let stderr: string[];
beforeEach(() => {
  door.__resetForTests();
  process.exitCode = 0;
  stderr = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  __setCwdReadersForTests(undefined);
  await pendingLeftoverChecks();
  for (const h of door.liveLaunches()) await h.stop("forced").catch(() => {});
  cleanupFixtures();
  door.__resetForTests();
  process.exitCode = savedExit;
  (process.stderr.write as unknown as { mockRestore(): void }).mockRestore();
});

/** A launch nobody finished: what a leak looks like. */
function leak(m: string) {
  return door.launch({
    argv: ["sleep", m],
    cwd: folder("styre-wt-"),
    env: process.env,
    kind: "agent",
    context: { ident: "ENG-1", stepId: 1, worktree: null },
  });
}

test("with no launch left, a normal exit keeps its exit code", async () => {
  process.exitCode = 75;
  await assertNoLeakedLaunches();
  expect(process.exitCode).toBe(75);
  expect(stderr).toEqual([]);
});

test("a launch still live is stopped, named, and the exit code becomes 70", async () => {
  const m = marker();
  const h = leak(m);
  const pid = h.proc.pid;
  expect(await until(() => isRunning(m))).toBe(true);
  await assertNoLeakedLaunches();
  expect(process.exitCode).toBe(EXIT.INTERNAL);
  expect(EXIT.INTERNAL).toBe(70);
  expect(stderr.join("")).toContain(`sleep ${m}`);
  expect(stderr.join("")).toContain(`(pid ${pid})`);
  expect(door.liveLaunches()).toEqual([]);
  expect(isRunning(m)).toBe(false); // stopped, not left
});

test("it waits for a check still running, and that check's own launch is not a leak", async () => {
  const m = marker();
  let inner: door.LaunchHandle | undefined;
  __setCwdReadersForTests({
    // What the real check does on macOS: a launch of its own, live while it works, released after.
    async: async () => {
      inner = leak(m);
      await Bun.sleep(150);
      await inner.stop("forced");
      return new Map();
    },
  });
  void checkLeftoversInBackground({ worktree: folder("styre-wt-"), since: "0", report: () => {} });
  await until(() => inner !== undefined);
  await assertNoLeakedLaunches();
  expect(process.exitCode).toBe(0);
  expect(door.liveLaunches()).toEqual([]);
});

test("a check that timed out is reported as skipped and is not a leak", async () => {
  const lines: string[][] = [];
  __setCwdReadersForTests({ async: async () => "skipped" });
  void checkLeftoversInBackground({
    worktree: folder("styre-wt-"),
    since: "0",
    report: (l) => lines.push(l),
  });
  await assertNoLeakedLaunches();
  expect(lines.flat().join("")).toContain("skipped");
  expect(process.exitCode).toBe(0);
});

test("guardWithExitCheck: a normal exit with a leak exits 70", async () => {
  const m = marker();
  await guardWithExitCheck("run", async () => {
    leak(m);
  });
  expect(process.exitCode).toBe(70);
  expect(door.liveLaunches()).toEqual([]);
});

test("guardWithExitCheck: a normal exit without a leak keeps the code the command set", async () => {
  await guardWithExitCheck("run", async () => {
    process.exitCode = 75;
  });
  expect(process.exitCode).toBe(75);
});

test("guardWithExitCheck: a command that threw is not a normal exit; its own code stands", async () => {
  const m = marker();
  await guardWithExitCheck("run", async () => {
    leak(m);
    throw usageError("bad flag");
  });
  expect(process.exitCode).toBe(EXIT.USAGE);
});

test("styre run and styre setup both use the exit check", () => {
  for (const f of ["run.ts", "setup.ts"]) {
    const src = readFileSync(join(import.meta.dir, "../../src/cli", f), "utf8");
    expect(src).toMatch(/guardWithExitCheck\("(run|setup)"/);
    expect(src).not.toMatch(/\bguard\("(run|setup)"/);
  }
});
