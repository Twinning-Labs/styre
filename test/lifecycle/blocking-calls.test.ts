// ENG-485 section 5.1 / Task 7: the blocking calls that used to call Bun.spawnSync directly now go
// through the door. These tests pin what the migration must keep: a stop in progress refuses them
// (and nothing turns that into "no remote" or "no branch"), the baseline and replay worktree
// removals are the cleanup calls that still run, and git output arrives intact.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { preflightAgentCli } from "../../src/agent/preflight.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { defaultGit, tryGit } from "../../src/config/slug.ts";
import {
  deferWorktreeRemoval,
  deliveredTestEvidenceAtBaseline,
  runAtBaseline,
} from "../../src/dispatch/baseline-rerun.ts";
import { resolveCheckExecution } from "../../src/dispatch/check-execution.ts";
import { replayCheckAtBaseline } from "../../src/dispatch/replay-harness.ts";
import { validateReviewEvidence } from "../../src/dispatch/review-evidence.ts";
import {
  addedFilesAt,
  changedFilesAt,
  deleteLocalBranch,
  deleteRemoteBranch,
  fileContentAt,
  pushBranch,
  stagedIndexEmpty,
  worktreeHead,
} from "../../src/dispatch/worktree.ts";
import { githubClient } from "../../src/integrations/adapters/github.ts";
import { probeCommandExists } from "../../src/setup/discover-schema.ts";
import * as door from "../../src/util/process/door.ts";
import { __resetSignalsForTests, handleStopSignal } from "../../src/util/process/signals.ts";
import { makeTestDb } from "../helpers/db.ts";

const dirs: string[] = [];
const savedState = process.env.XDG_STATE_HOME;
/** The machine's temp folder. Each test gets a private one inside it (N1): the code under test makes
 *  its `styre-baseline-*` folders in `os.tmpdir()`, which reads TMPDIR, so the counts below see only
 *  this test's folders, even while other test processes run. */
const sharedTmp = tmpdir();
const savedTmpdir = process.env.TMPDIR;
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const sh = (args: string[], cwd: string): string => {
  const r = Bun.spawnSync(args, { cwd });
  if (!r.success) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

/** A repository with one commit; returns its path and the sha. */
function repo(files: Record<string, string | Uint8Array> = { "README.md": "x" }): {
  path: string;
  sha: string;
} {
  const path = tmp("styre-blocking-repo-");
  sh(["git", "init", "-q", "-b", "main", "."], path);
  sh(["git", "config", "user.email", "t@s.dev"], path);
  sh(["git", "config", "user.name", "T"], path);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(path, name, ".."), { recursive: true });
    writeFileSync(join(path, name), content);
  }
  sh(["git", "add", "-A"], path);
  sh(["git", "commit", "-qm", "base"], path);
  return { path, sha: sh(["git", "rev-parse", "HEAD"], path) };
}

const worktreesOf = (path: string): string[] =>
  sh(["git", "worktree", "list", "--porcelain"], path)
    .split("\n")
    .filter((l) => l.startsWith("worktree "));

beforeEach(() => {
  const own = realpathSync(mkdtempSync(join(sharedTmp, "styre-blocking-tmp-")));
  dirs.push(own);
  process.env.TMPDIR = own;
  process.env.XDG_STATE_HOME = tmp("styre-blocking-state-");
  door.__resetForTests();
});
/** The `styre-baseline-*` folders in this test's own temp folder. */
const baselineDirs = (): string[] =>
  readdirSync(tmpdir()).filter((n) => n.startsWith("styre-baseline-"));
/** Worktrees a test locked: unlocked and removed after it, pass or fail. */
const locked: { repo: string; wt: string }[] = [];
/** The handler's budget for the held cleanups, when time is not what a test is about. */
const ample = () => 60_000;

afterEach(() => {
  const unlocked = locked.splice(0);
  for (const { repo, wt } of unlocked)
    Bun.spawnSync(["git", "worktree", "unlock", wt], { cwd: repo });
  // What a test still holds is removed, not just forgotten, so a failing test leaks nothing.
  door.runDeferredCleanups(ample);
  for (const { repo, wt } of unlocked) {
    Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
    rmSync(wt, { recursive: true, force: true });
  }
  door.__resetForTests();
  __resetSignalsForTests();
  if (savedTmpdir === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
  else process.env.TMPDIR = savedTmpdir;
  if (savedState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  else process.env.XDG_STATE_HOME = savedState;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// --- a stop in progress refuses every migrated call, and nothing swallows that ---------------------

test("every migrated blocking call refuses with RunInterrupted once a stop has begun", () => {
  const r = repo();
  const wt = r.path;
  const { db } = makeTestDb();
  door.beginStopping();
  const calls: Record<string, () => unknown> = {
    "tryGit (null on failure, but not on a stop)": () => tryGit(["rev-parse", "HEAD"], r.path),
    defaultGit: () => defaultGit(["rev-parse", "HEAD"], r.path),
    worktreeHead: () => worktreeHead(wt),
    fileContentAt: () => fileContentAt(r.sha, "README.md", wt),
    changedFilesAt: () => changedFilesAt(r.sha, wt),
    addedFilesAt: () => addedFilesAt(r.sha, wt),
    stagedIndexEmpty: () => stagedIndexEmpty(wt),
    deleteLocalBranch: () => deleteLocalBranch(r.path, "nope"),
    deleteRemoteBranch: () => deleteRemoteBranch(r.path, "nope"),
    pushBranch: () => pushBranch(r.path, "main"),
    probeCommandExists: () => probeCommandExists(r.path, "sh"),
    "the preflight PATH probe": () =>
      preflightAgentCli({ ...DEFAULT_AGENT_CONFIG, provider: "claude", command: "sh" }),
    "the review evidence blob read": () =>
      validateReviewEvidence(
        db,
        1,
        r.path,
        r.sha,
        [{ kind: "source", path: "README.md", line: 1 }] as never,
        true,
      ),
    "the forge's remote lookup": () => githubClient({ repoPath: r.path, token: "t" }),
  };
  for (const [name, call] of Object.entries(calls)) {
    expect(call, name).toThrow(door.RunInterrupted);
  }
});

test("tryGit keeps its contract: null on any failure, a trimmed answer on success", () => {
  const r = repo();
  expect(tryGit(["rev-parse", "HEAD"], r.path)).toBe(r.sha);
  expect(tryGit(["no-such-subcommand"], r.path)).toBeNull();
  expect(tryGit(["rev-parse", "HEAD"], join(r.path, "does", "not", "exist"))).toBeNull();
});

test("the forge's remote lookup still names a missing origin, not a stop", () => {
  const r = repo(); // no origin remote
  expect(() => githubClient({ repoPath: r.path, token: "t" })).toThrow(
    /could not read remote\.origin\.url/,
  );
  sh(["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"], r.path);
  expect(githubClient({ repoPath: r.path, token: "t" })).toMatchObject({
    owner: "acme",
    repo: "widgets",
  });
});

// --- the cleanup calls: a baseline or replay worktree is removed even when the stop lands during its run
// Once a stop has begun the run code's own release leaves the removal held: the handler alone makes
// it (I1), so these tests run the handler's cleanups after the run code returns.

test("runAtBaseline's worktree, when the stop lands during the run, is removed by the handler's cleanups", async () => {
  const r = repo();
  const before = worktreesOf(r.path);
  const obs = await runAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    command: "true",
    timeoutMs: 10_000,
    onSettled: () => door.beginStopping(), // the stop begins after the command, before the removal
  });
  expect(door.isStopping()).toBe(true);
  expect(obs.execution?.outcome).toBe("completed-zero");
  expect(worktreesOf(r.path)).toHaveLength(before.length + 1); // held for the handler
  expect(door.runDeferredCleanups(ample)).toEqual([]);
  expect(worktreesOf(r.path)).toEqual(before);
  expect(baselineDirs()).toEqual([]);
});

test("deliveredTestEvidenceAtBaseline's worktree, when the stop lands during the run, is removed by the handler's cleanups", async () => {
  const r = repo();
  const source = join(r.path, "delivered.py");
  writeFileSync(source, "def test_bug(): assert False\n");
  const plan = resolveCheckExecution({
    components: [
      {
        name: "api",
        kind: "python",
        dir: "api",
        paths: ["api/**"],
        commands: {},
        extensions: [".py"],
      },
    ],
    testFile: "api/tests/test_bug.py",
  });
  const before = worktreesOf(r.path);
  const out = await deliveredTestEvidenceAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    testFile: plan.testFile,
    sourcePath: source,
    plan,
    timeoutMs: 1000,
    run: async () => {
      door.beginStopping();
      return {
        exitCode: 1,
        stdout: "E       assert 1 == 2\n1 failed in 0.01s",
        stderr: "",
        timedOut: false,
      };
    },
  });
  expect(door.isStopping()).toBe(true);
  expect(out.verdict).toBe("binds");
  expect(worktreesOf(r.path)).toHaveLength(before.length + 1); // held for the handler
  expect(door.runDeferredCleanups(ample)).toEqual([]);
  expect(worktreesOf(r.path)).toEqual(before);
});

test("replayCheckAtBaseline's worktree, when the stop lands during the run, is removed by the handler's cleanups", async () => {
  const r = repo();
  const before = worktreesOf(r.path);
  const coarse = await replayCheckAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    components: [
      { name: "checks", kind: "python", paths: ["checks/**"], commands: {}, extensions: [".py"] },
    ],
    testFile: "checks/a_test.py",
    testName: "test_ac",
    content: "def test_ac():\n    assert False\n",
    timeoutMs: 5000,
    run: async () => {
      door.beginStopping();
      return { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false };
    },
  });
  expect(door.isStopping()).toBe(true);
  expect(coarse).toBe("red");
  expect(worktreesOf(r.path)).toHaveLength(before.length + 1); // held for the handler
  expect(door.runDeferredCleanups(ample)).toEqual([]);
  expect(worktreesOf(r.path)).toEqual(before);
});

// The stop handler re-raises without waiting for the run code to unwind, so each removal is also
// held with the door while its worktree exists: the handler's runDeferredCleanups removes it even
// when the run code is still waiting on its command (m3). A held removal then runs only once.

/** Resolves once `n` launches are live. */
async function launches(n: number): Promise<void> {
  const end = Date.now() + 10_000;
  while (door.liveLaunches().length < n) {
    if (Date.now() > end) throw new Error("the command never started");
    await Bun.sleep(10);
  }
}

test("runAtBaseline's worktree is removed by the handler's cleanups while its command still runs", async () => {
  const r = repo();
  const before = worktreesOf(r.path);
  const running = runAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    command: "sleep 30",
    timeoutMs: 30_000,
  });
  try {
    await launches(1);
    expect(worktreesOf(r.path)).toHaveLength(before.length + 1); // the baseline worktree is there
    door.beginStopping();
    expect(door.runDeferredCleanups(ample)).toEqual([]);
    expect(worktreesOf(r.path)).toEqual(before); // removed before the run code unwound
  } finally {
    // The command this test started ends with it, pass or fail, and the run code unwinds.
    for (const h of door.liveLaunches()) await h.stop("forced");
    await running;
  }
  expect(worktreesOf(r.path)).toEqual(before);
});

test("deliveredTestEvidenceAtBaseline's and replay's worktrees are removed by the handler's cleanups while their check still runs", async () => {
  const r = repo();
  const before = worktreesOf(r.path);
  const source = join(r.path, "delivered.py");
  writeFileSync(source, "def test_bug(): assert False\n");
  const components = [
    { name: "api", kind: "python" as const, paths: ["**"], commands: {}, extensions: [".py"] },
  ];
  const plan = resolveCheckExecution({ components, testFile: "tests/test_bug.py" });
  const finish: (() => void)[] = [];
  // The check is still running: its promise has not settled when the cleanups run.
  const run = () =>
    new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>(
      (resolve) => {
        finish.push(() =>
          resolve({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
        );
      },
    );
  const delivered = deliveredTestEvidenceAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    testFile: plan.testFile,
    sourcePath: source,
    plan,
    timeoutMs: 1000,
    run,
  });
  const replay = replayCheckAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    components,
    testFile: "checks/a_test.py",
    testName: "test_ac",
    content: "def test_ac():\n    assert False\n",
    timeoutMs: 1000,
    run,
  });
  try {
    const end = Date.now() + 10_000;
    while (finish.length < 2) {
      if (Date.now() > end) throw new Error("the checks never started");
      await Bun.sleep(10);
    }
    expect(worktreesOf(r.path)).toHaveLength(before.length + 2);
    door.beginStopping();
    expect(door.runDeferredCleanups(ample)).toEqual([]);
    expect(worktreesOf(r.path)).toEqual(before);
  } finally {
    // The checks end, pass or fail, so the run code unwinds and releases what it still holds.
    for (const f of finish) f();
    await Promise.all([delivered, replay]);
  }
  expect(worktreesOf(r.path)).toEqual(before);
});

// I2: a held removal that fails throws, naming the worktree and the command that finishes it by
// hand, so the failure is said: by the handler during a stop, by the run code otherwise.

/** The path git registered for the one worktree in `after` that is not in `before`. */
const added = (before: string[], after: string[]): string => {
  const line = after.find((l) => !before.includes(l));
  if (!line) throw new Error("no worktree was added");
  return line.slice("worktree ".length);
};
const lock = (repoPath: string, wt: string): void => {
  locked.push({ repo: repoPath, wt });
  sh(["git", "worktree", "lock", wt], repoPath);
};

test("a held removal that fails during a stop is said by the handler, with the worktree and the command to remove it", async () => {
  const r = repo();
  const before = worktreesOf(r.path);
  const running = runAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    command: "sleep 30",
    timeoutMs: 30_000,
  });
  const err: string[] = [];
  let wt = "";
  try {
    await launches(1);
    wt = added(before, worktreesOf(r.path));
    lock(r.path, wt); // `worktree remove --force` refuses a locked worktree
    await handleStopSignal(
      "SIGTERM",
      { command: "run", run: null },
      {
        stderr: (s) => {
          err.push(s);
        },
        emit: () => {},
        reraise: () => {},
        exit: () => {},
        now: () => Date.now(),
        leftovers: () => [],
        noCore: () => {},
      },
    );
  } finally {
    for (const h of door.liveLaunches()) await h.stop("forced");
    await running;
  }
  const lines = err.filter((l) => l.startsWith("styre: could not clean up after the run: "));
  expect(lines).toHaveLength(1);
  const line = lines[0] as string;
  const name = wt.split("/").pop() as string;
  expect(line).toMatch(/: git worktree remove --force \S+ failed \(.*locked.*\); remove it with: /);
  expect(line).toContain(`; remove it with: git -C ${r.path} worktree remove --force `);
  expect(line.endsWith(`${name}\n`)).toBe(true);
  // Said, not hidden: the worktree is still registered, and its folder is still there to remove.
  expect(worktreesOf(r.path)).toContain(`worktree ${wt}`);
  expect(existsSync(wt)).toBe(true);
});

test("a held removal that fails on the normal path is said, and the result is still returned", async () => {
  const r = repo();
  const before = worktreesOf(r.path);
  const source = join(r.path, "delivered.py");
  writeFileSync(source, "def test_bug(): assert False\n");
  const components = [
    { name: "api", kind: "python" as const, paths: ["**"], commands: {}, extensions: [".py"] },
  ];
  const plan = resolveCheckExecution({ components, testFile: "tests/test_bug.py" });
  // The check locks the worktree it runs in, so its removal fails once the check is done.
  const run = async () => {
    lock(r.path, added(before, worktreesOf(r.path)));
    return { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false };
  };
  const err: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    err.push(String(s));
    return true;
  };
  let coarse: string;
  let verdict: string;
  try {
    coarse = await replayCheckAtBaseline({
      repoPath: r.path,
      baselineSha: r.sha,
      components,
      testFile: "checks/a_test.py",
      testName: "test_ac",
      content: "def test_ac():\n    assert False\n",
      timeoutMs: 1000,
      run,
    });
    const afterReplay = worktreesOf(r.path);
    verdict = (
      await deliveredTestEvidenceAtBaseline({
        repoPath: r.path,
        baselineSha: r.sha,
        testFile: plan.testFile,
        sourcePath: source,
        plan,
        timeoutMs: 1000,
        run: async () => {
          lock(r.path, added(afterReplay, worktreesOf(r.path)));
          return { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false };
        },
      })
    ).verdict;
  } finally {
    (process.stderr as { write: unknown }).write = write;
  }
  expect(coarse).toBe("red");
  expect(verdict).not.toBe("does-not-bind");
  const lines = err.filter((l) => l.startsWith("styre: could not remove a temporary worktree: "));
  expect(lines).toHaveLength(2);
  for (const l of lines) {
    expect(l).toMatch(/git worktree remove --force \S+ failed \(.*locked.*\); remove it with: /);
    expect(l).toContain(`; remove it with: git -C ${r.path} worktree remove --force `);
  }
  expect(worktreesOf(r.path)).toHaveLength(before.length + 2);
});

/** Lines the code under test writes to stderr while `fn` runs. */
async function stderrOf(fn: () => Promise<unknown>): Promise<string[]> {
  const err: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    err.push(String(s));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr as { write: unknown }).write = write;
  }
  return err;
}

/** Puts a `git` first on PATH that runs `onRemove` (shell) for `worktree remove` and the real git
 *  for everything else. Returns the restore. */
function gitShim(onRemove: string, onList = ":"): () => void {
  return loggingGitShim(onRemove, onList).restore;
}

/** As gitShim, with `onList` (shell) run for `worktree list` too, and every call logged: `calls()`
 *  returns the logged argument lists. */
function loggingGitShim(onRemove: string, onList = ":") {
  const shim = tmp("styre-git-shim-");
  const log = join(shim, "calls.log");
  const realGit = Bun.which("git");
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$1 $2" = "worktree remove" ]; then ${onRemove}; fi\nif [ "$1 $2" = "worktree list" ]; then ${onList}; fi\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim}:${savedPath}`;
  return {
    restore: () => {
      process.env.PATH = savedPath;
    },
    calls: (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

/** The handler's dependencies, with its clock moved on by `shift` ms after its first reading. */
function handlerDeps(err: string[], shift = 0) {
  let readings = 0;
  return {
    stderr: (s: string) => {
      err.push(s);
    },
    emit: () => {},
    reraise: () => {},
    exit: () => {},
    now: () => Date.now() + (readings++ === 0 ? 0 : shift),
    leftovers: () => [],
    noCore: () => {},
  };
}

/** Starts runAtBaseline with a command that blocks, and resolves once its worktree exists. Returns
 *  the worktree, and `end`, which stops the command and lets the run code unwind. */
async function blockedBaseline(r: { path: string; sha: string }) {
  const before = worktreesOf(r.path);
  const running = runAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    command: "sleep 30",
    timeoutMs: 30_000,
  });
  await launches(1);
  const wt = added(before, worktreesOf(r.path));
  return {
    wt,
    before,
    end: async () => {
      for (const h of door.liveLaunches()) await h.stop("forced");
      await running;
    },
  };
}
const cleanupLines = (err: string[]) =>
  err.filter((l) => l.startsWith("styre: could not clean up after the run: "));

test("the handler's skip line names the worktree and the git command that removes it (B9)", async () => {
  const r = repo();
  const b = await blockedBaseline(r);
  const err: string[] = [];
  try {
    // Every reading after the first is past the deadline: no time is left for the removal.
    await handleStopSignal("SIGTERM", { command: "run", run: null }, handlerDeps(err, 10_000));
  } finally {
    await b.end();
  }
  expect(cleanupLines(err)).toEqual([
    `styre: could not clean up after the run: no time was left before the stop deadline to remove the worktree ${b.wt} with: git -C ${r.path} worktree remove --force ${b.wt}\n`,
  ]);
  // The advice works as printed.
  sh(["sh", "-c", `git -C ${r.path} worktree remove --force ${b.wt}`], r.path);
  expect(worktreesOf(r.path)).toEqual(b.before);
});

test("when the worktree's .git is gone, the skip line gives the command that works then (N2)", async () => {
  const r = repo();
  const b = await blockedBaseline(r);
  const err: string[] = [];
  try {
    rmSync(join(b.wt, ".git")); // what a removal cut short can leave
    await handleStopSignal("SIGTERM", { command: "run", run: null }, handlerDeps(err, 10_000));
  } finally {
    await b.end();
  }
  const advice = `rm -rf ${b.wt} && git -C ${r.path} worktree prune`;
  expect(cleanupLines(err)).toEqual([
    `styre: could not clean up after the run: no time was left before the stop deadline to remove the worktree ${b.wt} with: ${advice}\n`,
  ]);
  sh(["sh", "-c", advice], r.path);
  expect(worktreesOf(r.path)).toEqual(b.before);
});

test("when git fails because the worktree's .git is gone, the failure line gives the command that works then (N2)", async () => {
  const r = repo();
  const b = await blockedBaseline(r);
  const err: string[] = [];
  try {
    rmSync(join(b.wt, ".git"));
    await handleStopSignal("SIGTERM", { command: "run", run: null }, handlerDeps(err));
  } finally {
    await b.end();
  }
  const lines = cleanupLines(err);
  expect(lines).toHaveLength(1);
  const advice = `rm -rf ${b.wt} && git -C ${r.path} worktree prune`;
  expect(lines[0]).toStartWith(
    `styre: could not clean up after the run: git worktree remove --force ${b.wt} failed (`,
  );
  expect(lines[0]).toEndWith(`); remove it with: ${advice}\n`);
  // git really refused it, and the advice works as printed.
  expect(worktreesOf(r.path)).toContain(`worktree ${b.wt}`);
  sh(["sh", "-c", advice], r.path);
  expect(worktreesOf(r.path)).toEqual(b.before);
});

test("a held removal that times out says so, with the git command that removes it (B12)", async () => {
  const r = repo();
  const b = await blockedBaseline(r);
  const err: string[] = [];
  const restore = gitShim("exec sleep 20"); // a removal that would take 20 s
  try {
    // 5 s of the 6.5 s are gone after the first reading: about 1.25 s is left for the removal.
    await handleStopSignal("SIGTERM", { command: "run", run: null }, handlerDeps(err, 5_000));
  } finally {
    restore();
    await b.end();
  }
  expect(cleanupLines(err)).toEqual([
    `styre: could not clean up after the run: git worktree remove --force ${b.wt} failed (timed out); remove it with: git -C ${r.path} worktree remove --force ${b.wt}\n`,
  ]);
});

test("a held removal ended by a signal names the signal (N3)", async () => {
  const r = repo();
  const restore = gitShim("kill -INT $$"); // as a second Ctrl-C reaching git would
  let wt = "";
  let err: string[] = [];
  try {
    err = await stderrOf(async () => {
      const obs = await runAtBaseline({
        repoPath: r.path,
        baselineSha: r.sha,
        command: "true",
        timeoutMs: 10_000,
        onSettled: () => {
          wt = added([], worktreesOf(r.path).slice(1));
        },
      });
      expect(obs.execution?.outcome).toBe("completed-zero"); // the result is still returned
    });
  } finally {
    restore();
  }
  expect(err).toEqual([
    `styre: could not remove a temporary worktree: git worktree remove --force ${wt} failed (killed by SIGINT); remove it with: git -C ${r.path} worktree remove --force ${wt}\n`,
  ]);
});

test("a worktree whose folder is entirely gone, under a temp folder reached through a symlink, is still unregistered (R2-1)", async () => {
  const r = repo();
  // git lists the realpath; the temp folder's own path goes through a symlink, as macOS's does.
  const real = join(tmpdir(), "real");
  mkdirSync(real);
  const link = join(tmpdir(), "link");
  symlinkSync(real, link);
  process.env.TMPDIR = link;
  const b = await blockedBaseline(r);
  // git lists the realpath; Styre holds the same folder through the link.
  const held = join(link, basename(b.wt));
  expect(b.wt).toBe(join(real, basename(b.wt)));
  expect(existsSync(held)).toBe(true);
  const err: string[] = [];
  try {
    rmSync(held, { recursive: true, force: true }); // the whole folder is gone, git's entry is not
    await handleStopSignal("SIGTERM", { command: "run", run: null }, handlerDeps(err));
  } finally {
    await b.end();
  }
  // Removed, not left silently: git accepts the removal of a worktree whose folder is missing.
  expect(cleanupLines(err)).toEqual([]);
  expect(worktreesOf(r.path)).toEqual(b.before);
});

test("when git cannot list the worktrees, the worktree counts as registered: the removal is tried and its failure said (R2-3)", async () => {
  const r = repo();
  const b = await blockedBaseline(r);
  const shim = loggingGitShim(":", "exit 1"); // `git worktree list` fails
  const err: string[] = [];
  try {
    rmSync(join(b.wt, ".git")); // so the code must ask git whether it is still registered
    await handleStopSignal("SIGTERM", { command: "run", run: null }, handlerDeps(err));
  } finally {
    shim.restore();
    await b.end();
  }
  expect(shim.calls()).toContain(`worktree remove --force ${b.wt}`);
  const lines = cleanupLines(err);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith(
    `); remove it with: rm -rf ${b.wt} && git -C ${r.path} worktree prune\n`,
  );
  expect(worktreesOf(r.path)).toContain(`worktree ${b.wt}`); // said, and still there to remove
});

test("a temp folder written with //, ./ or ../ still takes every real removal, and an escape is still refused (R2-2)", async () => {
  const r = repo();
  const own = tmpdir();
  mkdirSync(join(own, "x"));
  mkdirSync(join(own, "sub"));
  process.env.TMPDIR = `${own}//./x/../sub`;
  const before = worktreesOf(r.path);
  const source = join(r.path, "delivered.py");
  writeFileSync(source, "def test_bug(): assert False\n");
  const components = [
    { name: "api", kind: "python" as const, paths: ["**"], commands: {}, extensions: [".py"] },
  ];
  const plan = resolveCheckExecution({ components, testFile: "tests/test_bug.py" });
  const run = async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false });
  const err = await stderrOf(async () => {
    const obs = await runAtBaseline({
      repoPath: r.path,
      baselineSha: r.sha,
      command: "true",
      timeoutMs: 10_000,
    });
    expect(obs.execution?.outcome).toBe("completed-zero");
    expect(
      (
        await deliveredTestEvidenceAtBaseline({
          repoPath: r.path,
          baselineSha: r.sha,
          testFile: plan.testFile,
          sourcePath: source,
          plan,
          timeoutMs: 1000,
          run,
        })
      ).execution?.coarse,
    ).toBe("red"); // the check ran in its worktree
    expect(
      await replayCheckAtBaseline({
        repoPath: r.path,
        baselineSha: r.sha,
        components,
        testFile: "checks/a_test.py",
        testName: "test_ac",
        content: "def test_ac():\n    assert False\n",
        timeoutMs: 1000,
        run,
      }),
    ).toBe("red");
  });
  expect(err).toEqual([]);
  expect(worktreesOf(r.path)).toEqual(before);
  expect(readdirSync(join(own, "sub"))).toEqual([]); // every folder removed
  // A path that leaves the temp folder is refused however it is written.
  const outside = join(own, "sub", "..", "styre-baseline-adv-escape");
  mkdirSync(outside);
  expect(() => deferWorktreeRemoval(r.path, outside)).toThrow(/refusing to remove/);
  expect(existsSync(outside)).toBe(true);
  // A path handed over as written, not through join(), is judged by where it resolves.
  const rawEscape = `${tmpdir()}/../styre-baseline-adv-raw-escape`; // in `own`, not in `sub`
  mkdirSync(rawEscape);
  expect(() => deferWorktreeRemoval(r.path, rawEscape)).toThrow(/refusing to remove/);
  expect(existsSync(rawEscape)).toBe(true);
  const rawInside = `${tmpdir()}/./styre-baseline-adv-raw-inside`; // in `sub`
  mkdirSync(rawInside);
  deferWorktreeRemoval(r.path, rawInside)();
  expect(existsSync(rawInside)).toBe(false);
});

/** A folder outside this test's temp folder, removed after the test. */
function outsideFolder(): string {
  const d = realpathSync(mkdtempSync(join(sharedTmp, "styre-blocking-outside-")));
  dirs.push(d);
  return d;
}

/** A registered worktree of `repoPath` at `path`, on a branch of its own, holding an uncommitted
 *  file: work that `worktree remove --force` would destroy. */
function victimWorktree(repoPath: string, path: string, branch: string): string {
  sh(["git", "worktree", "add", "-q", "-b", branch, path], repoPath);
  writeFileSync(join(path, "uncommitted.txt"), "work in progress");
  return path;
}

/** Refused before anything is held: nothing runs, and the victim worktree and its file survive. */
function expectRefusedAndKept(repoPath: string, wt: string, victim: string): void {
  const before = worktreesOf(repoPath);
  expect(() => deferWorktreeRemoval(repoPath, wt)).toThrow(/refusing to remove/);
  expect(door.runDeferredCleanups(ample)).toEqual([]); // nothing was held
  expect(readFileSync(join(victim, "uncommitted.txt"), "utf8")).toBe("work in progress");
  expect(worktreesOf(repoPath)).toEqual(before);
}

test("a prefixed symlink in the temp folder is refused, whatever it points to (R3-1a)", () => {
  const r = repo();
  // To a worktree outside the temp folder.
  const far = victimWorktree(r.path, join(outsideFolder(), "victim"), "victim-far");
  const farLink = join(tmpdir(), "styre-baseline-link-far");
  symlinkSync(far, farLink);
  expectRefusedAndKept(r.path, farLink, far);
  // To a worktree that is itself a styre-baseline folder in the temp folder: only the link check
  // can tell the two apart, since both resolve to an accepted folder.
  const near = victimWorktree(r.path, join(tmpdir(), "styre-baseline-victim"), "victim-near");
  const nearLink = join(tmpdir(), "styre-baseline-link-near");
  symlinkSync(near, nearLink);
  expectRefusedAndKept(r.path, nearLink, near);
  // A trailing slash would make the link check follow the link.
  expectRefusedAndKept(r.path, `${nearLink}/`, near);
});

test("a .. that passes through a symlink is judged where the system resolves it, and refused (R3-1b)", () => {
  const r = repo();
  const outside = outsideFolder();
  mkdirSync(join(outside, "victim"));
  const target = victimWorktree(r.path, join(outside, "styre-baseline-z"), "victim-hop");
  symlinkSync(join(outside, "victim"), join(tmpdir(), "styre-baseline-hop"));
  // As text this is <tmp>/styre-baseline-z; the system follows hop, to <outside>/styre-baseline-z.
  const wt = `${tmpdir()}/styre-baseline-hop/../styre-baseline-z`;
  // Bun's realpath resolves `..` as text, so the same folder is shown by its identity.
  const id = (p: string) => `${statSync(p).dev}:${statSync(p).ino}`;
  expect(id(wt)).toBe(id(target));
  expectRefusedAndKept(r.path, wt, target);
  // The same hop to a path that does not exist (nothing on disk yet) is refused too.
  expect(() =>
    deferWorktreeRemoval(r.path, `${tmpdir()}/styre-baseline-hop/../styre-baseline-none`),
  ).toThrow(/refusing to remove/);
});

test("deferWorktreeRemoval refuses a folder that is not a styre-baseline folder directly in the temp folder (N5)", () => {
  const r = repo();
  const notOurs = [
    join(r.path, "sub"), // inside the operator's repo: no .git of its own
    join(tmpdir(), "someone-else"),
    join(tmpdir(), "styre-baseline-adv-x", "nested"),
    join(r.path, "styre-baseline-adv-y"),
  ];
  for (const d of notOurs) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "keep.txt"), "not Styre's");
    expect(() => deferWorktreeRemoval(r.path, d), d).toThrow(/refusing to remove/);
  }
  expect(door.runDeferredCleanups(ample)).toEqual([]); // nothing was held
  for (const d of notOurs) expect(readFileSync(join(d, "keep.txt"), "utf8")).toBe("not Styre's");
  // The folders the call sites make are accepted.
  for (const prefix of ["styre-baseline-adv-", "styre-baseline-bind-", "styre-baseline-wt-"]) {
    const ok = mkdtempSync(join(tmpdir(), prefix));
    deferWorktreeRemoval(r.path, ok)();
    expect(existsSync(ok)).toBe(false);
  }
});

test("the other worktree calls are not cleanup calls: a baseline checkout is refused during a stop", async () => {
  const r = repo();
  // A git on PATH that logs every call, so the test sees what was started, not only what failed.
  const shim = tmp("styre-git-shim-");
  const log = join(shim, "calls.log");
  const realGit = Bun.which("git");
  writeFileSync(join(shim, "git"), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${realGit}' "$@"\n`, {
    mode: 0o755,
  });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim}:${savedPath}`;
  try {
    door.beginStopping();
    const obs = await runAtBaseline({
      repoPath: r.path,
      baselineSha: r.sha,
      command: "true",
      timeoutMs: 10_000,
    });
    expect(obs.execution).toBeNull(); // the add was refused, nothing ran
    expect(obs.reason).toMatch(/RunInterrupted|interrupted/);
    expect(worktreesOf(r.path)).toHaveLength(1);
    // Its empty folder is held for the handler, which removes it.
    expect(baselineDirs()).toHaveLength(1);
    expect(door.runDeferredCleanups(ample)).toEqual([]);
    expect(baselineDirs()).toEqual([]);
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
    // Never registered: git is only asked whether it lists it, and the empty folder is removed.
    expect(calls.filter((c) => c.startsWith("worktree"))).toEqual(["worktree list --porcelain"]);
    expect(worktreesOf(r.path)).toHaveLength(1);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("replay and delivered test checkouts are refused during a stop, and nothing runs", async () => {
  const r = repo();
  const source = join(r.path, "delivered.py");
  writeFileSync(source, "def test_bug(): assert False\n");
  const plan = resolveCheckExecution({
    components: [
      {
        name: "api",
        kind: "python",
        dir: "api",
        paths: ["api/**"],
        commands: {},
        extensions: [".py"],
      },
    ],
    testFile: "api/tests/test_bug.py",
  });
  let ran = 0;
  const run = async () => {
    ran++;
    return { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false };
  };
  door.beginStopping();
  expect(
    await deliveredTestEvidenceAtBaseline({
      repoPath: r.path,
      baselineSha: r.sha,
      testFile: plan.testFile,
      sourcePath: source,
      plan,
      timeoutMs: 1000,
      run,
    }),
  ).toMatchObject({ verdict: "unknown" });
  await expect(
    replayCheckAtBaseline({
      repoPath: r.path,
      baselineSha: r.sha,
      components: [
        { name: "checks", kind: "python", paths: ["checks/**"], commands: {}, extensions: [".py"] },
      ],
      testFile: "checks/a_test.py",
      testName: "test_ac",
      content: "x",
      timeoutMs: 5000,
      run,
    }),
  ).rejects.toBeInstanceOf(door.RunInterrupted);
  expect(ran).toBe(0);
  expect(worktreesOf(r.path)).toHaveLength(1);
  // Their empty folders are held for the handler, which removes them without asking git.
  expect(door.runDeferredCleanups(ample)).toEqual([]);
  expect(baselineDirs()).toEqual([]);
});

// --- git output arrives intact (no caller needs raw bytes: they all decoded UTF-8 before) -----------

test("git show returns multibyte text and a large file exactly", () => {
  const text = "café ☃ 日本語 \u{1F600}\n";
  const big = `${"x".repeat(200_000)}\n${text.repeat(20_000)}`; // well past one pipe buffer
  const r = repo();
  mkdirSync(join(r.path, "a"));
  writeFileSync(join(r.path, "a", "é☃.txt"), text);
  writeFileSync(join(r.path, "big.txt"), big);
  sh(["git", "add", "-A"], r.path);
  sh(["git", "commit", "-qm", "second"], r.path);
  const sha = sh(["git", "rev-parse", "HEAD"], r.path);
  expect(fileContentAt(sha, "a/é☃.txt", r.path)).toBe(text);
  expect(fileContentAt(sha, "big.txt", r.path)).toBe(big);
  expect(fileContentAt(sha, "absent.txt", r.path)).toBeNull();
  // A path with a byte outside printable ASCII still arrives unquoted through the -z framing.
  expect(changedFilesAt(sha, r.path).sort()).toEqual(["a/é☃.txt", "big.txt"]);
});

test("review evidence reads a committed blob through the door and counts its lines", () => {
  const r = repo({ "src/a.ts": "one\ntwo\nthree\n" });
  const { db } = makeTestDb();
  const ok = [{ kind: "source", path: "src/a.ts", line: 3 }] as never;
  const past = [{ kind: "source", path: "src/a.ts", line: 99 }] as never;
  expect(() => validateReviewEvidence(db, 1, r.path, r.sha, ok, true)).not.toThrow();
  expect(() => validateReviewEvidence(db, 1, r.path, r.sha, past, true)).toThrow(
    /nonexistent source line/,
  );
});
