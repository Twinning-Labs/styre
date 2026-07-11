import type { Database } from "bun:sqlite";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";

interface VacuousFinding {
  acId: number;
  reason: string;
}

/** Corrective feedback for a scoped re-author `checks:dispatch` (paralleling `designFeedback`): the
 *  vacuous findings that forced the latest checks loopback, so the re-author knows WHY each flagged
 *  AC's prior check was vacuous. Empty when there is no prior checks loopback (fresh dispatch). */
export function checksFeedback(db: Database, ticketId: number): string {
  const events = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "checks",
  );
  const latest = events[events.length - 1];
  if (!latest?.payload_json) return "";
  const findings = (JSON.parse(latest.payload_json) as { findings?: VacuousFinding[] }).findings;
  if (!findings || findings.length === 0) return "";
  const lines = findings.map((f) => `- AC ${f.acId}: prior check was vacuous — ${f.reason}`);
  return `## Prior check feedback (re-author to actually exercise the AC)\n\nA prior authored check PASSED on the current broken code — it is vacuous and did not test the criterion. Write a check that FAILS on the code as it is now, and RUN it to confirm it fails for the RIGHT reason (the asserted behavior, not an import/collection error) before finishing:\n${lines.join("\n")}`;
}
