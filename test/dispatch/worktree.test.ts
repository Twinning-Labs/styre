import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addedFilesAt,
  changedFilesAt,
  changedFilesBetween,
  commitWorktree,
  discardPaths,
  ensureWorktree,
  fileContentAt,
  pendingChanges,
  pendingEntries,
  readDiscardedSources,
  removeWorktree,
  stagedIndexEmpty,
  sweepScratch,
  undoAttempt,
  worktreeHasChanges,
} from "../../src/dispatch/worktree.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
});

// Make a real git repo with one commit on `main`; return its path.
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-wt-"));
  roots.push(root);
  const run = (args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], { cwd: root });
    if (!res.success) {
      throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    }
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@styre.dev"]);
  run(["config", "user.name", "Styre Test"]);
  writeFileSync(join(root, "README.md"), "# repo\n");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("ensureWorktree creates a worktree on a branch; idempotent on reuse", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-1", wt);
  expect(existsSync(join(wt, "README.md"))).toBe(true);
  // calling again is a no-op (does not throw)
  ensureWorktree(repo, "feat/eng-1", wt);
});

test("commitWorktree stages a named new file + tracked edits and reports changed=true", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-c`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-2", wt);
  writeFileSync(join(wt, "README.md"), "# repo edited\n"); // tracked edit → staged by `git add -u`
  writeFileSync(join(wt, "file.txt"), "hello"); // brand-new → must be named in newPaths
  expect(worktreeHasChanges(wt)).toBe(true);
  const result = commitWorktree(wt, "feat: ENG-2-d0001 implement", ["file.txt"]);
  expect(result.changed).toBe(true);
  expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(worktreeHasChanges(wt)).toBe(false);
});

test("commitWorktree does NOT commit an undeclared new file (staged index stays empty → no-op)", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-u`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-2u", wt);
  writeFileSync(join(wt, "scratch.txt"), "junk"); // brand-new, NOT passed in newPaths
  const before = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt }).stdout.toString().trim();
  const result = commitWorktree(wt, "feat: nothing declared", []); // omit it → nothing staged
  expect(result.changed).toBe(false);
  expect(result.sha).toBe(before); // HEAD unchanged; the untracked file is left in place
});

test("commitWorktree on a clean tree reports changed=false (no-op)", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-n`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-3", wt);
  const result = commitWorktree(wt, "feat: nothing", []);
  expect(result.changed).toBe(false);
  expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
});

test("removeWorktree detaches the worktree", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-r`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-4", wt);
  removeWorktree(repo, wt);
  expect(existsSync(join(wt, "README.md"))).toBe(false);
});

test("changedFilesAt returns the files a commit touched", () => {
  const root = mkdtempSync(join(tmpdir(), "styre-cf-"));
  roots.push(root);
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  writeFileSync(join(root, "feature.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "feature.test.ts"), "test\n");
  run(["add", "-A"]);
  run(["commit", "-m", "work"]);
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
  const files = changedFilesAt(sha, root);
  expect(files.sort()).toEqual(["feature.test.ts", "feature.ts"]);
});

test("changedFilesBetween returns the cumulative diff across commits", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-cfb-"));
  roots.push(repo);
  function git(a: string[], cwd: string) {
    const r = Bun.spawnSync(["git", ...a], { cwd });
    if (!r.success) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  }
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@s.dev"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "base.txt"), "x");
  git(["add", "-A"], repo);
  git(["commit", "-m", "base"], repo);
  const base = git(["rev-parse", "HEAD"], repo);
  writeFileSync(join(repo, "a.ts"), "1");
  git(["add", "-A"], repo);
  git(["commit", "-m", "c1"], repo);
  writeFileSync(join(repo, "b.ts"), "2");
  git(["add", "-A"], repo);
  git(["commit", "-m", "c2"], repo);
  const head = git(["rev-parse", "HEAD"], repo);

  expect(changedFilesBetween(base, head, repo).sort()).toEqual(["a.ts", "b.ts"]);
});

// In-place mode (worktreePath === repoPath): the checkout is disposable (single-use container),
// so styre works on a branch in the repo root instead of a separate git worktree.
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-wt-test-"));
  roots.push(dir);
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  run(["init", "-q"]);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"]);
  run(["checkout", "-q", "--detach"]); // simulate a disposable container checkout
  return dir;
}
const head = (dir: string) =>
  Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })
    .stdout.toString()
    .trim();

test("ensureWorktree in-place: checks out the branch in the repo root", () => {
  const repo = tmpRepo();
  ensureWorktree(repo, "styre/eng-1", repo); // worktreePath === repoPath
  expect(head(repo)).toBe("styre/eng-1");
});
test("ensureWorktree in-place is idempotent (no reset error on repeat)", () => {
  const repo = tmpRepo();
  ensureWorktree(repo, "styre/eng-1", repo);
  ensureWorktree(repo, "styre/eng-1", repo); // ~6x/unit in reality
  expect(head(repo)).toBe("styre/eng-1");
});
test("removeWorktree in-place is a no-op (never removes the repo root)", () => {
  const repo = tmpRepo();
  ensureWorktree(repo, "styre/eng-1", repo);
  removeWorktree(repo, repo); // must not throw, must not delete the repo
  expect(head(repo)).toBe("styre/eng-1");
});
test("worktree mode still creates a separate worktree (regression)", () => {
  const repo = tmpRepo();
  const wt = join(mkdtempSync(join(tmpdir(), "styre-wt-out-")), "eng-1");
  roots.push(wt);
  ensureWorktree(repo, "styre/eng-1", wt);
  expect(
    Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt })
      .stdout.toString()
      .trim(),
  ).toBe("styre/eng-1");
});

function repoWithCommits(): { root: string; addSha: string; modSha: string } {
  const root = mkdtempSync(join(tmpdir(), "styre-wt-"));
  roots.push(root);
  const git = (a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd: root });
    if (!r.success) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@s.dev"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(root, "existing.py"), "x = 1\n");
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  // commit that ADDS a new file
  writeFileSync(join(root, "new_test.py"), "def test_ok():\n    assert False\n");
  git(["add", "-A"]);
  git(["commit", "-m", "add"]);
  const addSha = git(["rev-parse", "HEAD"]);
  // commit that MODIFIES an existing file
  writeFileSync(join(root, "existing.py"), "x = 2\n");
  git(["add", "-A"]);
  git(["commit", "-m", "mod"]);
  const modSha = git(["rev-parse", "HEAD"]);
  return { root, addSha, modSha };
}

test("addedFilesAt returns only git-status A (added) files, not modified ones", () => {
  const { root, addSha, modSha } = repoWithCommits();
  expect(addedFilesAt(addSha, root)).toEqual(["new_test.py"]);
  expect(addedFilesAt(modSha, root)).toEqual([]); // a modify commit adds nothing
});

test("fileContentAt reads committed content, null when the path is absent at that sha", () => {
  const { root, addSha } = repoWithCommits();
  expect(fileContentAt(addSha, "new_test.py", root)).toContain("def test_ok()");
  expect(fileContentAt(addSha, "does_not_exist.py", root)).toBeNull();
});

// --- pendingEntries / pendingChanges / stagedIndexEmpty / undoAttempt (Task 1) -----------------

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-wt-"));
  roots.push(dir);
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(dir, "tracked.txt"), "v1\n");
  writeFileSync(join(dir, "deleteme.txt"), "gone soon\n"); // a committed file the deletion case removes
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return dir;
}

test("pendingEntries: new file → isNew, tracked edit → not isNew, deletion → not isNew", () => {
  const dir = repo();
  writeFileSync(join(dir, "tracked.txt"), "v2\n"); // modify tracked
  writeFileSync(join(dir, "brand_new.py"), "x\n"); // untracked new
  Bun.spawnSync(["git", "rm", "--quiet", "deleteme.txt"], { cwd: dir }); // real staged deletion of a committed file
  const entries = pendingEntries(dir).sort((a, b) => a.path.localeCompare(b.path));
  expect(entries.find((e) => e.path === "brand_new.py")?.isNew).toBe(true);
  expect(entries.find((e) => e.path === "tracked.txt")?.isNew).toBe(false);
  expect(entries.find((e) => e.path === "deleteme.txt")?.isNew).toBe(false); // deletion → not isNew
  expect(entries.find((e) => e.path === "deleteme.txt")?.isDeleted).toBe(true);
  expect(entries.find((e) => e.path === "brand_new.py")?.isDeleted).toBe(false);
  expect(entries.find((e) => e.path === "tracked.txt")?.isDeleted).toBe(false);
  expect(pendingChanges(dir).sort()).toEqual(["brand_new.py", "deleteme.txt", "tracked.txt"]);
});

test("pendingEntries: a staged rename's original-path token is isNew=false", () => {
  const dir = repo();
  Bun.spawnSync(["git", "mv", "tracked.txt", "renamed.txt"], { cwd: dir }); // staged rename → `R  renamed.txt\0tracked.txt`
  const entries = pendingEntries(dir);
  // Both the new path and the original path appear; neither is a brand-new untracked file.
  expect(entries.every((e) => e.isNew === false)).toBe(true);
  expect(entries.map((e) => e.path).sort()).toEqual(["renamed.txt", "tracked.txt"]);
});

test("stagedIndexEmpty: true when nothing staged, false with a staged deletion", () => {
  const dir = repo();
  expect(stagedIndexEmpty(dir)).toBe(true);
  Bun.spawnSync(["git", "rm", "--quiet", "tracked.txt"], { cwd: dir }); // staged deletion
  expect(stagedIndexEmpty(dir)).toBe(false);
});

test("undoAttempt: restores tracked, removes this attempt's new files, spares pre-existing cruft", () => {
  const dir = repo();
  writeFileSync(join(dir, "cruft.egg-info"), "pre\n"); // pre-existing untracked cruft
  const untrackedBefore = new Set(
    pendingEntries(dir)
      .filter((e) => e.isNew)
      .map((e) => e.path),
  );
  // the "attempt": edit tracked + create a new file
  writeFileSync(join(dir, "tracked.txt"), "attempt\n");
  writeFileSync(join(dir, "scratch.py"), "junk\n");
  undoAttempt(dir, untrackedBefore);
  expect(
    Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir }).stdout.toString().trim(),
  ).toBe("?? cruft.egg-info"); // tracked restored, scratch.py gone, cruft spared
});

// --- discardPaths (Task 1) ----------------------------------------------------------------------

test("discardPaths removes only the named untracked files, spares the rest", () => {
  const dir = repo();
  writeFileSync(join(dir, "keep.py"), "1\n");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "junk.py"), "2\n");
  discardPaths(dir, ["sub/junk.py"]);
  expect(existsSync(join(dir, "sub", "junk.py"))).toBe(false);
  expect(existsSync(join(dir, "keep.py"))).toBe(true);
});

test("discardPaths is a no-op on empty input and never throws on a missing path", () => {
  const dir = repo();
  expect(() => discardPaths(dir, [])).not.toThrow();
  expect(() => discardPaths(dir, ["does/not/exist.py"])).not.toThrow();
});

test("readDiscardedSources reads sources, skips oversized and missing paths, never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "styre-rds-"));
  writeFileSync(join(root, "small.go"), "package a\n\nfunc Help() int { return 1 }\n");
  writeFileSync(join(root, "big.go"), "x".repeat(256 * 1024 + 1));
  const out = readDiscardedSources(root, ["small.go", "big.go", "absent.go"]);
  expect([...out.keys()]).toEqual(["small.go"]);
  expect(out.get("small.go")).toContain("func Help()");
  expect(readDiscardedSources(root, []).size).toBe(0);
  rmSync(root, { recursive: true, force: true });
});

test("readDiscardedSources stops at the total budget", () => {
  const root = mkdtempSync(join(tmpdir(), "styre-rds-budget-"));
  const paths: string[] = [];
  for (let i = 0; i < 40; i++) {
    const p = `f${i}.go`;
    writeFileSync(join(root, p), "x".repeat(200 * 1024));
    paths.push(p);
  }
  const out = readDiscardedSources(root, paths);
  // 4 MB budget / 200 KB per file = 20 files kept, the rest skipped.
  expect(out.size).toBe(20);
  rmSync(root, { recursive: true, force: true });
});

test("readDiscardedSources skips symlinks rather than reading through them", () => {
  const root = mkdtempSync(join(tmpdir(), "styre-rds-link-"));
  writeFileSync(join(root, "target.txt"), "secret contents\n");
  symlinkSync(join(root, "target.txt"), join(root, "link.go"));
  const out = readDiscardedSources(root, ["link.go"]);
  expect(out.size).toBe(0);
  rmSync(root, { recursive: true, force: true });
});

// --- sweepScratch (Task 1) ----------------------------------------------------------------------

test("sweepScratch removes every styre_scratch/ dir at any depth and returns their repo-relative paths", () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(root, "a", "b", "styre_scratch"), { recursive: true });
  writeFileSync(join(root, "a", "b", "styre_scratch", "repro.py"), "x");
  mkdirSync(join(root, "pkg", "styre_scratch"), { recursive: true });
  mkdirSync(join(root, "src", "styre_checks"), { recursive: true }); // sibling convention — must be spared
  writeFileSync(join(root, "keep.ts"), "x");

  const removed = sweepScratch(root).sort();

  expect(removed).toEqual(["a/b/styre_scratch", "pkg/styre_scratch"]);
  expect(existsSync(join(root, "a", "b", "styre_scratch"))).toBe(false);
  expect(existsSync(join(root, "pkg", "styre_scratch"))).toBe(false);
  expect(existsSync(join(root, "src", "styre_checks"))).toBe(true); // spared
  expect(existsSync(join(root, "keep.ts"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("sweepScratch is a no-op (returns []) with no drawer, and skips .git and node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git", "styre_scratch"), { recursive: true }); // inside .git → skipped
  mkdirSync(join(root, "node_modules", "dep", "styre_scratch"), { recursive: true }); // skipped

  const removed = sweepScratch(root);

  expect(removed).toEqual([]);
  expect(existsSync(join(root, ".git", "styre_scratch"))).toBe(true); // never descended into
  expect(existsSync(join(root, "node_modules", "dep", "styre_scratch"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
