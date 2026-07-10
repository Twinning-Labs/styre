import type { Database } from "bun:sqlite";
import { listActiveByTicket } from "../db/repos/ac-check.ts";
import { insertSignal, listByTicket } from "../db/repos/ground-truth-signal.ts";

/** After a proven docs-only commit that moved HEAD (V→sha), record that the verified verdict still
 *  holds at `sha`, so the resolver's HEAD-keyed gate/integration re-checks pass at `sha` and it
 *  advances to review instead of re-gating (design §2, Blocker-1 fix). Sound because the
 *  commitGuard proved `sha` differs from V only in doc paths. Writes, in one transaction:
 *   - the verified `integration` signal replicated verbatim (result + detail + command) — always
 *     (S4 integration always runs; `ranShasFor` is result-agnostic);
 *   - an `ac-check-gate` `pass` signal — ONLY when the ticket has active ac-checks (matches the
 *     resolver's `gateHasChecks` guard). */
export function carryVerifiedVerdictForward(db: Database, ticketId: number, sha: string): void {
  const integ = listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "integration")
    .at(-1);
  db.transaction(() => {
    if (integ) {
      insertSignal(db, {
        ticketId,
        signalType: "integration",
        result: integ.result,
        command: integ.command ?? undefined,
        branchHeadSha: sha,
        detail: integ.detail_json ? JSON.parse(integ.detail_json) : undefined,
      });
    }
    if (listActiveByTicket(db, ticketId).length > 0) {
      insertSignal(db, {
        ticketId,
        signalType: "ac-check-gate",
        result: "pass",
        branchHeadSha: sha,
        detail: { carriedForward: true },
      });
    }
  })();
}
