import { existsSync } from "node:fs";
import { join } from "node:path";

/** Run git in `cwd`, returning trimmed stdout; throws on failure. */
function git(args: string[], cwd: string): string {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (!res.success) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString().trim();
}

/** Create a worktree on `branch` (reset to current HEAD) if absent; reuse if present.
 *  The worktree is the agent's only writable surface (capability isolation, move 4). */
export function ensureWorktree(repoPath: string, branch: string, worktreePath: string): void {
  if (existsSync(join(worktreePath, ".git"))) {
    return;
  }
  git(["worktree", "add", "-B", branch, worktreePath], repoPath);
}

export function worktreeHasChanges(worktreePath: string): boolean {
  return git(["status", "--porcelain"], worktreePath) !== "";
}

/** Stage everything and commit (CL-COMMIT — the daemon commits, never the agent).
 *  No changes → no commit; returns the current HEAD sha with changed=false. */
export function commitWorktree(
  worktreePath: string,
  message: string,
): { sha: string; changed: boolean } {
  git(["add", "-A"], worktreePath);
  if (git(["status", "--porcelain"], worktreePath) === "") {
    return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: false };
  }
  git(["commit", "-m", message], worktreePath);
  return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: true };
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  git(["worktree", "remove", "--force", worktreePath], repoPath);
}
