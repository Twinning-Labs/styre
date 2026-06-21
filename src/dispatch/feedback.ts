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
    (s) => s.branch_head_sha === sha && s.result !== "pass" && s.signal_type !== "scope_diff",
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
    const why =
      typeof detail.stderr === "string" && detail.stderr !== ""
        ? `: ${detail.stderr.slice(0, 500)}`
        : "";
    return `- The ${s.signal_type} check ${s.result}${why}`;
  });
  return `Your previous attempt did not pass verification. Fix these before finishing:\n${lines.join("\n")}`;
}
