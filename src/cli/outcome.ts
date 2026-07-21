import type { RunOutcome } from "../daemon/run-ticket.ts";
import { EXIT } from "./errors.ts";

/** The user-facing sentence for a terminal outcome (presentation layer, NOT a state rename).
 *  `escalated` is a distinct outcome from `blocked`: the run explicitly handed the ticket to a
 *  human (pending `human_resume`), rather than hitting a resolver dead-end (ENG-353). */
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
    case "escalated":
      return "Escalated — a human needs to unblock this; re-run once it's resolved.";
  }
}

export function exitCodeForOutcome(o: RunOutcome): number {
  switch (o) {
    case "pr-ready":
    case "done":
      return EXIT.OK;
    case "parked":
    case "escalated":
      return EXIT.TEMPFAIL;
    case "blocked":
    case "no-progress":
      return EXIT.OPERATIONAL;
  }
}
