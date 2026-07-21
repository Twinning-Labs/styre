import type { RunOutcome } from "../daemon/run-ticket.ts";
import { EXIT } from "./errors.ts";

/** The user-facing sentence for a terminal outcome (presentation layer, NOT a state rename).
 *  `escalated` is intentionally absent — it is not a RunOutcome yet (ENG-353). */
export function outcomeSentence(o: RunOutcome): string {
  switch (o) {
    case "pr-ready":
      return "Opened the PR — ready for your review. Waiting on CI + merge approval.";
    case "done":
      return "Merged and released.";
    case "parked":
      return "Paused — ran out of budget; resume anytime.";
    case "blocked":
      return "Stopped — no actionable work remains.";
    case "no-progress":
      return "Stopped — couldn't make progress.";
  }
}

export function exitCodeForOutcome(o: RunOutcome): number {
  switch (o) {
    case "pr-ready":
    case "done":
      return EXIT.OK;
    case "parked":
      return EXIT.TEMPFAIL;
    case "blocked":
    case "no-progress":
      return EXIT.OPERATIONAL;
  }
}
