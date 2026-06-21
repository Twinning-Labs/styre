import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedFilesAt,
  commitWorktree,
  ensureWorktree,
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
