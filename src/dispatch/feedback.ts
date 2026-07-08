import type { Database } from "bun:sqlite";
import { listActiveByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { listByTicket as listAcs } from "../db/repos/acceptance-criterion.ts";
import { getLatestByWorkUnit } from "../db/repos/dispatch.ts";
import { listByUnit, listByTicket as listSignals } from "../db/repos/ground-truth-signal.ts";

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

/** Corrective feedback for a gate-fail loopback: WHICH acceptance-checks are still red. UNLIKE
 *  implementFeedback (unit-scoped, reads per-unit verify signals), this reads the TICKET-level
 *  `ac-check-gate` signal — the only place the still-red AC-id set lives (§4). Empty string when the
 *  gate never ran or passed (stillRed empty). Reason-agnostic: the still-red set drives re-code. */
export function gateFeedback(db: Database, ticketId: number): string {
  const gateSigs = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-gate");
  const latest = gateSigs[gateSigs.length - 1];
  if (!latest) return "";
  const stillRed =
    (JSON.parse(latest.detail_json ?? "{}") as { stillRed?: number[] }).stillRed ?? [];
  if (stillRed.length === 0) return "";
  const acText = new Map(listAcs(db, ticketId).map((a) => [a.id, a.text]));
  const pathsByAc = new Map<number, string[]>();
  for (const c of listAcChecks(db, ticketId)) {
    if (c.test_path === null) continue;
    const arr = pathsByAc.get(c.ac_id) ?? [];
    arr.push(c.test_path);
    pathsByAc.set(c.ac_id, arr);
  }
  const lines = stillRed.map((acId) => {
    const paths = pathsByAc.get(acId) ?? [];
    const where = paths.length > 0 ? paths.join(", ") : "(check file unknown)";
    const text = acText.get(acId) ?? "";
    return `- AC ${acId}${text ? `: ${text}` : ""} — still-red check(s): ${where}. Make the code satisfy it.`;
  });
  return `The acceptance-check gate failed: these acceptance criteria are not yet satisfied by your code. Do NOT edit, weaken, or delete the check files (the runner freezes them and re-fails the gate on any change) — fix the CODE so they pass:\n${lines.join("\n")}`;
}
