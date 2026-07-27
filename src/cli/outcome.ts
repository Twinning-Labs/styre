import type { PauseReason, RunOutcome } from "../daemon/run-ticket.ts";
import { EXIT } from "./errors.ts";

/** The user-facing sentence for a terminal outcome (presentation layer, NOT a state rename).
 *  `paused` covers every resumable stop — `reason` names WHY (budget / needs_you / interrupted).
 *  `abandoned` is reserved for a genuine terminal give-up (ENG-386); no path in this codebase
 *  currently emits it. */
export function outcomeSentence(o: RunOutcome, reason?: PauseReason): string {
  switch (o) {
    case "pr-ready":
      return "Opened the PR — ready for your review. Waiting on CI + merge approval.";
    case "done":
      return "Merged and released.";
    case "abandoned":
      return "Stopped — couldn't make progress and there's nothing specific to fix; rethink the ticket and start fresh.";
    case "paused":
      switch (reason) {
        case "budget":
          return "Paused — out of budget; resume anytime.";
        case "interrupted":
          return "Paused — interrupted; resume to continue.";
        default: // needs_you
          return "Paused — needs you to unblock it, then resume.";
      }
  }
}

export function exitCodeForOutcome(o: RunOutcome): number {
  switch (o) {
    case "pr-ready":
    case "done":
      return EXIT.OK;
    case "paused":
      return EXIT.TEMPFAIL; // 75 — resumable, every reason
    case "abandoned":
      return EXIT.OPERATIONAL; // 1 — genuine terminal
  }
}
