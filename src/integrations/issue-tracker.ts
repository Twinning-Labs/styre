/** Vendor-neutral issue-tracker port (zero lock-in). The core depends only on this interface;
 *  Linear/JIRA/etc. are config-selected adapters that live behind it. Mirrors the AgentRunner
 *  pattern (src/agent/runner.ts + selectAgentRunner). */
import type { IngestedTicket } from "./ticket-source.ts";

export type IssueState = "in_progress" | "in_review" | "done" | "canceled" | "blocked";

export interface IssueTrackerPort {
  /** Ingestion-only READ: fetch a ticket by ref to seed the SoT (control-loop trigger). MUST NOT
   *  be called from the control loop — the loop reads the SoT, never the tracker. */
  fetchTicket(ref: string): Promise<IngestedTicket>;
  /** Set the issue's coarse state. The adapter maps the neutral state to its vendor vocabulary. */
  setState(ref: string, state: IssueState): Promise<void>;
  /** Apply a label delta, preserving labels outside the delta (label-safe; never clobbers). */
  setLabels(ref: string, change: { add: string[]; remove: string[] }): Promise<void>;
  /** Post a comment, deduped by idempotencyKey (the adapter probes existing comments). Returns
   *  the created comment's id/ref, or null if it already existed. */
  addComment(ref: string, body: string, idempotencyKey: string): Promise<string | null>;
}

export type IssueTrackerFactory = () => IssueTrackerPort;

export function selectIssueTracker(
  config: { issueTracker: string },
  adapters: Record<string, IssueTrackerFactory>,
): IssueTrackerPort {
  const factory = adapters[config.issueTracker];
  if (!factory) {
    throw new Error(`selectIssueTracker: no adapter registered for '${config.issueTracker}'`);
  }
  return factory();
}
