import { basename } from "node:path";
import { type BlockingResult, RunInterrupted, runBlocking } from "../util/process/door.ts";

/** Local git: a healthy call never takes this long (ENG-485 section 5.1). */
const LOCAL_GIT_MS = 30_000;

/** Run git in `cwd`, returning trimmed stdout, or null when git answered with a failure
 *  (probe-graceful). The try/catch matters: the spawn THROWS (not `{success:false}`) when `cwd`
 *  does not exist, so an unguarded call would propagate — this keeps `slugForCwd`/`deriveSlug`
 *  robust when the resolved repo dir is missing/fabricated. Two things are not answers and are
 *  thrown, never read as "no remote" or "no branch": a stop in progress (`RunInterrupted`), and a
 *  call that outlived its timeout and was killed. Read as null, a timeout made `deriveSlug` pick the
 *  folder name in silence: a different state folder, where `--resume` cannot find its checkpoint
 *  (ENG-485 final review A F10). */
export function tryGit(args: string[], cwd: string): string | null {
  let res: BlockingResult;
  try {
    res = runBlocking(["git", ...args], { cwd, timeoutMs: LOCAL_GIT_MS });
  } catch (err) {
    if (err instanceof RunInterrupted) throw err;
    return null;
  }
  if (res.timedOut) {
    throw new Error(`git ${args.join(" ")} timed out after ${LOCAL_GIT_MS} ms in ${cwd}`);
  }
  return res.success ? res.stdout.trim() : null;
}

/** Parse a GitHub remote URL into { owner, repo }, or null. Pure/SDK-free so slug derivation
 *  never pulls the @octokit adapter. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp) return { owner: scp[1], repo: scp[2] };
  const proto = /^(?:https?|ssh|git):\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
    trimmed,
  );
  if (proto) return { owner: proto[1], repo: proto[2] };
  return null;
}

/** Slug from the origin remote's repo name, else the dir basename. */
export function deriveSlug(repoDir: string): string {
  const url = tryGit(["config", "--get", "remote.origin.url"], repoDir);
  const parsed = url ? parseGitHubRemote(url) : null;
  return parsed?.repo ?? basename(repoDir);
}

export type GitRun = (args: string[], cwd: string) => string;
export const defaultGit: GitRun = (args, cwd) => {
  const r = runBlocking(["git", ...args], { cwd, timeoutMs: LOCAL_GIT_MS });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

/** cwd's git top-level, or throw (fail-closed). Message unchanged from in-place.ts. */
export function discoverRepoRoot(cwd: string = process.cwd(), git: GitRun = defaultGit): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new Error(
      `--in-place: no git repo at the working directory ${cwd}; launch with WORKDIR / docker -w set to the checkout.`,
    );
  }
}
