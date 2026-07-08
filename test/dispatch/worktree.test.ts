import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addedFilesAt,
  changedFilesAt,
  changedFilesBetween,
  commitWorktree,
  ensureWorktree,
  fileContentAt,
  removeWorktree,
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

test("commitWorktree commits changes and reports changed=true with a sha", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-c`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-2", wt);
  writeFileSync(join(wt, "file.txt"), "hello");
  expect(worktreeHasChanges(wt)).toBe(true);
  const result = commitWorktree(wt, "feat: ENG-2-d0001 implement");
  expect(result.changed).toBe(true);
  expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(worktreeHasChanges(wt)).toBe(false);
});

test("commitWorktree on a clean tree reports changed=false (no-op)", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-n`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-3", wt);
  const result = commitWorktree(wt, "feat: nothing");
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
