/**
 * The official-SDK GitHub *checks* adapter — the thin vendor edge implementing the neutral
 * `ChecksPort`. It imports the shared `githubClient` from `./github.ts` (which owns the single
 * `@octokit/*` import) — this file MUST NOT import `@octokit` directly (zero-lock-in firewall).
 *
 * This file is a NOT-unit-tested SDK edge — it needs a live token + repo; the `githubForge`
 * precedent. It is verified by typecheck + build + the operator smoke test below. The core poll
 * logic (`pollChecks`) is exercised with `fakeChecks`.
 *
 * The AGGREGATION is deliberately NOT here (ENG-340): it lives in `./github-checks-verdict.ts` as a
 * pure function and is fully unit-tested. "Needs a live token" was only ever true of the two HTTP
 * calls below — so the verdict rules moved somewhere they can be tested, and this edge is now just
 * fetch-two-lists-and-hand-them-over.
 *
 * SMOKE TEST (operator-run): point at a real clone with a pushed branch + a commit that has CI:
 *   GITHUB_TOKEN=ghp_xxx bun run -e '
 *     import { githubChecks } from "./src/integrations/adapters/github-checks.ts";
 *     const c = githubChecks({ repoPath: "/abs/path/to/clone" });
 *     console.log(await c.status({ ref: "<commit sha with checks>" }));
 *   '
 * Expect: "passing" when all checks are green, "failing" on a red check, "pending" while running.
 */
import type { CheckVerdict, ChecksPort } from "../checks.ts";
import { aggregateChecksVerdict } from "./github-checks-verdict.ts";
import { githubClient } from "./github.ts";

/** GitHub checks adapter. Aggregates the modern Checks API (check-runs) and the legacy
 *  commit-status API for a commit `ref`. Register as
 *  `{ github: () => githubChecks({ repoPath: profile.targetRepo }) }`. */
export function githubChecks(opts: { repoPath: string; token?: string }): ChecksPort {
  const { octokit, owner, repo } = githubClient(opts);

  return {
    async status({ ref }: { ref: string }): Promise<CheckVerdict> {
      // Modern Checks API (paginated — a commit can have many check-runs).
      const runs = await octokit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        owner,
        repo,
        ref,
      });
      // Legacy commit-status API (some CIs still post statuses, not check-runs).
      const statuses = await octokit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/statuses", {
        owner,
        repo,
        ref,
      });

      return aggregateChecksVerdict(runs, statuses);
    },
  };
}
