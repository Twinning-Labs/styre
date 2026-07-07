import { basename } from "node:path";

/** Run git in `cwd`, returning trimmed stdout, or null on ANY failure (probe-graceful). The
 *  try/catch matters: `Bun.spawnSync` THROWS (not `{success:false}`) when `cwd` does not exist, so
 *  an unguarded call would propagate — this honors the "null on any failure" contract and keeps
 *  `slugForCwd`/`deriveSlug` robust when the resolved repo dir is missing/fabricated. */
export function tryGit(args: string[], cwd: string): string | null {
  try {
    const res = Bun.spawnSync(["git", ...args], { cwd });
    return res.success ? res.stdout.toString().trim() : null;
  } catch {
    return null;
  }
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
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
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
