// ENG-485 section 9: the detached leftover check finds processes still running in a step's
// worktree that started during the step and are not part of anything Styre runs. It reports them and
// never stops them. Fixtures here are real detached `sleep` processes with a unique marker, known by
// pid and start time and removed by that identity, even when a test fails (never by the marker).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import {
  LEFTOVER_TIMEOUT_MS,
  type Leftover,
  __setCwdReadersForTests,
  __setLsofPathForTests,
  checkLeftovers,
  checkLeftoversInBackground,
  commandFromCmdline,
  decodeLsofName,
  findLeftovers,
  formatLeftover,
  lsofEnv,
  pendingLeftoverChecks,
} from "../../src/util/process/leftovers.ts";
import { listProcesses, nowToken, probe } from "../../src/util/process/proc-table.ts";
import {
  claimPrinted,
  cleanupFixtures,
  folder,
  goFile,
  isRunning,
  leave,
  marker,
  pastToken,
  runsIn,
  until,
} from "../helpers/leftover-fixtures.ts";
import { own, ownTree } from "../helpers/own-processes.ts";

const only = (r: Leftover[] | "skipped", m: string): Leftover[] => {
  expect(r).not.toBe("skipped");
  return (r as Leftover[]).filter((l) => l.command.includes(`sleep ${m}`));
};
const scan = (wt: string, since: string, extra: { until?: string } = {}) =>
  findLeftovers({ worktree: wt, since, timeoutMs: 5000, viaDiagnostic: true, ...extra });
/** Poll until the detached fixture shows up in the check, so the test never races the fork. */
async function find(wt: string, since: string, m: string): Promise<Leftover | undefined> {
  let hit: Leftover | undefined;
  await until(() => {
    hit = only(scan(wt, since), m)[0];
    return hit !== undefined;
  });
  return hit;
}
beforeEach(() => {
  door.__resetForTests();
});
afterEach(async () => {
  __setCwdReadersForTests(undefined);
  __setLsofPathForTests(undefined);
  await pendingLeftoverChecks();
  for (const h of door.liveLaunches()) await h.stop("forced").catch(() => {});
  cleanupFixtures();
  door.__resetForTests();
});

describe("what counts as a leftover (section 9.2)", () => {
  test("a detached nohup process in the worktree is reported, and left running", async () => {
    const wt = folder("styre wt "); // a space in the path (Review Focus 2)
    const since = nowToken();
    const m = marker();
    await leave(wt, m);
    const hit = await find(wt, since, m);
    expect(hit).toBeDefined();
    if (!hit) return;
    expect(hit.cwd).toBe(realpathSync(wt));
    expect(formatLeftover(hit)).toBe(
      `styre: the agent left "${hit.command}" (pid ${hit.pid}) running in the worktree; stop it with: kill ${hit.pid} (if it is not yours)\n`,
    );
    // Reported, never stopped: it is alive after the check, and after a second check.
    expect(probe(hit.pid).kind).toBe("alive");
    scan(wt, since);
    expect(probe(hit.pid)).toMatchObject({ kind: "alive", info: { state: "running" } });
  });

  test("a worktree reached through a symlink still matches (Review Focus 2)", async () => {
    const real = folder("styre-real-");
    const link = join(folder("styre-link-"), "wt");
    symlinkSync(real, link);
    const since = nowToken();
    const m = marker();
    await leave(real, m);
    expect(await find(link, since, m)).toBeDefined();
    // ... and the other way round: the process sits in the link, the folder given is the target.
    const m2 = marker();
    await leave(link, m2);
    expect(await find(real, since, m2)).toBeDefined();
  });

  test("a working folder a reader names through a symlink is compared by its real path", async () => {
    // lsof and /proc print real paths today; the comparison must not depend on that.
    const real = folder("styre-real-");
    const link = join(folder("styre-link-"), "wt");
    symlinkSync(real, link);
    const since = nowToken();
    const m = marker();
    await leave(real, m);
    const hit = await find(real, since, m);
    expect(hit).toBeDefined();
    __setCwdReadersForTests({ sync: () => new Map([[hit?.pid ?? 0, link]]) });
    expect(only(scan(real, since), m)).toHaveLength(1);
  });

  test("a process in a subfolder of the worktree is reported", async () => {
    const wt = folder("styre-wt-");
    const sub = join(wt, "a", "b");
    mkdirSync(sub, { recursive: true });
    const since = nowToken();
    const m = marker();
    await leave(sub, m);
    expect(await find(wt, since, m)).toBeDefined();
  });

  test("a process in a sibling folder that only shares the name prefix is not reported", async () => {
    const parent = folder("styre-parent-");
    const wt = join(parent, "wt");
    const sibling = join(parent, "wt-other");
    mkdirSync(wt);
    mkdirSync(sibling);
    const since = nowToken();
    const m = marker();
    await leave(sibling, m);
    const m2 = marker();
    await leave(wt, m2);
    // The in-folder fixture proves the check ran and saw processes; the sibling one is absent.
    expect(await find(wt, since, m2)).toBeDefined();
    expect(only(scan(wt, since), m)).toEqual([]);
  });

  test("a process that started before the window is not reported", async () => {
    const wt = folder("styre-wt-");
    const m = marker();
    await leave(wt, m);
    expect(await find(wt, "0", m)).toBeDefined(); // it is running, and seen with an open window
    const after = nowToken();
    await pastToken(after);
    expect(only(scan(wt, nowToken()), m)).toEqual([]);
  });

  test("a process that started after the window ended is not reported", async () => {
    const wt = folder("styre-wt-");
    const end = nowToken();
    await pastToken(end);
    const m = marker();
    await leave(wt, m);
    expect(await find(wt, "0", m)).toBeDefined();
    expect(only(scan(wt, "0", { until: end }), m)).toEqual([]);
  });

  test("Styre's own live launches, and everything they started, are not reported", async () => {
    const wt = folder("styre-wt-");
    const since = nowToken();
    const mAgent = marker();
    const mGroup = marker();
    const base = { env: process.env, context: { ident: null, stepId: null, worktree: wt } };
    const agent = door.launch({
      ...base,
      argv: ["sh", "-c", `sleep ${mAgent} & wait`],
      cwd: wt,
      kind: "agent",
    });
    const group = door.launch({
      ...base,
      argv: ["sh", "-c", `sleep ${mGroup} & wait`],
      cwd: wt,
      kind: "group",
    });
    // Wait for each fixture's child to exist, so the exclusion is tested against real descendants.
    const seen = await until(() => runsIn(agent, mAgent) && runsIn(group, mGroup));
    expect(seen).toBe(true);
    const found = scan(wt, since);
    expect(found).not.toBe("skipped");
    const own = new Set([agent.proc.pid, group.proc.pid]);
    expect((found as Leftover[]).filter((l) => own.has(l.pid))).toEqual([]);
    expect(only(found, mAgent)).toEqual([]);
    expect(only(found, mGroup)).toEqual([]);
    await agent.stop("forced");
    await group.stop("forced");
  });

  test("Styre itself is never reported, even when its own working folder is the worktree", () => {
    const wt = folder("styre-wt-");
    const saved = process.cwd();
    try {
      process.chdir(wt);
      const found = scan(wt, "0");
      expect(found).not.toBe("skipped");
      expect((found as Leftover[]).some((l) => l.pid === process.pid)).toBe(false);
    } finally {
      process.chdir(saved);
    }
  });

  test("a worktree that no longer exists has nothing to report", () => {
    const gone = join(folder("styre-gone-"), "never-created");
    expect(scan(gone, "0")).toEqual([]);
  });

  test("the command text is the process's own, cut to 120 characters", async () => {
    const wt = folder("styre-wt-");
    const since = nowToken();
    const m = marker();
    // The pid printed is the nohup'd shell's. Its command carries the marker in a `:` no-op, and it
    // then only loops on short sleeps until the go folder is removed, so it never has a long lived
    // child that could outlive it unclaimed. The outer shell waits for the go file, so the nohup'd
    // shell is still its child (and this test's descendant) when it is claimed. The outer shell
    // itself is claimed at once, and whatever happens the `finally` claims its whole tree while it
    // is still connected, then opens the gate: a failed claim fails the test and leaves nothing
    // running (every loop here also ends once its folder is gone).
    const gate = goFile();
    const sh =
      'cd "$1" || exit 1; nohup sh -c ": sleep $2 $3; while [ -d \'${4%/*}\' ]; do sleep 0.05; done" >/dev/null 2>&1 & echo $!; while [ ! -e "$4" ] && [ -d "${4%/*}" ]; do sleep 0.02; done';
    const p = Bun.spawn(["sh", "-c", sh, "sh", wt, m, "x".repeat(300), gate.path], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const outer = probe(p.pid);
    expect(outer.kind === "alive" && own(outer.info).length === 1).toBe(true);
    try {
      await claimPrinted(m, p.stdout, since);
    } finally {
      if (outer.kind === "alive") ownTree(outer.info);
      gate.go();
    }
    await p.exited;
    let hit: Leftover | undefined;
    await until(() => {
      hit = (scan(wt, since) as Leftover[]).find(
        (l) => l.command.startsWith("sh -c") && l.command.includes(`sleep ${m}`),
      );
      return hit !== undefined;
    });
    expect(hit).toBeDefined();
    expect(hit?.command.length).toBe(120);
    expect(hit?.command.startsWith("sh -c")).toBe(true);
  });
});

describe("the two ways to run lsof (section 9.1)", () => {
  test("a check without viaDiagnostic finds the same leftover", async () => {
    const wt = folder("styre wt ");
    const since = nowToken();
    const m = marker();
    await leave(wt, m);
    const r = findLeftovers({ worktree: wt, since, timeoutMs: 5000, viaDiagnostic: false });
    expect(only(r, m)).toHaveLength(1);
  });

  test.skipIf(process.platform !== "darwin")(
    "once a stop has begun the diagnostic form still works and the door form is refused",
    async () => {
      const wt = folder("styre-wt-");
      const since = nowToken();
      const m = marker();
      await leave(wt, m);
      door.beginStopping();
      expect(only(scan(wt, since), m)).toHaveLength(1);
      expect(() =>
        findLeftovers({ worktree: wt, since, timeoutMs: 5000, viaDiagnostic: false }),
      ).toThrow(door.RunInterrupted);
    },
  );
});

describe("a check that cannot finish is skipped, never hung and never thrown", () => {
  test("a reader that times out gives skipped", () => {
    __setCwdReadersForTests({ sync: () => "skipped" });
    expect(scan(folder("styre-wt-"), "0")).toBe("skipped");
  });

  test.skipIf(process.platform !== "darwin")(
    "a real lsof that exceeds its timeout gives skipped",
    () => {
      const t0 = Date.now();
      const r = findLeftovers({
        worktree: folder("styre-wt-"),
        since: "0",
        timeoutMs: 1,
        viaDiagnostic: true,
      });
      expect(r).toBe("skipped");
      expect(Date.now() - t0).toBeLessThan(4000);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "the background check's lsof launch that exceeds its timeout is skipped, stopped and released",
    async () => {
      const got: string[][] = [];
      const t0 = Date.now();
      await checkLeftoversInBackground({
        worktree: folder("styre-wt-"),
        since: "0",
        timeoutMs: 1,
        report: (l) => got.push(l),
      });
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(got.flat().join("")).toContain("skipped");
      expect(door.liveLaunches()).toEqual([]);
    },
  );
});

describe("the check after an agent step runs in the background (section 9.1)", () => {
  test("it reports what it finds through `report`, with the exact line", async () => {
    const wt = folder("styre wt ");
    const since = nowToken();
    const m = marker();
    await leave(wt, m);
    expect(await find(wt, since, m)).toBeDefined();
    const got: string[][] = [];
    await checkLeftoversInBackground({ worktree: wt, since, report: (l) => got.push(l) });
    const mine = got.flat().filter((l) => l.includes(`sleep ${m}`));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(
      /^styre: the agent left ".*sleep .*" \(pid \d+\) running in the worktree; stop it with: kill \d+ \(if it is not yours\)\n$/,
    );
    expect(door.liveLaunches()).toEqual([]); // a check that launched lsof released it
  });

  test("a clean worktree reports nothing", async () => {
    const got: string[][] = [];
    await checkLeftoversInBackground({
      worktree: folder("styre-wt-"),
      since: nowToken(),
      report: (l) => got.push(l),
    });
    expect(got).toEqual([]);
  });

  test("it returns before the check finishes, and pendingLeftoverChecks waits for it", async () => {
    let release: (v: Map<number, string>) => void = () => {};
    __setCwdReadersForTests({
      async: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const p = checkLeftoversInBackground({
      worktree: folder("styre-wt-"),
      since: "0",
      report: () => {},
    });
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    let waited = false;
    const pending = pendingLeftoverChecks().then(() => {
      waited = true;
    });
    await Bun.sleep(100);
    expect(settled).toBe(false);
    expect(waited).toBe(false);
    release(new Map());
    await pending;
    expect(waited).toBe(true);
    expect(settled).toBe(true);
  });

  test("a check that timed out is reported as skipped", async () => {
    __setCwdReadersForTests({ async: async () => "skipped" });
    const got: string[][] = [];
    await checkLeftoversInBackground({
      worktree: folder("styre-wt-"),
      since: "0",
      report: (l) => got.push(l),
    });
    expect(got).toHaveLength(1);
    expect(got[0]).toHaveLength(1);
    expect(got[0][0]).toMatch(/^styre: .*skipped.*\n$/);
  });

  test("a reader that throws is reported as skipped, and never rejects", async () => {
    __setCwdReadersForTests({
      async: async () => {
        throw new Error("boom");
      },
    });
    const got: string[][] = [];
    await checkLeftoversInBackground({
      worktree: folder("styre-wt-"),
      since: "0",
      report: (l) => got.push(l),
    });
    await pendingLeftoverChecks();
    expect(got.flat().join("")).toMatch(/skipped.*boom/);
  });

  test("once a stop has begun the check says nothing: the handler runs its own", async () => {
    __setCwdReadersForTests({
      async: async () => {
        throw new door.RunInterrupted();
      },
    });
    const got: string[][] = [];
    await checkLeftoversInBackground({
      worktree: folder("styre-wt-"),
      since: "0",
      report: (l) => got.push(l),
    });
    expect(got).toEqual([]);
  });

  test("the timeout constant is the section 9.1 value", () => {
    expect(LEFTOVER_TIMEOUT_MS).toBe(5_000);
  });
});

describe("checkLeftovers: the signal handler's step 5", () => {
  test("it reports a leftover of each stopped agent launch, from that launch's own start", async () => {
    const wt = folder("styre wt ");
    const m = marker();
    const since = nowToken();
    // The agent waits for the go file, so its sleep is still its child (and this test's
    // descendant) when the test claims it; then it exits and leaves the sleep behind.
    const gate = goFile();
    const agent = door.launch({
      argv: [
        "sh",
        "-c",
        'nohup sleep "$1" >/dev/null 2>&1 & echo $!; while [ ! -e "$2" ] && [ -d "${2%/*}" ]; do sleep 0.02; done',
        "sh",
        m,
        gate.path,
      ],
      cwd: wt,
      env: process.env,
      kind: "agent",
      context: { ident: "ENG-1", stepId: 1, worktree: wt },
    });
    await claimPrinted(m, agent.proc.stdout, since);
    gate.go();
    await agent.proc.exited;
    await agent.finish();
    let out: string[] = [];
    await until(() => {
      out = checkLeftovers({ stopped: [agent], timeoutMs: 5000 }).filter((l) =>
        l.includes(`sleep ${m}`),
      );
      return out.length > 0;
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(
      /^styre: the agent left ".*sleep .*" \(pid \d+\) running in the worktree; stop it with: kill \d+ \(if it is not yours\)\n$/,
    );
    const pid = Number(/pid (\d+)/.exec(out[0])?.[1]);
    expect(probe(pid).kind).toBe("alive"); // reported, not stopped
  });

  test("a launch that is not an agent, or has no worktree, is not checked", async () => {
    const wt = folder("styre-wt-");
    const m = marker();
    await leave(wt, m);
    const grp = door.launch({
      argv: ["true"],
      cwd: wt,
      env: process.env,
      kind: "group",
      context: { ident: null, stepId: null, worktree: wt },
    });
    const bare = door.launch({
      argv: ["true"],
      cwd: wt,
      env: process.env,
      kind: "agent",
      context: { ident: null, stepId: null, worktree: null },
    });
    await grp.proc.exited;
    await bare.proc.exited;
    expect(checkLeftovers({ stopped: [grp, bare], timeoutMs: 5000 })).toEqual([]);
  });

  test("a skipped check is said, not dropped", async () => {
    __setCwdReadersForTests({ sync: () => "skipped" });
    const wt = folder("styre-wt-");
    const agent = door.launch({
      argv: ["true"],
      cwd: wt,
      env: process.env,
      kind: "agent",
      context: { ident: "ENG-1", stepId: 1, worktree: wt },
    });
    await agent.proc.exited;
    const out = checkLeftovers({ stopped: [agent], timeoutMs: 5000 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^styre: .*skipped.*\n$/);
  });
});

test("the listing the check reads is the same clock as a launch's start token", async () => {
  // The window compares a launch's `record.startedAt` with other processes' start tokens.
  const wt = folder("styre-wt-");
  const h = door.launch({
    argv: ["sleep", marker()],
    cwd: wt,
    env: process.env,
    kind: "agent",
    context: { ident: null, stepId: null, worktree: wt },
  });
  const me = listProcesses().find((p) => p.pid === h.proc.pid);
  expect(me?.startedAt).toBe(h.record.startedAt);
  await h.stop("forced");
});

// ---- fix round 1 ---------------------------------------------------------------------------------

/** The report lines the background check gives for a worktree. */
async function background(wt: string, since: string, timeoutMs?: number): Promise<string[]> {
  const got: string[][] = [];
  await checkLeftoversInBackground({
    worktree: wt,
    since,
    timeoutMs,
    report: (l) => got.push(l),
  });
  return got.flat();
}

describe("lsof prints odd bytes escaped; the check decodes them (review round 1, important 1)", () => {
  test.each([
    ["a UTF-8 letter as hex escapes", "/w\\xc3\\xa9 dir", "/wé dir"],
    ["a tab", "/tab\\tdir", "/tab\tdir"],
    ["a newline", "/a\\nb", "/a\nb"],
    ["a carriage return, backspace and form feed", "/a\\rb\\bc\\fd", "/a\rb\bc\fd"],
    ["a backslash", "/a\\\\b", "/a\\b"],
    ["a control character as ^X", "/a^Ib^[c", "/a\tb\x1bc"],
    ["plain text, spaces and raw UTF-8 untouched", "/plain dir/é", "/plain dir/é"],
  ])("decodes %s", (_name, raw, want) => {
    expect(decodeLsofName(raw)).toBe(want);
  });

  test("lsof gets one fixed locale, whatever the caller's", () => {
    expect(lsofEnv().LC_ALL).toBe("C");
    expect(lsofEnv().LANG).toBeUndefined();
  });

  test.each([
    ["non-ASCII", "styre wé dir "],
    ["a tab", "styre\ttab dir "],
    ["a plain control", "styre plain dir "],
  ])(
    "a worktree with %s in its path is found, by the diagnostic check and the background check",
    async (_n, prefix) => {
      const wt = folder(prefix);
      const since = nowToken();
      const m = marker();
      await leave(wt, m);
      expect(only(scan(wt, since), m)).toHaveLength(1);
      expect((await background(wt, since)).filter((l) => l.includes(`sleep ${m}`))).toHaveLength(1);
    },
  );

  /** A stand in for lsof that records the locale it was given. */
  function fakeLsof(): { seen: () => string } {
    const dir = folder("styre-fake-lsof-");
    const exe = join(dir, "lsof");
    writeFileSync(
      exe,
      `#!/bin/sh\nprintf '%s' "$LC_ALL" > "${dir}/seen"\nprintf 'p%s\\nn/\\n' "$$"\n`,
    );
    chmodSync(exe, 0o755);
    __setLsofPathForTests(exe);
    return { seen: () => readFileSync(join(dir, "seen"), "utf8") };
  }
  test.skipIf(process.platform !== "darwin")(
    "every lsof path runs with LC_ALL=C even when the environment says otherwise",
    async () => {
      const savedAll = process.env.LC_ALL;
      process.env.LC_ALL = "en_US.UTF-8";
      try {
        const wt = folder("styre-wt-");
        const f = fakeLsof();
        findLeftovers({ worktree: wt, since: "0", timeoutMs: 5000, viaDiagnostic: true });
        expect(f.seen()).toBe("C");
        writeFileSync(join(wt, "x"), "");
        findLeftovers({ worktree: wt, since: "0", timeoutMs: 5000, viaDiagnostic: false });
        expect(f.seen()).toBe("C");
        await background(wt, "0");
        expect(f.seen()).toBe("C");
      } finally {
        if (savedAll === undefined) Reflect.deleteProperty(process.env, "LC_ALL");
        else process.env.LC_ALL = savedAll;
      }
    },
  );
});

describe("checkLeftovers is the handler's entry (review round 1, important 2)", () => {
  test("it works with the door closed: no throw, and the leftover is still found", async () => {
    const wt = folder("styre wt ");
    const m = marker();
    const since = nowToken();
    // The agent waits for the go file, so its sleep is still its child (and this test's
    // descendant) when the test claims it; then it exits and leaves the sleep behind.
    const gate = goFile();
    const agent = door.launch({
      argv: [
        "sh",
        "-c",
        'nohup sleep "$1" >/dev/null 2>&1 & echo $!; while [ ! -e "$2" ] && [ -d "${2%/*}" ]; do sleep 0.02; done',
        "sh",
        m,
        gate.path,
      ],
      cwd: wt,
      env: process.env,
      kind: "agent",
      context: { ident: "ENG-1", stepId: 1, worktree: wt },
    });
    await claimPrinted(m, agent.proc.stdout, since);
    gate.go();
    await agent.proc.exited;
    expect(await until(() => isRunning(m))).toBe(true);
    await agent.finish();
    door.beginStopping();
    let out: string[] = [];
    expect(() => {
      out = checkLeftovers({ stopped: [agent], timeoutMs: 5000 });
    }).not.toThrow();
    expect(out.filter((l) => l.includes(`sleep ${m}`))).toHaveLength(1);
  });

  test("a process that was already in the worktree before the agent launch is not reported", async () => {
    const wt = folder("styre-wt-");
    const before = marker();
    await leave(wt, before); // the developer's own, running before the step
    await pastToken(nowToken());
    const mine = marker();
    const since = nowToken();
    // The agent waits for the go file, so its sleep is still its child (and this test's
    // descendant) when the test claims it; then it exits and leaves the sleep behind.
    const gate = goFile();
    const agent = door.launch({
      argv: [
        "sh",
        "-c",
        'nohup sleep "$1" >/dev/null 2>&1 & echo $!; while [ ! -e "$2" ] && [ -d "${2%/*}" ]; do sleep 0.02; done',
        "sh",
        mine,
        gate.path,
      ],
      cwd: wt,
      env: process.env,
      kind: "agent",
      context: { ident: "ENG-1", stepId: 1, worktree: wt },
    });
    await claimPrinted(mine, agent.proc.stdout, since);
    gate.go();
    await agent.proc.exited;
    expect(await until(() => isRunning(mine))).toBe(true);
    await agent.finish();
    const out = checkLeftovers({ stopped: [agent], timeoutMs: 5000 });
    expect(out.filter((l) => l.includes(`sleep ${mine}`))).toHaveLength(1); // the check ran
    expect(out.filter((l) => l.includes(`sleep ${before}`))).toEqual([]);
  });
});

describe("a reorphaned member of a live command group is not a leftover (R24 part 1)", () => {
  test("the leader is still running", async () => {
    const wt = folder("styre-wt-");
    const since = nowToken();
    const m = marker();
    const g = door.launch({
      argv: ["sh", "-c", `(sleep ${m} &); sleep ${marker()}`],
      cwd: wt,
      env: process.env,
      kind: "group",
      context: { ident: null, stepId: null, worktree: wt },
    });
    expect(await until(() => runsIn(g, m))).toBe(true);
    expect(only(scan(wt, since), m)).toEqual([]);
    await g.stop("forced");
  });

  test("the leader has already exited, its record is still held", async () => {
    const wt = folder("styre-wt-");
    const since = nowToken();
    const m = marker();
    const g = door.launch({
      argv: ["sh", "-c", `(sleep ${m} &); exit 0`],
      cwd: wt,
      env: process.env,
      kind: "group",
      context: { ident: null, stepId: null, worktree: wt },
    });
    await g.proc.exited;
    expect(await until(() => runsIn(g, m))).toBe(true);
    expect(door.liveLaunches()).toHaveLength(1);
    expect(only(scan(wt, since), m)).toEqual([]);
    await g.stop("forced");
  });
});

describe("a check overtaken by a stop, and a check that failed (R24 part 2)", () => {
  test("a stop that begins during the check ends it silently: no line, no report", async () => {
    __setCwdReadersForTests({
      async: async () => {
        door.beginStopping();
        return "skipped";
      },
    });
    expect(await background(folder("styre-wt-"), "0")).toEqual([]);
  });

  test("a failure caused by the stop (not a timeout) is silent too", async () => {
    __setCwdReadersForTests({
      async: async () => {
        door.beginStopping();
        throw new Error("the lsof launch was killed by the stop");
      },
    });
    expect(await background(folder("styre-wt-"), "0")).toEqual([]);
  });

  test("a stop that begins during the check hides a finding too: the handler reports it", async () => {
    __setCwdReadersForTests({
      async: async () => {
        door.beginStopping();
        return new Map([[process.ppid, "/"]]);
      },
    });
    expect(await background(folder("styre-wt-"), "0")).toEqual([]);
  });
});

describe.skipIf(process.platform !== "darwin")(
  "a failed or unstartable lsof is skipped with its real reason, never a clean result (R24 parts 2 and 5)",
  () => {
    function shim(body: string): string {
      const dir = folder("styre-fake-lsof-");
      const exe = join(dir, "lsof");
      writeFileSync(exe, `#!/bin/sh\n${body}\n`);
      chmodSync(exe, 0o755);
      return exe;
    }
    const paths: [string, () => string, RegExp][] = [
      ["exits 1 with empty output", () => shim("echo boom >&2; exit 1"), /status 1.*boom/],
      ["is not there", () => join(folder("styre-none-"), "no-such-lsof"), /lsof/],
    ];
    test.each(paths)("lsof that %s: the diagnostic check", (_n, make) => {
      __setLsofPathForTests(make());
      expect(scan(folder("styre-wt-"), "0")).toBe("skipped");
    });
    test.each(paths)("lsof that %s: the door form of the sync check", (_n, make) => {
      __setLsofPathForTests(make());
      expect(
        findLeftovers({
          worktree: folder("styre-wt-"),
          since: "0",
          timeoutMs: 5000,
          viaDiagnostic: false,
        }),
      ).toBe("skipped");
    });
    test.each(paths)(
      "lsof that %s: the background check says so, with the reason",
      async (_n, make, why) => {
        __setLsofPathForTests(make());
        const lines = await background(folder("styre-wt-"), "0");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^styre: skipped the check .*\(/);
        expect(lines[0]).toMatch(why);
        expect(lines[0]).not.toContain("did not finish in time");
        expect(door.liveLaunches()).toEqual([]);
      },
    );
    test("a timeout names the timeout", async () => {
      __setLsofPathForTests(shim("sleep 30"));
      const lines = await background(folder("styre-wt-"), "0", 300);
      const line = lines[0] ?? "";
      expect(line).toMatch(/did not finish/);
      expect(door.liveLaunches()).toEqual([]);
    });
    test("lsof is found without a PATH (the absolute system path is used)", async () => {
      const savedPath = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin"; // has sh and ps, not /usr/sbin
      try {
        const wt = folder("styre-wt-");
        const since = nowToken();
        const m = marker();
        await leave(wt, m);
        expect(only(scan(wt, since), m)).toHaveLength(1);
        expect((await background(wt, since)).filter((l) => l.includes(`sleep ${m}`))).toHaveLength(
          1,
        );
      } finally {
        process.env.PATH = savedPath;
      }
    });
  },
);

describe("the command text (R24 part 4)", () => {
  test("a Linux cmdline is NUL separated, joined with spaces, cut to 120", () => {
    expect(commandFromCmdline("node\0server.js\0--port=80\0")).toBe("node server.js --port=80");
    expect(commandFromCmdline(`sh\0-c\0${"x".repeat(300)}\0`).length).toBe(120);
    expect(commandFromCmdline("")).toBe("");
  });

  test.skipIf(process.platform !== "linux")(
    "on Linux a reported leftover's command comes from /proc",
    async () => {
      const wt = folder("styre-wt-");
      const since = nowToken();
      const m = marker();
      await leave(wt, m);
      const hit = await find(wt, since, m);
      expect(hit?.command).toBe(`sleep ${m}`);
    },
  );
});
