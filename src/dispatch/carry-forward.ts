import type { Database } from "bun:sqlite";
import { listActiveByTicket } from "../db/repos/ac-check.ts";
import { insertSignal, listByTicket } from "../db/repos/ground-truth-signal.ts";

/** After a proven docs-only commit that moved HEAD (V→sha), record that the verified verdict still
 *  holds at `sha`, so the resolver's HEAD-keyed gate/integration re-checks pass at `sha` and it
 *  advances to review instead of re-gating (design §2, Blocker-1 fix). Sound because the
 *  docScope commit scope proved `sha` differs from V only in doc paths. Writes, in one transaction:
 *   - the verified `integration` signal replicated (result + command + detail, the detail gaining
 *     `carriedForward` and `carriedFrom`) — always (S4 integration always runs; `ranShasFor` is
 *     result-agnostic);
 *   - an `ac-check-gate` `pass` signal — ONLY when the ticket has active ac-checks (matches the
 *     resolver's `gateHasChecks` guard). */
export function carryVerifiedVerdictForward(db: Database, ticketId: number, sha: string): void {
  // The ticket-level (work_unit_id NULL) integration signal — the one `ranShasFor` reads. Filtering
  // on NULL hardens the read against any future work-unit-scoped integration signal (none today).
  const integ = listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "integration" && s.work_unit_id === null)
    .at(-1);
  db.transaction(() => {
    if (integ) {
      // Replicated verbatim, INCLUDING its `ran` run record — which the ENG-439 evidence floor
      // reads as executed evidence at the new head. That is intended (a docs-only commit cannot
      // invalidate a suite run) but it is the one place a run record is attached to a commit at
      // which it did not execute, so it is marked. `carriedForward` is a LEDGER marker, read by
      // nothing today — including the floor, deliberately: refusing carried evidence would
      // escalate every needs_docs ticket that committed docs. It exists so an audit can tell a
      // carried claim from a measured one, the same role the gate copy's flag already plays.
      // Known limit on the docs-only premise: in a repo that compiles docs into its suite (Rust
      // doctests, Sphinx/pytest --doctest-glob) a docs commit CAN break the run being vouched for.
      const carried = integ.detail_json
        ? (JSON.parse(integ.detail_json) as Record<string, unknown>)
        : {};
      insertSignal(db, {
        ticketId,
        signalType: "integration",
        result: integ.result,
        command: integ.command ?? undefined,
        branchHeadSha: sha,
        // `carriedFrom` is READ — the evidence floor follows it to find the per-unit sweeps this
        // function does not replicate. It is what keeps a docs commit from destroying one evidence
        // channel while carrying the other across.
        // Set or CLEARED, never inherited. `...carried` may already hold a `carriedFrom` from an
        // earlier hop, and a stale one would point the evidence floor at a head two carries back,
        // where the unit sweeps it is looking for do not live. One hop is the only claim this
        // function can support.
        detail: { ...carried, carriedForward: true, carriedFrom: integ.branch_head_sha ?? null },
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
