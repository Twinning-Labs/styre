import type { IssueState, IssueTrackerPort } from "../issue-tracker.ts";

/** In-memory recording IssueTrackerPort for tests (the FakeAgentRunner analogue). */
export function fakeIssueTracker(): IssueTrackerPort & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
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
