import type { IssueState, IssueTrackerPort } from "../issue-tracker.ts";
import type { IngestedTicket } from "../ticket-source.ts";

/** In-memory recording IssueTrackerPort for tests (the FakeAgentRunner analogue). */
export function fakeIssueTracker(opts?: { ticket?: IngestedTicket }): IssueTrackerPort & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const cannedTicket: IngestedTicket = opts?.ticket ?? {
    ident: "ENG-1",
    title: "fake ticket",
    description: "fake body",
    typeLabel: "Feature",
    linearIssueUuid: "fake-uuid",
    url: "https://fake/ENG-1",
  };
  return {
    calls,
    async fetchTicket(ref: string) {
      calls.push({ method: "fetchTicket", args: [ref] });
      return cannedTicket;
    },
    async setState(ref: string, state: IssueState) {
      calls.push({ method: "setState", args: [ref, state] });
    },
    async setLabels(ref: string, change: { add: string[]; remove: string[] }) {
      calls.push({ method: "setLabels", args: [ref, change] });
    },
    async addComment(ref: string, body: string, idempotencyKey: string) {
      calls.push({ method: "addComment", args: [ref, body, idempotencyKey] });
      return `fake-comment-${calls.length}`;
    },
  };
}
