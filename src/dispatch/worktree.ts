import { type Dirent, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

/** Run git in `cwd`, returning trimmed stdout; throws on failure. */
function git(args: string[], cwd: string): string {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (!res.success) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString().trim();
}

/** Run a git command whose output is a NUL-delimited path list, returning the raw paths (ENG-363).
 *
 *  Every path-listing git command MUST go through this. Git's default for `--name-only` is to
 *  **C-quote** any path holding a byte outside printable ASCII: `café/Gemfile` comes back as the
 *  literal 15-character string `"caf\303\251/Gemfile"`, double quotes included. Downstream that is
 *  not a path at all — `basename()` yields `Gemfile"`, so no manifest matched, no scope glob
 *  matched, and `git show <sha>:<path>` could not read it back.
 *
 *  `-z` is the load-bearing flag, not `core.quotePath=false`: quotePath only governs the
 *  non-ASCII case, and git still C-quotes a path containing a control character (a directory
 *  whose name embeds a newline still arrives as `"we\nird/x"` with it set). `-z` disables quoting
 *  unconditionally, and NUL-delimiting is the only framing a path containing a newline survives —
 *  splitting that same output on "\n" would silently yield two bogus entries. Callers therefore
 *  pass `-z` in `args`; this helper does the raw read (no trim — see `gitRaw`) and the split.
 *  The trailing NUL git writes after the last path is what the empty-token filter drops. */
function gitPathsZ(args: string[], cwd: string): string[] {
  return gitRaw(args, cwd)
    .split("\0")
    .filter((p) => p !== "");
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
 *  gates to inspect what a coding attempt actually touched. NUL-delimited — see `gitPathsZ`. */
export function changedFilesAt(sha: string, worktreePath: string): string[] {
  return gitPathsZ(["diff-tree", "--no-commit-id", "-r", "--name-only", "-z", sha], worktreePath);
}

/** Files changed between two commits (cumulative, `base..head`). Used by verify to attribute a
 *  work-unit's FULL diff — across all its commits, including loopback re-codes — to components.
 *  NUL-delimited — see `gitPathsZ`. */
export function changedFilesBetween(
  baseSha: string,
  headSha: string,
  worktreePath: string,
): string[] {
  if (baseSha === headSha) return [];
  return gitPathsZ(["diff", "--name-only", "-z", `${baseSha}..${headSha}`], worktreePath);
}

/** Files ADDED (git-status `A`) by commit `sha` — its diff vs its parent, `--diff-filter=A` only.
 *  M2's checks-identity (§5.1) accepts a check ONLY when its test file is newly added: the file-scoped
 *  selector is safe precisely because the added file contains nothing but styre's check. A modified
 *  (`M`) file is rejected — it would re-admit the pre-existing tests around the edit.
 *  NUL-delimited — see `gitPathsZ`; its output feeds `git show <sha>:<path>` in `fileContentAt`,
 *  which a C-quoted path could not address. */
export function addedFilesAt(sha: string, worktreePath: string): string[] {
  return gitPathsZ(
    ["diff-tree", "--no-commit-id", "-r", "--name-only", "--diff-filter=A", "-z", sha],
    worktreePath,
  );
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
  /** True iff this entry deletes a tracked file (porcelain status contains `D`). The discard
   *  disposition's rename-safety guard uses it: an undeclared new file coinciding with a tracked
   *  deletion may be a move git did not pair, so it must not be silently discarded. */
  isDeleted: boolean;
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
    entries.push({ path: entry.slice(3), isNew: status === "??", isDeleted: status.includes("D") });
    if (status.includes("R") || status.includes("C")) {
      i++;
      // original path of a git-DETECTED rename/copy: a tracked move, not a new file and not a bare
      // deletion (git paired it) → isNew=false, isDeleted=false.
      if (i < tokens.length) entries.push({ path: tokens[i], isNew: false, isDeleted: false });
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

/** Delete the named untracked files from the worktree — the discard disposition (checks): each path
 *  is a brand-new untracked file this dispatch created and did not declare. Mirrors undoAttempt's
 *  `git clean -fd` idiom (removes the files + any now-empty untracked dirs they created), scoped to
 *  exactly these pathspecs so pre-existing cruft is spared. No-op / never throws on empty input. */
export function discardPaths(worktreePath: string, paths: string[]): void {
  if (paths.length === 0) return;
  git(["clean", "-fd", "--", ...paths], worktreePath);
}

/** The largest single discarded file worth holding in memory for the symbol tier. A source helper is
 *  kilobytes; anything larger is not one. */
const MAX_DISCARDED_SOURCE_BYTES = 256 * 1024;
/** Total budget across one dispatch, so an agent that emits hundreds of undeclared generated files
 *  cannot pin unbounded memory in the runner for the life of the dispatch. */
const MAX_DISCARDED_SOURCE_TOTAL = 4 * 1024 * 1024;

/** Read the about-to-be-discarded files so the discard-poison guard can later ask whether one of them
 *  DEFINED a symbol the toolchain reports as missing (design 4.5). Must be called immediately before
 *  `discardPaths`, which deletes them. Unreadable, oversized and non-regular paths are skipped, as is
 *  anything past the total budget. Symlinks are skipped (not followed) — a discarded symlink may
 *  resolve outside the worktree entirely, and reading through it could cause a false tie even though
 *  the contents never leave memory. Binary files are read but simply never match a definition pattern.
 *  The symbol tier is best-effort — every other tier works without it. Never throws. */
export function readDiscardedSources(worktreePath: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let budget = MAX_DISCARDED_SOURCE_TOTAL;
  for (const p of paths) {
    try {
      const full = join(worktreePath, p);
      const st = lstatSync(full);
      if (!st.isFile() || st.size > MAX_DISCARDED_SOURCE_BYTES || st.size > budget) continue;
      out.set(p, readFileSync(full, "utf8"));
      budget -= st.size;
    } catch {
      // unreadable → skip; the guard degrades to the name-based tiers
    }
  }
  return out;
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
