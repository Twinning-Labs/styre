import { type Dirent, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { runLockStatus } from "../cli/run-lock.ts";

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
  try {
    git(["worktree", "add", "-B", branch, worktreePath], repoPath);
  } catch (err) {
    // The add fails when `branch` is still held by a leftover worktree — a non-`done` run that never
    // freed it (the "worktree already used by worktree" collision, ENG-381). If a holder exists, free
    // it when safe (prunable) and retry once; reconcileWorktree REFUSES a live/foreign holder rather
    // than destroy it. Any other add failure (no holder → a real git error) re-throws unchanged.
    if (worktreeHoldingBranch(repoPath, branch) === null) throw err;
    reconcileWorktree(repoPath, branch, undefined, worktreePath);
    git(["worktree", "add", "-B", branch, worktreePath], repoPath);
  }
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

/** One worktree registered in a repo, as reported by `git worktree list --porcelain`. */
export interface WorktreeRecord {
  /** The worktree's path as git records it. */
  path: string;
  /** The checked-out commit, or null for a bare entry. */
  head: string | null;
  /** The full ref (`refs/heads/<name>`), or null when detached/bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** git will not prune or auto-remove it. */
  locked: boolean;
  /** git reports its working tree missing — safe to free with `git worktree prune`. */
  prunable: boolean;
}

/** Parse `git worktree list --porcelain` into one record per worktree. Pure (no git call) so the
 *  flag extraction is exhaustively testable. Records are blank-line separated; each carries
 *  `worktree <path>`, an optional `HEAD <sha>`, one of `branch refs/heads/<name>` | `detached` |
 *  `bare`, and optional `locked [<reason>]` / `prunable [<reason>]` lines. A block with no
 *  `worktree` line (e.g. the trailing blank) yields no record. */
export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  for (const block of output.split("\n\n")) {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked = false;
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
      else if (line === "detached") detached = true;
      else if (line === "bare") bare = true;
      else if (line === "locked" || line.startsWith("locked ")) locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
    }
    if (path !== null) records.push({ path, head, branch, detached, bare, locked, prunable });
  }
  return records;
}

/** Every worktree registered in `repoPath`. */
export function listWorktrees(repoPath: string): WorktreeRecord[] {
  return parseWorktreePorcelain(git(["worktree", "list", "--porcelain"], repoPath));
}

/** A worktree that currently has some branch checked out (path + git's `prunable` flag). */
export interface BranchHolder {
  path: string;
  prunable: boolean;
}

/** The worktree (if any) registered in `repoPath` that has `branch` checked out, with git's
 *  `prunable` flag; null when no registered worktree holds it. */
export function worktreeHoldingBranch(repoPath: string, branch: string): BranchHolder | null {
  const target = `refs/heads/${branch}`;
  const rec = listWorktrees(repoPath).find((w) => w.branch === target);
  return rec === undefined ? null : { path: rec.path, prunable: rec.prunable };
}

/** The disposition of a `reconcileWorktree` call. */
export interface ReconcileResult {
  /** Worktree paths this call freed (the recorded stale path if removed, plus any pruned holder). */
  freed: string[];
  /** `"in-place"` when the target IS the repo root (no separate worktree to reconcile), else null. */
  skipped: "in-place" | null;
}

/** Free `branch` so a subsequent `ensureWorktree` add can re-take it — WITHOUT ever force-removing a
 *  worktree styre can't prove is stale. The branch is deterministic per ticket (`<prefix>/<ident>`),
 *  so a blind `git worktree remove --force` on whatever holds it could destroy a live parallel run's
 *  uncommitted work (adversarial review, ENG-380).
 *
 *  In-place (the target worktree IS the repo root) has no separate worktree to reconcile — signalled
 *  either by `newWorktreePath === repoPath` (fresh run) or `staleWorktreePath === repoPath` (resume of
 *  a same-container run); the primitive owns that skip so no caller can misfire it. Otherwise:
 *    0. `checkpointDir` (ENG-382): if a DIFFERENT live run owns the ticket's run lock
 *       (`runLockStatus`), refuse outright BEFORE any git mutation — touch nothing, not even
 *       `worktree prune` — so a live parallel run's worktree is never at risk.
 *    1. If `staleWorktreePath` is given — the ticket's OWN prior worktree, recorded on resume —
 *       remove it; it is provably this ticket's, and we are resuming/replacing it.
 *    2. `git worktree prune`, which frees ONLY holders whose working dir is already gone (prunable).
 *  If a NON-prunable worktree still holds the branch afterward: with no lock context (`checkpointDir`
 *  undefined) → refuse (ENG-381 prunable-only behaviour, no way to prove staleness); else a
 *  styre-owned leftover (`/styre-wt-` path, no live owner) → free it; else (a human's own
 *  `git worktree add`, foreign path) → refuse, never force-remove. */
export function reconcileWorktree(
  repoPath: string,
  branch: string,
  staleWorktreePath: string | undefined,
  newWorktreePath: string,
  checkpointDir?: string,
): ReconcileResult {
  if (newWorktreePath === repoPath || staleWorktreePath === repoPath) {
    return { freed: [], skipped: "in-place" };
  }
  const freed: string[] = [];
  // A DIFFERENT live run owning this ticket's checkpoint means we must touch nothing.
  const foreignLive = (() => {
    if (checkpointDir === undefined) return false;
    const s = runLockStatus(checkpointDir);
    return s !== null && !s.self;
  })();

  // Touch NOTHING when a different live run owns the ticket: refuse BEFORE any git mutation —
  // including `worktree prune` — rather than after. Behaviour-equivalent either way (prune only
  // ever reaps ALREADY-dead worktrees, never the live holder), but this ordering matches the
  // invariant literally instead of just in effect.
  if (foreignLive) {
    const holder = worktreeHoldingBranch(repoPath, branch);
    if (holder !== null) {
      throw new Error(
        `branch ${branch} is checked out at ${holder.path} by a worktree styre can't safely remove; ` +
          `free it with 'git worktree remove ${holder.path}', then re-run.`,
      );
    }
    return { freed: [], skipped: null };
  }

  if (staleWorktreePath !== undefined) {
    try {
      removeWorktree(repoPath, staleWorktreePath); // the ticket's own recorded prior worktree
      freed.push(staleWorktreePath);
    } catch {
      // already gone / never registered — the prune below clears any dangling ref
    }
  }

  const prunableHolder = worktreeHoldingBranch(repoPath, branch);
  if (prunableHolder?.prunable) freed.push(prunableHolder.path);
  git(["worktree", "prune"], repoPath);

  const holder = worktreeHoldingBranch(repoPath, branch);
  if (holder !== null && !holder.prunable) {
    // Free ONLY a styre-owned leftover with no live owner. An unknown lock context, or a human's
    // own `git worktree add` (non-styre path) → refuse, never force-remove. (The different-live-
    // owner case is handled above, before any mutation.)
    const styreOwned = holder.path.includes("/styre-wt-");
    if (checkpointDir === undefined || !styreOwned) {
      throw new Error(
        `branch ${branch} is checked out at ${holder.path} by a worktree styre can't safely remove; ` +
          `free it with 'git worktree remove ${holder.path}', then re-run.`,
      );
    }
    removeWorktree(repoPath, holder.path);
    git(["worktree", "prune"], repoPath);
    freed.push(holder.path);
  }
  return { freed, skipped: null };
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

/** Delete the local branch if it exists; a missing branch is a silent success. */
export function deleteLocalBranch(repoPath: string, branch: string): void {
  Bun.spawnSync(["git", "branch", "-D", branch], { cwd: repoPath }); // ignore exit (absent = fine)
}

/** Delete the remote branch (closing its PR) if it exists; a missing remote ref is a silent
 *  success. Existence is probed first (locale-proof — no stderr parsing); a real delete failure
 *  is a non-fatal warning (the effort reap already succeeded), never thrown. */
export function deleteRemoteBranch(repoPath: string, branch: string): void {
  const ls = Bun.spawnSync(["git", "ls-remote", "--heads", "origin", branch], { cwd: repoPath });
  if (ls.exitCode !== 0 || ls.stdout.toString().trim() === "") return; // no remote / branch absent → silent
  const res = Bun.spawnSync(["git", "push", "origin", "--delete", branch], { cwd: repoPath });
  if (res.exitCode !== 0) {
    process.stderr.write(
      `styre clean: could not delete remote branch ${branch}: ${res.stderr.toString().trim()}\n`,
    );
  }
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
