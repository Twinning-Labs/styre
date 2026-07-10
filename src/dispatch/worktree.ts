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
 *  The worktree is the agent's only writable surface (capability isolation, move 4).
 *
 *  In-place mode (`worktreePath === repoPath`, i.e. the checkout is disposable — a single-use
 *  container): no separate worktree. Create/switch the branch directly in the repo root instead. */
export function ensureWorktree(repoPath: string, branch: string, worktreePath: string): void {
  if (worktreePath === repoPath) {
    // Called ~6x/unit; `checkout -B` resets the ref to HEAD each time, so skip when already on it.
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath) === branch) return;
    git(["checkout", "-B", branch], repoPath);
    return;
  }
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
  if (worktreePath === repoPath) return; // in-place: never remove the repo root
  git(["worktree", "remove", "--force", worktreePath], repoPath);
}

/** The current commit sha of `branch` in `repoPath`, or null if the branch/ref is absent. */
export function branchHeadSha(repoPath: string, branch: string): string | null {
  try {
    return git(["rev-parse", branch], repoPath);
  } catch {
    return null;
  }
}

/** The files changed by commit `sha` (its diff vs its parent). Read-only; used by the verify
 *  gates to inspect what a coding attempt actually touched. */
export function changedFilesAt(sha: string, worktreePath: string): string[] {
  const out = git(["diff-tree", "--no-commit-id", "-r", "--name-only", sha], worktreePath);
  return out === "" ? [] : out.split("\n").filter((l) => l !== "");
}

/** Files changed between two commits (cumulative, `base..head`). Used by verify to attribute a
 *  work-unit's FULL diff — across all its commits, including loopback re-codes — to components. */
export function changedFilesBetween(
  baseSha: string,
  headSha: string,
  worktreePath: string,
): string[] {
  if (baseSha === headSha) return [];
  const out = git(["diff", "--name-only", `${baseSha}..${headSha}`], worktreePath);
  return out === "" ? [] : out.split("\n").filter((l) => l !== "");
}

/** Files ADDED (git-status `A`) by commit `sha` — its diff vs its parent, `--diff-filter=A` only.
 *  M2's checks-identity (§5.1) accepts a check ONLY when its test file is newly added: the file-scoped
 *  selector is safe precisely because the added file contains nothing but styre's check. A modified
 *  (`M`) file is rejected — it would re-admit the pre-existing tests around the edit. */
export function addedFilesAt(sha: string, worktreePath: string): string[] {
  const out = git(
    ["diff-tree", "--no-commit-id", "-r", "--name-only", "--diff-filter=A", sha],
    worktreePath,
  );
  return out === "" ? [] : out.split("\n").filter((l) => l !== "");
}

/** The committed content of `file` at `sha` (`git show <sha>:<file>`), or `null` when the path is
 *  absent at that commit. Used by checks-identity (§5.1) to confirm the authored `test_name` is
 *  present in the committed added file (every line of an added file is a `+` line, so "on a `+`
 *  line" reduces to substring presence — M2a plan-time decision 2). */
export function fileContentAt(sha: string, file: string, worktreePath: string): string | null {
  const res = Bun.spawnSync(["git", "show", `${sha}:${file}`], { cwd: worktreePath });
  return res.success ? res.stdout.toString() : null;
}

/** Like the module-private `git`, but returns RAW stdout (NO trim). Required for `--porcelain -z`
 *  parsing: an unstaged entry's status column is `" M path"` (leading space), and the existing
 *  `git()` `.trim()` would strip that space off the FIRST entry, corrupting its path (review
 *  Blocker-1). Mirrors `git`'s spawn + error handling. */
function gitRaw(args: string[], cwd: string): string {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (!res.success) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString();
}

/** The current HEAD commit sha of the worktree. */
export function worktreeHead(worktreePath: string): string {
  return git(["rev-parse", "HEAD"], worktreePath);
}

/** Every path in the uncommitted working-tree delta vs HEAD — tracked modifications/deletions,
 *  untracked additions, and BOTH sides of a rename/copy. Uses `--porcelain=v1 -z` (NUL-delimited,
 *  never octal-quoted, `core.quotePath=false`) so no path escaping/quoting can hide an entry.
 *  Load-bearing for the docs:revise commitGuard: an agent with Write can CREATE an untracked
 *  source file, which a bare `git diff` would miss (review finding B1). */
export function pendingChanges(worktreePath: string): string[] {
  // gitRaw (NOT git): porcelain -z status columns can start with a space (" M path"); trimming
  // would corrupt the first entry's path (review Blocker-1). The trailing NUL is dropped by the
  // `!== ""` filter below.
  const out = gitRaw(
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z"],
    worktreePath,
  );
  if (out === "") return [];
  const tokens = out.split("\0").filter((t) => t !== "");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    const status = entry.slice(0, 2); // XY
    paths.push(entry.slice(3)); // the (new) path
    // Rename/copy entries are followed by a second token: the ORIGINAL path.
    if (status.includes("R") || status.includes("C")) {
      i++;
      if (i < tokens.length) paths.push(tokens[i]);
    }
  }
  return paths;
}

/** Discard every uncommitted change (tracked restore + untracked removal), restoring HEAD.
 *  `git clean -fd` (no `-x`) spares ignored files, so the ephemeral SQLite under XDG state is
 *  untouched even when `worktreePath === repoPath` (in-place). */
export function revertWorktree(worktreePath: string): void {
  git(["checkout", "--", "."], worktreePath);
  git(["clean", "-fd"], worktreePath);
}
