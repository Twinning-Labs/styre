/**
 * The official-SDK GitHub adapter — the thin vendor edge implementing the neutral `ForgePort`
 * behind `@octokit/rest` (PRs + comments) and the `git` CLI (the branch push). This is the ONLY
 * file in the repo allowed to import the GitHub SDK; the core depends solely on `../forge.ts`
 * (the Linear-adapter precedent).
 *
 * Why both Octokit AND git: Octokit speaks the REST API (open/probe PRs, post comments) but cannot
 * transfer commit OBJECTS — only the daemon's authenticated `git push` moves the branch's commits to
 * the remote. So push is a `git -C ${repoPath} push origin ${branch}` (probe-skipped if the remote
 * ref is already at the target sha); PRs/comments go through Octokit.
 *
 * Zero lock-in: every `@octokit/*` import stays here. The pure `parseGitHubRemote` helper below is
 * unit-tested; the SDK/git-calling paths are not (the fake port covers the core, and they need a live
 * token + remote), verified only by typecheck + build.
 *
 * SMOKE TEST (operator-run, no real API/push in CI — the Linear-adapter precedent): the adapter needs
 * a real GitHub repo cloned at `repoPath` with a pushed feature branch + commit, and a token with
 * `repo` scope. Run manually:
 *
 *   GITHUB_TOKEN=ghp_xxx bun run -e '
 *     import { githubForge } from "./src/integrations/adapters/github.ts";
 *     const f = githubForge({ repoPath: "/abs/path/to/scratch/clone" });
 *     await f.push({ branch: "styre-smoke", sha: "<commit sha on that branch>" });
 *     const pr = await f.ensurePr({ branch: "styre-smoke", base: "main", title: "styre smoke", body: "smoke" });
 *     console.log("PR", pr.ref, pr.url);
 *     console.log("comment", await f.addPrComment(pr.ref, "smoke from styre", "smoke-" + Date.now()));
 *   '
 *
 * Expect: the branch pushes (or skips if already at sha); a PR is created or reused (re-running returns
 * the same ref/url); a comment is posted, and re-running the same idempotencyKey returns null (no dup).
 */
import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import type { ForgePort } from "../forge.ts";

/** The hidden idempotency tag appended to a PR comment and probed for on dedup. Pure. */
export function projKeyTag(idempotencyKey: string): string {
  return `<!-- proj-key: ${idempotencyKey} -->`;
}

/**
 * Parse a git remote URL into `{ owner, repo }`, or null if it isn't a GitHub remote.
 * Handles SSH (`git@github.com:owner/repo.git`), HTTPS (`https://github.com/owner/repo.git`), and
 * `ssh://git@github.com/owner/repo.git`, with or without a trailing `.git` / slash / whitespace.
 * A non-GitHub host or a missing owner/repo segment returns null. Pure.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  // SCP-like SSH: git@github.com:owner/repo(.git)
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp) return { owner: scp[1], repo: scp[2] };
  // URL forms: https://github.com/owner/repo(.git) or ssh://git@github.com/owner/repo(.git)
  const proto = /^(?:https?|ssh|git):\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
    trimmed,
  );
  if (proto) return { owner: proto[1], repo: proto[2] };
  return null;
}

/** Resolve `{ owner, repo }` from the `origin` remote of the git repo at `repoPath`. */
function resolveOwnerRepo(repoPath: string): { owner: string; repo: string } {
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync("git", ["-C", repoPath, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
  } catch (cause) {
    throw new Error(
      `githubForge: could not read remote.origin.url for repo at ${repoPath} (is it a git checkout with an 'origin' remote?)`,
      { cause },
    );
  }
  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) {
    throw new Error(
      `githubForge: remote.origin.url '${remoteUrl}' is not a recognizable GitHub remote.`,
    );
  }
  return parsed;
}

/**
 * The GitHub adapter. Backed by `new Octokit({ auth })` (token from opts or `GITHUB_TOKEN`; a
 * missing token is a setup/GOAL-INSTALL failure) plus the `git` CLI for the push. Owner/repo are
 * derived from the `origin` remote of `repoPath`. Register as
 * `{ github: () => githubForge({ repoPath: profile.targetRepo }) }`.
 */
export function githubForge(opts: { repoPath: string; token?: string }): ForgePort {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "githubForge: no GitHub token. Set GITHUB_TOKEN (or pass opts.token) — this is a setup/GOAL-INSTALL touchpoint.",
    );
  }
  const { repoPath } = opts;
  const { owner, repo } = resolveOwnerRepo(repoPath);
  const octokit = new Octokit({ auth: token });

  return {
    async push({ branch, sha }: { branch: string; sha: string }): Promise<void> {
      // Probe: if the remote head is already at sha, skip (idempotent).
      try {
        const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
        if (ref.data.object.sha === sha) return;
      } catch (err) {
        // A 404 means the branch doesn't exist on the remote yet — fall through to push.
        if ((err as { status?: number }).status !== 404) throw err;
      }
      // Only the daemon's authenticated git can transfer the commit objects. Feature branch only.
      execFileSync("git", ["-C", repoPath, "push", "origin", branch], { stdio: "pipe" });
    },

    async ensurePr({
      branch,
      base,
      title,
      body,
    }: {
      branch: string;
      base: string;
      title: string;
      body: string;
    }): Promise<{ ref: string; url: string }> {
      // Probe: reuse an existing open PR for head owner:branch.
      const existing = await octokit.pulls.list({
        owner,
        repo,
        head: `${owner}:${branch}`,
        state: "open",
      });
      const found = existing.data[0];
      if (found) return { ref: String(found.number), url: found.html_url };
      const created = await octokit.pulls.create({ owner, repo, head: branch, base, title, body });
      return { ref: String(created.data.number), url: created.data.html_url };
    },

    async addPrComment(
      prRef: string,
      body: string,
      idempotencyKey: string,
    ): Promise<string | null> {
      const issueNumber = Number(prRef);
      const tag = projKeyTag(idempotencyKey);
      // Probe the PR's issue comments for the idempotency tag.
      const existing = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
      });
      if (existing.data.some((c) => (c.body ?? "").includes(tag))) return null;
      const created = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: `${body}\n\n${tag}`,
      });
      return String(created.data.id);
    },
  };
}
