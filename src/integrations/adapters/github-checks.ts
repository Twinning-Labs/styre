/**
 * The official-SDK GitHub *checks* adapter — the thin vendor edge implementing the neutral
 * `ChecksPort`. It imports the shared `githubClient` from `./github.ts` (which owns the single
 * `@octokit/*` import) — this file MUST NOT import `@octokit` directly (zero-lock-in firewall).
 *
 * The aggregation (check-runs + legacy commit statuses → passing/failing/pending) is a documented,
 * NOT-unit-tested SDK edge — it needs a live token + repo; the `githubForge` precedent. It is
 * verified by typecheck + build + the operator smoke test below. The core poll logic
 * (`pollChecks`) is exercised with `fakeChecks`.
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

      const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);
      let anyFailing = false;
      let anyPending = false;
      let anyReported = false;

      for (const run of runs) {
        anyReported = true;
        if (run.status !== "completed") anyPending = true;
        else if (run.conclusion && FAIL_CONCLUSIONS.has(run.conclusion)) anyFailing = true;
      }
      // Collapse legacy statuses to the latest state per context (the API returns newest first).
      const seen = new Set<string>();
      for (const s of statuses) {
        if (seen.has(s.context)) continue;
        seen.add(s.context);
        anyReported = true;
        if (s.state === "failure" || s.state === "error") anyFailing = true;
        else if (s.state === "pending") anyPending = true;
      }

      if (anyFailing) return "failing";
      if (anyPending) return "pending";
      if (anyReported) return "passing";
      // No checks reported yet for this commit — treat as still pending (re-poll). A repo with
      // genuinely no checks should be configured checksSystem="none", not "github".
      return "pending";
    },
  };
}
