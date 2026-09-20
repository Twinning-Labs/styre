import type { Database } from "bun:sqlite";
import { findingsForUnit } from "../db/repos/review-round.ts";

/** The same unresolved ledger used by routing, including legacy deferrable majors. */
export function reviewFeedback(db: Database, ticketId: number, workUnitId: number): string {
  const findings = findingsForUnit(db, ticketId, workUnitId);
  if (findings.length === 0) return "";
  return `## Review findings requiring investigation

Treat each rationale as a claim to validate against code and evidence. Repair a justified finding;
if it is incorrect, dispute it with concrete counterevidence without making an unjustified edit.
Do not weaken tests to hide a defect. You cannot close findings or accept risk yourself.
Include exactly one review_responses entry per finding in your existing styre-sidecar:
{ "new_files": [], "review_responses": [{ "finding_id": 1, "action": "repaired" | "disputed",
"rationale": "why", "evidence": [{"kind":"source","path":"repo/relative/file","line":1}] }] }
Evidence may instead be {"kind":"measurement","signal_id":1} for runner-recorded evidence,
or {"kind":"reference","url":"https://primary-source.example/spec"} for a cited external source.
Citations and your response are claims; an independent reviewer will adjudicate them.

${JSON.stringify(findings, null, 2)}`;
}
