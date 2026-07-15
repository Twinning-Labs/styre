import { type Dirent, existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

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

/** Stage the scoped surface and commit (CL-COMMIT — the daemon commits, never the agent):
 *  `git add -u` (all tracked modifications/deletions — always in scope; scratch is never tracked)
 *  plus the named new files. Emptiness is decided on the STAGED INDEX (see stagedIndexEmpty), so an
 *  undeclared untracked file left in the worktree never forces an empty commit. No changes → no
 *  commit; returns current HEAD with changed=false. */
export function commitWorktree(
  worktreePath: string,
  message: string,
  newPaths: string[],
): { sha: string; changed: boolean } {
  git(["add", "-u"], worktreePath);
  if (newPaths.length > 0) git(["add", "--", ...newPaths], worktreePath);
  if (stagedIndexEmpty(worktreePath)) {
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

export interface PendingEntry {
  path: string;
  isNew: boolean;
}

/** Every path in the uncommitted working-tree delta vs HEAD, with an `isNew` flag. Uses
 *  `--porcelain=v1 -z` (NUL-delimited, `quotePath=false`) so path escaping can never hide an entry.
 *  isNew ⇔ the porcelain status is exactly `??` (a brand-new untracked file). A rename/copy emits a
 *  second token (the ORIGINAL path) with no status prefix — that half is the deletion of a tracked
 *  file, so it is recorded isNew=false rather than status-parsed (its path bytes are not a status). */
export function pendingEntries(worktreePath: string): PendingEntry[] {
  // `--untracked-files=all` is load-bearing: without it git COLLAPSES a brand-new directory to a
  // single `dir/` entry, so an agent that creates `checks/ac1.py` would surface only `checks/` —
  // which no declared path (`checks/ac1.py`) can match, making the scope gate reject every new-dir
  // deliverable. Listing untracked files individually is what lets named staging + scope judgment
  // work for files the agent creates in a new subtree (the common case).
  const out = gitRaw(
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    worktreePath,
  );
  if (out === "") return [];
  const tokens = out.split("\0").filter((t) => t !== "");
  const entries: PendingEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    const status = entry.slice(0, 2); // XY
    entries.push({ path: entry.slice(3), isNew: status === "??" });
    if (status.includes("R") || status.includes("C")) {
      i++;
      if (i < tokens.length) entries.push({ path: tokens[i], isNew: false }); // original path of the rename/copy
    }
  }
  return entries;
}

/** The pending-change paths only — a convenience projection of `pendingEntries` for callers that
 *  don't need the `isNew` flag (currently the worktree tests). */
export function pendingChanges(worktreePath: string): string[] {
  return pendingEntries(worktreePath).map((e) => e.path);
}

/** True iff the STAGED INDEX has no changes. Uses `git diff --cached --quiet` (a non-throwing
 *  spawn): exit 0 → empty, exit 1 → has staged changes, anything else → a real git error → throw.
 *  Measuring the index (not `git status --porcelain`, which also reports untracked files) is what
 *  lets a read-only step with an untracked stray return changed=false instead of committing empty. */
export function stagedIndexEmpty(worktreePath: string): boolean {
  const res = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: worktreePath });
  if (res.exitCode === 0) return true;
  if (res.exitCode === 1) return false;
  throw new Error(
    `git diff --cached --quiet failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
  );
}

/** Surgically discard the current attempt: restore all tracked files to HEAD and remove ONLY the
 *  untracked files this attempt created (untracked-now minus `untrackedBefore`). Pre-existing cruft
 *  (an earlier stray, provision's `*.egg-info`) is spared — a blanket `git clean` would delete it and
 *  break the editable install. Called on every pre-commit failure exit so retries start clean. */
export function undoAttempt(worktreePath: string, untrackedBefore: Set<string>): void {
  git(["checkout", "--", "."], worktreePath);
  const strays = pendingEntries(worktreePath)
    .filter((e) => e.isNew && !untrackedBefore.has(e.path))
    .map((e) => e.path);
  if (strays.length > 0) git(["clean", "-fd", "--", ...strays], worktreePath);
}

/** Discard every uncommitted change (tracked restore + untracked removal), restoring HEAD.
 *  `git clean -fd` (no `-x`) spares ignored files, so the ephemeral SQLite under XDG state is
 *  untouched even when `worktreePath === repoPath` (in-place). */
export function revertWorktree(worktreePath: string): void {
  git(["checkout", "--", "."], worktreePath);
  git(["clean", "-fd"], worktreePath);
}

/** Roll the branch back to `sha` (`git reset --hard`), discarding any commit(s) after it AND the
 *  working tree. Used to un-do a daemon commit whose post-commit validation rejected it — so a
 *  rejected authoring round leaves NO commit on the branch (codex finding P1). `git clean -fd`
 *  (no `-x`) then removes any newly-untracked files the reset surfaced, sparing ignored files
 *  (the ephemeral SQLite under XDG state) in in-place mode. */
export function resetWorktreeHard(worktreePath: string, sha: string): void {
  git(["reset", "--hard", sha], worktreePath);
  git(["clean", "-fd"], worktreePath);
}

const SWEEP_SKIP_DIRS = new Set([".git", "node_modules"]);

/** Recursively delete every directory named `styre_scratch/` under `worktreePath` — the worker's
 *  sanctioned throwaway drawer (ENG-300). Placed by the worker next to the code it exercises so its
 *  imports resolve; styre wipes it so scratch never reaches the commit scope guard or a broad test
 *  run. Skips `.git`/`node_modules`; never throws (best-effort). Returns the repo-relative POSIX
 *  paths removed, for non-gating telemetry. */
export function sweepScratch(worktreePath: string): string[] {
  const removed: string[] = [];
  sweepWalk(worktreePath, worktreePath, removed);
  return removed;
}

function sweepWalk(dir: string, root: string, removed: string[]): void {
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip, never throw
  }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    const full = join(dir, ent.name);
    if (ent.name === "styre_scratch") {
      try {
        rmSync(full, { recursive: true, force: true });
        removed.push(relative(root, full));
      } catch {
        // best-effort: a failed remove is non-fatal — the guard and telemetry still proceed
      }
      continue; // removed — do not recurse into it
    }
    if (SWEEP_SKIP_DIRS.has(ent.name)) continue;
    sweepWalk(full, root, removed);
  }
}
