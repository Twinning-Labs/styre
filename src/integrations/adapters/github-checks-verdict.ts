/**
 * The GitHub checks AGGREGATION — pure, vendor-typed, fully unit-tested (ENG-340).
 *
 * Split out of `github-checks.ts` deliberately. That file is a documented not-unit-tested SDK edge
 * because it needs a live token + repo; that is true of the two HTTP calls and false of the logic
 * they feed. Keeping the decision here means every verdict rule is testable without a token, and
 * the edge shrinks to "fetch two lists, hand them over".
 *
 * Structural types (not `@octokit` types) keep the zero-lock-in firewall intact: this file imports
 * no vendor SDK, and `github-checks.ts` passes the API payloads in structurally.
 */
import type { CheckVerdict } from "../checks.ts";

/** The fields we need from a modern Checks API check-run. */
export interface CheckRunLike {
  status: string;
  conclusion?: string | null;
}

/** The fields we need from a legacy commit-status. */
export interface CommitStatusLike {
  context: string;
  state: string;
}

/** Conclusions that mean "this check is satisfied".
 *  `neutral` and `skipped` belong here: branch protection treats a skipped required check as
 *  satisfied, so treating them as red would block PRs GitHub itself considers mergeable. */
const PASS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Conclusions that produced NO verdict about the code — neither green nor red, so they are
 *  ignored entirely and a sibling check decides.
 *
 *  `cancelled` is the load-bearing one (ENG-340 #1). Styre always pushes then opens a PR, which is
 *  exactly what trips `concurrency: cancel-in-progress`: the push suite is cancelled by the PR
 *  suite, and BOTH hang off the same head sha (`filter=latest` dedups within a suite, not across
 *  suites). Counting `cancelled` as failure escalated green PRs. It also fires on manual
 *  cancellation and `workflow_run` cleanups — never a statement about the code.
 *
 *  `stale` is GitHub explicitly saying the result is no longer valid for this sha. That is not
 *  evidence of green (the old denylist read it as such); it is the absence of evidence. */
const NO_VERDICT_CONCLUSIONS = new Set(["cancelled", "stale"]);

/**
 * Aggregate check-runs + legacy commit-statuses for one sha into a single verdict.
 *
 * Precedence: any red → `failing`; else anything unfinished → `pending`; else, if anything
 * actually reported a verdict → `passing`; else `pending` (nothing has reported *yet* — the caller's
 * wait budget bounds that, and ENG-340's `no_checks_configured` grace will separate "yet" from
 * "ever").
 *
 * The pass set is an ALLOWLIST on purpose. It used to be a failure denylist, which fails OPEN:
 * every conclusion not in the set read as green, so `startup_failure` (a workflow that never ran
 * because its YAML is broken) reported the PR as verified. Breaking your CI config was a way to
 * make styre call a PR ready. Unknown conclusions — including ones GitHub adds after this ships —
 * now fail safe.
 */
export function aggregateChecksVerdict(
  runs: readonly CheckRunLike[],
  statuses: readonly CommitStatusLike[],
): CheckVerdict {
  let anyFailing = false;
  let anyPending = false;
  let anyReported = false;

  for (const r of runs) {
    if (r.status !== "completed") {
      anyPending = true;
      continue;
    }
    const conclusion = r.conclusion ?? "";
    if (NO_VERDICT_CONCLUSIONS.has(conclusion)) continue;
    anyReported = true;
    if (!PASS_CONCLUSIONS.has(conclusion)) anyFailing = true;
  }

  // Collapse to the latest state per context (the API returns newest first).
  const seen = new Set<string>();
  for (const s of statuses) {
    if (seen.has(s.context)) continue;
    seen.add(s.context);
    anyReported = true;
    if (s.state === "success") continue;
    if (s.state === "pending") anyPending = true;
    else anyFailing = true; // failure, error, and anything unrecognised
  }

  if (anyFailing) return "failing";
  if (anyPending) return "pending";
  if (anyReported) return "passing";
  return "pending";
}
