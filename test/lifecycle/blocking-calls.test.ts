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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightAgentCli } from "../../src/agent/preflight.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { defaultGit, tryGit } from "../../src/config/slug.ts";
import {
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
import { makeTestDb } from "../helpers/db.ts";

const dirs: string[] = [];
const savedState = process.env.XDG_STATE_HOME;
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
  process.env.XDG_STATE_HOME = tmp("styre-blocking-state-");
  door.__resetForTests();
});
afterEach(() => {
  door.__resetForTests();
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

test("runAtBaseline removes its worktree when the stop lands during the run", async () => {
  const r = repo();
  const before = worktreesOf(r.path);
  const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith("styre-baseline-adv-"));
  const obs = await runAtBaseline({
    repoPath: r.path,
    baselineSha: r.sha,
    command: "true",
    timeoutMs: 10_000,
    onSettled: () => door.beginStopping(), // the stop begins after the command, before the removal
  });
  expect(door.isStopping()).toBe(true);
  expect(obs.execution?.outcome).toBe("completed-zero");
  expect(worktreesOf(r.path)).toEqual(before);
  expect(readdirSync(tmpdir()).filter((n) => n.startsWith("styre-baseline-adv-"))).toEqual(
    tmpBefore,
  );
});

test("deliveredTestEvidenceAtBaseline removes its worktree when the stop lands during the run", async () => {
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
  expect(worktreesOf(r.path)).toEqual(before);
});

test("replayCheckAtBaseline removes its worktree when the stop lands during the run", async () => {
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
  expect(worktreesOf(r.path)).toEqual(before);
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
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
    expect(calls.filter((c) => c.startsWith("worktree add"))).toEqual([]); // never started
    expect(calls.some((c) => c.startsWith("worktree remove"))).toBe(true); // the cleanup call ran
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
