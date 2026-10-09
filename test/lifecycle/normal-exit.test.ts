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
import { listRecords } from "../../src/util/process/records.ts";
import {
  claimLaunch,
  cleanupFixtures,
  folder,
  isRunning,
  marker,
  until,
} from "../helpers/leftover-fixtures.ts";

const savedExit = process.exitCode;
/** `process.exitCode` as read after an assignment of `undefined` (the type narrows otherwise). */
const exitCode = (): number | undefined => process.exitCode as number | undefined;
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

/** A launch nobody finished: what a leak looks like. Its `sleep <m>` is claimed for cleanup. */
function leak(m: string) {
  return claimLaunch(
    m,
    door.launch({
      argv: ["sleep", m],
      cwd: folder("styre-wt-"),
      env: process.env,
      kind: "agent",
      context: { ident: "ENG-1", stepId: 1, worktree: null },
    }),
  );
}

test("with no launch left, a normal exit keeps its exit code", async () => {
  process.exitCode = 75;
  await assertNoLeakedLaunches();
  expect(exitCode()).toBe(75);
  expect(stderr).toEqual([]);
});

test("a launch still live is stopped, named, and an unset exit code becomes 70", async () => {
  process.exitCode = undefined;
  const m = marker();
  const h = leak(m);
  const pid = h.proc.pid;
  expect(await until(() => isRunning(m))).toBe(true);
  await assertNoLeakedLaunches();
  expect(exitCode()).toBe(EXIT.INTERNAL);
  expect(EXIT.INTERNAL).toBe(70);
  expect(stderr.join("")).toContain(`sleep ${m}`);
  expect(stderr.join("")).toContain(`(pid ${pid})`);
  expect(door.liveLaunches()).toEqual([]);
  expect(isRunning(m)).toBe(false); // stopped, not left
});

test("a zero exit code becomes 70 too", async () => {
  process.exitCode = 0;
  leak(marker());
  await assertNoLeakedLaunches();
  expect(exitCode()).toBe(70);
});

test.each([75, 65, 64, 1])(
  "an exit code already set to %d is never overwritten, and the leak is still stopped and printed (R22)",
  async (code) => {
    process.exitCode = code;
    const m = marker();
    leak(m);
    expect(await until(() => isRunning(m))).toBe(true);
    await assertNoLeakedLaunches();
    expect(exitCode()).toBe(code);
    expect(stderr.join("")).toContain(`sleep ${m}`);
    expect(door.liveLaunches()).toEqual([]);
    expect(isRunning(m)).toBe(false);
  },
);

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
  expect(exitCode()).toBe(0);
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
  expect(exitCode()).toBe(0);
});

test("guardWithExitCheck: a normal exit with a leak exits 70", async () => {
  const m = marker();
  await guardWithExitCheck("run", async () => {
    leak(m);
  });
  expect(exitCode()).toBe(70);
  expect(door.liveLaunches()).toEqual([]);
});

test("guardWithExitCheck: a normal exit without a leak keeps the code the command set", async () => {
  await guardWithExitCheck("run", async () => {
    process.exitCode = 75;
  });
  expect(exitCode()).toBe(75);
});

test("guardWithExitCheck: a command that leaked a launch and threw: the leak is stopped and printed, its record removed, the error's exit code kept (R23)", async () => {
  process.exitCode = undefined;
  const m = marker();
  await guardWithExitCheck("run", async () => {
    leak(m);
    throw usageError("bad flag");
  });
  expect(exitCode()).toBe(EXIT.USAGE);
  expect(stderr.join("")).toContain(`sleep ${m}`);
  expect(door.liveLaunches()).toEqual([]);
  expect(isRunning(m)).toBe(false);
  expect(listRecords().filter((r) => r.record.command.includes(m))).toEqual([]);
});

test("guardWithExitCheck: an internal error that leaked keeps its own exit code too", async () => {
  process.exitCode = undefined;
  await guardWithExitCheck("run", async () => {
    leak(marker());
    throw new Error("boom");
  });
  expect(exitCode()).toBe(EXIT.INTERNAL);
  expect(door.liveLaunches()).toEqual([]);
});

test("styre run and styre setup both use the exit check", () => {
  for (const f of ["run.ts", "setup.ts"]) {
    const src = readFileSync(join(import.meta.dir, "../../src/cli", f), "utf8");
    expect(src).toMatch(/guardWithExitCheck\(\s*"(run|setup)"/);
    // The citty command goes through the body that runs the exit check (and removes the stop
    // handlers after it, R27).
    expect(src).toMatch(/run: \(ctx\) => (run|setup)CommandBody\(/);
    expect(src).not.toMatch(/\bguard\("(run|setup)"/);
  }
});
