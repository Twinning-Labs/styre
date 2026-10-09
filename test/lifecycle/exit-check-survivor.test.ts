// ENG-485 section 7.7 (final review A F2): a launch whose stop left a survivor keeps its record,
// and its survivor was already named by the caller that stopped it. The exit check must not call
// that launch an internal error, stop it a second time, or turn a successful exit into 70.
//
// Safety: the survivor is a fake process table entry, pid 999999 (no such process on macOS, whose
// pids end at 99999). The stop's kill function refuses every signal with EPERM, so this test sends
// no real signal at all: it only makes a stop do less. The command (`true`) ends by itself.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { assertNoLeakedLaunches } from "../../src/cli/exit-check.ts";
import * as door from "../../src/util/process/door.ts";
import { checkLeftoversInBackground } from "../../src/util/process/leftovers.ts";
import { type ProcInfo, listProcesses, nowToken } from "../../src/util/process/proc-table.ts";
import { realStopDeps } from "../../src/util/process/stop.ts";
import { runCommand } from "../../src/util/run-command.ts";
import { makeTempDir } from "../helpers/temp.ts";

const FAKE = 999999;
let state: string;
const saved = process.env.XDG_STATE_HOME;
beforeEach(() => {
  state = makeTempDir("styre-exit-check-");
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  door.__resetForTests();
  process.env.XDG_STATE_HOME = saved;
  rmSync(state, { recursive: true, force: true });
});

test("a survivor already reported is not an internal error at exit, and success stays 0", async () => {
  let group: number | null = null;
  let clock = 0;
  door.__setStopDepsForTests({
    ...realStopDeps,
    list: () => {
      const table = listProcesses();
      group ??= door.liveLaunches()[0]?.record.pid ?? null;
      if (group === null) return table;
      const fake: ProcInfo = {
        pid: FAKE,
        ppid: 1,
        pgid: group,
        startedAt: "1.000000",
        state: "running",
      };
      return [...table, fake];
    },
    kill: () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    sleep: async () => {
      await Bun.sleep(1);
      clock += 250;
    },
    now: () => clock,
  });
  const lines: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  const before = process.exitCode;
  process.exitCode = 0;
  let code: number | string | undefined;
  try {
    const r = await runCommand("true", { cwd: state, timeoutMs: 5_000 });
    expect(r.exitCode).toBe(0);
    await assertNoLeakedLaunches();
    code = process.exitCode;
  } finally {
    process.stderr.write = real;
    process.exitCode = before;
  }
  expect(code).toBe(0);
  expect(lines.filter((l) => l.includes("internal error"))).toEqual([]);
  // Named once, by the command's own stop, not again by the exit check.
  expect(lines.filter((l) => l.includes(`(pid ${FAKE})`)).length).toBe(1);
});

test.skipIf(process.platform !== "darwin")(
  "the leftover check's own lsof names a survivor of its group, so the exit check can rely on it",
  async () => {
    let group: number | null = null;
    let clock = 0;
    door.__setStopDepsForTests({
      ...realStopDeps,
      list: () => {
        const table = listProcesses();
        group ??= door.liveLaunches()[0]?.record.pid ?? null;
        if (group === null) return table;
        const fake: ProcInfo = {
          pid: FAKE,
          ppid: 1,
          pgid: group,
          startedAt: "1.000000",
          state: "running",
        };
        return [...table, fake];
      },
      kill: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
      sleep: async () => {
        await Bun.sleep(1);
        clock += 250;
      },
      now: () => clock,
    });
    const lines: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      lines.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      await checkLeftoversInBackground({ worktree: state, since: nowToken(), report: () => {} });
    } finally {
      process.stderr.write = real;
    }
    expect(group).not.toBeNull();
    expect(lines.filter((l) => l.includes(`(pid ${FAKE})`)).length).toBe(1);
  },
);
