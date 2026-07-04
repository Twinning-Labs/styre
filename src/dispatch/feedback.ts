import type { Database } from "bun:sqlite";
import { getLatestByWorkUnit } from "../db/repos/dispatch.ts";
import { listByUnit } from "../db/repos/ground-truth-signal.ts";

/** Build the corrective feedback for re-coding a bounced-back unit, from the prior coding
 *  attempt's non-pass check results. Empty string on the first attempt (no prior failures). */
export function implementFeedback(db: Database, workUnitId: number): string {
  const sha = getLatestByWorkUnit(db, workUnitId)?.branch_head_sha ?? null;
  if (sha === null) {
    return "";
  }
  const failures = listByUnit(db, workUnitId).filter(
    (s) =>
      s.branch_head_sha === sha &&
      s.result !== "pass" &&
      s.signal_type !== "scope_diff" &&
      // advisory run-all-on-unowned sweeps surface UNTOUCHED stacks' pre-existing red — never feed
      // them to the re-coding agent (it can't and shouldn't iterate on stacks this unit didn't touch).
      s.signal_type !== "ran-all-unowned",
  );
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.map((s) => {
    const detail =
      s.detail_json === null ? {} : (JSON.parse(s.detail_json) as Record<string, unknown>);
    if (detail.reason === "behavioral-no-test") {
      return "- Your previous attempt changed behavior but added no test. Add a test that exercises the new behavior, then make it pass.";
    }
    if (s.signal_type === "completeness" && Array.isArray(detail.under)) {
      const under = detail.under as string[];
      return `- Your previous attempt did not modify these declared files, which the plan required you to change: ${under.join(", ")}. Implement the change to them.`;
    }
    const why =
      typeof detail.stderr === "string" && detail.stderr !== ""
        ? `: ${detail.stderr.slice(0, 500)}`
        : "";
    return `- The ${s.signal_type} check ${s.result}${why}`;
  });
  return `Your previous attempt did not pass verification. Fix these before finishing:\n${lines.join("\n")}`;
}
